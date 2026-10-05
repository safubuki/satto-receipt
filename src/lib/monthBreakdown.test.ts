import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CategoryBreakdown } from "../components/CategoryBreakdown"
import { buildMonthInsightPrompt, describeGeminiError, withBusyRetry } from "./geminiOcr"
import { buildMonthBreakdown, collectMonthFoods, percentShares } from "./monthBreakdown"

const yen = (value: number) =>
  new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(value)

describe("percentShares", () => {
  it("rounds shares so they add up to 100", () => {
    expect(percentShares([1, 1, 1])).toEqual([34, 33, 33])
    expect(percentShares([50, 50])).toEqual([50, 50])
    expect(percentShares([0, 0])).toEqual([0, 0])
  })
})

describe("buildMonthBreakdown", () => {
  it("compares this month with the previous calendar month", () => {
    const breakdown = buildMonthBreakdown(
      [
        { visitedAt: "2026-03-02", total: 10000, category: "スーパー" },
        { visitedAt: "2026-03-18", total: 1000, category: "飲食店" },
        { visitedAt: "2026-02-11", total: 10010, category: "スーパー" },
        { visitedAt: "2026-02-20", total: 5000, category: "飲食店" },
        { visitedAt: "2026-01-01", total: 99999, category: "娯楽" },
      ],
      "2026-03",
    )

    expect(breakdown.previousMonth).toBe("2026-02")
    expect(breakdown.total).toBe(11000)
    expect(breakdown.delta).toBe(11000 - 15010)
    expect(breakdown.slices.map((slice) => [slice.name, slice.percent, slice.delta])).toEqual([
      ["スーパー", 91, -10],
      ["飲食店", 9, -4000],
    ])
    expect(breakdown.lead?.name).toBe("スーパー")
    expect(breakdown.leadChange).toMatchObject({ name: "飲食店", delta: -4000 })
    expect(breakdown.dropped).toEqual([])
  })

  it("treats a dropped category as the change only when the amount is large enough", () => {
    const breakdown = buildMonthBreakdown(
      [
        { visitedAt: "2026-04-03", total: 4000, category: "スーパー" },
        { visitedAt: "2026-03-03", total: 4000, category: "スーパー" },
        { visitedAt: "2026-03-09", total: 3000, category: "娯楽" },
        { visitedAt: "2026-03-12", total: 400, category: "コンビニ" },
      ],
      "2026-04",
    )

    expect(breakdown.leadChange).toMatchObject({ name: "娯楽", total: 0, previousTotal: 3000, delta: -3000 })
    expect(breakdown.dropped.map((row) => row.name)).toEqual(["娯楽", "コンビニ"])
    expect(breakdown.slices).toEqual([
      expect.objectContaining({ name: "スーパー", percent: 100, delta: 0 }),
    ])
  })

  it("skips comparison text material when last month has no receipts", () => {
    const breakdown = buildMonthBreakdown(
      [
        { visitedAt: "2026-01-05", total: 800, category: "  " },
        { visitedAt: "2026-01-06", total: 200, category: undefined },
      ],
      "2026-01",
    )

    expect(breakdown.previousMonth).toBe("2025-12")
    expect(breakdown.hasPrevious).toBe(false)
    expect(breakdown.leadChange).toBeNull()
    expect(breakdown.slices).toEqual([
      expect.objectContaining({ name: "未分類", total: 1000, percent: 100 }),
    ])
  })

  it("notices a large swing inside a category that stayed both months", () => {
    const breakdown = buildMonthBreakdown(
      [
        { visitedAt: "2026-05-02", total: 800, category: "コンビニ" },
        { visitedAt: "2026-04-02", total: 400, category: "コンビニ" },
      ],
      "2026-05",
    )

    expect(breakdown.leadChange).toMatchObject({ name: "コンビニ", delta: 400 })
  })
})

describe("buildMonthInsightPrompt", () => {
  it("asks for two short sentences and hands over only the chosen facts", () => {
    const prompt = buildMonthInsightPrompt({
      month: "2026年3月",
      total: 11000,
      count: 2,
      previous: { month: "2026年2月", total: 15010, count: 2 },
      largest: { name: "スーパー", total: 10000, percent: 91 },
      change: { name: "飲食店", total: 1000, previousTotal: 5000, delta: -4000 },
      topStore: { name: "イオン", total: 10000 },
    })

    expect(prompt).toContain("2文以内")
    expect(prompt).toContain("節約の指示")
    expect(prompt).toContain("いちばん大きい分類: スーパー 10000円 91%")
    expect(prompt).toContain("増減の大きい分類: 飲食店 今月 1000円 先月 5000円 差 -4000円")
    expect(prompt).not.toContain("店別上位")
  })

  it("tells the model to stop after one sentence when nothing changed enough", () => {
    const prompt = buildMonthInsightPrompt({
      month: "2026年1月",
      total: 1000,
      count: 2,
      previous: null,
      largest: { name: "未分類", total: 1000, percent: 100 },
      change: null,
      topStore: null,
    })

    expect(prompt).toContain("先月: なし")
    expect(prompt).toContain("増減の大きい分類: なし")
    expect(prompt).toContain("なければ1文で終える")
  })

  it("keeps food names out of the lite prompt and asks 3.8 Flash for short advice", () => {
    const input = {
      month: "2026年3月",
      total: 11000,
      count: 2,
      previous: { month: "2026年2月", total: 15010, count: 2 },
      largest: { name: "スーパー", total: 10000, percent: 91 },
      change: { name: "飲食店", total: 1000, previousTotal: 5000, delta: -4000 },
      topStore: { name: "イオン", total: 10000 },
      nomikai: 1800,
      foods: [{ name: "牛乳", quantity: 2, amount: 400 }],
      foodsOmitted: 3,
    }

    expect(buildMonthInsightPrompt(input)).not.toContain("牛乳")
    const advice = buildMonthInsightPrompt(input, "gemini-3.8-flash")
    expect(advice).toContain("使い方の提案を1つ")
    expect(advice).toContain("食生活")
    expect(advice).toContain("健康")
    expect(advice).toContain("診断、病名、治療、サプリの指示は書かない")
    expect(advice).toContain("牛乳 数量2 400円、ほか3品")
    expect(advice).toContain("飲み会: 1800円")
    expect(advice).not.toContain("節約の指示")
  })

  it("tells 3.8 Flash to skip diet and health when there are no line items", () => {
    const prompt = buildMonthInsightPrompt({
      month: "2026年3月",
      total: 11000,
      count: 2,
      previous: null,
      largest: { name: "スーパー", total: 11000, percent: 100 },
      change: null,
      topStore: null,
      foods: [],
    }, "gemini-3.8-flash")

    expect(prompt).toContain("明細がなければお金だけ")
    expect(prompt).toContain("明細: なし")
  })
})

