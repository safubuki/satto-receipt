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
  ]
  const rows = receipts.flatMap((receipt) => {
    // 品目がない場合は1行で出力
    if (!receipt.lineItems.length) {
      return [
        [
          receipt.visitedAt,
          receipt.storeName,
          receipt.category ?? '',
          '',
          '',
          '',
          '',
          '',
          receipt.total,
          receipt.note ?? '',
        ],
      ]
    }

    // 品目ごとに1行ずつ出力
    return receipt.lineItems.map((line) => [
      receipt.visitedAt,
      receipt.storeName,
      receipt.category ?? '',
      line.name,
      line.category,
      line.quantity,
      line.price,
      line.price * line.quantity,
      receipt.total,
      receipt.note ?? '',
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
