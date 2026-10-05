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