describe("describeGeminiError", () => {
  const busy = new Error(
    '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}',
  )

  it("turns a busy 3.8 response into a short Japanese message", () => {
    expect(describeGeminiError(busy).message).toBe("Gemini が混み合っています。しばらくしてから、もう一度押してください。")
  })

  it("retries a busy model twice, then gives up in Japanese", async () => {
    const waits: number[] = []
    let calls = 0
    await expect(
      withBusyRetry(async () => {
        calls += 1
        throw busy
      }, async (ms) => {
        waits.push(ms)
      }),
    ).rejects.toThrow("Gemini が混み合っています。しばらくしてから、もう一度押してください。")
    expect(calls).toBe(3)
    expect(waits).toEqual([1000, 2000])
  })

  it("does not retry an invalid API key", async () => {
    let calls = 0
    await expect(
      withBusyRetry(async () => {
        calls += 1
        throw new Error("401 API_KEY_INVALID")
      }),
    ).rejects.toThrow("APIキーが無効です。正しいGemini APIキーを入力してください。")
    expect(calls).toBe(1)
  })
})

describe("collectMonthFoods", () => {
  it("sums the same item and keeps the highest spenders", () => {
    const result = collectMonthFoods(
      [
        {
          visitedAt: "2026-03-02",
          total: 1000,
          lineItems: [
            { name: " 牛乳 ", price: 200, quantity: 2 },
            { name: "牛乳", price: 180, quantity: 1 },
            { name: "   ", price: 100, quantity: 1 },
          ],
        },
        {
          visitedAt: "2026-03-04",
          total: 500,
          lineItems: [{ name: "カップ麺", price: 150, quantity: 4 }],
        },
        {
          visitedAt: "2026-02-01",
          total: 900,
          lineItems: [{ name: "先月のパン", price: 300, quantity: 1 }],
        },
      ],
      "2026-03",
      1,
    )

    expect(result.foods).toEqual([{ name: "カップ麺", quantity: 4, amount: 600 }])
    expect(result.omitted).toBe(1)
  })
})

describe("CategoryBreakdown", () => {
  it("draws a pie and the comparison with last month", () => {
    const breakdown = buildMonthBreakdown(
      [
        { visitedAt: "2026-03-02", total: 10000, category: "スーパー" },
        { visitedAt: "2026-03-18", total: 1000, category: "飲食店" },
        { visitedAt: "2026-02-11", total: 6000, category: "スーパー" },
        { visitedAt: "2026-02-20", total: 3000, category: "娯楽" },
      ],
      "2026-03",
    )
    const html = renderToStaticMarkup(
      createElement(CategoryBreakdown, {
        breakdown,
        colors: new Map([["スーパー", "#3de0a2"]]),
      }),
    )

    expect(html).toContain("<svg")
    expect(html).toContain("スーパー")
    expect(html).toContain(yen(10000))
    expect(html).toContain("先月より")
    expect(html).toContain(`娯楽 ${yen(3000)}`)
    expect(html).toContain('fill="#3de0a2"')
  })

  it("says when this month has no spending", () => {
    const html = renderToStaticMarkup(
      createElement(CategoryBreakdown, {
        breakdown: buildMonthBreakdown([{ visitedAt: "2026-02-01", total: 1500, category: "スーパー" }], "2026-03"),
        colors: new Map(),
      }),
    )

    expect(html).toContain("この月の支出はまだありません。")
    expect(html).toContain(`先月は ${yen(1500)} でした。`)
    expect(html).not.toContain("<svg")
  })

  it("draws one circle when the month has a single genre", () => {
    const html = renderToStaticMarkup(
      createElement(CategoryBreakdown, {
        breakdown: buildMonthBreakdown([{ visitedAt: "2026-03-01", total: 500, category: "スーパー" }], "2026-03"),
        colors: new Map([["スーパー", "#3de0a2"]]),
      }),
    )

    expect(html).toContain("<circle")
    expect(html).toContain("先月の支出はありません。")
  })
})
