import type { Receipt } from "./types"

type ReceiptIdentity = Pick<Receipt, "storeName" | "visitedAt" | "total">

const normalizeStoreName = (name: string) =>
  name.normalize("NFKC").toLowerCase().replace(/\s+/gu, "").replace(/[‐‑‒–—―−]/gu, "-")

/** Find possible duplicates without treating missing store/date/amount as a match. */
export const findDuplicateReceipts = (
  receipts: readonly Receipt[],
  candidate: ReceiptIdentity,
): Receipt[] => {
  const storeName = normalizeStoreName(candidate.storeName)
  if (
    !storeName ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(candidate.visitedAt) ||
    !Number.isFinite(candidate.total) ||
    candidate.total === 0
  ) return []

  return receipts.filter((receipt) =>
    receipt.visitedAt === candidate.visitedAt &&
    receipt.total === candidate.total &&
    normalizeStoreName(receipt.storeName) === storeName,
  )
}

/** まとめて保存する候補のうち、保存済みか、同じ束の前のものと重なる件数。 */
export const countBatchDuplicates = (
  saved: readonly Receipt[],
  candidates: readonly ReceiptIdentity[],
): number => {
  const seen: Receipt[] = [...saved]
  let count = 0
  for (const candidate of candidates) {
    if (findDuplicateReceipts(seen, candidate).length) count += 1
    seen.push({ ...candidate, id: "", lineItems: [], createdAt: "", updatedAt: "" })
  }
  return count
}
