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
const compactFieldClass = "ui-field px-2 py-2 text-base"
const labelClass = "block text-sm font-semibold text-slate-200"

const itemsSum = (items: ItemDraft[]) =>
  items.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 1), 0)

const toAmount = (total: string) => Number(total.replace(/,/g, "")) || 0

const formatYen = (value: number) =>
  new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(value)

const newItem = (id: string, category: string): ItemDraft => ({ id, name: "", category, price: "", quantity: "1" })

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
  const [addingCategory, setAddingCategory] = useState(false)
  // 品目が0件でも入力行を1つ見せる。打ち始めた時点で同じidの品目にするので、入力中にフォーカスが外れない
  const [blankId, setBlankId] = useState(() => crypto.randomUUID())
  const [focusId, setFocusId] = useState<string | null>(null)

  const sum = itemsSum(value.lineItems)
  const totalAmount = toAmount(value.total)
  const rows = value.lineItems.length > 0 ? value.lineItems : [newItem(blankId, value.category)]
  const isBlankRow = value.lineItems.length === 0

  // 合計が空か明細合計と同じ間は、明細に合わせて合計も更新する。読み取った合計など別の値が入っていれば触らない
  const changeItems = (lineItems: ItemDraft[]) => {
    const followsItems = value.total.trim() === "" || totalAmount === sum
    const nextSum = itemsSum(lineItems)
    onChange({
      ...value,
      lineItems,
      total: followsItems ? (nextSum > 0 ? String(nextSum) : "") : value.total,
    })
  }

  const updateItem = (id: string, patch: Partial<ItemDraft>) => {
    if (isBlankRow) {
      setBlankId(crypto.randomUUID())
      changeItems([{ ...newItem(id, value.category), ...patch }])
      return
    }
    changeItems(value.lineItems.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  const addItem = () => {
    const id = crypto.randomUUID()
    setFocusId(id)
    // 空の入力行しかないときは、その行を置き換えるだけにして空行を2つ並べない
    changeItems([...value.lineItems, newItem(id, value.category)])
  }

  const submitCategory = () => {
    const name = categoryName.trim()
    if (!name) return
    onAddCategory(name)
    onChange({ ...value, category: name })
    setCategoryName("")
    setAddingCategory(false)
  }

  return (
    <div className="space-y-5">
      <label className={labelClass}>
        お店
        <input
          className={`${fieldClass} mt-1.5`}
          value={value.storeName}
          onChange={(event) => onChange({ ...value, storeName: event.target.value })}
          placeholder="お店の名前"
          enterKeyHint="next"
        />
      </label>

      <div>
        <p className={labelClass}>買ったもの</p>
        <div className="mt-1.5 grid grid-cols-[minmax(0,1fr)_5.5rem_3rem_2rem] gap-1.5 px-0.5 text-[11px] text-slate-400" aria-hidden="true">
          <span>品名</span>
          <span>単価</span>
          <span>個数</span>
          <span />
        </div>
        <div className="mt-1 space-y-1.5">
          {rows.map((item) => (
            <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_5.5rem_3rem_2rem] items-center gap-1.5">
              <input
                className={compactFieldClass}
                value={item.name}
                onChange={(event) => updateItem(item.id, { name: event.target.value })}
                placeholder="例：お弁当"
                aria-label="品名"
                autoFocus={item.id === focusId}
                enterKeyHint="next"
              />
              <input
                inputMode="numeric"
                className={compactFieldClass}
                value={item.price}
                onChange={(event) => updateItem(item.id, { price: event.target.value })}
                placeholder="¥0"
                aria-label="単価"
                enterKeyHint="next"
              />
              <input
                inputMode="numeric"
                className={`${compactFieldClass} text-center`}
                value={item.quantity}
                onChange={(event) => updateItem(item.id, { quantity: event.target.value })}
                placeholder="1"
                aria-label="個数"
              />
              {isBlankRow ? (
                <span />
              ) : (
                <button
                  type="button"
                  aria-label={`${item.name || "品目"}を削除`}
                  className="grid h-9 w-8 place-items-center rounded-lg text-lg text-slate-400 hover:bg-white/5 hover:text-red-300"
                  onClick={() => changeItems(value.lineItems.filter((entry) => entry.id !== item.id))}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
        <button type="button" className="ui-btn ui-btn-quiet mt-2 w-full border-dashed py-2 text-sm" onClick={addItem}>
          ＋ もう1品追加
        </button>
      </div>

      <div>
        <label className={labelClass}>
          合計
          <div className="ui-field mt-1.5 flex items-center gap-1 px-3 py-2">
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
        {sum > 0 && totalAmount === sum && <p className="mt-1.5 text-xs text-slate-400">買ったものから自動で計算しています</p>}
        {sum > 0 && totalAmount !== sum && (
          <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-slate-300">
            <span>買ったものの合計 {formatYen(sum)}</span>
            <button
              type="button"
              className="ui-btn ui-btn-quiet shrink-0 border-mint/60 px-3 py-1.5 text-xs text-mint"
              onClick={() => onChange({ ...value, total: String(sum) })}
            >
              合計に反映
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className={labelClass}>
          日付
          <input
            type="date"
            className={`${fieldClass} mt-1.5`}
            value={value.visitedAt}
            onChange={(event) => onChange({ ...value, visitedAt: event.target.value })}
          />
        </label>
        <label className={labelClass}>
          分類
          <select
            className={`${fieldClass} mt-1.5`}
            value={value.category}
            onChange={(event) => onChange({ ...value, category: event.target.value })}
          >
            <option value="">未選択</option>
            {categories.map((category) => (
              <option key={category.id} value={category.name}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {addingCategory ? (
        <div className="-mt-2 flex gap-2">
          <input
            className={fieldClass}
            value={categoryName}
            onChange={(event) => setCategoryName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                submitCategory()
              }
            }}
            placeholder="新しい分類の名前"
            aria-label="新しい分類の名前"
            autoFocus
          />
          <button type="button" className="ui-btn ui-btn-secondary shrink-0 px-4 py-2 text-sm" onClick={submitCategory}>
            追加
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-quiet shrink-0 px-3 py-2 text-sm"
            onClick={() => {
              setCategoryName("")
              setAddingCategory(false)
            }}
          >
            やめる
          </button>
        </div>
      ) : (
        <div className="-mt-3 flex justify-end">
          <button type="button" className="px-1 py-1 text-xs font-semibold text-mint" onClick={() => setAddingCategory(true)}>
            ＋ 分類を新しく作る
          </button>
        </div>
      )}

      <div>
        <p className={labelClass}>
          当てはまるものをタップ <span className="text-xs font-normal text-slate-400">（任意）</span>
        </p>
        <div className="mt-1.5 grid grid-cols-2 gap-3">
          <button
            type="button"
            aria-pressed={Boolean(value.isNomikai)}
            onClick={() => onChange({ ...value, isNomikai: !value.isNomikai })}
            className="ui-toggle ui-toggle-nomikai py-2.5 text-sm"
          >
            {value.isNomikai && <span aria-hidden="true">✓ </span>}🍺 飲み会
          </button>
          <button
            type="button"
            aria-pressed={Boolean(value.isJibara)}
            onClick={() => onChange({ ...value, isJibara: !value.isJibara })}
            className="ui-toggle ui-toggle-jibara py-2.5 text-sm"
          >
            {value.isJibara && <span aria-hidden="true">✓ </span>}👛 自腹
          </button>
        </div>
      </div>

      <label className={labelClass}>
        メモ <span className="text-xs font-normal text-slate-400">（任意）</span>
        <textarea
          rows={2}
          className={`${fieldClass} mt-1.5 font-normal`}
          value={value.note}
          onChange={(event) => onChange({ ...value, note: event.target.value })}
          placeholder="あとで見返したいこと"
        />
      </label>
    </div>
  )
}
