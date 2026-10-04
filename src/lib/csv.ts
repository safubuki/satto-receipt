import type { Receipt } from './types'

const escapeCell = (value: unknown) => {
  const str = value === undefined || value === null ? '' : String(value)
  if (str.includes('"') || str.includes(',') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export const toCsv = (receipts: Receipt[]): string => {
  const header = [
    'date',
    'store',
    'store_category',
    'item_name',
    'item_category',
    'quantity',
    'unit_price',
    'subtotal',
    'receipt_total',
    'note',
    'is_nomikai',
    'is_jibara',
    'id',
  ]
  const rows = receipts.flatMap((receipt) => {
    const items = receipt.lineItems ?? []
    const base = [
      receipt.visitedAt,
      receipt.storeName,
      receipt.category ?? '',
    ]
    const tail = [
      receipt.total,
      receipt.note ?? '',
      receipt.isNomikai ? '1' : '',
      receipt.isJibara ? '1' : '',
      receipt.id,
    ]

    // 品目がない場合は1行で出力
    if (!items.length) {
      return [[...base, '', '', '', '', '', ...tail]]
    }

    // 品目ごとに1行ずつ出力。同じ id の行は1件のレシートに戻す。
    return items.map((line) => [
      ...base,
      line.name,
      line.category,
      line.quantity,
      line.price,
      line.price * line.quantity,
      ...tail,
    ])
  })

  return [header, ...rows].map((row) => row.map(escapeCell).join(',')).join('\n')
}

export const downloadCsv = (csv: string, filename = 'receipts.csv') => {
  // BOMを追加してExcelでの文字化けを防止
  const bom = new Uint8Array([0xEF, 0xBB, 0xBF])
  const blob = new Blob([bom, csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
