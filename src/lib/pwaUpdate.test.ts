import { afterEach, describe, expect, it, vi } from "vitest"
import { clearUpdateCompleteNotice, readUpdateCompleteNotice, updateInstalledApp } from "./pwaUpdate"

const installStorage = () => {
  const store = new Map<string, string>()
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
  })
}

describe("updateInstalledApp", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("leaves a completion notice and reloads when the update finishes", async () => {
    installStorage()
    vi.stubGlobal("navigator", {})
    const reload = vi.fn()
    vi.stubGlobal("window", { location: { reload } })

    await updateInstalledApp()

    expect(reload).toHaveBeenCalledOnce()
    expect(readUpdateCompleteNotice()).toEqual({
      title: "更新が完了しました",
      message: "アプリを更新しました。",
      updateComplete: true,
    })
  })

  it("clears the completion notice after it is dismissed", async () => {
    installStorage()
    vi.stubGlobal("navigator", {})
    vi.stubGlobal("window", { location: { reload: vi.fn() } })

    await updateInstalledApp()
    clearUpdateCompleteNotice()

    expect(readUpdateCompleteNotice()).toBeNull()
  })

  it("does not leave a completion notice when the update check fails", async () => {
    installStorage()
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistrations: () => Promise.reject(new Error("offline")),
      },
    })
    const reload = vi.fn()
    vi.stubGlobal("window", { location: { reload } })

    await expect(updateInstalledApp()).rejects.toThrow("offline")
    expect(reload).not.toHaveBeenCalled()
    expect(readUpdateCompleteNotice()).toBeNull()
  })
})
