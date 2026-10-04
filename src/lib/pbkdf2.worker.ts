import { PBKDF2_ITERATIONS } from "./kdf"

const encoder = new TextEncoder()

self.addEventListener("message", (event: MessageEvent<{ passphrase: string; salt: ArrayBuffer }>) => {
  const { passphrase, salt } = event.data
  void (async () => {
    try {
      const material = await crypto.subtle.importKey(
        "raw",
        encoder.encode(passphrase),
        "PBKDF2",
        false,
        ["deriveBits"],
      )
      const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: new Uint8Array(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
        material,
        256,
      )
      self.postMessage({ bits })
    } catch (error) {
      self.postMessage({ error: error instanceof Error ? error.message : "key derivation failed" })
    }
  })()
})
