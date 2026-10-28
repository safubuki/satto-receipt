import type { SpendReceipt, SpendShare } from "./monthBreakdown"

/** 円グラフの分け方。店の種類ではなく、何を買ったか。 */
export const GOODS_TYPES = [
  { name: "食品", color: "#3de0a2" },
  { name: "外食", color: "#f87171" },
  { name: "日用品", color: "#38bdf8" },
  { name: "医薬品", color: "#a78bfa" },
  { name: "衣料品", color: "#f472b6" },
  { name: "家電・雑貨", color: "#facc15" },
  { name: "娯楽・サービス", color: "#fb923c" },
  { name: "その他", color: "#94a3b8" },
] as const

export type GoodsType = (typeof GOODS_TYPES)[number]["name"]

// 品目の分類（食品・衣類など）と、店の分類（スーパー・ドラッグストアなど）の両方を受ける。上から順に見る。
const RULES: [RegExp, GoodsType][] = [
  [/飲食店|外食|レストラン|居酒屋/, "外食"],
  [/医薬|薬|医療/, "医薬品"],
  [/衣/, "衣料品"],
  [/日用|ドラッグ/, "日用品"],
  [/家電|雑貨/, "家電・雑貨"],
  [/娯楽|サービス/, "娯楽・サービス"],
  [/食|飲料|酒|スーパー|コンビニ/, "食品"],
]

export const goodsTypeOf = (label: string | undefined): GoodsType => {
  const text = label?.trim() ?? ""
  if (!text) return "その他"
  return RULES.find(([pattern]) => pattern.test(text))?.[1] ?? "その他"
}

/**
 * 1枚のレシートの合計を、品目の種類ごとに分ける。
 * 明細の金額の比率で合計を割り振るので、税や値引きの差もその比率で入る。
 * 明細がなければ店の分類から決める。飲み会と飲食店はまとめて外食にする。
 */
export const goodsShares = (receipt: SpendReceipt): SpendShare[] => {
  const total = Number.isFinite(receipt.total) ? receipt.total : 0
  const fallback = goodsTypeOf(receipt.category)
  if (receipt.isNomikai || fallback === "外食") return [{ name: "外食", amount: total }]

  const weights = new Map<GoodsType, number>()
  for (const item of receipt.lineItems ?? []) {
    const amount = (Number(item.price) || 0) * (Number(item.quantity) || 1)
    if (amount <= 0) continue
    const type = item.category?.trim() ? goodsTypeOf(item.category) : fallback
    weights.set(type, (weights.get(type) ?? 0) + amount)
  }
  const weightSum = Array.from(weights.values()).reduce((sum, value) => sum + value, 0)
  if (weightSum <= 0 || total <= 0) return [{ name: fallback, amount: total }]

  const entries = Array.from(weights.entries()).sort((a, b) => b[1] - a[1])
  const amounts = entries.map(([, weight]) => Math.floor((total * weight) / weightSum))
  // 切り捨てた端数は、いちばん大きい種類に寄せる。
  amounts[0] += total - amounts.reduce((sum, value) => sum + value, 0)
  return entries.map(([name], index) => ({ name, amount: amounts[index] }))
}
