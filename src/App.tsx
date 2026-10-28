import type { ReactNode } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { downloadCsv, toCsv } from "./lib/csv"
import { runOcr } from "./lib/ocr"
import { analyzeReceiptWithGemini, saveApiKey, clearApiKey, hasApiKey, getGeminiModel, saveGeminiModel, classifyItemNames, type GeminiModelId } from "./lib/geminiOcr"
import { decryptVault, deriveKey, encryptVault, readSalt, storeSalt, bytesToBase64, base64ToBytes, clearSalt, savePassphrase, getSavedPassphrase, clearSavedPassphrase } from "./lib/crypto"
import { formatLocalDate, formatLocalMonth, shiftMonth } from "./lib/date"
import { clearVault, loadVault, saveVault } from "./lib/db"
import type { Category, LineItem, Receipt, Vault } from "./lib/types"
import { importCsvToReceipts } from "./lib/csvImport"
import { countBatchDuplicates, findDuplicateReceipts } from "./lib/duplicateReceipts"
import { GOODS_TYPES, goodsShares } from "./lib/goods"
import { CategoryBreakdown } from "./components/CategoryBreakdown"
import { LineInsightsPanel } from "./components/LineInsights"
import { ReceiptFields, type ReceiptFormValue } from "./components/ReceiptFields"
import { Dialog } from "./components/Dialog"
import { buildLineInsights, buildMonthBreakdown, collectMonthItemNames, itemLabelMap, type LineInsights } from "./lib/monthBreakdown"
import { applyAppUpdate, blurActiveElement, checkAppUpdate, clearUpdateCompleteNotice, holdTextFocus, readUpdateCompleteNotice } from "./lib/pwaUpdate"

import "./index.css"

type Session = {
  key: CryptoKey
  vault: Vault
}

type ReceiptDraft = ReceiptFormValue & {
  imageData?: string
}

type CaptureMode = "single" | "batch"

/** まとめて登録で撮った1枚。読み取りは裏で進み、保存ボタンで一度に登録する。 */
type BatchShot = {
  id: string
  file: File
  thumb: string
  status: "reading" | "done" | "error"
  draft?: ReceiptDraft
  error?: string
}

const CAPTURE_MODE_KEY = "capture_mode"

const readCaptureMode = (): CaptureMode => {
  try {
    return localStorage.getItem(CAPTURE_MODE_KEY) === "batch" ? "batch" : "single"
  } catch {
    return "single"
  }
}

const storeCaptureMode = (mode: CaptureMode) => {
  try {
    localStorage.setItem(CAPTURE_MODE_KEY, mode)
  } catch {
    // 保存できなくても、この画面の選択は state で保持する
  }
}

type AppNotice = {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  updateComplete?: boolean
  imageData?: string
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

const goodsColors: ReadonlyMap<string, string> = new Map(GOODS_TYPES.map((type) => [type.name, type.color]))

const createVault = (): Vault => ({
  receipts: [],
  categories: defaultCategories,
})

const initialDraft = (): ReceiptDraft => ({
  storeName: "",
  visitedAt: formatLocalDate(),
  total: "",
  note: "",
  category: "",
  lineItems: [],
  isNomikai: false,
  isJibara: false,
})

const hasUnsavedDraft = (draft: ReceiptDraft) =>
  draft.storeName.trim() !== "" ||
  Number(String(draft.total).replace(/,/g, "")) > 0 ||
  draft.lineItems.length > 0 ||
  draft.note.trim() !== "" ||
  draft.category.trim() !== "" ||
  Boolean(draft.isNomikai) ||
  Boolean(draft.isJibara)

const normalizeVault = (vault: Vault): Vault => ({
  ...vault,
  receipts: (vault.receipts ?? []).map((receipt) => ({
    ...receipt,
    total: Number(receipt.total) || 0,
    lineItems: receipt.lineItems ?? [],
  })),
})

const isValidDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)

const compressImage = async (file: File, maxSide = 1280, quality = 0.6): Promise<string> => {
  const bitmap = await createImageBitmap(file)
  try {
    const { width, height } = bitmap
    const scale = Math.min(1, maxSide / Math.max(width, height))
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const ctx = canvas.getContext("2d")
    if (ctx) ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL("image/jpeg", quality)
  } finally {
    bitmap.close()
  }
}
const parseReceiptText = (text: string): { total?: string; store?: string } => {
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

  return { total, store }
}

const formatCurrency = (value: number) =>
  new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(value)

const Pill = ({ children }: { children: ReactNode }) => (
  <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-slate-200">
    {children}
  </span>
)

const MOBILE_QUERY = "(max-width: 767px)"

const useIsMobile = () => {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches)
  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY)
    const onChange = () => setMobile(media.matches)
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [])
  return mobile
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 20 20" aria-hidden="true" className={`h-5 w-5 shrink-0 text-slate-300 transition-transform ${open ? "rotate-180" : ""}`}>
    <path d="M5 7.5 10 12.5 15 7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const MobileDisclosure = ({
  title,
  heading = "h2",
  mobile,
  open,
  onToggle,
  trailing,
  headerClassName = "",
  children,
}: {
  title: string
  heading?: "h2" | "h3"
  mobile: boolean
  open: boolean
  onToggle: () => void
  trailing?: ReactNode
  headerClassName?: string
  children: ReactNode
}) => {
  const Heading = heading
  const expanded = !mobile || open
  return (
    <>
      {mobile ? (
        <div className={`flex items-center gap-2 ${headerClassName}`}>
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="flex min-w-0 flex-1 items-center justify-between gap-3 py-1 text-left"
          >
            <span className="min-w-0 text-base font-semibold leading-snug text-white">{title}</span>
            <Chevron open={open} />
          </button>
          {expanded && trailing}
        </div>
      ) : (
        <div className={`flex items-start justify-between gap-2 ${headerClassName}`}>
          <Heading className="text-base font-semibold text-white">{title}</Heading>
          {trailing}
        </div>
      )}
      {expanded && children}
    </>
  )
}

const disclosureCardClass = (collapsed: boolean, expandedClass: string) =>
  `rounded-3xl border border-white/10 bg-white/5 ${collapsed ? "px-4 py-2" : expandedClass}`

const toLineItems = (items: ReceiptDraft["lineItems"]): LineItem[] =>
  items
    .filter((item) => item.name.trim() || Number(item.price))
    .map((item) => ({
      id: item.id || crypto.randomUUID(),
      name: item.name.trim() || "品目",
      category: item.category,
      price: Number(item.price) || 0,
      quantity: Number(item.quantity) || 1,
    }))

const draftTotal = (draft: ReceiptDraft) => Number(String(draft.total).replace(/,/g, "")) || 0

const draftToReceipt = (draft: ReceiptDraft, keepImage: boolean, now: string): Receipt => ({
  id: crypto.randomUUID(),
  storeName: draft.storeName || "無題のレシート",
  visitedAt: draft.visitedAt || formatLocalDate(),
  total: draftTotal(draft),
  category: draft.category,
  note: draft.note || undefined,
  imageData: keepImage ? draft.imageData : undefined,
  lineItems: toLineItems(draft.lineItems),
  isNomikai: draft.isNomikai || false,
  isJibara: draft.isJibara || false,
  createdAt: now,
  updatedAt: now,
})

