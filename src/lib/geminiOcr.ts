/**
 * Gemini SDK を使用したレシートOCR
 * 
 * ## 公式ドキュメント
 * https://ai.google.dev/gemini-api/docs
 * 
 * ## インストール方法
 * npm install @google/genai
 * 
 * ## モデル一覧
 * https://ai.google.dev/gemini-api/docs/models/gemini
 * - gemini-2.5-flash-lite: 最もコスパが良い（推奨）
 * - gemini-2.5-flash: 高精度（思考機能付き）
 * - gemini-2.5-pro: 最高精度（高コスト）
 */

import { GoogleGenAI } from "@google/genai"

// 使用するモデル（変更可能）
const MODEL_NAME = "gemini-2.5-flash-lite"

export interface ReceiptOcrResult {
  storeName: string
  date: string
  total: string
  items: Array<{
    name: string
    price: number
    quantity: number
  }>
  rawText: string
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
  const prompt = `このレシート画像を解析してください。以下のJSON形式で回答してください。日本語のレシートです。

{
  "storeName": "店舗名",
  "date": "YYYY-MM-DD形式の日付",
  "total": "合計金額（数字のみ）",
  "items": [
    {"name": "商品名", "price": 金額, "quantity": 数量}
  ],
  "rawText": "レシートに記載されている全テキスト"
}

注意事項:
- 日付が読み取れない場合は空文字にしてください
- 合計金額が読み取れない場合は"0"にしてください
- 商品が読み取れない場合はitemsは空配列にしてください
- JSONのみを出力し、他の説明は不要です`

  // 5. Gemini APIを呼び出し
  try {
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
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
        temperature: 0.1,
        maxOutputTokens: 2048,
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

    try {
      const result = JSON.parse(jsonStr)
      onProgress?.(1.0)

      return {
        storeName: result.storeName || '',
        date: result.date || '',
        total: String(result.total || '0'),
        items: result.items || [],
        rawText: result.rawText || '',
      }
    } catch {
      // JSONパースに失敗した場合
      onProgress?.(1.0)
      return {
        storeName: '',
        date: '',
        total: '0',
        items: [],
        rawText: text,
      }
    }
  } catch (error) {
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
