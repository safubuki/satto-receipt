import type { Vault } from './types'

const SALT_KEY = 'receipt-vault-salt'
const PASSPHRASE_KEY = 'receipt-vault-passphrase'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const iterations = 200_000

// localStorageが使えない環境でも落ちないようにメモリ上にフォールバック
const memoryStore = new Map<string, string>()
const safeGetItem = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return memoryStore.get(key) ?? null
  }
}

const safeSetItem = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
    memoryStore.delete(key)
  } catch {
    memoryStore.set(key, value)
  }
}

const safeRemoveItem = (key: string): void => {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
  memoryStore.delete(key)
}

export const bytesToBase64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))

export const base64ToBytes = (value: string): Uint8Array =>
  new Uint8Array(atob(value).split('').map((c) => c.charCodeAt(0)))

export const getOrCreateSalt = (): Uint8Array => {
  const stored = safeGetItem(SALT_KEY)
  if (stored) return base64ToBytes(stored)

  const salt = crypto.getRandomValues(new Uint8Array(16))
  safeSetItem(SALT_KEY, bytesToBase64(salt))
  return salt
}

export const clearSalt = (): void => {
  safeRemoveItem(SALT_KEY)
}

// パスフレーズ記憶機能
export const savePassphrase = (passphrase: string): void => {
  // Base64エンコードして保存（平文ではなく軽い難読化）
  safeSetItem(PASSPHRASE_KEY, btoa(encodeURIComponent(passphrase)))
}

export const getSavedPassphrase = (): string | null => {
  const stored = safeGetItem(PASSPHRASE_KEY)
  if (!stored) return null
  try {
    return decodeURIComponent(atob(stored))
  } catch {
    return null
  }
}

export const clearSavedPassphrase = (): void => {
  safeRemoveItem(PASSPHRASE_KEY)
}

export const hasRememberedPassphrase = (): boolean => {
  return safeGetItem(PASSPHRASE_KEY) !== null
}

export const deriveKey = async (
  passphrase: string,
  salt: Uint8Array,
): Promise<CryptoKey> => {
  const normalizedSalt = new Uint8Array(salt)
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: normalizedSalt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export const encryptVault = async (
  vault: Vault,
  key: CryptoKey,
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const data = encoder.encode(JSON.stringify(vault))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data,
  )

  return { ciphertext, iv }
}

export const decryptVault = async (params: {
  ciphertext: ArrayBuffer
  iv: Uint8Array
  key: CryptoKey
}): Promise<Vault> => {
  const { ciphertext, iv, key } = params
  const ivBuffer = new Uint8Array(iv)
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBuffer },
    key,
    ciphertext,
  )

  const json = decoder.decode(decrypted)
  return JSON.parse(json) as Vault
}
