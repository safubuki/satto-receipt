import type { Receipt } from "./types"

// very small CSV parser for our own export shape
const parseCsvLine = (line: string): string[] => {
  const result: string[] = []
  let current = ""
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"' && line[i + 1] === '"') {
      current += '"'
      i++
    } else if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === "," && !inQuotes) {
      result.push(current)
      current = ""
    } else {
      current += char
    }
  }
  result.push(current)
  return result
}

export const importCsvToReceipts = (csv: string): Receipt[] => {
  const lines = csv
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return []

  const header = lines[0].toLowerCase()
  const dataLines = header.includes("store") ? lines.slice(1) : lines

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
  }

  // CSV columns: date, store, store_category, item_name, item_category, quantity, unit_price, subtotal, receipt_total, note, is_nomikai, is_jibara
  // Index:       0     1      2               3          4              5         6           7         8              9     10          11

  // Group by date + store + total to aggregate line items
  const map = new Map<string, Row>()
  
  dataLines.forEach((line) => {
    const cols = parseCsvLine(line)
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
    
    const key = `${date}||${store}||${total}||${note ?? ""}`
    
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
      id: crypto.randomUUID(),
      storeName: row.store || "インポート",
      visitedAt: row.date || now.slice(0, 10),
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
