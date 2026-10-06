const UPDATE_COMPLETE_KEY = "satto-receipt:update-complete"

export type UpdateCompleteNotice = {
  title: string
  message: string
  updateComplete: true
}

export type AppUpdateCheck = "current" | "ready"

const updateCompleteNotice = (): UpdateCompleteNotice => ({
  title: "アップデートしました",
  message: "最新版にアップデートしました。",
  updateComplete: true,
})

/** 再読み込み後に完了ダイアログを出すための印を読む。閉じるまでは消さない。 */
export const readUpdateCompleteNotice = (): UpdateCompleteNotice | null => {
  try {
    if (sessionStorage.getItem(UPDATE_COMPLETE_KEY) !== "1") return null
  } catch {
    return null
  }
  return updateCompleteNotice()
}

export const clearUpdateCompleteNotice = (): void => {
  try {
    sessionStorage.removeItem(UPDATE_COMPLETE_KEY)
  } catch {
    // 表示を消せなくても、次の操作は続ける
  }
}

const rememberUpdateComplete = (): void => {
  try {
    sessionStorage.setItem(UPDATE_COMPLETE_KEY, "1")
  } catch {
    // 完了表示を出せなくても、更新の読み込み直しは続ける
  }
}

/** フォーカス中の入力から外す。更新の読み込み直しでスマホキーボードが開くのを防ぐ。 */
export const blurActiveElement = (): void => {
  if (typeof document === "undefined") return
  const active = document.activeElement
  if (active instanceof HTMLElement) active.blur()
}

/**
 * 更新確認のあいだ、入力欄へフォーカスが戻ってキーボードが開かないようにする。
 * 戻した関数を呼ぶと解除する。
 */
export const holdTextFocus = (): (() => void) => {
  if (typeof document === "undefined") return () => {}
  const stop = (event: Event) => {
    const target = event.target
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      target.blur()
    }
  }
  document.addEventListener("focusin", stop, true)
  blurActiveElement()
  return () => document.removeEventListener("focusin", stop, true)
}

const hasIncomingWorker = (registrations: readonly ServiceWorkerRegistration[]) =>
  registrations.some((registration) => registration.waiting || registration.installing)

/** 新しいサービスワーカーがあるかだけを調べる。ここでは画面を読み込み直さない。 */
export const checkAppUpdate = async (): Promise<AppUpdateCheck> => {
  if (!("serviceWorker" in navigator)) return "current"
  const registrations = await navigator.serviceWorker.getRegistrations()
  if (registrations.length === 0) return "current"

  let activated = false
  let available = hasIncomingWorker(registrations)
  const markActivated = () => {
    activated = true
    available = true
  }
  navigator.serviceWorker.addEventListener("controllerchange", markActivated)
  try {
    await Promise.all(
      registrations.map(async (registration) => {
        await registration.update()
        if (registration.waiting || registration.installing) available = true
      }),
    )
    if (!available && !activated) return "current"
    if (!activated) {
      await new Promise<void>((resolve) => {
        const timer = globalThis.setTimeout(resolve, 1500)
        const onChange = () => {
          globalThis.clearTimeout(timer)
          navigator.serviceWorker.removeEventListener("controllerchange", onChange)
          resolve()
        }
        navigator.serviceWorker.addEventListener("controllerchange", onChange)
        if (registrations.some((registration) => registration.waiting) && registrations.every((registration) => !registration.installing)) {
          onChange()
        }
      })
    }
    return "ready"
  } finally {
    navigator.serviceWorker.removeEventListener("controllerchange", markActivated)
  }
}

/** 届いている更新を有効にして読み込み直す。 */
export const applyAppUpdate = async (): Promise<void> => {
  blurActiveElement()
  rememberUpdateComplete()
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      const waiting = registrations.filter((registration) => registration.waiting)
      if (waiting.length > 0) {
        for (const registration of waiting) {
          registration.waiting?.postMessage({ type: "SKIP_WAITING" })
        }
        await new Promise<void>((resolve) => {
          const timer = globalThis.setTimeout(resolve, 1500)
          navigator.serviceWorker.addEventListener(
            "controllerchange",
            () => {
              globalThis.clearTimeout(timer)
              resolve()
            },
            { once: true },
          )
        })
      }
    }
    blurActiveElement()
    window.location.reload()
  } catch (error) {
    clearUpdateCompleteNotice()
    throw error
  }
}
