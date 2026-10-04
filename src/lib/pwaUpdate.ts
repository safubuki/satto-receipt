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
  window.location.reload()
}
