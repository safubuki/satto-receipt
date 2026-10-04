import { describe, expect, it } from "vitest"
import { toCsv } from "./csv"
import { importCsvToReceipts } from "./csvImport"
import { formatLocalDate, shiftMonth } from "./date"
import type { Receipt } from "./types"

const sample = (id: string, store: string, total: number, note = 'メモ, "引用"\n2行目'): Receipt => ({
  id,
  storeName: store,
  visitedAt: "2026-10-01",
  total,
  category: "スーパー",
  note,
  lineItems: [
    { id: `${id}-a`, name: "牛乳", category: "食品", price: 200, quantity: 2 },
    { id: `${id}-b`, name: "パン", category: "食品", price: 150, quantity: 1 },
  ],
  isNomikai: false,
  isJibara: true,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
})

describe("csv", () => {
  it("keeps two same-day receipts with the same total separate", () => {
    const receipts = [
      sample("11111111-1111-4111-8111-111111111111", "イオン", 550),
      sample("22222222-2222-4222-8222-222222222222", "イオン", 550),
    ]
    const imported = importCsvToReceipts(`\uFEFF${toCsv(receipts)}`)

    expect(imported.map((receipt) => receipt.id)).toEqual(receipts.map((receipt) => receipt.id))
    expect(imported[0].lineItems).toHaveLength(2)
    expect(imported[0].lineItems[0]).toMatchObject({ name: "牛乳", price: 200, quantity: 2 })
    expect(imported[0].note).toBe('メモ, "引用"\n2行目')
    expect(imported[0].isJibara).toBe(true)
    expect(imported[0].total).toBe(550)
  })

  it("still imports the previous CSV shape", () => {
    const csv = [
      "date,store,store_category,item_name,item_category,quantity,unit_price,subtotal,receipt_total,note,is_nomikai,is_jibara",
      "2026-09-01,セブン,コンビニ,おにぎり,食品,1,150,150,300,,",
      "2026-09-01,セブン,コンビニ,お茶,飲料,1,150,150,300,,,1",
    ].join("\n")
    const imported = importCsvToReceipts(csv)

    expect(imported).toHaveLength(1)
    expect(imported[0].storeName).toBe("セブン")
    expect(imported[0].total).toBe(300)
    expect(imported[0].lineItems.map((item) => item.name)).toEqual(["おにぎり", "お茶"])
    expect(imported[0].isJibara).toBe(true)
  })

  it("exports a receipt whose line items were missing", () => {
    const receipt = sample("33333333-3333-4333-8333-333333333333", "店", 100, "")
    delete (receipt as { lineItems?: Receipt["lineItems"] }).lineItems
    const imported = importCsvToReceipts(toCsv([receipt]))

    expect(imported).toHaveLength(1)
    expect(imported[0].lineItems).toEqual([])
    expect(imported[0].total).toBe(100)
  })
})

describe("local dates", () => {
  it("uses the local calendar instead of UTC", () => {
    expect(formatLocalDate(new Date(2026, 9, 1, 0, 30))).toBe("2026-10-01")
  })

  it("moves across year boundaries", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12")
    expect(shiftMonth("2026-12", 1)).toBe("2027-01")
  })
})
