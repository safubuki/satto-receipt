import { afterEach, describe, expect, it, vi } from "vitest"
import { applyAppUpdate, checkAppUpdate, clearUpdateCompleteNotice, readUpdateCompleteNotice } from "./pwaUpdate"

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

const stubWindow = (reload = vi.fn()) => {
  vi.stubGlobal("window", { location: { reload } })
  return reload
}

describe("app update check", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("treats a browser without a service worker as already current", async () => {
    installStorage()
    const reload = stubWindow()
    vi.stubGlobal("navigator", {})

    await expect(checkAppUpdate()).resolves.toBe("current")

    expect(reload).not.toHaveBeenCalled()
    expect(readUpdateCompleteNotice()).toBeNull()
  })

  it("stays current when the installed worker has no update", async () => {
    installStorage()
    const reload = stubWindow()
    const update = vi.fn(async () => {})
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistrations: async () => [{ waiting: null, installing: null, update }],
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    })

    await expect(checkAppUpdate()).resolves.toBe("current")

    expect(update).toHaveBeenCalledOnce()
    expect(reload).not.toHaveBeenCalled()
    expect(readUpdateCompleteNotice()).toBeNull()
  })

  it("reports a waiting worker without reloading yet", async () => {
    installStorage()
    const reload = stubWindow()
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistrations: async () => [{ waiting: { postMessage: vi.fn() }, installing: null, update: vi.fn(async () => {}) }],
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    })

    await expect(checkAppUpdate()).resolves.toBe("ready")

    expect(reload).not.toHaveBeenCalled()
    expect(readUpdateCompleteNotice()).toBeNull()
  })

  it("reports ready when a new worker takes control during the check", async () => {
    installStorage()
    const listeners = new Set<() => void>()
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistrations: async () => [{
          waiting: null,
          installing: null,
          update: vi.fn(async () => {
            listeners.forEach((listener) => listener())
          }),
        }],
        addEventListener: (_type: string, listener: () => void) => {
          listeners.add(listener)
        },
        removeEventListener: (_type: string, listener: () => void) => {
          listeners.delete(listener)
        },
      },
    })

    await expect(checkAppUpdate()).resolves.toBe("ready")
    expect(readUpdateCompleteNotice()).toBeNull()
  })

  it("does not leave a completion notice when the update check fails", async () => {
    installStorage()
    const reload = stubWindow()
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistrations: async () => [{
          waiting: null,
          installing: null,
          update: async () => {
            throw new Error("offline")
          },
        }],
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    })

    await expect(checkAppUpdate()).rejects.toThrow("offline")
    expect(reload).not.toHaveBeenCalled()
    expect(readUpdateCompleteNotice()).toBeNull()
  })

  it("reloads and stores the updated notice when the waiting worker is applied", async () => {
    vi.useFakeTimers()
    installStorage()
    const reload = stubWindow()
    const postMessage = vi.fn()
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistrations: async () => [{ waiting: { postMessage }, installing: null }],
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    })

    const pending = applyAppUpdate()
    await vi.advanceTimersByTimeAsync(1500)
    await pending

    expect(postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" })
    expect(reload).toHaveBeenCalledOnce()
    expect(readUpdateCompleteNotice()).toEqual({
      title: "アップデートしました",
      message: "最新版にアップデートしました。",
      updateComplete: true,
    })
  })

  it("clears the completion notice after it is dismissed", async () => {
    vi.useFakeTimers()
    installStorage()
    stubWindow()
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistrations: async () => [{ waiting: { postMessage: vi.fn() }, installing: null }],
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    })

    const pending = applyAppUpdate()
    await vi.advanceTimersByTimeAsync(1500)
    await pending
    clearUpdateCompleteNotice()

    expect(readUpdateCompleteNotice()).toBeNull()
  })

  it("removes the completion notice when applying the update fails", async () => {
    installStorage()
    const reload = stubWindow()
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistrations: () => Promise.reject(new Error("offline")),
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    })

    await expect(applyAppUpdate()).rejects.toThrow("offline")
    expect(reload).not.toHaveBeenCalled()
    expect(readUpdateCompleteNotice()).toBeNull()
  })
})
