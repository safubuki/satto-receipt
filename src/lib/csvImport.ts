import { formatLocalDate } from "./date"
import type { Receipt } from "./types"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Quote-aware CSV reader. Keeps commas and line breaks inside quoted cells. */
const parseCsv = (csv: string): string[][] => {
  const text = csv.replace(/^\uFEFF/, "")
  const rows: string[][] = []
  let row: string[] = []
  let current = ""
  let inQuotes = false

  const pushRow = () => {
    row.push(current)
    if (row.some((cell) => cell.trim() !== "")) {
      rows.push(row.map((cell) => cell.trim()))
    }
    row = []
    current = ""
  }

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
    } else if (char === ",") {
      row.push(current)
      current = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++
      pushRow()
    } else {
      current += char
    }
  }

  if (current.length > 0 || row.length > 0) pushRow()
  return rows
}

export const importCsvToReceipts = (csv: string): Receipt[] => {
  const rows = parseCsv(csv)
  if (!rows.length) return []

  const header = rows[0].join(",").toLowerCase()
  const dataLines = header.includes("store") ? rows.slice(1) : rows

  type LineItemRow = {
    name: string
    category: string
    price: number
    quantity: number
  }

  type Row = {
    date: string
    store: string
    storeCategory: string
    total: number
    note?: string
    isNomikai?: boolean
    isJibara?: boolean
    lineItems: LineItemRow[]
    id: string
  }

  // CSV columns: date, store, store_category, item_name, item_category, quantity, unit_price, subtotal, receipt_total, note, is_nomikai, is_jibara
  // Index:       0     1      2               3          4              5         6           7         8              9     10          11

  // Group by date + store + total to aggregate line items
  const map = new Map<string, Row>()
  
  dataLines.forEach((cols) => {
    const date = cols[0] ?? ""
    const store = cols[1] ?? ""
    const storeCategory = cols[2] ?? ""
    const itemName = cols[3] ?? ""
    const itemCategory = cols[4] ?? ""
    const quantity = Number(cols[5]) || 1
    const unitPrice = Number(cols[6]) || 0
    // receipt_total is at index 8
    const total = Number(cols[8] ?? cols[6] ?? 0) || 0
    const note = cols[9] || undefined
    // is_nomikai at index 10, is_jibara at index 11 (optional for backward compatibility)
    const isNomikai = cols[10] === '1' || cols[10]?.toLowerCase() === 'true'
    const isJibara = cols[11] === '1' || cols[11]?.toLowerCase() === 'true'
    const receiptId = UUID_RE.test(cols[12] ?? "") ? cols[12] : ""

    // id がある行は同じレシートにまとめる。古いCSVは日付・店・合計・メモでまとめる。
    const key = receiptId
      ? `id:${receiptId}`
      : `${date}||${store}||${total}||${note ?? ""}`
    
    if (!map.has(key)) {
      map.set(key, {
        date,
        store,
        storeCategory,
        total,
        note,
        isNomikai,
        isJibara,
        lineItems: [],
        id: receiptId,
      })
    }
    
    const existing = map.get(key)!
    // Update flags if this row has them set
    if (isNomikai) existing.isNomikai = true
    if (isJibara) existing.isJibara = true
    
    // Add line item if item_name exists
    if (itemName) {
      existing.lineItems.push({
        name: itemName,
        category: itemCategory || storeCategory || '未分類',
        price: unitPrice,
        quantity,
      })
    }
  })

  return Array.from(map.values()).map((row) => {
    const now = new Date().toISOString()
    return {
      id: row.id || crypto.randomUUID(),
      storeName: row.store || "インポート",
      visitedAt: row.date || formatLocalDate(),
      total: row.total,
      category: row.storeCategory || undefined,
      note: row.note,
      lineItems: row.lineItems.map((item) => ({
        id: crypto.randomUUID(),
        name: item.name,
        category: item.category,
        price: item.price,
        quantity: item.quantity,
      })),
      isNomikai: row.isNomikai || undefined,
      isJibara: row.isJibara || undefined,
      createdAt: now,
      updatedAt: now,
    }
  })
}
