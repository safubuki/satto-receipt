import type { ReactNode } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { clsx } from "clsx"
import { downloadCsv, toCsv } from "./lib/csv"
import { runOcr } from "./lib/ocr"
import { analyzeReceiptWithGemini, saveApiKey, clearApiKey, hasApiKey } from "./lib/geminiOcr"
import { decryptVault, deriveKey, encryptVault, getOrCreateSalt } from "./lib/crypto"
import { clearVault, loadVault, saveVault } from "./lib/db"
import type { Category, LineItem, Receipt, Vault } from "./lib/types"
import { importCsvToReceipts } from "./lib/csvImport"

import "./index.css"

type Session = {
  key: CryptoKey
  vault: Vault
}

type LineItemDraft = {
  id: string
  name: string
  category: string
  price: string
  quantity: string
}

type ReceiptDraft = {
  storeName: string
  visitedAt: string
  total: string
  note: string
  category: string
  imageData?: string
  lineItems: LineItemDraft[]
}

const defaultCategories: Category[] = [
  { id: "supermarket", name: "スーパー", color: "#3de0a2" },
  { id: "convenience", name: "コンビニ", color: "#f59e0b" },
  { id: "drugstore", name: "ドラッグストア", color: "#a78bfa" },
  { id: "restaurant", name: "飲食店", color: "#ef4444" },
  { id: "clothing", name: "衣料品店", color: "#ec4899" },
  { id: "electronics", name: "家電・雑貨", color: "#38bdf8" },
  { id: "medical", name: "医療・薬局", color: "#14b8a6" },
  { id: "entertainment", name: "娯楽", color: "#8b5cf6" },
  { id: "other", name: "その他", color: "#94a3b8" },
]

const createVault = (): Vault => ({
  receipts: [],
  categories: defaultCategories,
})

const initialDraft = (categories: Category[]): ReceiptDraft => ({
  storeName: "",
  visitedAt: new Date().toISOString().slice(0, 10),
  total: "",
  note: "",
  category: categories[0]?.name ?? "その他",
  lineItems: [],
})

const compressImage = async (file: File, maxSide = 1280, quality = 0.6): Promise<string> => {
  const bitmap = await createImageBitmap(file)
  const { width, height } = bitmap
  const scale = Math.min(1, maxSide / Math.max(width, height))
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const ctx = canvas.getContext("2d")
  if (ctx) ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL("image/jpeg", quality)
}
const parseReceiptText = (text: string): { items: LineItemDraft[]; total?: string; store?: string } => {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)

  let total: string | undefined
  const store = lines[0]

  for (const line of lines) {
    if (/合計|計|total/i.test(line) && !total) {
      const num = line.match(/([0-9]+[.,]?[0-9]*)/)
      if (num) total = num[1].replace(",", "")
    }
  }

  return { items: [], total, store }
}

const formatCurrency = (value: number) =>
  new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(value)

const StatCard = ({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: boolean
}) => (
  <div
    className={clsx(
      "rounded-2xl border border-white/10 p-4 backdrop-blur",
      accent ? "bg-white/10 shadow-soft" : "bg-white/5",
    )}
  >
    <p className="text-xs uppercase tracking-[0.15em] text-slate-400">{label}</p>
    <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
  </div>
)

const Pill = ({ children }: { children: ReactNode }) => (
  <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-slate-200">
    {children}
  </span>
)

// スマホ判定ヘルパー関数（安全に判定）
const detectMobile = (): boolean => {
  try {
    if (typeof window === 'undefined') return true // SSR時はスマホ扱い
    
    // 画面幅判定 (最も確実)
    const narrowScreen = window.innerWidth < 768
    if (narrowScreen) return true
    
    // タッチデバイス判定
    let hasTouch = false
    try {
      hasTouch = 'ontouchstart' in window || (navigator && navigator.maxTouchPoints > 0)
    } catch {
      // ignore
    }
    if (hasTouch) return true
    
    // User-Agent判定
    let mobileUA = false
    try {
      if (navigator && navigator.userAgent) {
        mobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
      }
    } catch {
      // ignore
    }
    
    return mobileUA
  } catch {
    // 何かエラーがあったらスマホ扱い（安全側）
    return true
  }
}

