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
    'item',
    'category',
    'quantity',
    'price',
    'receipt_total',
    'note',
  ]
  const rows = receipts.flatMap((receipt) => {
    if (!receipt.lineItems.length) {
      return [
        [
          receipt.visitedAt,
          receipt.storeName,
          '',
          '',
          '',
          '',
          receipt.total,
          receipt.note ?? '',
        ],
      ]
    }

    return receipt.lineItems.map((line) => [
      receipt.visitedAt,
      receipt.storeName,
      line.name,
      line.category,
      line.quantity,
      line.price,
      receipt.total,
      receipt.note ?? '',
    ])
  })

  return [header, ...rows].map((row) => row.map(escapeCell).join(',')).join('\n')
}

export const downloadCsv = (csv: string, filename = 'receipts.csv') => {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
