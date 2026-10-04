/**
 * Gemini API でのレシート読み取りと月次コメント。
 * 標準は Gemini 3.5 Flash-Lite。読み取りを優先するときは 3.8 Flash。
 * https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
 * https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
 */

import { GoogleGenAI, type ThinkingConfig } from "@google/genai"

export type GeminiModelId = "gemini-3.5-flash-lite" | "gemini-3.8-flash"

const MODEL_KEY = "gemini_model"
const DEFAULT_MODEL: GeminiModelId = "gemini-3.5-flash-lite"

// 3.5 Flash-Lite は minimal が抽出向け。3.8 Flash に minimal を渡すとエラーになる。
const MODEL_THINKING: Record<GeminiModelId, ThinkingConfig["thinkingLevel"]> = {
  "gemini-3.5-flash-lite": "minimal" as ThinkingConfig["thinkingLevel"],
  "gemini-3.8-flash": "low" as ThinkingConfig["thinkingLevel"],
}

export const getGeminiModel = (): GeminiModelId => {
  try {
    const stored = localStorage.getItem(MODEL_KEY)
    if (stored === "gemini-3.5-flash-lite" || stored === "gemini-3.8-flash") return stored
  } catch {
    // localStorage が使えないときは標準の Lite を使う
  }
  return DEFAULT_MODEL
}

export const saveGeminiModel = (model: GeminiModelId): void => {
  try {
    localStorage.setItem(MODEL_KEY, model)
  } catch {
    // 保存できなくても、この画面の選択は呼び出し側の state で保持する
  }
}

const thinkingFor = (model: GeminiModelId): ThinkingConfig => ({
  thinkingLevel: MODEL_THINKING[model],
})

export interface ReceiptOcrResult {
  storeName: string
  date: string
  total: string
  category: string
  isNomikai: boolean
  highlight: string
  items: Array<{
    name: string
    price: number
    quantity: number
    category?: string
  }>
  rawText: string
}

export type MonthInsightInput = {
  month: string
  total: number
  count: number
  nomikai: number
  jibara: number
  byCategory: Array<{ name: string; total: number; count: number }>
  topStores: Array<{ name: string; total: number }>
}

// ========== APIキー管理 ==========

// APIキーをlocalStorageに保存
export const saveApiKey = (apiKey: string): void => {
  try {
    // Base64エンコード（簡易的な難読化）
    const encoded = btoa(apiKey)
    localStorage.setItem('gemini_api_key', encoded)
  } catch (e) {
    console.error('Failed to save API key:', e)
  }
}

// APIキーをlocalStorageから取得
export const getApiKey = (): string | null => {
  try {
    const encoded = localStorage.getItem('gemini_api_key')
    if (!encoded) return null
    return atob(encoded)
  } catch (e) {
    console.error('Failed to get API key:', e)
    return null
  }
}

// APIキーを削除
export const clearApiKey = (): void => {
  localStorage.removeItem('gemini_api_key')
}

// APIキーが保存されているか確認
export const hasApiKey = (): boolean => {
  return !!getApiKey()
}

// ========== 画像変換ユーティリティ ==========

// FileをBase64文字列に変換
const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // data:image/jpeg;base64, の部分を除去
      const base64 = result.split(',')[1]
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// ========== メイン処理 ==========

/**
 * Gemini SDKでレシート画像を解析
 * 
 * @example
 * ```typescript
 * import { analyzeReceiptWithGemini, saveApiKey } from './lib/geminiOcr'
 * 
 * // 1. APIキーを保存（初回のみ）
 * saveApiKey('AIza...')
 * 
 * // 2. 画像を解析
 * const file = new File([blob], 'receipt.jpg', { type: 'image/jpeg' })
 * const result = await analyzeReceiptWithGemini(file, (progress) => {
 *   console.log(`進捗: ${progress * 100}%`)
 * })
 * 
 * console.log(result.storeName)  // 店名
 * console.log(result.date)       // 日付
 * console.log(result.total)      // 合計金額
 * ```
 */