const formatMonthLabel = (month: string) => {
  const [year, monthNumber] = month.split("-")
  return `${year}年${Number(monthNumber)}月`
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [isFirstTime, setIsFirstTime] = useState(true)
  const [ocrProgress, setOcrProgress] = useState<number | null>(null)
  const [ocrText, setOcrText] = useState("")
  const [lastUploadedName, setLastUploadedName] = useState<string | null>(null)
  const [saveImage, setSaveImage] = useState(false)
  const [draft, setDraft] = useState<ReceiptDraft>(initialDraft())
  const [filters, setFilters] = useState({ query: "", category: "all" })
  const [summaryTab, setSummaryTab] = useState<"overview" | "monthly">("overview")
  // 選択中の年月（YYYY-MM形式）
  const [selectedMonth, setSelectedMonth] = useState(() => formatLocalMonth())
  const [visibleCount, setVisibleCount] = useState(20)
  const [expandedImages, setExpandedImages] = useState<Set<string>>(new Set())
  const [openReceiptIds, setOpenReceiptIds] = useState<Set<string>>(new Set())
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<ReceiptDraft | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showCategoryBreakdown, setShowCategoryBreakdown] = useState(false)
  const [showLineInsights, setShowLineInsights] = useState(false)
  const [lineInsightLoading, setLineInsightLoading] = useState(false)
  const [lineInsightError, setLineInsightError] = useState<string | null>(null)
  const [lineInsightNote, setLineInsightNote] = useState<string | null>(null)
  const [groupedInsights, setGroupedInsights] = useState<{ key: string; insights: LineInsights } | null>(null)
  const categories = useMemo(() => {
    const stored = session?.vault.categories ?? []
    const extras = stored.filter(
      (category) => !defaultCategories.some((base) => base.id === category.id || base.name === category.name),
    )
    return [...defaultCategories, ...extras]
  }, [session])
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const cameraSession = useRef(0)
  const captureLock = useRef(false)
  const autoLoginStarted = useRef(false)
  const [cameraActive, setCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraPaused, setCameraPaused] = useState(false)
  const [capturedImage, setCapturedImage] = useState<string | null>(null)
  const [holdingCapture, setHoldingCapture] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [savingReceipt, setSavingReceipt] = useState(false)
  const receiptSaveInFlight = useRef(false)
  const [useGemini, setUseGemini] = useState(true)
  const [geminiModel, setGeminiModel] = useState<GeminiModelId>(() => getGeminiModel())
  const [showApiKeyModal, setShowApiKeyModal] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState("")
  const [apiKeyError, setApiKeyError] = useState<string | null>(null)
  const [pwaUpdating, setPwaUpdating] = useState(false)
  const [notice, setNotice] = useState<AppNotice | null>(readUpdateCompleteNotice)
  const isMobile = useIsMobile()
  const [expenseOpen, setExpenseOpen] = useState(false)
  const [expenseFromAi, setExpenseFromAi] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [captureMode, setCaptureMode] = useState<CaptureMode>(readCaptureMode)
  const [batch, setBatch] = useState<BatchShot[]>([])
  const batchRef = useRef<BatchShot[]>([])
  const batchJobs = useRef(new Map<string, Promise<void>>())
  const [shotFlash, setShotFlash] = useState(0)
  // まとめて保存した直後のレシート。一覧で手元のレシートと見比べる目印にする。
  const [savedBatch, setSavedBatch] = useState<Set<string> | null>(null)
  const expenseSectionRef = useRef<HTMLDivElement | null>(null)
  const listSectionRef = useRef<HTMLElement | null>(null)
  const sessionRef = useRef<Session | null>(null)

  useEffect(() => {
    sessionRef.current = session
  }, [session])
  const noticeResolver = useRef<((value: boolean) => void) | null>(null)

  useEffect(() => {
    const checkFirstTime = async () => {
      const stored = await loadVault()
      setIsFirstTime(!stored)
    }
    checkFirstTime()
  }, [])

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
    const salt = readSalt()
    await saveVault({
      id: "data",
      version: 1,
      ...encrypted,
      ...(salt ? { salt: bytesToBase64(salt) } : {}),
    })
    setSession({ key, vault: normalizeVault(nextVault) })
  }

  const handleUnlock = async (passphrase: string, rememberMe: boolean = false) => {
    setUnlockError(null)
    setUnlocking(true)

    try {
      const stored = await loadVault()
      let saltFromRecord: Uint8Array | null = null
      if (stored?.salt) {
        try {
          const bytes = base64ToBytes(stored.salt)
          saltFromRecord = bytes.length > 0 ? bytes : null
        } catch {
          saltFromRecord = null
        }
      }
      const localSalt = readSalt()
      const salts: Uint8Array[] = []
      for (const candidate of [saltFromRecord, localSalt]) {
        if (!candidate) continue
        const encoded = bytesToBase64(candidate)
        if (salts.some((existing) => bytesToBase64(existing) === encoded)) continue
        salts.push(candidate)
      }

      if (!stored) {
        const salt = salts[0] ?? crypto.getRandomValues(new Uint8Array(16))
        storeSalt(salt)
        const key = await deriveKey(passphrase, salt)
        await persistVault(createVault(), key)
        setDraft(initialDraft())
        if (rememberMe) savePassphrase(passphrase)
        return
      }

      if (!salts.length) {
        setUnlockError("暗号化に必要なソルトが見つかりません。パスフレーズだけでは復元できません。CSVバックアップがあれば、初期化のあと読み込んでください。")
        return
      }

      let opened = false
      for (const salt of salts) {
        try {
          const key = await deriveKey(passphrase, salt)
          const vault = normalizeVault(await decryptVault({
            ciphertext: stored.ciphertext,
            iv: stored.iv,
            key,
          }))
          storeSalt(salt)
          setSession({ key, vault })
          setDraft(initialDraft())
          const encoded = bytesToBase64(salt)
          if (stored.salt !== encoded) {
            try {
              await saveVault({ ...stored, salt: encoded })
            } catch (error) {
              console.error(error)
            }
          }
          if (rememberMe) savePassphrase(passphrase)
          opened = true
          break
        } catch (error) {
          console.error(error)
        }
      }

      if (!opened) {
        setUnlockError("パスフレーズが違うかデータを復号できませんでした。")
        clearSavedPassphrase()
      }
    } catch (error) {
      console.error(error)
      setUnlockError("パスフレーズが違うかデータを復号できませんでした。")
      clearSavedPassphrase()
    } finally {
      setUnlocking(false)
    }
  }

  // 自動ログイン処理
  useEffect(() => {
    if (autoLoginStarted.current) return
    autoLoginStarted.current = true
    const savedPassphrase = getSavedPassphrase()
    if (savedPassphrase) {
      void handleUnlock(savedPassphrase, false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleLock = async () => {
    stopCamera()
    // ログアウト時にisFirstTimeを再チェック
    const stored = await loadVault()
    setIsFirstTime(!stored)
    setSession(null)
    setOcrText("")
    setOcrProgress(null)
    setLastUploadedName(null)
    setDraft(initialDraft())
    setExpenseOpen(false)
    setExpenseFromAi(false)
    setMenuOpen(false)
    batchJobs.current.clear()
    batchRef.current = []
    setBatch([])
    setSavedBatch(null)
    // 注意: ログアウトでは記憶を消さない（明示的にログアウトしても次回は自動ログインできる）
    // 記憶を消すのはデータ初期化時のみ
  }

  const closeNotice = (value: boolean) => {
    if (notice?.updateComplete) clearUpdateCompleteNotice()
    const resolve = noticeResolver.current
    noticeResolver.current = null
    setNotice(null)
    resolve?.(value)
  }

  const askConfirm = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; imageData?: string }) =>
    new Promise<boolean>((resolve) => {
      if (noticeResolver.current) noticeResolver.current(false)
      noticeResolver.current = resolve
      setNotice({
        title: options?.title ?? "確認",
        message,
        confirmLabel: options?.confirmLabel ?? "続ける",
        cancelLabel: options?.cancelLabel,
        danger: options?.danger,
        imageData: options?.imageData,
      })
    })

  const showNotice = (message: string, title = "お知らせ") =>
    new Promise<void>((resolve) => {
      if (noticeResolver.current) noticeResolver.current(false)
      noticeResolver.current = () => resolve()
      setNotice({ title, message })
    })

  const handleAppUpdate = async () => {
    const releaseFocus = holdTextFocus()
    setPwaUpdating(true)
    try {
      const status = await checkAppUpdate()
      if (status === "current") {
        setPwaUpdating(false)
        await showNotice("いまの版が最新です。このまま使えます。", "アプリ更新")
        return
      }
      if (session && (hasUnsavedDraft(draft) || batchRef.current.length > 0)) {
        setPwaUpdating(false)
        const confirmed = await askConfirm("未保存の入力は消えます。アプリを更新して読み込み直しますか？", {
          title: "アプリを更新",
          confirmLabel: "更新する",
        })
        if (!confirmed) return
        setPwaUpdating(true)
      }
      await applyAppUpdate()
    } catch {
      setPwaUpdating(false)
      await showNotice("通信できる場所で、もう一度押してみてください。", "更新を確認できませんでした")
    } finally {
      releaseFocus()
      blurActiveElement()
      window.setTimeout(blurActiveElement, 0)
      window.setTimeout(blurActiveElement, 300)
    }
  }

  const closeApiKeyModal = () => {
    setApiKeyInput("")
    setApiKeyError(null)
    setShowApiKeyModal(false)
  }

  const closeEdit = () => {
    setEditDraft(null)
    setEditingId(null)
  }

  const handleReset = async () => {
    const confirmed = await askConfirm("保存したレシートと設定が削除されます。この操作は取り消せません。", {
      title: "データを初期化",
      confirmLabel: "削除する",
      danger: true,
    })
    if (!confirmed) return
    
    await clearVault()
    clearSalt()
    clearSavedPassphrase() // パスフレーズ記憶も削除
    setIsFirstTime(true)
    setSession(null)
    setDraft(initialDraft())
    setOcrText("")
    setUnlockError(null)
    setLastUploadedName(null)
  }

  // 画像1枚を読み取って入力欄の形にする。1件ずつでも、まとめてでも同じ処理を使う。
  const readReceipt = async (file: File, onProgress?: (progress: number) => void): Promise<{ draft: ReceiptDraft; text: string }> => {
    const preview = await compressImage(file)

    // Gemini APIを使うか、従来のOCRを使うか
    if (useGemini && hasApiKey()) {
      const result = await analyzeReceiptWithGemini(file, onProgress)

      // AIが判定したカテゴリを設定（存在する場合）
      let selectedCategory = categories[0]?.name ?? "その他"
      if (result.category) {
        const found = categories.find(c => c.name === result.category)
        if (found) {
          selectedCategory = found.name
        }
      }

      const stamp = Date.now()
      const lineItemDrafts: ReceiptDraft["lineItems"] = (result.items || []).map((item: { name: string; price: number; quantity?: number; category?: string }, idx: number) => ({
        id: `item-${idx}-${stamp}`,
        name: item.name,
        category: item.category || selectedCategory,
        price: String(item.price),
        quantity: String(item.quantity || 1),
      }))

      return {
        text: result.rawText,
        draft: {
          ...initialDraft(),
          storeName: result.storeName || "",
          visitedAt: result.date && isValidDate(result.date) ? result.date : formatLocalDate(),
          total: result.total || "",
          category: selectedCategory,
          note: result.highlight || "",
          isNomikai: result.isNomikai,
          imageData: preview,
          lineItems: lineItemDrafts,
        },
      }
    }

    // 従来のTesseract OCR
    const text = await runOcr(file, onProgress)
    const parsed = parseReceiptText(text)
    return {
      text,
      draft: {
        ...initialDraft(),
        storeName: parsed.store ?? "",
        total: parsed.total ?? "",
        imageData: preview,
      },
    }
  }

  const handleOcr = async (file: File, input?: HTMLInputElement, alreadyConfirmed = false) => {
    if (!alreadyConfirmed && hasUnsavedDraft(draft)) {
      const confirmed = await askConfirm("未保存の入力があります。上書きしますか？", {
        title: "入力の上書き",
        confirmLabel: "上書きする",
      })
      if (!confirmed) {
        if (input) input.value = ""
        return false
      }
    }

    setCameraError(null)
    setOcrProgress(0)
    setLastUploadedName(file.name)
    try {
      const result = await readReceipt(file, setOcrProgress)
      setOcrText(result.text)
      setDraft(result.draft)
      setExpenseFromAi(true)
      setExpenseOpen(true)
      window.setTimeout(() => {
        if (!window.matchMedia(MOBILE_QUERY).matches) return
        expenseSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
      }, 80)
      return true
    } catch (error) {
      console.error("OCR error:", error)
      setCameraError(error instanceof Error ? error.message : "OCR処理に失敗しました")
      return false
    } finally {
      setOcrProgress(null)
      if (input) input.value = ""
    }
  }

  const clearDraft = () => {
    setDraft(initialDraft())
    setOcrText("")
    setOcrProgress(null)
    setLastUploadedName(null)
    setExpenseFromAi(false)
    setExpenseOpen(false)
    stopCamera()
  }

  const handleSaveReceipt = async () => {
    if (!session || !canSaveReceipt || receiptSaveInFlight.current) return
    receiptSaveInFlight.current = true
    setSavingReceipt(true)

    try {
      const receipt = draftToReceipt(draft, saveImage, new Date().toISOString())

      const duplicates = findDuplicateReceipts(session.vault.receipts, {
        storeName: draft.storeName,
        visitedAt: receipt.visitedAt,
        total: receipt.total,
      })
      if (duplicates.length) {
        const summaries = duplicates.slice(0, 3).map((saved) =>
          `${saved.visitedAt} / ${formatCurrency(saved.total)}\n${saved.storeName}`,
        ).join("\n\n")
        const more = duplicates.length > 3 ? `\n\nほか${duplicates.length - 3}件` : ""
        const confirmed = await askConfirm(
          `同じ店名・日付・合計金額のレシートが${duplicates.length}件あります。\n\n登録済みのレシート\n${summaries}${more}\n\n別の買い物であれば、そのまま保存できます。`,
          { title: "同じレシートではありませんか？", confirmLabel: "それでも保存", cancelLabel: "保存しない" },
        )
        if (!confirmed) return
      }

      const nextVault = {
        ...session.vault,
        receipts: [receipt, ...session.vault.receipts],
      }

      await persistVault(nextVault, session.key)
      setDraft(initialDraft())
      setOcrText("")
      setOcrProgress(null)
      setLastUploadedName(null)
      setExpenseFromAi(false)
      setExpenseOpen(false)
      stopCamera()
    } finally {
      receiptSaveInFlight.current = false
      setSavingReceipt(false)
    }
  }

  const updateBatch = (update: (shots: BatchShot[]) => BatchShot[]) => {
    batchRef.current = update(batchRef.current)
    setBatch(batchRef.current)
  }

  const readBatchShot = (id: string, file: File) => {
    const job = readReceipt(file)
      .then((result) => {
        updateBatch((shots) => shots.map((shot) => (shot.id === id ? { ...shot, status: "done", draft: result.draft, error: undefined } : shot)))
      })
      .catch((error: unknown) => {
        console.error("OCR error:", error)
        const message = error instanceof Error ? error.message : "読み取れませんでした。"
        updateBatch((shots) => shots.map((shot) => (shot.id === id ? { ...shot, status: "error", error: message } : shot)))
      })
      .finally(() => {
        if (batchJobs.current.get(id) === job) batchJobs.current.delete(id)
      })
    batchJobs.current.set(id, job)
  }

  const addBatchShot = async (file: File) => {
    const id = crypto.randomUUID()
    // 縮小できない画像でも束には入れ、読み取りの結果で失敗を見せる。
    const thumb = await compressImage(file, 240, 0.7).catch(() => "")
    // 撮りながら確かめられるよう、新しいものをカメラに近い先頭へ置く。
    updateBatch((shots) => [{ id, file, thumb, status: "reading" }, ...shots])
    readBatchShot(id, file)
  }

  const retryBatchShot = (shot: BatchShot) => {
    updateBatch((shots) => shots.map((entry) => (entry.id === shot.id ? { ...entry, status: "reading", error: undefined } : entry)))
    readBatchShot(shot.id, shot.file)
  }

  const removeBatchShot = (id: string) => {
    batchJobs.current.delete(id)
    updateBatch((shots) => shots.filter((shot) => shot.id !== id))
  }

  const discardBatch = async () => {
    if (!batchRef.current.length) return
    const confirmed = await askConfirm(`撮影した${batchRef.current.length}件を保存せずに破棄します。`, {
      title: "まとめて取り消す",
      confirmLabel: "破棄する",
      danger: true,
    })
    if (!confirmed) return
    batchJobs.current.clear()
    updateBatch(() => [])
  }

  const handleSaveBatch = async () => {
    if (!session || receiptSaveInFlight.current || !batchRef.current.length) return
    receiptSaveInFlight.current = true
    setSavingReceipt(true)

    try {
      // 最後に撮った分の読み取りが終わるまで待ってから保存する。
      await Promise.allSettled(Array.from(batchJobs.current.values()))
      // 待っている間に一覧で編集・削除されていても、それを上書きしないよう最新の内容に足す。
      const current = sessionRef.current ?? session
      const shots = batchRef.current
      const ready = shots.filter((shot): shot is BatchShot & { draft: ReceiptDraft } => shot.status === "done" && Boolean(shot.draft))
      if (!ready.length) {
        await showNotice("読み取れたレシートがありません。撮り直すか、取り消してください。", "保存できません")
        return
      }

      const failed = shots.length - ready.length
      const duplicates = countBatchDuplicates(
        current.vault.receipts,
        ready.map(({ draft: shotDraft }) => ({ storeName: shotDraft.storeName, visitedAt: shotDraft.visitedAt, total: draftTotal(shotDraft) })),
      )
      const warnings = [
        failed > 0 ? `読み取れなかった${failed}件は保存しません。` : "",
        duplicates > 0 ? `${duplicates}件は、同じ店名・日付・合計のレシートがすでにあります。` : "",
      ].filter(Boolean)
      if (warnings.length) {
        const confirmed = await askConfirm(`${ready.length}件を保存します。\n\n${warnings.join("\n")}`, {
          title: "まとめて保存",
          confirmLabel: `${ready.length}件を保存`,
          cancelLabel: "戻る",
        })
        if (!confirmed) return
      }

      const now = new Date().toISOString()
      const receipts = ready.map((shot) => draftToReceipt(shot.draft, saveImage, now))
      await persistVault({
        ...current.vault,
        receipts: [...receipts, ...current.vault.receipts],
      }, current.key)

      batchJobs.current.clear()
      updateBatch(() => [])
      stopCamera()
      setSavedBatch(new Set(receipts.map((receipt) => receipt.id)))
      // 一覧で金額を見比べられるよう、保存した月を開く。
      const months = new Set(receipts.map((receipt) => receipt.visitedAt.slice(0, 7)))
      const [month] = Array.from(months)
      if (months.size === 1 && month && month <= formatLocalMonth()) {
        setSelectedMonth(month)
        setVisibleCount(Math.max(20, receipts.length))
      }
      setFilters({ query: "", category: "all" })
      window.setTimeout(() => {
        listSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
      }, 80)
    } finally {
      receiptSaveInFlight.current = false
      setSavingReceipt(false)
    }
  }

  const changeCaptureMode = (mode: CaptureMode) => {
    setCaptureMode(mode)
    storeCaptureMode(mode)
    setCameraError(null)
    if (cameraPaused) resumeCamera()
  }

  const handlePickImages = (files: FileList | null, input: HTMLInputElement) => {
    const picked = Array.from(files ?? [])
    setMenuOpen(false)
    if (!picked.length) return
    if (captureMode === "batch") {
      picked.forEach((file) => void addBatchShot(file))
      input.value = ""
      return
    }
    void handleOcr(picked[0], input)
  }

  const handleDeleteReceipt = async (id: string) => {
    if (!session) return
    const nextVault = {
      ...session.vault,
      receipts: session.vault.receipts.filter((r) => r.id !== id),
    }
    await persistVault(nextVault, session.key)
  }

  const openEdit = (receipt: Receipt) => {
    setEditingId(receipt.id)
    setEditDraft({
      storeName: receipt.storeName,
      visitedAt: receipt.visitedAt,
      total: String(receipt.total),
      note: receipt.note ?? "",
      category: receipt.category ?? "",
      isNomikai: Boolean(receipt.isNomikai),
      isJibara: Boolean(receipt.isJibara),
      imageData: receipt.imageData,
      lineItems: (receipt.lineItems ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category,
        price: String(item.price),
        quantity: String(item.quantity),
      })),
    })
  }

  const saveEdit = async () => {
    if (!session || !editingId || !editDraft) return
    const current = session.vault.receipts.find((receipt) => receipt.id === editingId)
    if (!current) return
    const now = new Date().toISOString()
    const nextReceipt: Receipt = {
      ...current,
      storeName: editDraft.storeName || "無題のレシート",
      visitedAt: editDraft.visitedAt || formatLocalDate(),
      total: Number(String(editDraft.total).replace(/,/g, "")) || 0,
      category: editDraft.category || undefined,
      note: editDraft.note || undefined,
      isNomikai: Boolean(editDraft.isNomikai),
      isJibara: Boolean(editDraft.isJibara),
      lineItems: toLineItems(editDraft.lineItems),
      updatedAt: now,
    }
    await persistVault({
      ...session.vault,
      receipts: session.vault.receipts.map((receipt) => (receipt.id === editingId ? nextReceipt : receipt)),
    }, session.key)
    setEditingId(null)
    setEditDraft(null)
  }

  const handleAddCategory = async (name: string) => {
    if (!session) return
    const trimmed = name.trim()
    if (!trimmed || categories.some((category) => category.name === trimmed)) return
    await persistVault({
      ...session.vault,
      categories: [...categories, { id: crypto.randomUUID(), name: trimmed, color: "#94a3b8" }],
    }, session.key)
  }

  const handleExport = () => {
    if (!session) return
    // 日付降順（新しい順）でソートしてからエクスポート
    const sorted = [...session.vault.receipts].sort((a, b) => b.visitedAt.localeCompare(a.visitedAt))
    const csv = toCsv(sorted)
    downloadCsv(csv)
  }

  const handleImportCsv = async (file: File) => {
    if (!session) return
    try {
      const text = await file.text()
      const receipts = importCsvToReceipts(text)
      if (!receipts.length) {
        await showNotice("読み込めるレシートがありませんでした。", "読み込めませんでした")
        return
      }
      const existingIds = new Set(session.vault.receipts.map((receipt) => receipt.id))
      const fresh = receipts.filter((receipt) => !existingIds.has(receipt.id))
      if (!fresh.length) {
        await showNotice("このCSVのレシートはすでに読み込み済みです。", "読み込めませんでした")
        return
      }
      await persistVault({
        ...session.vault,
        receipts: [...fresh, ...session.vault.receipts],
      }, session.key)
      const skipped = receipts.length - fresh.length
      await showNotice(
        skipped > 0
          ? `${fresh.length}件を読み込みました。${skipped}件は重複のためスキップしました。`
          : `${fresh.length}件を読み込みました。`,
        "読み込み完了",
      )
    } catch (error) {
      console.error(error)
      await showNotice("CSVの読み込みに失敗しました。ファイル形式を確認してください。", "読み込めませんでした")
    }
  }

  const handleCleanupImages = async () => {
    if (!session) return
    const hasImage = session.vault.receipts.some((receipt) => receipt.imageData)
    if (!hasImage) {
      await showNotice("保存されている画像はありません。")
      return
    }
    const confirmed = await askConfirm("保存済みのレシート画像だけを削除します。店名や金額は残ります。", {
      title: "画像を削除",
      confirmLabel: "削除する",
      danger: true,
    })
    if (!confirmed) return
    const cleaned = session.vault.receipts.map((r) => ({ ...r, imageData: undefined }))
    await persistVault({ ...session.vault, receipts: cleaned }, session.key)
    setExpandedImages(new Set())
  }

  const startCamera = async () => {
    stopCamera()
    setCameraReady(false)
    setCameraError(null)
    const constraints: MediaStreamConstraints = {
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: false,
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream
      const track = stream.getVideoTracks()[0]
      if (track) {
        try {
          await track.applyConstraints({ width: 1280, height: 720, frameRate: { ideal: 30, max: 30 } })
        } catch {
          // ignore
        }
      }
      // まずcameraActiveをtrueにしてvideo要素をレンダリングさせる
      // video要素のref callbackでストリーム接続が行われる
      setCameraActive(true)
      // カメラ起動時にページトップへスクロール
      window.scrollTo({ top: 0, behavior: 'smooth' })

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
    cameraSession.current += 1
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setCameraActive(false)
    setCameraError(null)
    setCameraReady(false)
    setCameraPaused(false)
    setCapturedImage(null)
    setHoldingCapture(false)
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
    setHoldingCapture(false)
  }

  useEffect(() => {
    return () => {
      stopCamera()
    }
  }, [])

  useEffect(() => {
    if (!notice?.updateComplete) return
    blurActiveElement()
    const timers = [0, 50, 250, 800].map((delay) => window.setTimeout(blurActiveElement, delay))
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
    }
  }, [notice?.updateComplete, session])


  // まとめて登録: カメラは止めずに1枚を束へ足し、読み取りは裏で進める。
  const captureToBatch = async () => {
    const video = videoRef.current
    if (!video || !cameraReady) {
      setCameraError("カメラ映像が準備できていません。数秒待つか再起動してください。")
      return
    }
    captureLock.current = true
    try {
      const canvas = document.createElement("canvas")
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext("2d")
      if (!ctx || canvas.width === 0 || canvas.height === 0) {
        setCameraError("カメラ映像が取得できません。数秒待つか再起動してください。")
        return
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      setCameraError(null)
      setShotFlash((count) => count + 1)
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/jpeg", 0.8),
      )
      if (!blob) {
        setCameraError("撮影に失敗しました。もう一度撮影してください。")
        return
      }
      await addBatchShot(new File([blob], `capture-${Date.now()}.jpg`, { type: "image/jpeg" }))
    } catch (error) {
      console.error(error)
      setCameraError("撮影に失敗しました。もう一度撮影してください。")
    } finally {
      captureLock.current = false
    }
  }

  const captureFromCamera = async () => {
    if (captureLock.current) return
    if (captureMode === "batch") {
      await captureToBatch()
      return
    }
    if (cameraPaused) {
      resumeCamera()
      return
    }
    if (!videoRef.current) {
      setCameraError("カメラが初期化されていません。起動し直してください。")
      return
    }
    if (!cameraReady) {
      setCameraError("カメラ映像が準備できていません。数秒待つか再起動してください。")
      return
    }

    const video = videoRef.current
    const session = cameraSession.current
    const replaceExisting = hasUnsavedDraft(draft)
    captureLock.current = true

    try {
      // 確認ダイアログより先に、押した瞬間のフレームを仮保存する。
      pauseCamera()
      setCameraError(null)

      const canvas = document.createElement("canvas")
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext("2d")
      if (!ctx || canvas.width === 0 || canvas.height === 0) {
        setCameraError("カメラ映像が取得できません。数秒待つか再起動してください。")
        resumeCamera()
        return
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

      const previewDataUrl = canvas.toDataURL("image/jpeg", 0.8)
      setCapturedImage(previewDataUrl)
      if (replaceExisting) setHoldingCapture(true)
      else setIsProcessing(true)

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/jpeg", 0.8),
      )
      if (!blob || cameraSession.current !== session) {
        if (cameraSession.current === session) resumeCamera()
        return
      }

      const file = new File([blob], `capture-${Date.now()}.jpg`, { type: "image/jpeg" })

      if (replaceExisting) {
        const confirmed = await askConfirm("未保存の入力があります。上書きすると、この画像で読み取ります。キャンセルすると、この画像は破棄します。", {
          title: "入力の上書き",
          confirmLabel: "上書きする",
          imageData: previewDataUrl,
        })
        if (!confirmed || cameraSession.current !== session) {
          if (cameraSession.current === session) resumeCamera()
          return
        }
        setHoldingCapture(false)
        setIsProcessing(true)
      }

      const recognized = await handleOcr(file, undefined, true)
      if (!recognized && cameraSession.current === session) resumeCamera()
    } catch (error) {
      console.error(error)
      if (cameraSession.current === session) {
        setCameraError("撮影に失敗しました。もう一度撮影してください。")
        resumeCamera()
      }
    } finally {
      captureLock.current = false
      setHoldingCapture(false)
      setIsProcessing(false)
    }
  }

  const filteredReceipts = useMemo(() => {
    if (!session) return []
    const query = filters.query.toLowerCase()
    return session.vault.receipts
      .filter((receipt) => {
        // 選択された月のみ表示
        const matchesMonth = receipt.visitedAt.startsWith(selectedMonth)
        const matchesQuery =
          !query ||
          receipt.storeName.toLowerCase().includes(query) ||
          (receipt.note ?? "").toLowerCase().includes(query)
        const matchesCategory =
          filters.category === "all" || receipt.category === filters.category
        return matchesMonth && matchesQuery && matchesCategory
      })
      // 日付降順（新しい順）でソート
      .sort((a, b) => b.visitedAt.localeCompare(a.visitedAt))
  }, [session, filters, selectedMonth])

  const currentMonth = formatLocalMonth()

  // 支出がない月にも戻れるよう、暦の1か月ずつ移動する
  const goToPrevMonth = useCallback(() => {
    setSelectedMonth((month) => shiftMonth(month, -1))
    setVisibleCount(20)
  }, [])

  const goToNextMonth = useCallback(() => {
    setSelectedMonth((month) => {
      if (month >= currentMonth) return month
      const next = shiftMonth(month, 1)
      return next > currentMonth ? month : next
    })
    setVisibleCount(20)
  }, [currentMonth])

  const hasPrevMonth = selectedMonth > "2000-01"
  const hasNextMonth = selectedMonth < currentMonth

  // 選択月の合計金額
  const selectedMonthTotal = useMemo(() => {
    if (!session) return 0
    return session.vault.receipts
      .filter((r) => r.visitedAt.startsWith(selectedMonth))
      .reduce((sum, r) => sum + r.total, 0)
  }, [session, selectedMonth])

  // 選択月の飲み会合計
  const selectedMonthNomikai = useMemo(() => {
    if (!session) return 0
    return session.vault.receipts
      .filter((r) => r.visitedAt.startsWith(selectedMonth) && r.isNomikai)
      .reduce((sum, r) => sum + r.total, 0)
  }, [session, selectedMonth])

  // 選択月の自腹合計
  const selectedMonthJibara = useMemo(() => {
    if (!session) return 0
    return session.vault.receipts
      .filter((r) => r.visitedAt.startsWith(selectedMonth) && r.isJibara)
      .reduce((sum, r) => sum + r.total, 0)
  }, [session, selectedMonth])

  // ドラフトに未保存データがあるか
  const hasDraftData = useMemo(() => hasUnsavedDraft(draft), [draft])
  const canSaveReceipt = hasDraftData && !isProcessing && ocrProgress === null && !savingReceipt
  const saveReady = canSaveReceipt && !cameraError
  const saveButtonTitle = savingReceipt
    ? "保存処理中です"
    : canSaveReceipt
      ? "入力内容を保存できます"
      : isProcessing || ocrProgress !== null
        ? "読み取りが終わるまでお待ちください"
        : "保存する内容を入力してください"
  const saveButtonClass = `footer-save-btn ui-btn ui-btn-quiet disabled:opacity-40 ${saveReady ? "footer-save-ready" : ""}`
  const cancelButtonClass = "footer-cancel-lit ui-btn ui-btn-quiet"

  const displayedReceipts = useMemo(
    () => (filteredReceipts.length > visibleCount ? filteredReceipts.slice(0, visibleCount) : filteredReceipts),
    [filteredReceipts, visibleCount],
  )
  
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

  const monthBreakdown = useMemo(
    () => buildMonthBreakdown(session?.vault.receipts ?? [], selectedMonth, goodsShares),
    [session, selectedMonth],
  )

  const lineInsights = useMemo(
    () => buildLineInsights(session?.vault.receipts ?? [], selectedMonth),
    [session, selectedMonth],
  )
  const lineInsightKey = useMemo(
    () => `${selectedMonth}\n${collectMonthItemNames(session?.vault.receipts ?? [], selectedMonth).join("\n")}`,
    [session, selectedMonth],
  )

  useEffect(() => {
    setShowLineInsights(false)
    setLineInsightError(null)
    setLineInsightNote(null)
    setGroupedInsights(null)
  }, [selectedMonth])

  const handleLineInsights = async () => {
    if (showLineInsights) {
      setShowLineInsights(false)
      return
    }
    setShowLineInsights(true)
    if (!session || lineInsights.receiptsWithItems === 0) return
    if (groupedInsights?.key === lineInsightKey) return
    if (!hasApiKey()) {
      setShowLineInsights(false)
      setShowApiKeyModal(true)
      return
    }
    setLineInsightLoading(true)
    setLineInsightError(null)
    setLineInsightNote(null)
    try {
      const names = collectMonthItemNames(session.vault.receipts, selectedMonth)
      const groups = await classifyItemNames(names, geminiModel)
      setGroupedInsights({
        key: lineInsightKey,
        insights: buildLineInsights(session.vault.receipts, selectedMonth, itemLabelMap(names, groups)),
      })
    } catch (error) {
      setLineInsightError(error instanceof Error ? error.message : "品名を分類できませんでした。")
      setLineInsightNote("分類できなかったので、表記が同じ品だけをまとめています。")
    } finally {
      setLineInsightLoading(false)
    }
  }

  const iconUrl = `${import.meta.env.BASE_URL}turtle_icon_receipt.png`
  const batchMode = captureMode === "batch"
  const batchReading = batch.filter((shot) => shot.status === "reading").length
  const batchFailed = batch.filter((shot) => shot.status === "error").length
  const batchTotal = batch.reduce((sum, shot) => sum + (shot.draft ? draftTotal(shot.draft) : 0), 0)
  const batchSummary = batch.length === 0
    ? "続けて撮って、最後に保存"
    : batchReading > 0
      ? `${batch.length}件 · 読み取り中 ${batchReading}`
      : `${batch.length}件 · ${formatCurrency(batchTotal)}`
  const modeLocked = hasDraftData || batch.length > 0 || isProcessing || holdingCapture || savingReceipt
  const captureButtonLabel = batchMode
    ? "撮影"
    : isProcessing ? "認識中" : holdingCapture ? "確認中" : cameraPaused ? "再撮影" : "撮影"
  const captureDisabled = batchMode
    ? !cameraActive || savingReceipt
    : !cameraActive || isProcessing || holdingCapture
  const recognitionDone = !batchMode && Boolean(capturedImage) && cameraPaused && !holdingCapture && !isProcessing && !cameraError
  // まとめてでは下部に取り消すを出さない。撮影ボタンを広く保ち、取り消しは一覧の×か取り消すで行う。
  const showCancel = !batchMode && hasDraftData && !recognitionDone
  const footerSaveDisabled = batchMode ? batch.length === 0 || savingReceipt : !canSaveReceipt
  const footerSaveClass = batchMode
    ? `footer-save-btn ui-btn ui-btn-quiet disabled:opacity-40 ${batch.length > 0 && batchReading === 0 && !savingReceipt ? "footer-save-ready" : ""}`
    : saveButtonClass
  const footerSaveLabel = savingReceipt ? "保存中" : batchMode && batch.length > 0 ? `${batch.length}件保存` : "保存"
  const showCaptureCard = !isMobile || cameraActive || batch.length > 0 || ocrProgress !== null || Boolean(cameraError) || Boolean(draft.imageData)
  const captureFirst = cameraActive || batch.length > 0
  const savedBatchReceipts = savedBatch ? (session?.vault.receipts ?? []).filter((receipt) => savedBatch.has(receipt.id)) : []
  const pickImageInput = (className: string) => (
    <label className={className}>
      {batchMode ? "画像を選ぶ（複数可）" : "画像を選ぶ"}
      <input
        type="file"
        accept="image/*"
        multiple={batchMode}
        className="hidden"
        onChange={(event) => handlePickImages(event.target.files, event.target)}
      />
    </label>
  )
  const modeSwitch = (className = "") => (
    <div role="group" aria-label="登録のしかた" className={`grid grid-cols-2 gap-1 rounded-xl bg-black/40 p-1 ${className}`}>
      {([["single", "1件ずつ"], ["batch", "まとめて"]] as const).map(([mode, label]) => (
        <button
          key={mode}
          type="button"
          aria-pressed={captureMode === mode}
          disabled={modeLocked && captureMode !== mode}
          title={modeLocked && captureMode !== mode ? "保存か取り消しのあとで切り替えられます" : undefined}
          onClick={() => changeCaptureMode(mode)}
          className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-40 ${captureMode === mode ? "bg-mint text-fog shadow" : "text-slate-300 hover:bg-white/5"}`}
        >
          {label}
        </button>
      ))}
    </div>
  )

  return (
    <div className="min-h-screen bg-fog text-sand">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-fog/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <img src={iconUrl} alt="" className="h-11 w-11 rounded-full object-cover" />
            <div>
              <h1 className="text-lg font-bold text-white sm:text-2xl">サッとレシート</h1>
              <p className="hidden text-sm text-slate-400 sm:block">買い物ごとに、端末の中へ。</p>
            </div>
          </div>
          {session && (
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => void handleAppUpdate()}
                disabled={pwaUpdating}
                className="ui-btn ui-btn-quiet h-9 whitespace-nowrap px-3 text-xs"
              >
                {pwaUpdating ? "更新しています" : "アプリ更新"}
              </button>
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={() => setMenuOpen(true)}
                className="ui-btn ui-btn-quiet h-9 whitespace-nowrap px-3 text-xs"
              >
                メニュー
              </button>
            </div>
          )}
        </div>
      </header>

      {!session ? (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8 lg:flex-row">
          <div className="flex-1 rounded-3xl border border-white/10 bg-white/5 p-5 sm:p-8">
            <UnlockPanel onUnlock={handleUnlock} unlocking={unlocking} error={unlockError} isFirstTime={isFirstTime} onReset={handleReset} autoFocus={!notice?.updateComplete} />
          </div>
          <div className="rounded-3xl border border-white/10 bg-white/5 p-5 sm:max-w-sm">
            <p className="text-base font-semibold text-white">この端末だけで開きます</p>
            <ul className="mt-3 list-disc space-y-2 pl-4 text-sm text-slate-400">
              <li>パスフレーズを忘れると復元できません。</li>
              <li>データは IndexedDB に残り、CSV でバックアップできます。</li>
              <li>Gemini を使うときだけ、画像が Google に送られます。明細から分かることでは、品名も送ります。</li>
            </ul>
            <button type="button" onClick={() => void handleAppUpdate()} disabled={pwaUpdating} className="ui-btn ui-btn-quiet mt-4 w-full py-2.5 text-sm">
              {pwaUpdating ? "更新しています" : "アプリ更新"}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 px-4 py-4 pb-40 lg:grid-cols-[minmax(0,1.6fr)_22rem] lg:pb-8">
            <section className={`${captureFirst ? "order-1" : "order-2"} min-w-0 space-y-4 lg:order-none lg:col-start-1 lg:row-start-1`}>
              {showCaptureCard && (
              <div className="space-y-4 rounded-3xl border border-white/10 bg-white/5 p-4 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-base font-semibold text-white">レシートの読み取り</h2>
                  {modeSwitch("hidden lg:grid")}
                </div>
                <p className="hidden text-sm text-slate-400 lg:block">
                  {batchMode
                    ? "続けて撮影し、最後にまとめて保存します。金額は保存したあと一覧で見比べてください。"
                    : "1枚ずつ読み取り、内容を確かめてから保存します。"}
                </p>
                {!batchMode && (lastUploadedName || ocrProgress !== null) && (
                  <div className="flex flex-wrap gap-2">
                    {lastUploadedName && <Pill>{lastUploadedName}</Pill>}
                    {ocrProgress !== null && <Pill>読み取り {Math.round(ocrProgress * 100)}%</Pill>}
                  </div>
                )}
                {!batchMode && ocrProgress !== null && (
                  <div className="h-2 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full bg-mint" style={{ width: `${Math.round(ocrProgress * 100)}%` }} />
                  </div>
                )}
                {useGemini && !hasApiKey() && (
                  <p className="hidden items-center justify-between gap-2 rounded-lg border border-amber-400/80 bg-amber-400/15 px-2.5 py-1 text-xs leading-none text-amber-200 lg:flex">
                    <span className="truncate">APIキーを設定してください</span>
                    <button type="button" className="shrink-0 font-semibold text-amber-100 underline" onClick={() => setShowApiKeyModal(true)}>
                      設定
                    </button>
                  </p>
                )}
                <div className="hidden gap-3 lg:grid lg:grid-cols-2">
                  {pickImageInput("ui-btn ui-btn-quiet w-full cursor-pointer border-dashed px-3 py-3 text-sm")}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => void (cameraActive ? stopCamera() : startCamera())}
                      className="ui-btn ui-btn-secondary px-3 py-2 text-sm"
                    >
                      {cameraActive ? "カメラOFF" : "カメラON"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void captureFromCamera()}
                      disabled={captureDisabled}
                      className="ui-btn ui-btn-primary px-3 py-2 text-sm disabled:opacity-100"
                    >
                      {captureButtonLabel}
                    </button>
                  </div>
                </div>
                {cameraActive && (
                  <div className="relative overflow-hidden rounded-2xl border border-mint/30 bg-black">
                    {!batchMode && capturedImage && cameraPaused && (
                      <div className="absolute inset-0 z-10">
                        <img src={capturedImage} alt="撮影したレシート" className="h-full w-full object-cover" />
                        {!holdingCapture && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/50 px-6 text-center">
                            {isProcessing ? (
                              <p className="text-2xl font-bold text-white">認識中...</p>
                            ) : cameraError ? (
                              <p className="text-base font-bold text-red-200 [overflow-wrap:anywhere]">{cameraError}</p>
                            ) : (
                              <p className="text-2xl font-bold text-mint">認識完了</p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {batchMode && shotFlash > 0 && (
                      <div key={shotFlash} className="shot-flash pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                        <p className="rounded-full bg-black/60 px-4 py-2 text-lg font-bold text-mint">撮影しました</p>
                      </div>
                    )}
                    {batchMode && (
                      <p className="absolute left-3 top-3 z-10 rounded-full bg-black/60 px-3 py-1 text-xs font-bold text-white">
                        まとめて · {batchSummary}
                      </p>
                    )}
                    <video
                      ref={setVideoRef}
                      className="aspect-[3/4] w-full object-cover sm:aspect-video"
                      autoPlay
                      playsInline
                      muted
                    />
                  </div>
                )}
                {cameraError && (batchMode || !cameraPaused) && <p className="text-sm text-red-200 [overflow-wrap:anywhere]">{cameraError}</p>}
                {!batchMode && !cameraActive && draft.imageData && (
                  <img src={draft.imageData} alt="読み取り画像" className="max-h-80 w-full rounded-2xl object-contain" />
                )}
                {!batchMode && ocrText && <p className="text-sm text-slate-400">読み取りメモ: {ocrText}</p>}
                {batchMode && batch.length > 0 && (
                  <div>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <p className="font-semibold text-white">撮影した {batch.length}件</p>
                      <p className="text-slate-300">
                        {batchReading > 0 ? `読み取り中 ${batchReading}件` : `合計 ${formatCurrency(batchTotal)}`}
                      </p>
                    </div>
                    <ul className="mt-2 space-y-2">
                      {batch.map((shot, index) => (
                        <li key={shot.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/20 p-2">
                          {shot.thumb ? (
                            <img src={shot.thumb} alt={`${batch.length - index}件目`} className="h-14 w-11 shrink-0 rounded-lg bg-black object-cover" />
                          ) : (
                            <div className="grid h-14 w-11 shrink-0 place-items-center rounded-lg bg-black text-xs text-slate-500">{batch.length - index}</div>
                          )}
                          <div className="min-w-0 flex-1">
                            {shot.status === "reading" && <p className="text-sm text-slate-300">読み取り中...</p>}
                            {shot.status === "error" && (
                              <>
                                <p className="text-sm text-red-200">読み取れませんでした</p>
                                <p className="line-clamp-2 text-xs text-slate-500 [overflow-wrap:anywhere]" title={shot.error}>{shot.error}</p>
                              </>
                            )}
                            {shot.status === "done" && shot.draft && (
                              <>
                                <p className="truncate text-sm font-semibold text-white">{shot.draft.storeName || "店名なし"}</p>
                                <p className="text-xs text-slate-400">
                                  {shot.draft.visitedAt}
                                  {shot.draft.lineItems.length > 0 ? ` · 明細${shot.draft.lineItems.length}` : ""}
                                </p>
                              </>
                            )}
                          </div>
                          {shot.status === "done" && shot.draft && (
                            <p className="shrink-0 font-bold text-mint">{formatCurrency(draftTotal(shot.draft))}</p>
                          )}
                          {shot.status === "error" && (
                            <button type="button" onClick={() => retryBatchShot(shot)} className="ui-btn ui-btn-quiet shrink-0 px-2 py-1.5 text-xs">
                              再読込
                            </button>
                          )}
                          <button
                            type="button"
                            aria-label={`${batch.length - index}件目を外す`}
                            onClick={() => removeBatchShot(shot.id)}
                            disabled={savingReceipt}
                            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-white/10 disabled:opacity-40"
                          >
                            <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                              <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                            </svg>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {batchFailed > 0 && (
                      <p className="mt-2 text-xs leading-relaxed text-red-200">読み取れなかった{batchFailed}件は、再読込するか外してください。そのままでも保存のときに除きます。</p>
                    )}
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button type="button" onClick={() => void discardBatch()} disabled={savingReceipt} className={`${cancelButtonClass} w-full py-3 text-sm`}>
                        取り消す
                      </button>
                      <button type="button" onClick={() => void handleSaveBatch()} disabled={footerSaveDisabled} className={`${footerSaveClass} w-full py-3 text-sm`}>
                        {savingReceipt ? "保存中" : `${batch.length}件を保存`}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              )}

              {!batchMode && (
              <div ref={expenseSectionRef} className={`scroll-mt-20 ${disclosureCardClass(isMobile && !expenseOpen, "p-4 sm:p-6")}`}>
                <MobileDisclosure
                  title={expenseFromAi ? "支出の入力" : "支出の入力（手動で入力する場合）"}
                  mobile={isMobile}
                  open={expenseOpen}
                  onToggle={() => setExpenseOpen((open) => !open)}
                  headerClassName={!isMobile || expenseOpen ? "mb-4" : ""}
                >
                <ReceiptFields value={draft} categories={categories} onChange={setDraft} onAddCategory={(name) => void handleAddCategory(name)} />
                <div className={`mt-4 grid gap-2 ${hasDraftData ? "grid-cols-2" : "grid-cols-1"}`}>
                  {hasDraftData && (
                    <button type="button" onClick={clearDraft} className={`${cancelButtonClass} w-full py-3 text-sm`}>
                      取り消す
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleSaveReceipt()}
                    disabled={!canSaveReceipt}
                    title={saveButtonTitle}
                    className={`${saveButtonClass} w-full py-3 text-sm`}
                  >
                    保存する
                  </button>
                </div>
                </MobileDisclosure>
              </div>
              )}
            </section>

            <aside className={`${captureFirst ? "order-2" : "order-1"} min-w-0 space-y-4 lg:order-none lg:col-start-2 lg:row-span-2 lg:row-start-1`}>
              <div className="rounded-3xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-center justify-between">
                  <button type="button" aria-label="前の月" onClick={goToPrevMonth} disabled={!hasPrevMonth} className="ui-btn ui-btn-secondary grid h-11 w-11 place-items-center rounded-full disabled:opacity-30">
                    &lt;
                  </button>
                  <p className="text-base font-semibold text-white">{formatMonthLabel(selectedMonth)}</p>
                  <button type="button" aria-label="次の月" onClick={goToNextMonth} disabled={!hasNextMonth} className="ui-btn ui-btn-secondary grid h-11 w-11 place-items-center rounded-full disabled:opacity-30">
                    &gt;
                  </button>
                </div>
                <p className="mt-3 text-center text-3xl font-bold text-mint">{formatCurrency(selectedMonthTotal)}</p>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-xl bg-amber-400/10 p-3 text-amber-200">🍺 {formatCurrency(selectedMonthNomikai)}</div>
                  <div className="rounded-xl bg-rose-400/10 p-3 text-rose-200">👛 {formatCurrency(selectedMonthJibara)}</div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    aria-expanded={showCategoryBreakdown}
                    aria-controls="category-breakdown"
                    onClick={() => setShowCategoryBreakdown((open) => !open)}
                    className={`ui-btn ui-btn-secondary w-full py-2.5 text-sm ${showCategoryBreakdown ? "border-mint text-mint" : ""}`}
                  >
                    円グラフ
                  </button>
                  <button
                    type="button"
                    aria-expanded={showLineInsights}
                    aria-controls="line-insights"
                    onClick={() => void handleLineInsights()}
                    disabled={lineInsightLoading}
                    title="同じ品にまとめるため、品名だけを Google に送ります。"
                    className={`ui-btn ui-btn-secondary w-full py-2.5 text-sm ${showLineInsights ? "border-mint text-mint" : ""}`}
                  >
                    {lineInsightLoading ? "分析中..." : "明細分析"}
                  </button>
                </div>
                {showCategoryBreakdown && (
                  <CategoryBreakdown
                    breakdown={monthBreakdown}
                    colors={goodsColors}
                    caption="明細の品目で分けています。明細がないレシートは店の種類から決めています。"
                  />
                )}
                {lineInsightError && <p className="mt-2 text-sm text-red-200">{lineInsightError}</p>}
                {showLineInsights && lineInsightNote && <p className="mt-2 text-xs text-slate-400">{lineInsightNote}</p>}
                {showLineInsights && !lineInsightLoading && (
                  <LineInsightsPanel insights={groupedInsights?.key === lineInsightKey ? groupedInsights.insights : lineInsights} />
                )}
                {showLineInsights && <p className="mt-2 text-xs text-slate-500">明細分析では品名だけを Google に送ります。金額、店名、画像は送りません。</p>}
              </div>

              <div className="rounded-3xl border border-white/10 bg-white/5 p-4 text-sm">
                <div className="mb-2 flex gap-2">
                  <button type="button" aria-pressed={summaryTab === "overview"} onClick={() => setSummaryTab("overview")} className={`ui-toggle px-3 py-1 text-xs ${summaryTab === "overview" ? "border-mint bg-mint text-fog" : ""}`}>年別</button>
                  <button type="button" aria-pressed={summaryTab === "monthly"} onClick={() => setSummaryTab("monthly")} className={`ui-toggle px-3 py-1 text-xs ${summaryTab === "monthly" ? "border-mint bg-mint text-fog" : ""}`}>月別</button>
                </div>
                {summaryTab === "overview" ? (
                  yearlyTotals.length === 0 ? <p className="text-slate-400">まだありません</p> : yearlyTotals.map((entry) => (
                    <div key={entry.year} className="flex justify-between py-1">
                      <span>{entry.year}</span>
                      <span className="font-semibold text-mint">{formatCurrency(entry.total)}</span>
                    </div>
                  ))
                ) : monthlyTotals.length === 0 ? <p className="text-slate-400">まだありません</p> : monthlyTotals.map((entry) => (
                  <button key={entry.month} type="button" onClick={() => setSelectedMonth(entry.month)} className="flex w-full justify-between py-1 text-left">
                    <span>{entry.month}</span>
                    <span className="text-mint">{formatCurrency(entry.total)} / {entry.count}件</span>
                  </button>
                ))}
              </div>
            </aside>

            <section ref={listSectionRef} className="order-3 min-w-0 scroll-mt-20 rounded-3xl border border-white/10 bg-white/5 p-4 sm:p-6 lg:order-none lg:col-span-2 lg:col-start-1 lg:row-start-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <h2 className="text-base font-semibold text-white">{formatMonthLabel(selectedMonth)}の支出</h2>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    className="ui-field rounded-full px-3 py-2 text-sm"
                    placeholder="店名・メモで検索"
                    value={filters.query}
                    onChange={(event) => {
                      setFilters((prev) => ({ ...prev, query: event.target.value }))
                      setVisibleCount(20)
                    }}
                  />
                  <select
                    className="ui-field rounded-full px-3 py-2 text-sm"
                    value={filters.category}
                    onChange={(event) => setFilters((prev) => ({ ...prev, category: event.target.value }))}
                  >
                    <option value="all">すべての分類</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.name}>{category.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              {savedBatchReceipts.length > 0 && (
                <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-mint/50 bg-mint/10 px-3 py-2">
                  <p className="min-w-0 text-sm text-white">
                    まとめて保存した <span className="font-bold">{savedBatchReceipts.length}件</span>
                    <span className="ml-2 font-bold text-mint">{formatCurrency(savedBatchReceipts.reduce((sum, receipt) => sum + receipt.total, 0))}</span>
                    <span className="block text-xs text-slate-300">手元のレシートと金額を見比べてください。違っていたら編集で直せます。</span>
                  </p>
                  <button type="button" onClick={() => setSavedBatch(null)} className="ui-btn ui-btn-quiet shrink-0 px-3 py-1.5 text-xs">
                    確認した
                  </button>
                </div>
              )}
              <div className="mt-4 space-y-3">
                {filteredReceipts.length === 0 && <p className="text-sm text-slate-400">この月の支出はありません。</p>}
                {displayedReceipts.map((receipt) => {
                  const open = openReceiptIds.has(receipt.id)
                  const justSaved = savedBatch?.has(receipt.id) ?? false
                  return (
                    <article key={receipt.id} className={`rounded-2xl border p-3 sm:p-4 ${justSaved ? "border-mint/60 bg-mint/5" : "border-white/10 bg-white/5"}`}>
                      <div className="flex items-start justify-between gap-3">
                        <button type="button" aria-expanded={open} className="min-w-0 flex-1 text-left" onClick={() => setOpenReceiptIds((prev) => {
                          const next = new Set(prev)
                          if (next.has(receipt.id)) next.delete(receipt.id)
                          else next.add(receipt.id)
                          return next
                        })}>
                          <p className="text-xs text-slate-400">{receipt.visitedAt}</p>
                          <p className="truncate font-semibold text-white" title={receipt.storeName}>{open ? "▾ " : "▸ "}{receipt.storeName}</p>
                          <p className="mt-1 truncate text-xs text-slate-300">
                            {receipt.category || "未分類"}
                            {receipt.isNomikai ? " 🍺" : ""}
                            {receipt.isJibara ? " 👛" : ""}
                            {(receipt.lineItems ?? []).length > 0 ? ` ・明細${receipt.lineItems.length}` : ""}
                          </p>
                        </button>
                        <div className="shrink-0 whitespace-nowrap text-right">
                          <p className="text-lg font-bold text-mint">{formatCurrency(receipt.total)}</p>
                          <div className="mt-1 flex justify-end gap-2">
                            <button type="button" className="rounded-full px-3 py-1.5 text-sm text-yellow-300" onClick={() => openEdit(receipt)}>編集</button>
                            <button type="button" className="rounded-full px-3 py-1.5 text-sm text-red-300" onClick={() => setDeleteTargetId(receipt.id)}>削除</button>
                          </div>
                        </div>
                      </div>
                      {open && (
                        <div className="mt-3 space-y-2 border-t border-white/10 pt-3 text-sm">
                          {receipt.note && <p className="text-slate-300">{receipt.note}</p>}
                          {(receipt.lineItems ?? []).map((item) => (
                            <div key={item.id} className="flex justify-between gap-2">
                              <span className="text-white">{item.name} {item.quantity > 1 ? `×${item.quantity}` : ""}</span>
                              <span className="text-mint">{formatCurrency(item.price * (item.quantity || 1))}</span>
                            </div>
                          ))}
                          {receipt.imageData && (
                            <div>
                              <button
                                type="button"
                                className="text-xs text-slate-300 underline"
                                onClick={() => setExpandedImages((prev) => {
                                  const next = new Set(prev)
                                  if (next.has(receipt.id)) next.delete(receipt.id)
                                  else next.add(receipt.id)
                                  return next
                                })}
                              >
                                {expandedImages.has(receipt.id) ? "画像を閉じる" : "画像を表示"}
                              </button>
                              {expandedImages.has(receipt.id) && (
                                <img src={receipt.imageData} alt="保存したレシート" className="mt-2 max-h-64 w-full object-contain" />
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  )
                })}
              </div>
              {filteredReceipts.length > visibleCount && (
                <button type="button" onClick={() => setVisibleCount((count) => count + 20)} className="ui-btn ui-btn-quiet mt-3 w-full py-2.5 text-sm">
                  もっと見る
                </button>
              )}
            </section>
          </div>

          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-white/10 bg-fog/95 px-4 pt-2 backdrop-blur safe-area-pb lg:hidden">
            {useGemini && !hasApiKey() && (
              <p className="mx-auto mb-1.5 flex max-w-lg items-center justify-between gap-2 rounded-lg border border-amber-400/80 bg-amber-400/15 px-2.5 py-1 text-xs leading-none text-amber-200">
                <span className="truncate">APIキーを設定してください</span>
                <button type="button" className="shrink-0 font-semibold text-amber-100 underline" onClick={() => setShowApiKeyModal(true)}>
                  設定
                </button>
              </p>
            )}
            <div className="mx-auto mb-2 flex max-w-lg items-center justify-between gap-3">
              {modeSwitch("shrink-0")}
              <p className="min-w-0 truncate text-right text-xs text-slate-400">
                {batchMode ? batchSummary : "1枚ずつ確かめて保存"}
              </p>
            </div>
            <div className={`mx-auto grid max-w-lg items-center gap-2 ${showCancel ? "grid-cols-[minmax(4.5rem,1fr)_minmax(0,1.4fr)_minmax(4.5rem,1fr)_minmax(4.5rem,1fr)]" : "grid-cols-[minmax(5rem,1fr)_minmax(0,2fr)_minmax(5rem,1fr)]"}`}>
              {recognitionDone ? (
                <button type="button" onClick={clearDraft} className={`footer-btn ${cancelButtonClass} h-10 min-w-0 whitespace-nowrap px-2 text-xs`}>
                  取り消す
                </button>
              ) : (
                <button type="button" onClick={() => void (cameraActive ? stopCamera() : startCamera())} className="footer-btn ui-btn ui-btn-secondary h-10 min-w-0 whitespace-nowrap px-2 text-xs">
                  {cameraActive ? "カメラOFF" : "カメラON"}
                </button>
              )}
              <button type="button" onClick={() => void captureFromCamera()} disabled={captureDisabled} className="footer-btn ui-btn ui-btn-primary h-11 min-w-0 whitespace-nowrap text-sm disabled:opacity-100">
                {captureButtonLabel}
              </button>
              {showCancel && (
                <button type="button" onClick={() => void (batchMode ? discardBatch() : clearDraft())} disabled={savingReceipt} className={`footer-btn ${cancelButtonClass} h-10 min-w-0 whitespace-nowrap px-2 text-xs`}>
                  取り消す
                </button>
              )}
              <button
                type="button"
                onClick={() => void (batchMode ? handleSaveBatch() : handleSaveReceipt())}
                disabled={footerSaveDisabled}
                title={batchMode ? "撮影した分をまとめて保存します" : saveButtonTitle}
                className={`footer-btn ${footerSaveClass} h-10 min-w-0 whitespace-nowrap px-2 text-xs`}
              >
                {footerSaveLabel}
              </button>
            </div>
          </div>
        </>
      )}

      {session && menuOpen && (
        <Dialog title="メニュー" onClose={() => setMenuOpen(false)}>
          <div className="space-y-5 text-sm">
            <section>
              <h4 className="font-semibold text-white">レシート画像から読み取る</h4>
              <p className="mt-1 text-xs text-slate-400">
                {batchMode ? "まとめてモードです。複数の画像を選ぶと、全部を読み取って保存待ちにします。" : "画像から店名・日付・合計・明細を読み取ります。"}
              </p>
              {pickImageInput("ui-btn ui-btn-secondary mt-2 w-full cursor-pointer py-2.5 text-sm")}
              <label className="mt-3 flex items-center gap-2 text-slate-300">
                <input type="checkbox" checked={saveImage} onChange={(event) => setSaveImage(event.target.checked)} />
                画像も保存する（長辺1280px）
              </label>
            </section>

            <section className="border-t border-white/10 pt-4">
              <h4 className="font-semibold text-white">AIモデル</h4>
              <div className="mt-2 flex items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-white">{geminiModel === "gemini-3.8-flash" ? "Gemini 3.8 Flash" : "Gemini 3.5 Flash-Lite"}</p>
                  <p className="text-xs text-slate-400">{hasApiKey() ? "APIキー設定済み" : "APIキー未設定"}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" aria-pressed={useGemini} onClick={() => setUseGemini((value) => !value)} className={`ui-toggle px-3 py-1 text-xs ${useGemini ? "border-mint bg-mint text-fog" : ""}`}>
                    {useGemini ? "ON" : "OFF"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      setShowApiKeyModal(true)
                    }}
                    className="ui-btn ui-btn-quiet px-3 py-1 text-xs"
                  >
                    キー設定
                  </button>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl bg-black/40 p-1" role="group" aria-label="読み取りモデル">
                {([["gemini-3.5-flash-lite", "3.5 Flash-Lite"], ["gemini-3.8-flash", "3.8 Flash"]] as const).map(([model, label]) => (
                  <button
                    key={model}
                    type="button"
                    aria-pressed={geminiModel === model}
                    onClick={() => {
                      saveGeminiModel(model)
                      setGeminiModel(model)
                    }}
                    className={`rounded-lg px-2 py-2 text-xs font-bold ${geminiModel === model ? "bg-mint text-fog shadow" : "text-slate-300 hover:bg-white/5"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-500">ONのとき、画像は Google に送られます。</p>
            </section>

            <section className="border-t border-white/10 pt-4">
              <h4 className="font-semibold text-white">データのバックアップ</h4>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button type="button" onClick={handleExport} className="ui-btn ui-btn-secondary py-2.5 text-sm">CSVを保存</button>
                <label className="ui-btn ui-btn-secondary w-full cursor-pointer py-2.5 text-sm">
                  CSVを読込
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      event.target.value = ""
                      if (!file) return
                      setMenuOpen(false)
                      void handleImportCsv(file)
                    }}
                  />
                </label>
              </div>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  void handleCleanupImages()
                }}
                className="ui-btn ui-btn-quiet mt-2 w-full py-2.5 text-sm"
              >
                保存済みのレシート画像を削除
              </button>
            </section>

            <section className="border-t border-white/10 pt-4">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  void handleLock()
                }}
                className="ui-btn ui-btn-quiet w-full py-2.5 text-sm"
              >
                ログアウト
              </button>
            </section>
          </div>
        </Dialog>
      )}

      {showApiKeyModal && (
        <Dialog title="Gemini APIキー" onClose={closeApiKeyModal}>
          <p className="text-sm text-slate-300">
            キーはこの端末に保存します。取得は <a className="text-mint underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio</a> です。
          </p>
          <input
            type="password"
            autoFocus
            className="ui-field mt-4 px-3 py-3 text-base"
            placeholder="AIza..."
            value={apiKeyInput}
            onChange={(event) => {
              setApiKeyInput(event.target.value)
              setApiKeyError(null)
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              const key = apiKeyInput.trim()
              if (!key) {
                setApiKeyError("キーを入力してください。")
                return
              }
              saveApiKey(key)
              closeApiKeyModal()
            }}
          />
          {apiKeyError && <p className="mt-2 text-sm text-red-300">{apiKeyError}</p>}
          <button
            type="button"
            className="ui-btn ui-btn-primary mt-4 w-full py-3 text-sm"
            onClick={() => {
              const key = apiKeyInput.trim()
              if (!key) {
                setApiKeyError("キーを入力してください。")
                return
              }
              saveApiKey(key)
              closeApiKeyModal()
            }}
          >
            保存
          </button>
          <button
            type="button"
            className="mt-3 w-full py-2 text-sm text-red-300"
            onClick={() => {
              clearApiKey()
              closeApiKeyModal()
            }}
          >
            保存済みのキーを削除
          </button>
        </Dialog>
      )}

      {deleteTargetId && (
        <Dialog title="削除の確認" onClose={() => setDeleteTargetId(null)} footer={
          <div className="grid grid-cols-2 gap-3">
            <button type="button" className="ui-btn ui-btn-secondary py-3 text-sm" onClick={() => setDeleteTargetId(null)}>キャンセル</button>
            <button
              type="button"
              className="ui-btn bg-red-500 py-3 text-sm text-white"
              onClick={() => {
                void handleDeleteReceipt(deleteTargetId)
                setDeleteTargetId(null)
              }}
            >
              削除する
            </button>
          </div>
        }>
          <p className="text-sm text-slate-300">このレシートを削除します。元には戻せません。</p>
        </Dialog>
      )}

      {editDraft && editingId && (
        <Dialog title="支出を編集" onClose={closeEdit} footer={
          <div className="grid grid-cols-2 gap-3">
            <button type="button" className="ui-btn ui-btn-secondary py-3 text-sm" onClick={closeEdit}>キャンセル</button>
            <button type="button" className="ui-btn ui-btn-primary py-3 text-sm" onClick={() => void saveEdit()}>保存</button>
          </div>
        }>
          <ReceiptFields value={editDraft} categories={categories} onChange={setEditDraft} onAddCategory={(name) => void handleAddCategory(name)} />
        </Dialog>
      )}

      {notice && (
        <Dialog title={notice.title} onClose={() => closeNotice(false)} footer={
          notice.confirmLabel ? (
            <div className="grid grid-cols-2 gap-3">
              <button type="button" className="ui-btn ui-btn-secondary py-3 text-sm" onClick={() => closeNotice(false)}>{notice.cancelLabel ?? "キャンセル"}</button>
              <button
                type="button"
                className={`ui-btn py-3 text-sm ${notice.danger ? "bg-red-500 text-white" : "ui-btn-primary"}`}
                onClick={() => closeNotice(true)}
              >
                {notice.confirmLabel}
              </button>
            </div>
          ) : (
            <button type="button" className="ui-btn ui-btn-primary w-full py-3 text-sm" onClick={() => closeNotice(true)}>
              OK
            </button>
          )
        }>
          {notice.imageData && (
            <img src={notice.imageData} alt="仮保存したレシート" className="mb-3 max-h-[40vh] w-full rounded-xl bg-black object-contain" />
          )}
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-300">{notice.message}</p>
        </Dialog>
      )}
    </div>
  )
}

