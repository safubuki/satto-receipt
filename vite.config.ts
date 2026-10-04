import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  base: '/satto-receipt/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'サッとレシート',
        short_name: 'サッとレシート',
        lang: 'ja',
        start_url: '/satto-receipt/',
        display: 'standalone',
        theme_color: '#0b1224',
        background_color: '#0b1224',
        icons: [
          {
            src: 'turtle_icon_receipt.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'turtle_icon_receipt.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        skipWaiting: true,
        clientsClaim: true,
        // 古いキャッシュを自動削除
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  // ビルド時にファイル名にハッシュを付与してキャッシュバスティング
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
})