export const analyzeReceiptWithGemini = async (
  file: File,
  onProgress?: (progress: number) => void
): Promise<ReceiptOcrResult> => {
  // 1. APIキーを取得
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error('APIキーが設定されていません。設定画面からGemini APIキーを入力してください。')
  }

  onProgress?.(0.1)

  // 2. SDKクライアントを初期化
  const ai = new GoogleGenAI({ apiKey })

  onProgress?.(0.2)

  // 3. 画像をBase64に変換
  const base64Image = await fileToBase64(file)
  const mimeType = file.type || 'image/jpeg'

  onProgress?.(0.4)

  // 4. プロンプト（解析指示）
  const prompt = `このレシート画像を解析してください。日本語のレシートです。税込の支払合計を total にしてください。

{
  "storeName": "屋号だけ。住所や電話番号は入れない",
  "date": "YYYY-MM-DD。読めなければ空文字",
  "total": "税込合計。数字のみ。読めなければ0",
  "category": "スーパー, コンビニ, ドラッグストア, 飲食店, 衣料品店, 家電・雑貨, 医療・薬局, 娯楽, その他 のいずれか",
  "isNomikai": "居酒屋・バー・飲み会など飲酒を伴う飲食なら true。スーパーで酒を買っただけなら false",
  "highlight": "買った内容を20文字以内で。例: 牛乳と惣菜",
  "items": [
    {"name": "商品名", "price": 税込単価, "quantity": 数量, "category": "食品, 飲料, 日用品, 医薬品, 衣類, 雑貨, サービス, その他"}
  ]
}

商品が読めなければ items は空配列。JSONのみ。`

  const model = getGeminiModel()

  // 5. Gemini APIを呼び出し
  try {
    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Image,
              },
            },
          ],
        },
      ],
      config: {
        maxOutputTokens: 8192,
        thinkingConfig: thinkingFor(model),
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: {
            storeName: { type: "string" },
            date: { type: "string" },
            total: { type: "string" },
            category: { type: "string" },
            isNomikai: { type: "boolean" },
            highlight: { type: "string" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  price: { type: "number" },
                  quantity: { type: "number" },
                  category: { type: "string" },
                },
                required: ["name", "price"],
              },
            },
          },
          required: ["storeName", "date", "total", "items"],
        },
      },
    })

    onProgress?.(0.9)

    // 6. レスポンスを解析
    const text = response.text || ''

    // JSONを抽出（マークダウンコードブロックを考慮）
    let jsonStr = text
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim()
    }

    let result: {
      storeName?: string
      date?: string
      total?: string | number
      category?: string
      isNomikai?: boolean
      highlight?: string
      items?: ReceiptOcrResult["items"]
      rawText?: string
    }
    try {
      result = JSON.parse(jsonStr)
    } catch {
      throw new Error("レシートの読み取り結果を解釈できませんでした。もう一度撮影するか、手入力してください。")
    }

    const items = Array.isArray(result.items) ? result.items : []
    const total = String(result.total ?? "").replace(/[^\d.]/g, "")
    const storeName = result.storeName?.trim() || ""
    const highlight = (result.highlight || "").trim().slice(0, 40)
    if (!storeName && items.length === 0 && (!total || total === "0")) {
      throw new Error("レシートを読み取れませんでした。全体が写るように、明るい場所でもう一度撮影してください。")
    }

    onProgress?.(1.0)
    return {
      storeName,
      date: result.date || "",
      total: total || "0",
      category: result.category || "その他",
      isNomikai: Boolean(result.isNomikai),
      highlight,
      items,
      rawText: highlight,
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("レシート")) {
      throw error
    }
    // APIエラーのハンドリング
    const errorMessage = error instanceof Error ? error.message : String(error)
    
    if (errorMessage.includes('API_KEY_INVALID') || errorMessage.includes('401')) {
      throw new Error('APIキーが無効です。正しいGemini APIキーを入力してください。')
    }
    if (errorMessage.includes('PERMISSION_DENIED') || errorMessage.includes('403')) {
      throw new Error('APIキーに権限がありません。Gemini APIが有効化されているか確認してください。')
    }
    if (errorMessage.includes('RESOURCE_EXHAUSTED') || errorMessage.includes('429')) {
      throw new Error('APIの利用制限に達しました。しばらく待ってから再試行してください。')
    }
    
    throw new Error(`Gemini API エラー: ${errorMessage}`)
  }
}

const describeApiError = (error: unknown): Error => {
  if (error instanceof Error && (error.message.startsWith("レシート") || error.message.startsWith("APIキー") || error.message.startsWith("Gemini"))) {
    return error
  }
  const errorMessage = error instanceof Error ? error.message : String(error)
  if (errorMessage.includes("API_KEY_INVALID") || errorMessage.includes("401")) {
    return new Error("APIキーが無効です。正しいGemini APIキーを入力してください。")
  }
  if (errorMessage.includes("PERMISSION_DENIED") || errorMessage.includes("403")) {
    return new Error("APIキーに権限がありません。Gemini APIが有効化されているか確認してください。")
  }
  if (errorMessage.includes("RESOURCE_EXHAUSTED") || errorMessage.includes("429")) {
    return new Error("APIの利用制限に達しました。しばらく待ってから再試行してください。")
  }
  return new Error(`Gemini API エラー: ${errorMessage}`)
}

/** 集計済みの数字と店名だけを送り、今月の短いふりかえりを作る。 */
export const summarizeMonth = async (input: MonthInsightInput): Promise<string> => {
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error("APIキーが設定されていません。設定画面からGemini APIキーを入力してください。")
  }
  if (input.count === 0) {
    throw new Error("この月の支出がまだないので、まとめられません。")
  }

  const model = getGeminiModel()
  const ai = new GoogleGenAI({ apiKey })
  const prompt = `あなたは個人の家計メモの助手です。次の集計だけを材料に、日本語で2文か3文のふりかえりを書いてください。
数字は材料にあるものだけを使い、足したり推測したりしないでください。説教や節約の命令はしないでください。マークダウンは使わないでください。

対象月: ${input.month}
件数: ${input.count}
合計: ${input.total}円
飲み会の合計: ${input.nomikai}円
自腹の合計: ${input.jibara}円
分類: ${input.byCategory.map((row) => `${row.name} ${row.total}円 ${row.count}件`).join("、") || "なし"}
店別上位: ${input.topStores.map((row) => `${row.name} ${row.total}円`).join("、") || "なし"}`

  try {
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        maxOutputTokens: 512,
        thinkingConfig: thinkingFor(model),
      },
    })
    const text = (response.text || "").trim()
    if (!text) throw new Error("まとめの文章を受け取れませんでした。")
    return text
  } catch (error) {
    throw describeApiError(error)
  }
}