// スマホ判定カスタムフック
const useIsMobile = () => {
  const [isMobile, setIsMobile] = useState(detectMobile)
  
  useEffect(() => {
    // マウント後に再判定
    setIsMobile(detectMobile())
    
    const handleResize = () => setIsMobile(detectMobile())
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])
  
  return isMobile
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [ocrProgress, setOcrProgress] = useState<number | null>(null)
  const [ocrText, setOcrText] = useState("")
  const [lastUploadedName, setLastUploadedName] = useState<string | null>(null)
  const [saveImage, setSaveImage] = useState(false)
  const [draft, setDraft] = useState<ReceiptDraft>(initialDraft(defaultCategories))
  const [filters, setFilters] = useState({ query: "", category: "all" })
  const [summaryTab, setSummaryTab] = useState<"overview" | "monthly">("overview")
  const [visibleCount, setVisibleCount] = useState(20)
  const [expandedImages, setExpandedImages] = useState<Set<string>>(new Set())
  const categories = session?.vault.categories ?? defaultCategories
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [cameraActive, setCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraPaused, setCameraPaused] = useState(false)  // 撮影後の一時停止
  const [capturedImage, setCapturedImage] = useState<string | null>(null)  // 撮影した画像
  const [isProcessing, setIsProcessing] = useState(false)  // OCR処理中
  const [useGemini, setUseGemini] = useState(true)  // Gemini APIを使うか
  const [showApiKeyModal, setShowApiKeyModal] = useState(false)  // APIキー設定モーダル
  const [apiKeyInput, setApiKeyInput] = useState("")  // APIキー入力
  const isMobile = useIsMobile()

  // ビデオ要素にストリームを接続する処理
  const attachStreamToVideo = useCallback((video: HTMLVideoElement, stream: MediaStream) => {
    video.srcObject = stream
    video.muted = true
    video.playsInline = true
    
    const playVideo = async () => {
      try {
        await video.play()
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          setCameraReady(true)
          setCameraError(null)
        } else {
          // 少し待ってから再チェック
          setTimeout(() => {
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              setCameraReady(true)
              setCameraError(null)
            }
          }, 500)
        }
      } catch {
        setCameraError("映像の再生に失敗しました。")
      }
    }

    if (video.readyState >= 2) {
      playVideo()
    } else {
      video.oncanplay = () => playVideo()
    }
  }, [])

  // video要素のref callback
  const setVideoRef = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node
    if (node && streamRef.current) {
      attachStreamToVideo(node, streamRef.current)
    }
  }, [attachStreamToVideo])

  const persistVault = async (nextVault: Vault, key: CryptoKey) => {
    const encrypted = await encryptVault(nextVault, key)
    await saveVault({ id: "data", version: 1, ...encrypted })
    setSession({ key, vault: nextVault })
  }

  const handleUnlock = async (passphrase: string) => {
    setUnlockError(null)
    setUnlocking(true)

    try {
      const salt = getOrCreateSalt()
      const key = await deriveKey(passphrase, salt)
      const stored = await loadVault()

      if (!stored) {
        const vault = createVault()
        await persistVault(vault, key)
        setDraft(initialDraft(vault.categories))
        return
      }

      const vault = await decryptVault({
        ciphertext: stored.ciphertext,
        iv: stored.iv,
        key,
      })

      setSession({ key, vault })
      setDraft(initialDraft(vault.categories))
    } catch (error) {
      console.error(error)
      setUnlockError("パスフレーズが違うかデータを復号できませんでした。")
    } finally {
      setUnlocking(false)
    }
  }

  const handleLock = async () => {
    setSession(null)
    setOcrText("")
    setOcrProgress(null)
    setLastUploadedName(null)
    setDraft(initialDraft(defaultCategories))
  }

  const handleReset = async () => {
    const confirmed = window.confirm(
      '⚠️ これまで保存したすべてのデータ（レシート・設定）が完全に削除されます。\n\nこの操作は取り消しできません。\n本当に削除しますか？'
    )
    if (!confirmed) return
    
    await clearVault()
    setSession(null)
    setDraft(initialDraft(defaultCategories))
    setOcrText("")
    setUnlockError(null)
    setLastUploadedName(null)
  }

  const handleOcr = async (file: File, input?: HTMLInputElement) => {
    setOcrProgress(0)
    setLastUploadedName(file.name)
    try {
      const preview = await compressImage(file)
      
      // Gemini APIを使うか、従来のOCRを使うか
      if (useGemini && hasApiKey()) {
        // Gemini API
        const result = await analyzeReceiptWithGemini(file, setOcrProgress)
        setOcrText(result.rawText)
        
        // AIが判定したカテゴリを設定（存在する場合）
        let selectedCategory = categories[0]?.name ?? "その他"
        if (result.category) {
          const found = categories.find(c => c.name === result.category)
          if (found) {
            selectedCategory = found.name
          }
        }
        
        // 品目データをLineItemDraft形式に変換
        const lineItemDrafts: LineItemDraft[] = (result.items || []).map((item: { name: string; price: number; quantity?: number; category?: string }, idx: number) => ({
          id: `item-${idx}-${Date.now()}`,
          name: item.name,
          category: item.category || selectedCategory,
          price: String(item.price),
          quantity: String(item.quantity || 1),
        }))
        
        setDraft({
          ...initialDraft(categories),
          storeName: result.storeName || "",
          visitedAt: result.date || new Date().toISOString().slice(0, 10),
          total: result.total || "",
          category: selectedCategory,
          imageData: preview,
          lineItems: lineItemDrafts,
        })
      } else {
        // 従来のTesseract OCR
        const text = await runOcr(file, setOcrProgress)
        setOcrText(text)
        const parsed = parseReceiptText(text)
        setDraft({
          ...initialDraft(categories),
          storeName: parsed.store ?? "",
          total: parsed.total ?? "",
          imageData: preview,
        })
      }
    } catch (error) {
      console.error("OCR error:", error)
      setCameraError(error instanceof Error ? error.message : "OCR処理に失敗しました")
    } finally {
      setOcrProgress(null)
      if (input) input.value = ""
    }
  }

  const clearDraft = () => {
    setDraft(initialDraft(categories))
    setOcrText("")
    setOcrProgress(null)
    setLastUploadedName(null)
    stopCamera()
  }

  const handleSaveReceipt = async () => {
    if (!session) return
    
    // ドラフトの品目データをLineItem形式に変換
    const lineItems: LineItem[] = draft.lineItems.map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      price: Number(item.price) || 0,
      quantity: Number(item.quantity) || 1,
    }))

    const computedTotal = Number(draft.total) || 0

    const now = new Date().toISOString()

    const receipt: Receipt = {
      id: crypto.randomUUID(),
      storeName: draft.storeName || "無題のレシート",
      visitedAt: draft.visitedAt || now.slice(0, 10),
      total: computedTotal,
      category: draft.category,
      note: draft.note || undefined,
      imageData: saveImage ? draft.imageData : undefined,
      lineItems,
      createdAt: now,
      updatedAt: now,
    }

    const nextVault = {
      ...session.vault,
      receipts: [receipt, ...session.vault.receipts],
    }

    await persistVault(nextVault, session.key)
    setDraft(initialDraft(session.vault.categories))
    setOcrText("")
    setOcrProgress(null)
    setLastUploadedName(null)
  }

  const handleDeleteReceipt = async (id: string) => {
    if (!session) return
    const nextVault = {
      ...session.vault,
      receipts: session.vault.receipts.filter((r) => r.id !== id),
    }
    await persistVault(nextVault, session.key)
  }

  const handleExport = () => {
    if (!session) return
    const csv = toCsv(session.vault.receipts)
    downloadCsv(csv)
  }

  const handleImportCsv = async (file: File) => {
    const text = await file.text()
    const receipts = importCsvToReceipts(text)
    if (!session) return
    const nextVault = {
      ...session.vault,
      receipts: [...receipts, ...session.vault.receipts],
    }
    await persistVault(nextVault, session.key)
  }

  const handleCleanupImages = async () => {
    if (!session) return
    const cleaned = session.vault.receipts.map((r) => ({ ...r, imageData: undefined }))
    await persistVault({ ...session.vault, receipts: cleaned }, session.key)
    setExpandedImages(new Set())
  }

  const startCamera = async () => {
    stopCamera()
    setCameraReady(false)
    setCameraError(null)
    const constraints: MediaStreamConstraints = {
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream
      const track = stream.getVideoTracks()[0]
      if (track) {
        try {
          await track.applyConstraints({ width: 1280, height: 720 })
        } catch {
          // ignore
        }
      }
      // まずcameraActiveをtrueにしてvideo要素をレンダリングさせる
      // video要素のref callbackでストリーム接続が行われる
      setCameraActive(true)

      // タイムアウトチェック
      setTimeout(() => {
        const currentVideo = videoRef.current
        if (currentVideo && currentVideo.videoWidth === 0) {
          setCameraError("カメラ映像が取得できません。ブラウザのカメラ設定・デバイス切り替えを確認してください。")
        }
      }, 3000)
    } catch {
      setCameraError("カメラを起動できませんでした。権限・他アプリ使用中・デバイス有無を確認してください。")
    }
  }

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setCameraActive(false)
    setCameraError(null)
    setCameraReady(false)
    setCameraPaused(false)
    setCapturedImage(null)
  }

  // カメラを一時停止
  const pauseCamera = () => {
    if (videoRef.current) {
      videoRef.current.pause()
      setCameraPaused(true)
    }
  }

  // カメラを再開
  const resumeCamera = () => {
    if (videoRef.current) {
      videoRef.current.play()
      setCameraPaused(false)
      setCapturedImage(null)
    }
  }

  useEffect(() => {
    return () => {
      stopCamera()
    }
  }, [])


  const captureFromCamera = async () => {
    if (!videoRef.current) {
      setCameraError("カメラが初期化されていません。起動し直してください。")
      return
    }
    if (!cameraReady) {
      setCameraError("カメラ映像が準備できていません。数秒待つか再起動してください。")
      return
    }
    
    const video = videoRef.current
    
    // 1. カメラを一時停止（撮影した瞬間を固定）
    pauseCamera()
    setIsProcessing(true)
    
    // 2. キャンバスで撮影
    const canvas = document.createElement("canvas")
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext("2d")
    if (ctx) ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    
    // 3. 撮影画像を保存（プレビュー用）
    const previewDataUrl = canvas.toDataURL("image/jpeg", 0.8)
    setCapturedImage(previewDataUrl)
    
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.8),
    )
    if (!blob) {
      setIsProcessing(false)
      resumeCamera()
      return
    }
    
    const file = new File([blob], `capture-${Date.now()}.jpg`, { type: "image/jpeg" })
    
    // 4. OCR処理
    try {
      await handleOcr(file)
    } finally {
      setIsProcessing(false)
      // 処理完了後、3秒待ってからカメラを再開
      setTimeout(() => {
        resumeCamera()
      }, 3000)
    }
  }

  const filteredReceipts = useMemo(() => {
    if (!session) return []
    const query = filters.query.toLowerCase()
    return session.vault.receipts.filter((receipt) => {
      const matchesQuery =
        !query ||
        receipt.storeName.toLowerCase().includes(query) ||
        (receipt.note ?? "").toLowerCase().includes(query)
      const matchesCategory =
        filters.category === "all" || receipt.category === filters.category
      return matchesQuery && matchesCategory
    })
  }, [session, filters])

  const displayedReceipts = useMemo(
    () => (filteredReceipts.length > visibleCount ? filteredReceipts.slice(0, visibleCount) : filteredReceipts),
    [filteredReceipts, visibleCount],
  )

  const currentYear = new Date().getFullYear().toString()
  
  const yearlySpent = session?.vault.receipts
    .filter((r) => r.visitedAt.startsWith(currentYear))
    .reduce((sum, r) => sum + r.total, 0)

  const monthlySpent = session?.vault.receipts
    .filter((r) => r.visitedAt.startsWith(new Date().toISOString().slice(0, 7)))
    .reduce((sum, r) => sum + r.total, 0)

  const monthlyTotals = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>()
    session?.vault.receipts.forEach((r) => {
      if (!r.visitedAt) return
      const key = r.visitedAt.slice(0, 7)
      const current = map.get(key) ?? { total: 0, count: 0 }
      map.set(key, { total: current.total + r.total, count: current.count + 1 })
    })
    return Array.from(map.entries())
      .map(([month, value]) => ({ month, total: value.total, count: value.count }))
      .sort((a, b) => (a.month > b.month ? -1 : 1))
  }, [session])

  const yearlyTotals = useMemo(() => {
    const map = new Map<string, number>()
    session?.vault.receipts.forEach((r) => {
      if (!r.visitedAt) return
      const key = r.visitedAt.slice(0, 4)
      map.set(key, (map.get(key) || 0) + r.total)
    })
    return Array.from(map.entries())
      .map(([year, total]) => ({ year, total }))
      .sort((a, b) => (a.year > b.year ? -1 : 1))
  }, [session])

  const lastReceipt = session?.vault.receipts[0]

  // ========== スマホ専用UI ==========
  if (isMobile) {
    return (
      <div className="min-h-screen bg-fog text-sand text-lg">
        {/* スマホ用ヘッダー */}
        <header className="sticky top-0 z-20 border-b border-white/10 bg-fog/95 backdrop-blur-lg" style={{ padding: '24px 28px' }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="rounded-full bg-gradient-to-r from-mint/60 to-mint/30 p-[2px]" style={{ width: '72px', height: '72px' }}>
                <div className="h-full w-full rounded-full bg-fog/90 p-[1px]">
                  <img
                    src={`${import.meta.env.BASE_URL}turtle_icon_receipt.png`}
                    alt="アイコン"
                    className="h-full w-full rounded-full object-cover"
                  />
                </div>
              </div>
              <h1 className="font-bold text-white" style={{ fontSize: '40px' }}>サッとレシート</h1>
            </div>
            {session && (
              <button
                onClick={handleLock}
                className="rounded-full border border-white/20 bg-white/10 font-semibold text-white"
                style={{ fontSize: '28px', padding: '20px 28px', minHeight: '72px' }}
              >
                ログアウト
              </button>
            )}
          </div>
        </header>

        {!session ? (
          // ========== スマホ用ログイン画面 ==========
          <div className="flex min-h-[80vh] flex-col items-center justify-center px-6">
            <div className="w-full rounded-3xl border border-white/10 bg-white/5" style={{ padding: '40px' }}>
              <div className="text-center" style={{ marginBottom: '40px' }}>
                <div className="mx-auto rounded-full bg-gradient-to-r from-mint/60 to-mint/30 p-[3px]" style={{ width: '140px', height: '140px', marginBottom: '28px' }}>
                  <div className="h-full w-full rounded-full bg-fog/90 p-[2px]">
                    <img
                      src={`${import.meta.env.BASE_URL}turtle_icon_receipt.png`}
                      alt="アイコン"
                      className="h-full w-full rounded-full object-cover"
                    />
                  </div>
                </div>
                <h2 className="font-bold text-white" style={{ fontSize: '40px' }}>サッとレシート</h2>
                <p className="text-slate-400" style={{ fontSize: '26px', marginTop: '20px' }}>買い物ごとにパシャと</p>
              </div>
              <UnlockPanel onUnlock={handleUnlock} unlocking={unlocking} error={unlockError} />
              <button
                onClick={handleReset}
                className="w-full text-center text-slate-500 underline"
                style={{ fontSize: '22px', marginTop: '36px', padding: '16px' }}
              >
                データを初期化
              </button>
            </div>
          </div>
        ) : (
          // ========== スマホ用メイン画面 ==========
          <div className="pb-40">
            {/* APIキー設定モーダル */}
            {showApiKeyModal && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-5">
                <div className="w-full max-w-md rounded-2xl border border-white/10 bg-fog" style={{ padding: '32px' }}>
                  <h3 className="font-bold text-white" style={{ fontSize: '40px' }}>⚙️ API設定</h3>
                  <p className="text-slate-400" style={{ fontSize: '32px', marginTop: '18px' }}>
                    Gemini APIキーを入力してください。キーは端末内にのみ保存されます。
                  </p>
                  <p className="text-slate-500" style={{ fontSize: '28px', marginTop: '14px' }}>
                    <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-mint underline">Google AI Studio</a> から無料で取得できます
                  </p>
                  <input
                    type="password"
                    className="w-full rounded-xl border border-white/10 bg-white/5 text-white placeholder-slate-500"
                    style={{ fontSize: '36px', padding: '22px', marginTop: '22px', minHeight: '80px' }}
                    placeholder="AIza..."
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                  />
                  <div className="flex gap-3" style={{ marginTop: '26px' }}>
                    <button
                      onClick={() => {
                        if (apiKeyInput.trim()) {
                          saveApiKey(apiKeyInput.trim())
                          setApiKeyInput("")
                        }
                        setShowApiKeyModal(false)
                      }}
                      className="flex-1 rounded-xl bg-mint font-bold text-fog"
                      style={{ fontSize: '36px', padding: '22px', minHeight: '80px' }}
                    >
                      保存
                    </button>
                    <button
                      onClick={() => {
                        clearApiKey()
                        setApiKeyInput("")
                        setShowApiKeyModal(false)
                      }}
                      className="flex-1 rounded-xl border border-red-400/50 bg-red-400/10 font-bold text-red-300"
                      style={{ fontSize: '36px', padding: '22px', minHeight: '80px' }}
                    >
                      削除
                    </button>
                  </div>
                  <button
                    onClick={() => setShowApiKeyModal(false)}
                    className="w-full text-center text-slate-500"
                    style={{ fontSize: '32px', marginTop: '22px', padding: '16px' }}
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            )}

            {/* カメラプレビュー (大きく表示) */}
            {cameraActive && (
              <div className="px-4 pt-4">
                <div className="relative overflow-hidden rounded-3xl border-2 border-mint/40 bg-black shadow-xl">
                  {/* 撮影した画像のオーバーレイ */}
                  {capturedImage && cameraPaused && (
                    <div className="absolute inset-0 z-10">
                      <img
                        src={capturedImage}
                        alt="撮影画像"
                        className="h-full w-full object-cover"
                      />
                      <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                        {isProcessing ? (
                          <div className="text-center">
                            <div className="mx-auto h-16 w-16 animate-spin rounded-full border-4 border-mint border-t-transparent" />
                            <p className="mt-4 text-3xl font-bold text-white">📝 認識中...</p>
                          </div>
                        ) : (
                          <div className="text-center">
                            <p className="text-5xl">✅</p>
                            <p className="mt-2 text-3xl font-bold text-mint">認識完了!</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  <video
                    ref={setVideoRef}
                    className="aspect-[3/4] w-full object-cover"
                    autoPlay
                    playsInline
                    muted
                    style={{ backgroundColor: "#0b1224" }}
                  />
                  {!cameraReady && !capturedImage && (
                    <p className="bg-white/5 px-4 py-3 text-center text-base text-slate-400">
                      📹 カメラ準備中...
                    </p>
                  )}
                  {cameraError && (
                    <p className="bg-red-500/10 px-4 py-3 text-center text-base text-red-200">
                      ⚠️ {cameraError}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* プレビュー画像 */}
            {!cameraActive && draft.imageData && (
              <div className="px-4 pt-4">
                <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/30">
                  <img
                    src={draft.imageData}
                    alt="撮影画像"
                    className="max-h-64 w-full object-contain"
                  />
                </div>
              </div>
            )}

            {/* サマリー - 枠で囲んで2列レイアウト */}
            <div className="mt-4 px-4">
              <div className="rounded-2xl border border-white/10 bg-white/5" style={{ padding: '24px' }}>
                <h3 style={{ fontSize: '36px', marginBottom: '20px' }} className="font-semibold text-white">サマリー</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-white/10 bg-white/10" style={{ padding: '20px' }}>
                    <p style={{ fontSize: '28px' }} className="text-slate-400">今月</p>
                    <p style={{ fontSize: '40px', marginTop: '8px' }} className="font-bold text-mint truncate">{formatCurrency(monthlySpent ?? 0)}</p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/5" style={{ padding: '20px' }}>
                    <p style={{ fontSize: '28px' }} className="text-slate-400">今年</p>
                    <p style={{ fontSize: '40px', marginTop: '8px' }} className="font-bold text-white truncate">{formatCurrency(yearlySpent ?? 0)}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* 月別合計 */}
            {monthlyTotals.length > 0 && (
              <div className="mt-3 px-4">
                <div className="rounded-2xl border border-white/10 bg-white/5" style={{ padding: '28px' }}>
                  <p className="font-semibold text-white" style={{ fontSize: '36px', marginBottom: '24px' }}>月別合計</p>
                  <div className="space-y-4">
                    {monthlyTotals.slice(0, 6).map((entry) => (
                      <div key={entry.month} className="flex items-center justify-between" style={{ padding: '12px 0' }}>
                        <span className="text-slate-300" style={{ fontSize: '36px' }}>{entry.month}</span>
                        <span className="font-semibold text-mint" style={{ fontSize: '44px' }}>{formatCurrency(entry.total)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* 入力フォーム（シンプル版）*/}
            <div className="mt-4 space-y-4 px-4">
              <div className="rounded-2xl border border-white/10 bg-white/5" style={{ padding: '28px' }}>
                <h3 style={{ fontSize: '40px', marginBottom: '24px' }} className="font-semibold text-white">レシート入力</h3>
                <div className="space-y-4">
                  <input
                    className="w-full rounded-xl border border-white/10 bg-white/5 text-white placeholder-slate-500"
                    style={{ fontSize: '36px', padding: '24px', minHeight: '80px' }}
                    value={draft.storeName}
                    onChange={(e) => setDraft((prev) => ({ ...prev, storeName: e.target.value }))}
                    placeholder="店名"
                  />
                  {/* 日付 - 1列 */}
                  <input
                    type="date"
                    className="w-full rounded-xl border border-white/10 bg-white/5 text-white"
                    style={{ fontSize: '36px', padding: '24px', minHeight: '80px' }}
                    value={draft.visitedAt}
                    onChange={(e) => setDraft((prev) => ({ ...prev, visitedAt: e.target.value }))}
                  />
                  {/* 金額 - 1列 */}
                  <div className="flex items-center rounded-xl border-2 border-mint/50 bg-mint/10" style={{ padding: '20px 24px', minHeight: '80px' }}>
                    <span style={{ fontSize: '48px' }} className="font-bold text-mint/70">¥</span>
                    <input
                      inputMode="numeric"
                      className="w-full bg-transparent font-bold text-mint placeholder-mint/50 outline-none"
                      style={{ fontSize: '48px' }}
                      value={draft.total}
                      onChange={(e) => setDraft((prev) => ({ ...prev, total: e.target.value }))}
                      placeholder="0"
                    />
                  </div>
                  <select
                    className="w-full rounded-xl border border-white/10 bg-white/5 text-white"
                    style={{ fontSize: '36px', padding: '24px', minHeight: '80px' }}
                    value={draft.category}
                    onChange={(e) => setDraft((prev) => ({ ...prev, category: e.target.value }))}
                  >
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.name}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                  {/* 画像保存オプション - レシート入力内に移動 */}
                  <label className="flex items-center gap-4 text-slate-300" style={{ fontSize: '32px', marginTop: '8px' }}>
                    <input
                      type="checkbox"
                      checked={saveImage}
                      onChange={(e) => setSaveImage(e.target.checked)}
                      className="rounded"
                      style={{ width: '40px', height: '40px' }}
                    />
                    カメラ画像も保存する
                  </label>
                </div>
              </div>
            </div>

            {/* レシート一覧 */}
            <div className="mt-5 px-4">
              <div className="rounded-2xl border border-white/10 bg-white/5" style={{ padding: '24px' }}>
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-white" style={{ fontSize: '40px' }}>レシート一覧</h3>
                  <span className="text-slate-400" style={{ fontSize: '36px' }}>{session.vault.receipts.length}件</span>
                </div>
                <div className="mt-4 space-y-4">
                {session.vault.receipts.length === 0 ? (
                  <p className="rounded-2xl bg-white/5 text-center text-slate-400" style={{ fontSize: '36px', padding: '48px 24px' }}>
                    まだレシートがありません
                  </p>
                ) : (
                  displayedReceipts.map((receipt) => (
                    <div
                      key={receipt.id}
                      className="rounded-2xl border border-white/10 bg-white/5"
                      style={{ padding: '28px' }}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-slate-400" style={{ fontSize: '32px' }}>{receipt.visitedAt}</p>
                          <p className="font-semibold text-white" style={{ fontSize: '40px', marginTop: '8px' }}>{receipt.storeName}</p>
                          <span className="inline-block rounded-full bg-white/10 text-slate-300" style={{ fontSize: '28px', padding: '12px 24px', marginTop: '14px' }}>
                            {receipt.category}
                          </span>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-mint" style={{ fontSize: '48px' }}>
                            {formatCurrency(receipt.total)}
                          </p>
                          <button
                            onClick={() => handleDeleteReceipt(receipt.id)}
                            className="text-red-400"
                            style={{ fontSize: '32px', marginTop: '14px', padding: '10px 0' }}
                          >
                            削除
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
                {filteredReceipts.length > visibleCount && (
                  <button
                    onClick={() => setVisibleCount((v) => v + 20)}
                    className="w-full rounded-xl border border-white/10 bg-white/5 font-semibold text-white"
                    style={{ fontSize: '36px', padding: '28px', minHeight: '90px' }}
                  >
                    もっと見る
                  </button>
                )}
                {/* CSV操作 - レシート一覧内に移動 */}
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <button
                    onClick={handleExport}
                    className="rounded-xl border border-white/15 bg-white/10 font-semibold text-white"
                    style={{ fontSize: '32px', padding: '24px', minHeight: '80px' }}
                  >
                    CSVを保存
                  </button>
                  <label className="flex cursor-pointer items-center justify-center rounded-xl border border-white/15 bg-white/10 font-semibold text-white" style={{ fontSize: '32px', padding: '24px', minHeight: '80px' }}>
                    CSVを読込
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        handleImportCsv(file)
                        e.target.value = ""
                      }}
                    />
                  </label>
                </div>
                </div>
              </div>
            </div>

            {/* 設定セクション */}
            <div className="mt-5 px-4 pb-6">
              <div className="rounded-2xl border border-white/10 bg-white/5" style={{ padding: '24px' }}>
                <h3 className="font-semibold text-white" style={{ fontSize: '40px', marginBottom: '20px' }}>設定</h3>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-white" style={{ fontSize: '32px' }}>Gemini AI認識</p>
                    <p className="text-slate-400" style={{ fontSize: '28px', marginTop: '6px' }}>
                      {hasApiKey() ? "✅ 設定済み" : "❌ 未設定"}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setUseGemini(!useGemini)}
                      className={clsx(
                        "rounded-full font-semibold",
                        useGemini
                          ? "bg-mint text-fog"
                          : "border border-white/20 bg-white/10 text-white"
                      )}
                      style={{ fontSize: '32px', padding: '20px 32px', minHeight: '72px' }}
                    >
                      {useGemini ? "ON" : "OFF"}
                    </button>
                    <button
                      onClick={() => setShowApiKeyModal(true)}
                      className="rounded-full border border-white/20 bg-white/10 text-white"
                      style={{ fontSize: '36px', padding: '18px 24px', minHeight: '72px' }}
                    >
                      ⚙️
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* スマホ用固定フッター */}
        {session && (
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-white/10 bg-fog/95 backdrop-blur-lg safe-area-pb" style={{ padding: '20px 24px' }}>
            <div className="flex items-center gap-4">
              <button
                onClick={cameraActive ? stopCamera : startCamera}
                className={clsx(
                  "flex-1 rounded-2xl font-bold",
                  cameraActive
                    ? "border-2 border-white/30 bg-white/10 text-white"
                    : "border-2 border-mint/60 bg-mint/20 text-mint"
                )}
                style={{ minHeight: '90px', fontSize: '32px' }}
              >
                {cameraActive ? "カメラOFF" : "カメラON"}
              </button>
              <button
                onClick={captureFromCamera}
                disabled={!cameraActive || isProcessing}
                className={clsx(
                  "flex-[2] rounded-2xl border-2 font-bold shadow-lg disabled:opacity-50",
                  isProcessing
                    ? "animate-pulse border-yellow-400 bg-yellow-400/30 text-yellow-200"
                    : "border-mint bg-mint text-fog"
                )}
                style={{ minHeight: '100px', fontSize: '40px' }}
              >
                {isProcessing ? "処理中..." : "撮影"}
              </button>
              <button
                onClick={handleSaveReceipt}
                className="flex-1 rounded-2xl border-2 border-white/30 bg-white/15 font-bold text-white"
                style={{ minHeight: '90px', fontSize: '32px' }}
              >
                保存
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ========== PC用UI (従来のレイアウト) ==========
  return (
    <div className="min-h-screen text-sand">
      {/* PC用APIキー設定モーダル */}
      {showApiKeyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-fog p-6">
            <h3 className="text-xl font-bold text-white">⚙️ Gemini API設定</h3>
            <p className="mt-3 text-sm text-slate-400">
              Gemini APIキーを入力してください。キーは端末内（localStorage）にのみ保存され、サーバーには送信されません。
            </p>
            <p className="mt-2 text-xs text-slate-500">
              APIキーは <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-mint underline">Google AI Studio</a> から無料で取得できます。
            </p>
            <input
              type="password"
              className="mt-4 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-base text-white placeholder-slate-500"
              placeholder="AIza..."
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
            />
            <div className="mt-4 flex gap-3">
              <button
                onClick={() => {
                  if (apiKeyInput.trim()) {
                    saveApiKey(apiKeyInput.trim())
                    setApiKeyInput("")
                  }
                  setShowApiKeyModal(false)
                }}
                className="flex-1 rounded-xl bg-mint py-3 text-sm font-bold text-fog transition hover:bg-mint/80"
              >
                保存
              </button>
              <button
                onClick={() => {
                  clearApiKey()
                  setApiKeyInput("")
                  setShowApiKeyModal(false)
                }}
                className="flex-1 rounded-xl border border-red-400/50 bg-red-400/10 py-3 text-sm font-bold text-red-300 transition hover:bg-red-400/20"
              >
                削除
              </button>
            </div>
            <button
              onClick={() => setShowApiKeyModal(false)}
              className="mt-3 w-full text-center text-sm text-slate-500 hover:text-slate-300"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 pt-8 pb-8">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="relative h-14 w-14 shrink-0 rounded-full bg-gradient-to-r from-mint/60 to-mint/30 p-[2px] shadow-soft">
              <div className="h-full w-full rounded-full bg-fog/90 p-[1px]">
                <img
                  src={`${import.meta.env.BASE_URL}turtle_icon_receipt.png`}
                  alt="サッとレシートアイコン"
                  className="h-full w-full rounded-full object-cover"
                />
              </div>
            </div>
            <div className="leading-tight">
              <p className="text-xs font-semibold uppercase tracking-[0.3em] text-mint">
                Encrypted Offline Receipt Ledger
              </p>
              <h1 className="mt-1 text-3xl font-bold text-white">サッとレシート</h1>
              <p className="text-base text-slate-300">
                買い物ごとにパシャと、端末に残す。ネット不要のレシートノート。
              </p>
            </div>
          </div>
          {session && (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleLock}
                className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/10"
              >
                🔒 ログアウト
              </button>
            </div>
          )}
        </header>

        {!session ? (
          <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
            <div className="rounded-3xl border border-white/10 bg-white/5 p-8 shadow-soft">
              <p className="text-sm text-slate-300">
                端末に保存したデータを開くためのパスフレーズを設定・入力してください。
                サーバーには送信せず、WebCrypto + IndexedDB で暗号化されます。
              </p>
              <UnlockPanel onUnlock={handleUnlock} unlocking={unlocking} error={unlockError} />
              <div className="mt-6 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <Pill>ローカル暗号化</Pill>
                <Pill>オフライン動作</Pill>
                <Pill>GitHub Pages 配信想定</Pill>
              </div>
            </div>
            <div className="space-y-3 rounded-3xl border border-white/10 bg-white/5 p-6">
              <p className="text-sm text-slate-200">運用のヒント</p>
              <ul className="list-disc space-y-2 pl-4 text-sm text-slate-400">
                <li>パスフレーズを忘れると復元できません。安全な場所に控えてください。</li>
                <li>ブラウザを閉じてもデータは端末内に残ります（IndexedDB）。</li>
                <li>CSV エクスポートでバックアップをとれます。</li>
              </ul>
              <button
                onClick={handleReset}
                className="text-left text-xs text-slate-400 underline hover:text-slate-200"
              >
                データを初期化する
              </button>
            </div>
          </div>
        ) : (
          <main className="grid gap-6 lg:auto-rows-min lg:grid-cols-[1.6fr_1fr]">
            <section className="space-y-6 lg:col-start-1 lg:row-start-1 order-1">
              <div className="rounded-3xl border border-white/10 bg-white/5 p-6 shadow-soft space-y-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-white">撮影 / アップロード</h2>
                    <p className="text-sm text-slate-400">
                      まずここから。画像を選ぶとOCRして下の入力欄に自動反映します。
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                    {lastUploadedName && <Pill>選択中: {lastUploadedName}</Pill>}
                    <Pill>プレビュー日付: {draft.visitedAt || "未設定"}</Pill>
                  </div>
                </div>

                <div className="flex flex-col gap-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="flex flex-col gap-2 text-sm text-slate-200">
                      画像アップロード / 撮影
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="w-full cursor-pointer rounded-xl border border-dashed border-white/25 bg-white/5 px-3 py-3 text-slate-200 file:mr-3 file:cursor-pointer file:rounded-lg file:border-none file:bg-mint/20 file:px-4 file:py-2 file:font-semibold file:text-mint"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (!file) return
                          handleOcr(file, e.target)
                        }}
                      />
                      {ocrProgress !== null && (
                        <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                          <div
                            className="h-full bg-mint"
                            style={{ width: `${Math.round(ocrProgress * 100)}%` }}
                          />
                        </div>
                      )}
                    </label>
                    <div className="flex flex-col gap-2 text-sm text-slate-200">
                      <div className="flex gap-2">
                        <button
                          onClick={cameraActive ? stopCamera : startCamera}
                          className="flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/10"
                        >
                          {cameraActive ? "カメラ停止" : "カメラを起動"}
                        </button>
                        <button
                          onClick={captureFromCamera}
                          disabled={!cameraActive || isProcessing}
                          className={clsx(
                            "flex-1 rounded-xl border px-4 py-2 text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed",
                            isProcessing
                              ? "animate-pulse border-yellow-400/60 bg-yellow-400/20 text-yellow-200"
                              : "border-mint/60 bg-mint/10 text-mint hover:bg-mint/20"
                          )}
                        >
                          {isProcessing ? "認識中..." : "シャッター"}
                        </button>
                      </div>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={saveImage}
                          onChange={(e) => setSaveImage(e.target.checked)}
                        />
                        圧縮画像を保存 (長辺1280px / JPEG 0.6)
                      </label>
                      {/* Gemini AI設定 */}
                      <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span>🤖</span>
                          <span className="text-white">Gemini AI</span>
                          <span className={hasApiKey() ? "text-mint" : "text-slate-500"}>
                            {hasApiKey() ? "✅" : "❌"}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setUseGemini(!useGemini)}
                            className={clsx(
                              "rounded-full px-3 py-1 text-xs font-semibold",
                              useGemini
                                ? "bg-mint text-fog"
                                : "border border-white/20 bg-white/10 text-white"
                            )}
                          >
                            {useGemini ? "ON" : "OFF"}
                          </button>
                          <button
                            onClick={() => setShowApiKeyModal(true)}
                            className="rounded-full border border-white/20 bg-white/10 px-2 py-1 text-xs text-white hover:bg-white/20"
                          >
                            ⚙️
                          </button>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={clearDraft}
                          className="flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/10"
                        >
                          プレビューをクリア
                        </button>
                        <button
                          onClick={handleCleanupImages}
                          className="flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/10"
                        >
                          画像のみクリーンアップ
                        </button>
                      </div>
                    </div>
                  </div>

                  {cameraActive && (
                    <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/40">
                      <video
                        ref={setVideoRef}
                        className="w-full object-contain h-64"
                        autoPlay
                        playsInline
                        muted
                        controls={false}
                        style={{ backgroundColor: "#0b1224" }}
                      />
                      {!cameraReady && (
                        <p className="px-3 py-2 text-xs text-slate-400 bg-white/5 border-t border-white/10">
                          カメラ準備中...
                        </p>
                      )}
                      {cameraError && (
                        <p className="px-3 py-2 text-xs text-red-200 bg-red-500/10 border-t border-white/10">
                          {cameraError}
                        </p>
                      )}
                    </div>
                  )}
                  {!cameraActive && cameraError && (
                    <p className="text-xs text-red-200">{cameraError}</p>
                  )}
                </div>

                <div className="grid gap-3 grid-cols-3">
                  <div className="rounded-xl bg-white/5 p-3">
                    <p className="text-xs text-slate-400">店名</p>
                    <p className="text-sm font-semibold text-white">
                      {draft.storeName || "未設定"}
                    </p>
                  </div>
                  <div className="rounded-xl bg-white/5 p-3">
                    <p className="text-xs text-slate-400">日付</p>
                    <p className="text-sm font-semibold text-white">
                      {draft.visitedAt || "未設定"}
                    </p>
                  </div>
                  <div className="rounded-xl bg-white/5 p-3">
                    <p className="text-xs text-slate-400">合計</p>
                    <p className="text-sm font-semibold text-mint">
                      {draft.total ? `${draft.total} 円` : "未設定"}
                    </p>
                  </div>
                </div>

                {draft.imageData && (
                  <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/20">
                    <img
                      src={draft.imageData}
                      alt="レシート画像"
                      className="max-h-80 w-full object-contain"
                    />
                  </div>
                )}
                {ocrText && (
                  <p className="text-xs text-slate-400">OCR抽出テキスト: {ocrText.slice(0, 120)}...</p>
                )}
              </div>

              <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                <h2 className="text-xl font-semibold text-white">レシート詳細・編集</h2>
                <p className="text-sm text-slate-400">店名・日付・合計を確認し、必要に応じてメモを追加。</p>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <label className="flex flex-col gap-2 text-sm text-slate-200">
                    店名
                    <input
                      className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-white outline-none ring-mint/30 focus:ring-2"
                      value={draft.storeName}
                      onChange={(e) => setDraft((prev) => ({ ...prev, storeName: e.target.value }))}
                      placeholder="スーパーABC"
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-slate-200">
                    日付
                    <input
                      type="date"
                      className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-white outline-none ring-mint/30 focus:ring-2"
                      value={draft.visitedAt}
                      onChange={(e) => setDraft((prev) => ({ ...prev, visitedAt: e.target.value }))}
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-slate-200">
                    合計
                    <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                      <span className="text-mint font-semibold">¥</span>
                      <input
                        inputMode="numeric"
                        className="w-full bg-transparent text-white outline-none"
                        value={draft.total}
                        onChange={(e) => setDraft((prev) => ({ ...prev, total: e.target.value }))}
                        placeholder="0"
                      />
                    </div>
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-slate-200">
                    分類 (ドロップダウン)
                    <select
                      className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-white outline-none ring-mint/30 focus:ring-2"
                      value={draft.category}
                      onChange={(e) => setDraft((prev) => ({ ...prev, category: e.target.value }))}
                    >
                      {categories.map((cat) => (
                        <option key={cat.id} value={cat.name}>
                          {cat.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="mt-4">
                  <label className="flex flex-col gap-2 text-sm text-slate-200">
                    メモ (任意)
                    <textarea
                      rows={3}
                      className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-white outline-none ring-mint/30 focus:ring-2"
                      value={draft.note}
                      onChange={(e) => setDraft((prev) => ({ ...prev, note: e.target.value }))}
                      placeholder="メモやタグを追加"
                    />
                  </label>
                </div>

                <div className="mt-6 flex flex-wrap gap-3">
                  <button
                    onClick={handleSaveReceipt}
                    className="rounded-2xl bg-gradient-to-r from-mint/80 to-mint px-5 py-3 text-sm font-semibold text-fog shadow-soft transition hover:translate-y-[-1px]"
                  >
                    保存する
                  </button>
                </div>
              </div>

            </section>
            <aside className="order-2 lg:order-none lg:col-start-2 lg:row-start-1 lg:row-span-2 space-y-4 rounded-3xl border border-white/10 bg-white/5 p-6">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-white">サマリー</h2>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSummaryTab("overview")}
                    className={clsx(
                      "rounded-full px-3 py-1 text-xs font-semibold",
                      summaryTab === "overview"
                        ? "bg-mint/20 text-mint border border-mint/50"
                        : "bg-white/5 text-slate-300 border border-white/10",
                    )}
                  >
                    サマリー
                  </button>
                  <button
                    onClick={() => setSummaryTab("monthly")}
                    className={clsx(
                      "rounded-full px-3 py-1 text-xs font-semibold",
                      summaryTab === "monthly"
                        ? "bg-mint/20 text-mint border border-mint/50"
                        : "bg-white/5 text-slate-300 border border-white/10",
                    )}
                  >
                    月別一覧
                  </button>
                </div>
              </div>

              {summaryTab === "overview" ? (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <StatCard label="今月の支出" value={formatCurrency(monthlySpent ?? 0)} accent />
                    <StatCard label="今年の支出" value={formatCurrency(yearlySpent ?? 0)} />
                  </div>
                  
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                    <p className="text-xs text-slate-400">最終更新</p>
                    <p className="text-sm font-semibold text-white">{lastReceipt ? lastReceipt.visitedAt : "未登録"}</p>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300">
                    <p className="font-semibold text-white">年別 合計</p>
                    {yearlyTotals.length === 0 && <p className="text-slate-400">まだありません</p>}
                    {yearlyTotals.map((entry) => (
                      <div key={entry.year} className="flex items-center justify-between py-1">
                        <span className="text-white">{entry.year}</span>
                        <span className="text-mint font-semibold">{formatCurrency(entry.total)}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300">
                  <p className="font-semibold text-white">月別一覧</p>
                  {monthlyTotals.length === 0 && <p className="text-slate-400">まだありません</p>}
                  {monthlyTotals.map((entry) => (
                    <div key={entry.month} className="flex items-center justify-between py-1">
                      <div className="text-white">{entry.month}</div>
                      <div className="text-right">
                        <p className="text-mint font-semibold">{formatCurrency(entry.total)}</p>
                        <p className="text-xs text-slate-400">{entry.count} 件</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300">
                <p className="font-semibold text-white">CSV</p>
                <p className="text-slate-400">暗号化解除済みデータを端末内でCSV化し、そのままダウンロードします。</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <button
                    onClick={handleExport}
                    className="rounded-xl border border-white/15 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:border-white/25 hover:bg-white/15"
                  >
                    CSVを保存
                  </button>
                  <label className="flex cursor-pointer items-center justify-center rounded-xl border border-white/15 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:border-white/25 hover:bg-white/15">
                    CSVを読込
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        handleImportCsv(file)
                        e.target.value = ""
                      }}
                    />
                  </label>
                </div>
              </div>
            </aside>
            <section className="order-3 lg:order-none lg:col-start-1 lg:row-start-2 rounded-3xl border border-white/10 bg-white/5 p-6">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-xl font-semibold text-white">レシート一覧</h2>
                  <p className="text-sm text-slate-400">検索とカテゴリフィルタで絞り込みできます。</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <input
                    className="w-48 rounded-full border border-white/15 bg-white/10 px-3 py-2 text-sm text-white outline-none ring-mint/30 focus:ring-2"
                    placeholder="店名・メモで検索"
                    value={filters.query}
                    onChange={(e) => setFilters((prev) => ({ ...prev, query: e.target.value }))}
                  />
                  <select
                    className="rounded-full border border-white/15 bg-white/10 px-3 py-2 text-sm text-white outline-none ring-mint/30 focus:ring-2"
                    value={filters.category}
                    onChange={(e) => setFilters((prev) => ({ ...prev, category: e.target.value }))}
                  >
                    <option value="all">すべて</option>
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.name}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                  {filteredReceipts.length > visibleCount && (
                    <button
                      onClick={() => setVisibleCount((v) => v + 20)}
                      className="rounded-full border border-white/15 bg-white/10 px-3 py-2 text-sm font-semibold text-white hover:border-white/25 hover:bg-white/15"
                    >
                      もっと見る
                    </button>
                  )}
                  {filteredReceipts.length > 0 && visibleCount > 20 && (
                    <button
                      onClick={() => setVisibleCount(20)}
                      className="rounded-full border border-white/15 bg-white/10 px-3 py-2 text-sm font-semibold text-white hover:border-white/25 hover:bg-white/15"
                    >
                      先頭に戻す
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-4 space-y-4">
                {filteredReceipts.length === 0 && (
                  <p className="text-sm text-slate-400">まだレシートがありません。アップロードして保存してください。</p>
                )}
                {displayedReceipts.map((receipt) => (
                  <article
                    key={receipt.id}
                    className="rounded-2xl border border-white/10 bg-white/5 p-4"
                  >
                    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                      <div>
                        <p className="text-sm uppercase tracking-[0.15em] text-slate-400">
                          {receipt.visitedAt}
                        </p>
                        <h3 className="text-xl font-semibold text-white">
                          {receipt.storeName}
                        </h3>
                        {receipt.category && (
                          <span className="mt-1 inline-block rounded-full border border-white/15 bg-white/5 px-2 py-1 text-xs text-slate-200">
                            {receipt.category}
                          </span>
                        )}
                        <p className="text-slate-400">{receipt.note ?? "メモなし"}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <p className="text-2xl font-bold text-mint">
                            {formatCurrency(receipt.total)}
                          </p>
                          {receipt.category && (
                            <p className="text-xs text-slate-400">{receipt.category}</p>
                          )}
                        </div>
                        <button
                          onClick={() => handleDeleteReceipt(receipt.id)}
                          className="rounded-full border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-100 transition hover:bg-red-500/20"
                        >
                          削除
                        </button>
                      </div>
                    </div>
                    {receipt.imageData && (
                      <div className="mt-3 overflow-hidden rounded-xl border border-white/10 bg-black/30">
                        <div className="flex items-center justify-between px-3 py-2">
                          <p className="text-sm text-slate-200">画像</p>
                          <button
                            onClick={() =>
                              setExpandedImages((prev) => {
                                const next = new Set(prev)
                                if (next.has(receipt.id)) next.delete(receipt.id)
                                else next.add(receipt.id)
                                return next
                              })
                            }
                            className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold text-white hover:border-white/25 hover:bg-white/10"
                          >
                            {expandedImages.has(receipt.id) ? "閉じる" : "表示"}
                          </button>
                        </div>
                        {expandedImages.has(receipt.id) && (
                          <img
                            src={receipt.imageData}
                            alt="レシート画像"
                            className="max-h-64 w-full object-contain"
                          />
                        )}
                      </div>
                    )}
                    {receipt.lineItems.length > 0 && (
                      <div className="mt-3 grid gap-2 md:grid-cols-2">
                        {receipt.lineItems.map((line) => (
                          <div
                            key={line.id}
                            className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2"
                          >
                            <div>
                              <p className="text-sm text-white">{line.name}</p>
                              <p className="text-xs text-slate-400">
                                {line.category} / x{line.quantity}
                              </p>
                            </div>
                            <p className="text-sm font-semibold text-mint">
                              {formatCurrency(line.price * line.quantity)}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </section>
          </main>
        )}
      </div>
    </div>
  )
}

const UnlockPanel = ({
  onUnlock,
  unlocking,
  error,
}: {
  onUnlock: (passphrase: string) => void
  unlocking: boolean
  error: string | null
}) => {
  const [value, setValue] = useState("")
  // スマホ判定 (安全なヘルパー関数を使用)
  const [isMobile, setIsMobile] = useState(detectMobile)
  useEffect(() => {
    setIsMobile(detectMobile())
    const handleResize = () => setIsMobile(detectMobile())
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  if (isMobile) {
    // スマホ用UI
    return (
      <div className="flex flex-col gap-6">
        <label className="text-slate-200" style={{ fontSize: '24px' }}>
          🔑 パスフレーズ
          <input
            type="password"
            className="w-full rounded-xl border border-white/10 bg-white/5 text-white outline-none ring-mint/30 focus:ring-2"
            style={{ fontSize: '26px', padding: '24px', marginTop: '16px', minHeight: '76px' }}
            placeholder="パスフレーズを入力"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        {error && <p className="text-red-300" style={{ fontSize: '22px' }}>{error}</p>}
        <button
          onClick={() => onUnlock(value)}
          disabled={unlocking || value.length < 4}
          className="w-full rounded-xl bg-gradient-to-r from-mint/70 to-mint font-bold text-fog shadow-soft transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
          style={{ fontSize: '28px', padding: '26px', minHeight: '84px' }}
        >
          {unlocking ? "🔓 復号中..." : "🔐 データを開く"}
        </button>
      </div>
    )
  }

  // PC用UI
  return (
    <div className="mt-6 flex flex-col gap-3">
      <label className="text-sm text-slate-200">
        パスフレーズ
        <input
          type="password"
          className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-white outline-none ring-mint/30 focus:ring-2"
          placeholder="8文字以上で設定してください"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      {error && <p className="text-sm text-red-300">{error}</p>}
      <button
        onClick={() => onUnlock(value)}
        disabled={unlocking || value.length < 4}
        className="rounded-2xl bg-gradient-to-r from-mint/70 to-mint px-4 py-3 text-sm font-semibold text-fog shadow-soft transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {unlocking ? "復号しています..." : "データを開く / 新規作成"}
      </button>
    </div>
  )
}

export default App

