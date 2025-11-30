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
  }

  const rows: Row[] = dataLines.map((line) => {
    const cols = parseCsvLine(line)
    // Our export: date, store, item, category, quantity, price, receipt_total, note
    const date = cols[0] ?? ""
    const store = cols[1] ?? ""
    const total = Number(cols[6] ?? cols[2] ?? 0) || 0
    const note = cols[7] || undefined
    return { date, store, total, note }
  })

  // Group by date + store + total + note to reduce duplicates
  const map = new Map<string, Row>()
  rows.forEach((row) => {
    const key = `${row.date}||${row.store}||${row.total}||${row.note ?? ""}`
    if (!map.has(key)) map.set(key, row)
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
      createdAt: now,
      updatedAt: now,
    }
  })
}