const UnlockPanel = ({
  onUnlock,
  unlocking,
  error,
  isFirstTime,
  onReset,
  autoFocus = true,
}: {
  onUnlock: (passphrase: string, rememberMe: boolean) => void
  unlocking: boolean
  error: string | null
  isFirstTime: boolean
  onReset: () => void
  autoFocus?: boolean
}) => {
  const savedPassphrase = getSavedPassphrase()
  const [value, setValue] = useState(savedPassphrase ?? "")
  const [rememberMe, setRememberMe] = useState(savedPassphrase !== null)

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (unlocking || value.length < 4) return
        onUnlock(value, rememberMe)
      }}
    >
      <p className="text-sm leading-relaxed text-slate-300">
        {isFirstTime ? "初回です。この端末用のパスフレーズを決めてください（4文字以上）。" : "パスフレーズを入力してデータを開きます。"}
      </p>
      <label className="text-sm text-slate-200">
        パスフレーズ
        <input
          type="password"
          autoFocus={autoFocus}
          className="ui-field mt-1 px-3 py-3 text-base"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} />
        次回から入力を省略する
      </label>
      {rememberMe && <p className="text-xs text-yellow-200/80">このブラウザにパスフレーズを保存します。自分の端末向けです。</p>}
      {error && <p className="text-sm text-red-300">{error}</p>}
      <button
        type="submit"
        disabled={unlocking || value.length < 4}
        className="ui-btn ui-btn-primary py-3 text-sm disabled:opacity-50"
      >
        {unlocking ? "復号しています..." : "データを開く"}
      </button>
      <button type="button" onClick={onReset} className="text-left text-xs text-slate-500 underline">
        データを初期化
      </button>
    </form>
  )
}

export default App
