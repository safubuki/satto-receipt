import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Service Workerのキャッシュをクリア（デバッグ用）
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    // 古いService Workerを解除してキャッシュをクリア
    for (const registration of registrations) {
      registration.update()
    }
  })
  // キャッシュストレージをクリア
  if ('caches' in window) {
    caches.keys().then((names) => {
      // workbox以外の古いキャッシュを削除
      names.forEach((name) => {
        if (!name.includes('workbox-precache')) {
          caches.delete(name)
        }
      })
    })
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
