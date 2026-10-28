import { describe, expect, it } from "vitest"
import { goodsShares, goodsTypeOf } from "./goods"
import { buildMonthBreakdown } from "./monthBreakdown"

describe("goodsTypeOf", () => {
  it("reads both item categories and store categories", () => {
    expect(goodsTypeOf("食品")).toBe("食品")
    expect(goodsTypeOf("飲料")).toBe("食品")
    expect(goodsTypeOf("衣類")).toBe("衣料品")
    expect(goodsTypeOf("医薬品")).toBe("医薬品")
    expect(goodsTypeOf("スーパー")).toBe("食品")
    expect(goodsTypeOf("ドラッグストア")).toBe("日用品")
    expect(goodsTypeOf("医療・薬局")).toBe("医薬品")
    expect(goodsTypeOf("飲食店")).toBe("外食")
    expect(goodsTypeOf("ガソリン")).toBe("その他")
    expect(goodsTypeOf(undefined)).toBe("その他")
  })
})

describe("goodsShares", () => {
  it("splits one receipt by what was bought, scaled to the paid total", () => {
    const shares = goodsShares({
      total: 1100,
      category: "ドラッグストア",
      lineItems: [
        { name: "風邪薬", category: "医薬品", price: 600, quantity: 1 },
        { name: "ティッシュ", category: "日用品", price: 200, quantity: 2 },
        { name: "値引", category: "その他", price: -100, quantity: 1 },
      ],
    })

    expect(shares).toEqual([
      { name: "医薬品", amount: 660 },
      { name: "日用品", amount: 440 },
    ])
  })

  it("keeps every yen when the split does not divide evenly", () => {
    const shares = goodsShares({
      total: 2,
      lineItems: [
        { category: "食品", price: 1 },
        { category: "日用品", price: 1 },
        { category: "衣類", price: 1 },
        { category: "雑貨", price: 1 },
      ],
    })

    expect(shares.reduce((sum, share) => sum + share.amount, 0)).toBe(2)
    expect(shares.every((share) => share.amount >= 0)).toBe(true)
  })

  it("falls back to the store when there are no line items, and counts drinking out as eating out", () => {
    expect(goodsShares({ total: 800, category: "コンビニ" })).toEqual([{ name: "食品", amount: 800 }])
    expect(goodsShares({ total: 5000, category: "その他", isNomikai: true })).toEqual([{ name: "外食", amount: 5000 }])
  })

  it("uses the store type for items without their own category", () => {
    expect(goodsShares({ total: 300, category: "衣料品店", lineItems: [{ name: "靴下", price: 300 }] })).toEqual([
      { name: "衣料品", amount: 300 },
    ])
  })
})

describe("buildMonthBreakdown by goods", () => {
  it("puts one supermarket receipt into food and household goods", () => {
    const breakdown = buildMonthBreakdown(
      [
        {
          visitedAt: "2026-10-02",
          total: 3000,
          category: "スーパー",
          lineItems: [
            { category: "食品", price: 2000, quantity: 1 },
            { category: "日用品", price: 1000, quantity: 1 },
          ],
        },
        { visitedAt: "2026-10-05", total: 1000, category: "衣料品店" },
      ],
      "2026-10",
      goodsShares,
    )

    expect(breakdown.total).toBe(4000)
    expect(breakdown.count).toBe(2)
    expect(breakdown.slices.map((slice) => [slice.name, slice.total, slice.percent])).toEqual([
      ["食品", 2000, 50],
      ["衣料品", 1000, 25],
      ["日用品", 1000, 25],
    ])
  })
})
