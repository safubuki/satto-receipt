import { PBKDF2_ITERATIONS } from './kdf'
import type { Vault } from './types'

const SALT_KEY = 'receipt-vault-salt'
const PASSPHRASE_KEY = 'receipt-vault-passphrase'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

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

export const readSalt = (): Uint8Array | null => {
  const stored = safeGetItem(SALT_KEY)
  if (!stored) return null
  try {
    const bytes = base64ToBytes(stored)
    return bytes.length > 0 ? bytes : null
  } catch {
    return null
  }
}

export const storeSalt = (salt: Uint8Array): void => {
  safeSetItem(SALT_KEY, bytesToBase64(new Uint8Array(salt)))
}

export const getOrCreateSalt = (): Uint8Array => {
  const existing = readSalt()
  if (existing) return existing

  const salt = crypto.getRandomValues(new Uint8Array(16))
  storeSalt(salt)
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

const importAesKey = (bits: ArrayBuffer): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])

const deriveBitsOnMain = async (passphrase: string, salt: Uint8Array): Promise<ArrayBuffer> => {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new Uint8Array(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    256,
  )
}

const deriveBitsInWorker = (passphrase: string, salt: Uint8Array): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pbkdf2.worker.ts', import.meta.url), { type: 'module' })
    const saltCopy = new Uint8Array(salt)
    const timer = window.setTimeout(() => {
      worker.terminate()
      reject(new Error('key derivation timed out'))
    }, 60_000)
    worker.onmessage = (event: MessageEvent<{ bits?: ArrayBuffer; error?: string }>) => {
      window.clearTimeout(timer)
      worker.terminate()
      if (event.data.bits) resolve(event.data.bits)
      else reject(new Error(event.data.error || 'key derivation failed'))
    }
    worker.onerror = () => {
      window.clearTimeout(timer)
      worker.terminate()
      reject(new Error('key derivation worker failed'))
    }
    worker.postMessage({ passphrase, salt: saltCopy.buffer }, [saltCopy.buffer])
  })

export const deriveKey = async (
  passphrase: string,
  salt: Uint8Array,
): Promise<CryptoKey> => {
  try {
    return await importAesKey(await deriveBitsInWorker(passphrase, salt))
  } catch (error) {
    console.error(error)
    return importAesKey(await deriveBitsOnMain(passphrase, salt))
  }
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
