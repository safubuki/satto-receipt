import { useState } from "react"
import type { Category } from "../lib/types"

export type ItemDraft = {
  id: string
  name: string
  category: string
  price: string
  quantity: string
}

export type ReceiptFormValue = {
  storeName: string
  visitedAt: string
  total: string
  note: string
  category: string
  lineItems: ItemDraft[]
  isNomikai?: boolean
  isJibara?: boolean
}

const fieldClass = "ui-field px-3 py-2 text-base"

const itemsSum = (items: ItemDraft[]) =>
  items.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 1), 0)

const formatYen = (value: number) =>
  new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(value)

export const ReceiptFields = ({
  value,
  categories,
  onChange,
  onAddCategory,
}: {
  value: ReceiptFormValue
  categories: Category[]
  onChange: (next: ReceiptFormValue) => void
  onAddCategory: (name: string) => void
}) => {
  const [categoryName, setCategoryName] = useState("")
  const sum = itemsSum(value.lineItems)

  const updateItem = (id: string, patch: Partial<ItemDraft>) => {
    onChange({
      ...value,
      lineItems: value.lineItems.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    })
  }

  return (
    <div className="space-y-3">
      <label className="block text-sm text-slate-200">
        店名
        <input
          className={`${fieldClass} mt-1`}
          value={value.storeName}
          onChange={(event) => onChange({ ...value, storeName: event.target.value })}
          placeholder="店名"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm text-slate-200">
          日付
          <input
            type="date"
            className={`${fieldClass} mt-1`}
            value={value.visitedAt}
            onChange={(event) => onChange({ ...value, visitedAt: event.target.value })}
          />
        </label>
        <label className="block text-sm text-slate-200">
          合計
          <div className="ui-field mt-1 flex items-center gap-1 px-3 py-2">
            <span className="font-bold text-mint" aria-hidden="true">¥</span>
            <input
              inputMode="numeric"
              aria-label="合計"
              className="w-full bg-transparent text-lg font-bold text-white outline-none placeholder:text-slate-500"
              value={value.total}
              onChange={(event) => onChange({ ...value, total: event.target.value })}
              placeholder="0"
            />
          </div>
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          aria-pressed={Boolean(value.isNomikai)}
          onClick={() => onChange({ ...value, isNomikai: !value.isNomikai })}
          className={`ui-toggle py-2 text-sm ${value.isNomikai ? "border-amber-300 bg-amber-400 text-fog" : ""}`}
        >
          🍺 飲み会
        </button>
        <button
          type="button"
          aria-pressed={Boolean(value.isJibara)}
          onClick={() => onChange({ ...value, isJibara: !value.isJibara })}
          className={`ui-toggle py-2 text-sm ${value.isJibara ? "border-rose-300 bg-rose-400 text-white" : ""}`}
        >
          👛 自腹
        </button>
      </div>
      <label className="block text-sm text-slate-200">
        分類
        <select
          className={`${fieldClass} mt-1`}
          value={value.category}
          onChange={(event) => onChange({ ...value, category: event.target.value })}
        >
          <option value="">分類を選択</option>
          {categories.map((category) => (
            <option key={category.id} value={category.name}>
              {category.name}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <input
          className={fieldClass}
          value={categoryName}
          onChange={(event) => setCategoryName(event.target.value)}
          placeholder="分類を追加"
        />
        <button
          type="button"
          className="ui-btn ui-btn-secondary shrink-0 px-4 py-2 text-sm"
          onClick={() => {
            const name = categoryName.trim()
            if (!name) return
            onAddCategory(name)
            onChange({ ...value, category: name })
            setCategoryName("")
          }}
        >
          追加
        </button>
      </div>
      <div className="space-y-2">
        <div>
          <p className="text-sm text-slate-200">明細</p>
          {value.lineItems.length === 0 && (
            <p className="mt-1 text-xs text-slate-400">撮影しなくても、ここで手入力できます。読み取れた品目もここに出ます。</p>
          )}
        </div>
        {value.lineItems.map((item) => (
          <div key={item.id} className="space-y-2 rounded-xl border border-white/10 p-2">
            <input
              className={fieldClass}
              value={item.name}
              onChange={(event) => updateItem(item.id, { name: event.target.value })}
              placeholder="品目"
            />
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
              <input
                inputMode="numeric"
                className={fieldClass}
                value={item.price}
                onChange={(event) => updateItem(item.id, { price: event.target.value })}
                placeholder="単価"
                aria-label="単価"
              />
              <input
                inputMode="numeric"
                className={fieldClass}
                value={item.quantity}
                onChange={(event) => updateItem(item.id, { quantity: event.target.value })}
                placeholder="数量"
                aria-label="数量"
              />
              <button
                type="button"
                className="ui-btn ui-btn-quiet px-3 text-sm text-red-300"
                onClick={() => onChange({ ...value, lineItems: value.lineItems.filter((entry) => entry.id !== item.id) })}
              >
                削除
              </button>
            </div>
          </div>
        ))}
        {sum > 0 && (
          <div className="flex items-center justify-between text-sm text-slate-300">
            <span>明細合計 {formatYen(sum)}</span>
            <button
              type="button"
              className="ui-btn ui-btn-quiet border-mint/60 px-3 py-1.5 text-xs text-mint"
              onClick={() => onChange({ ...value, total: String(sum) })}
            >
              合計に反映
            </button>
          </div>
        )}
        <button
          type="button"
          className="ui-btn ui-btn-secondary w-full py-2.5 text-sm"
          onClick={() =>
            onChange({
              ...value,
              lineItems: [
                ...value.lineItems,
                { id: crypto.randomUUID(), name: "", category: value.category, price: "", quantity: "1" },
              ],
            })
          }
        >
          + 手入力で品目を追加
        </button>
      </div>
      <label className="block text-sm text-slate-200">
        メモ
        <textarea
          rows={2}
          className={`${fieldClass} mt-1`}
          value={value.note}
          onChange={(event) => onChange({ ...value, note: event.target.value })}
          placeholder="メモ"
        />
      </label>
    </div>
  )
}
