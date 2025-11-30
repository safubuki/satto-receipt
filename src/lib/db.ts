import { openDB } from 'idb'
import type { VaultRecord } from './types'

const DB_NAME = 'receipt-vault'
const STORE_NAME = 'vault'
const VERSION = 1

const getDb = () =>
  openDB(DB_NAME, VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    },
  })

export const loadVault = async (): Promise<VaultRecord | null> => {
  const db = await getDb()
  return (await db.get(STORE_NAME, 'data')) ?? null
}

export const saveVault = async (record: VaultRecord) => {
  const db = await getDb()
  await db.put(STORE_NAME, record)
}

export const clearVault = async () => {
  const db = await getDb()
  await db.delete(STORE_NAME, 'data')
}
