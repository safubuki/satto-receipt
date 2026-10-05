const UPDATE_COMPLETE_KEY = "satto-receipt:update-complete"

export type UpdateCompleteNotice = {
  title: string
  message: string
  updateComplete: true
}

const updateCompleteNotice = (): UpdateCompleteNotice => ({
  title: "更新が完了しました",
  message: "アプリを更新しました。",
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

/** サービスワーカーの更新を確認し、画面を読み込み直す。 */
export const updateInstalledApp = async (): Promise<void> => {
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations()
    const hasIncoming = registrations.some((registration) => registration.waiting || registration.installing)
    await Promise.all(
      registrations.map(async (registration) => {
        try {
          await registration.update()
        } catch {
          // オフラインでも、このあと読み込み直す
        }
        registration.waiting?.postMessage({ type: "SKIP_WAITING" })
      }),
    )
    const waitingNow = registrations.some((registration) => registration.waiting || registration.installing) || hasIncoming
    if (waitingNow) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 1500)
        navigator.serviceWorker.addEventListener(
          "controllerchange",
          () => {
            window.clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      })
    }
  }
  rememberUpdateComplete()
  window.location.reload()
}
