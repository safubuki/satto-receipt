export type LineItem = {
  id: string
  name: string
  category: string
  price: number
  quantity: number
}

export type Receipt = {
  id: string
  storeName: string
  visitedAt: string
  total: number
  category?: string
  tax?: number
  note?: string
  imageData?: string
  lineItems: LineItem[]
  createdAt: string
  updatedAt: string
}

export type Category = {
  id: string
  name: string
  color: string
}

export type Vault = {
  receipts: Receipt[]
  categories: Category[]
}

export type VaultRecord = {
  id: 'data'
  ciphertext: ArrayBuffer
  iv: Uint8Array
  version: number
}
