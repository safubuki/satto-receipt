import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CategoryBreakdown } from "../components/CategoryBreakdown"
import { buildItemGroupPrompt, buildMonthInsightPrompt, describeGeminiError, parseItemGroups, withBusyRetry } from "./geminiOcr"
import { LineInsightsPanel } from "../components/LineInsights"
import { buildLineInsights, buildMonthBreakdown, collectMonthFoods, collectMonthItemNames, itemLabelMap, percentShares } from "./monthBreakdown"

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

describe("buildLineInsights", () => {
  const march = [
    {
      id: "a",
      visitedAt: "2026-03-02",
      total: 2380,
      storeName: "イオン",
      lineItems: [
        { name: "牛乳", price: 200, quantity: 2 },
        { name: "コシヒカリ5kg", price: 1980, quantity: 1 },
      ],
    },
    {
      id: "b",
      visitedAt: "2026-03-18",
      total: 308,
      storeName: "業務スーパー",
      lineItems: [
        { name: " 牛乳 ", price: 180, quantity: 1 },
        { name: "結束スパゲッティ", price: 128, quantity: 1 },
      ],
    },
    {
      id: "c",
      visitedAt: "2026-03-20",
      total: 316,
      storeName: "イオン",
      lineItems: [{ name: "結束スパゲッティ", price: 158, quantity: 2 }],
    },
    {
      id: "d",
      visitedAt: "2026-03-21",
      total: 100,
      storeName: "コンビニ",
      lineItems: [{ name: "お茶", price: 100, quantity: 1 }],
    },
    {
      id: "e",
      visitedAt: "2026-02-01",
      total: 999,
      storeName: "イオン",
      lineItems: [{ name: "牛乳", price: 999, quantity: 1 }],
    },
    {
      id: "f",
      visitedAt: "2026-03-22",
      total: 500,
      storeName: "店",
      lineItems: [],
    },
  ]

  it("finds repeats, price gaps, and spend concentration across the month", () => {
    const insights = buildLineInsights(march, "2026-03")

    expect(insights.receiptCount).toBe(5)
    expect(insights.receiptsWithItems).toBe(4)
    expect(insights.lineTotal).toBe(3104)
    expect(insights.repeats.map((item) => [item.name, item.receiptCount, item.quantity, item.amount])).toEqual([
      ["牛乳", 2, 3, 580],
      ["結束スパゲッティ", 2, 3, 444],
    ])
    expect(insights.topItems.map((item) => item.name)).toEqual(["コシヒカリ5kg", "牛乳", "結束スパゲッティ"])
    expect(insights.topSharePercent).toBe(97)
  })

  it("says nothing repeats when each item appears on one receipt", () => {
    const insights = buildLineInsights(
      [{ id: "only", visitedAt: "2026-04-01", total: 300, storeName: "店", lineItems: [{ name: "パン", price: 300, quantity: 1 }] }],
      "2026-04",
    )

    expect(insights.repeats).toEqual([])
    expect(insights.topSharePercent).toBeNull()
  })

  it("renders the accumulated facts without advice", () => {
    const html = renderToStaticMarkup(createElement(LineInsightsPanel, { insights: buildLineInsights(march, "2026-03") }))

    expect(html).toContain("明細があるレシートは 4件 / 5件")
    expect(html).toContain("購入金額が大きい商品")
    expect(html).toContain("繰り返し購入している商品")
    expect(html).toContain("別の買い物で買った回数です。")
    expect(html).toContain("牛乳")
    expect(html).toContain("2回")
    expect(html).not.toContain("数量")
    expect(html).toContain("上位3品で、明細の金額の 97%")
    expect(html).not.toContain("単価の差")
    expect(html).not.toContain("健康")
    expect(html).not.toContain("良さそう")
  })

  it("uses the same totals after different names are classified as one item", () => {
    const names = ["明治おいしい牛乳", "農協牛乳 1L", "結束スパゲッティ"]
    const labels = itemLabelMap(names, [
      { label: "牛乳", names: ["明治おいしい牛乳", "農協牛乳 1L", "一覧にない品"] },
      { label: "飲料", names: ["明治おいしい牛乳"] },
    ])
    const insights = buildLineInsights(
      [
        { id: "a", visitedAt: "2026-05-01", total: 200, storeName: "A店", lineItems: [{ name: "明治おいしい牛乳", price: 200, quantity: 1 }] },
        { id: "b", visitedAt: "2026-05-10", total: 180, storeName: "B店", lineItems: [{ name: "農協牛乳 1L", price: 180, quantity: 1 }] },
        { id: "c", visitedAt: "2026-05-11", total: 160, storeName: "C店", lineItems: [{ name: "結束スパゲッティ", price: 160, quantity: 1 }] },
      ],
      "2026-05",
      labels,
    )

    expect(labels.has("結束スパゲッティ")).toBe(false)
    expect(insights.repeats).toEqual([
      expect.objectContaining({
        name: "牛乳",
        receiptCount: 2,
        quantity: 2,
        amount: 380,
        sources: ["農協牛乳 1L", "明治おいしい牛乳"],
      }),
    ])
    const html = renderToStaticMarkup(createElement(LineInsightsPanel, { insights }))
    expect(html).toContain("2回")
    expect(html).toContain("農協牛乳 1L、明治おいしい牛乳")
    expect(html).not.toContain("単価の差")
  })

  it("shows two printed names under the largest purchases and counts the rest", () => {
    const html = renderToStaticMarkup(createElement(LineInsightsPanel, {
      insights: {
        receiptCount: 4,
        receiptsWithItems: 4,
        lineTotal: 400,
        namedItemCount: 1,
        topSharePercent: null,
        topItems: [{
          name: "乾物",
          quantity: 4,
          amount: 400,
          sources: ["カットわかめ", "大根", "豆腐", "高野豆腐"],
        }],
        repeats: [{
          name: "乾物",
          receiptCount: 4,
          quantity: 8,
          amount: 400,
          sources: ["カットわかめ", "大根", "豆腐", "高野豆腐"],
        }],
      },
    }))
    expect(html).toContain("カットわかめ、大根、ほか2品")
    expect(html).toContain("4回")
    expect(html).not.toContain("8")
    expect(html).not.toContain("高野豆腐")
  })
})

describe("item grouping", () => {
  it("asks only for groups and keeps the printed names", () => {
    const prompt = buildItemGroupPrompt(["明治おいしい牛乳", "農協牛乳 1L"])
    expect(prompt).toContain("1. 明治おいしい牛乳")
    expect(prompt).toContain("2. 農協牛乳 1L")
    expect(prompt).toContain("説明、助言、健康やお金のコメントは書かない")
    expect(prompt).not.toContain("提案を1つ")
  })

  it("reads groups from a JSON object and ignores a broken reply", () => {
    expect(parseItemGroups('説明です\n```json\n{"groups":[{"label":"牛乳","names":["明治おいしい牛乳"]}]}\n```')).toEqual([
      { label: "牛乳", names: ["明治おいしい牛乳"] },
    ])
    expect(() => parseItemGroups("まとめられません")).toThrow("品名を分類できませんでした")
  })

  it("collects the month's printed names without prices or stores", () => {
    expect(collectMonthItemNames([
      { visitedAt: "2026-05-01", total: 1, lineItems: [{ name: " 牛乳 ", price: 100, quantity: 1 }, { name: "牛乳", price: 120, quantity: 1 }] },
      { visitedAt: "2026-04-01", total: 1, lineItems: [{ name: "先月のパン", price: 100, quantity: 1 }] },
    ], "2026-05")).toEqual(["牛乳"])
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
