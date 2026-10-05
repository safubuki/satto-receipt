import { describe, expect, it } from "vitest"
import { findDuplicateReceipts } from "./duplicateReceipts"
import type { Receipt } from "./types"

const sample = (patch: Partial<Receipt> = {}): Receipt => ({
  id: "saved-receipt",
  storeName: "セブン-イレブン 京橋店",
  visitedAt: "2026-10-01",
  total: 1234,
  lineItems: [],
  createdAt: "2026-10-02T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  ...patch,
})

describe("possible duplicate receipts", () => {
  it("matches store, purchase date, and total even when registration dates or notes differ", () => {
    const saved = sample({ note: "元のメモ", category: "コンビニ" })
    const candidate = sample({ createdAt: "2026-10-10T00:00:00.000Z", note: "別のメモ", category: "その他" })
    expect(findDuplicateReceipts([saved], candidate)).toEqual([saved])
  })

  it("absorbs half-width katakana, full-width characters, spaces, and hyphen variants", () => {
    const saved = sample()
    const candidate = sample({ storeName: "　ｾﾌﾞﾝ‐ｲﾚﾌﾞﾝ　京橋 店\n" })
    expect(findDuplicateReceipts([saved], candidate)).toEqual([saved])
  })

  it("absorbs English letter casing and full-width Latin letters", () => {
    const saved = sample({ storeName: "AEON 飯塚店" })
    expect(findDuplicateReceipts([saved], sample({ storeName: "ａｅｏｎ　飯塚店" }))).toEqual([saved])
  })

  it.each([
    { visitedAt: "2026-10-02" },
    { total: 1235 },
    { storeName: "セブン-イレブン 飯塚店" },
    { storeName: "ローソン 京橋店" },
  ])("does not flag a different purchase: %j", (patch) => {
    expect(findDuplicateReceipts([sample()], sample(patch))).toEqual([])
  })

  it("does not remove meaningful Japanese long-vowel marks or guess similar store names", () => {
    expect(findDuplicateReceipts([sample({ storeName: "サンマート" })], sample({ storeName: "サンマト" }))).toEqual([])
    expect(findDuplicateReceipts([sample()], sample({ storeName: "セブン 京橋店" }))).toEqual([])
  })

  it.each([
    { storeName: "" },
    { storeName: "　 \n" },
    { visitedAt: "" },
    { visitedAt: "2026/10/01" },
    { total: 0 },
    { total: NaN },
    { total: Infinity },
  ])("does not flag incomplete purchase information: %j", (patch) => {
    const incomplete = sample(patch)
    expect(findDuplicateReceipts([incomplete], incomplete)).toEqual([])
  })

  it("includes receipts outside the currently displayed month and returns all matches in order", () => {
    const receipts = [sample({ id: "newer" }), sample({ total: 100 }), sample({ id: "older" })]
    const before = receipts.map((receipt) => ({ ...receipt }))
    expect(findDuplicateReceipts(receipts, sample()).map((receipt) => receipt.id)).toEqual(["newer", "older"])
    expect(receipts).toEqual(before)
  })

  it("also detects a repeated refund receipt", () => {
    const saved = sample({ total: -1234 })
    expect(findDuplicateReceipts([saved], sample({ total: -1234 }))).toEqual([saved])
  })
})
