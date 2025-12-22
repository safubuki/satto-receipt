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

  type Row = {
    date: string
    store: string
    total: number
    note?: string
    isNomikai?: boolean
    isJibara?: boolean
  }

  const rows: Row[] = dataLines.map((line) => {
    const cols = parseCsvLine(line)
    // CSV columns: date, store, store_category, item_name, item_category, quantity, unit_price, subtotal, receipt_total, note, is_nomikai, is_jibara
    // Index:       0     1      2               3          4              5         6           7         8              9     10          11
    const date = cols[0] ?? ""
    const store = cols[1] ?? ""
    // receipt_total is at index 8
    const total = Number(cols[8] ?? cols[6] ?? 0) || 0
    const note = cols[9] || undefined
    // is_nomikai at index 10, is_jibara at index 11 (optional for backward compatibility)
    const isNomikai = cols[10] === '1' || cols[10]?.toLowerCase() === 'true'
    const isJibara = cols[11] === '1' || cols[11]?.toLowerCase() === 'true'
    return { date, store, total, note, isNomikai, isJibara }
  })

  // Group by date + store + total + note to reduce duplicates
  const map = new Map<string, Row>()
  rows.forEach((row) => {
    const key = `${row.date}||${row.store}||${row.total}||${row.note ?? ""}`
    // Keep the first occurrence, but preserve flags if set
    if (!map.has(key)) {
      map.set(key, row)
    } else {
      const existing = map.get(key)!
      // If this row has flags set but existing doesn't, update
      if ((row.isNomikai || row.isJibara) && !existing.isNomikai && !existing.isJibara) {
        map.set(key, row)
      }
    }
  })

  return Array.from(map.values()).map((row) => {
    const now = new Date().toISOString()
    return {
      id: crypto.randomUUID(),
      storeName: row.store || "インポート",
      visitedAt: row.date || now.slice(0, 10),
      total: row.total,
      category: undefined,
      note: row.note,
      lineItems: [],
      isNomikai: row.isNomikai || undefined,
      isJibara: row.isJibara || undefined,
      createdAt: now,
      updatedAt: now,
    }
  })
}
