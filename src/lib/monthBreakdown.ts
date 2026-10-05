import { shiftMonth } from "./date"

export type SpendSlice = {
  name: string
  total: number
  count: number
  previousTotal: number
  delta: number
  percent: number
}

export type SpendChange = {
  name: string
  total: number
  previousTotal: number
  delta: number
}

export type MonthBreakdown = {
  month: string
  previousMonth: string
  total: number
  count: number
  previousTotal: number
  previousCount: number
  hasPrevious: boolean
  delta: number
  slices: SpendSlice[]
  /** 今月の金額がいちばん大きい分類。円グラフの説明に使う。 */
  lead: SpendSlice | null
  /**
   * 文章にしてよい増減。小さい差は円グラフと合計の比較で足りるので、ここには出さない。
   * 1,000円以上、または両方に金額があるときの25%以上。1,000円未満の新規・消滅は出さない。
   */
  leadChange: SpendChange | null
  /** 先月にあって今月は0円の分類。金額の大きい順。 */
  dropped: SpendChange[]
}

type SpendReceipt = {
  visitedAt?: string
  total: number
  category?: string
  lineItems?: readonly {
    name?: string
    price?: number
    quantity?: number
  }[]
}

export type MonthFood = {
  name: string
  quantity: number
  amount: number
}

/** 3.8 Flash の食生活コメントに渡す品名。金額の大きい順で、先頭だけ残す。 */
export const FOOD_LIMIT = 20

export const collectMonthFoods = (
  receipts: readonly SpendReceipt[],
  month: string,
  limit = FOOD_LIMIT,
): { foods: MonthFood[]; omitted: number } => {
  const totals = new Map<string, { quantity: number; amount: number }>()
  for (const receipt of receipts) {
    if (!(receipt.visitedAt ?? "").startsWith(month)) continue
    for (const item of receipt.lineItems ?? []) {
      const name = item.name?.trim().replace(/\s+/g, " ") ?? ""
      if (!name) continue
      const quantity = Number(item.quantity) || 1
      const price = Number.isFinite(item.price) ? Number(item.price) : 0
      const row = totals.get(name) ?? { quantity: 0, amount: 0 }
      row.quantity += quantity
      row.amount += price * quantity
      totals.set(name, row)
    }
  }
  const foods = Array.from(totals.entries())
    .map(([name, row]) => ({ name, quantity: row.quantity, amount: row.amount }))
    .sort((a, b) => b.amount - a.amount || b.quantity - a.quantity || a.name.localeCompare(b.name, "ja"))
  return {
    foods: foods.slice(0, limit),
    omitted: Math.max(0, foods.length - limit),
  }
}

export type ItemGroup = {
  label: string
  names: string[]
}

export type RepeatedItem = {
  name: string
  receiptCount: number
  quantity: number
  amount: number
  /** このグループに入った、レシート上の表記。 */
  sources: string[]
}

export type SpendRank = {
  name: string
  amount: number
  quantity: number
  sources: string[]
}

/** 1か月分の明細を突き合わせて初めて言えること。アドバイス文は作らない。 */
export type LineInsights = {
  receiptCount: number
  receiptsWithItems: number
  lineTotal: number
  namedItemCount: number
  topItems: SpendRank[]
  /** 表示している上位品が、明細金額に占める割合。品目が上位より多いときだけ意味がある。 */
  topSharePercent: number | null
  repeats: RepeatedItem[]
}

const itemName = (name: string | undefined) => name?.trim().replace(/\s+/g, " ") ?? ""

const shortMoney = (value: number) => Math.round(value)

const NAME_LIMIT = 200

/** その月の明細に出た品名。分類へ渡す一覧で、表記のゆれはまだまとめていない。 */
export const collectMonthItemNames = (
  receipts: readonly SpendReceipt[],
  month: string,
): string[] => {
  const names = new Set<string>()
  for (const receipt of receipts) {
    if (!(receipt.visitedAt ?? "").startsWith(month)) continue
    for (const item of receipt.lineItems ?? []) {
      const name = itemName(item.name)
      if (name) names.add(name)
    }
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b, "ja")).slice(0, NAME_LIMIT)
}

/** モデルの分類を、実在する品名だけに適用する。同じ品名が複数グループにあれば先のグループを使う。 */
export const itemLabelMap = (names: readonly string[], groups: readonly ItemGroup[]): Map<string, string> => {
  const known = new Set(names.map((name) => itemName(name)).filter(Boolean))
  const labels = new Map<string, string>()
  for (const group of groups) {
    const members = group.names.map((name) => itemName(name)).filter((name) => known.has(name))
    const label = itemName(group.label) || members[0]
    if (!label) continue
    for (const name of members) {
      if (!labels.has(name)) labels.set(name, label)
    }
  }
  return labels
}

export const buildLineInsights = (
  receipts: readonly (SpendReceipt & { id?: string; storeName?: string })[],
  month: string,
  labelMap?: ReadonlyMap<string, string>,
): LineInsights => {
  const inMonth = receipts.filter((receipt) => (receipt.visitedAt ?? "").startsWith(month))
  type Observation = {
    receiptId: string
    name: string
    quantity: number
    unitPrice: number
    amount: number
    store: string
    visitedAt: string
  }
  const observations: Observation[] = []
  let receiptsWithItems = 0

  inMonth.forEach((receipt, index) => {
    const named = (receipt.lineItems ?? []).filter((item) => itemName(item.name))
    if (named.length === 0) return
    receiptsWithItems += 1
    const receiptId = receipt.id || `${receipt.visitedAt ?? ""}-${index}`
    const store = receipt.storeName?.trim() || "店名なし"
    const visitedAt = receipt.visitedAt ?? ""
    for (const item of named) {
      const quantity = Number(item.quantity) || 1
      const unitPrice = Number.isFinite(item.price) ? Number(item.price) : 0
      observations.push({
        receiptId,
        name: itemName(item.name),
        quantity,
        unitPrice,
        amount: shortMoney(unitPrice * quantity),
        store,
        visitedAt,
      })
    }
  })

  const labels = labelMap ?? new Map<string, string>()
  const byName = new Map<string, { rows: Observation[]; sources: Set<string> }>()
  for (const observation of observations) {
    const label = labels.get(observation.name) || observation.name
    const bucket = byName.get(label) ?? { rows: [], sources: new Set<string>() }
    bucket.rows.push(observation)
    bucket.sources.add(observation.name)
    byName.set(label, bucket)
  }

  const sourcesOf = (sources: Set<string>) => Array.from(sources).sort((a, b) => a.localeCompare(b, "ja"))

  const repeats = Array.from(byName.entries())
    .map(([name, bucket]) => ({
      name,
      receiptCount: new Set(bucket.rows.map((row) => row.receiptId)).size,
      quantity: bucket.rows.reduce((sum, row) => sum + row.quantity, 0),
      amount: bucket.rows.reduce((sum, row) => sum + row.amount, 0),
      sources: sourcesOf(bucket.sources),
    }))
    .filter((item) => item.receiptCount >= 2)
    .sort((a, b) => b.receiptCount - a.receiptCount || b.amount - a.amount || a.name.localeCompare(b.name, "ja"))
    .slice(0, 5)

  const ranked = Array.from(byName.entries())
    .map(([name, bucket]) => ({
      name,
      amount: bucket.rows.reduce((sum, row) => sum + row.amount, 0),
      quantity: bucket.rows.reduce((sum, row) => sum + row.quantity, 0),
      sources: sourcesOf(bucket.sources),
    }))
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "ja"))
  const lineTotal = ranked.reduce((sum, item) => sum + item.amount, 0)
  const topItems = ranked.slice(0, 3)
  const topAmount = topItems.reduce((sum, item) => sum + item.amount, 0)
  const topSharePercent = ranked.length > topItems.length && lineTotal > 0
    ? Math.round((topAmount / lineTotal) * 100)
    : null

  return {
    receiptCount: inMonth.length,
    receiptsWithItems,
    lineTotal,
    namedItemCount: byName.size,
    topItems,
    topSharePercent,
    repeats,
  }
}

const EMPTY_NAME = "未分類"

const bucket = () => ({ total: 0, count: 0 })

/** 表示用の整数パーセント。合計が100になるよう、端数の大きい分類から1%ずつ足す。 */
export const percentShares = (totals: number[]): number[] => {
  const sum = totals.reduce((acc, value) => acc + value, 0)
  if (sum <= 0) return totals.map(() => 0)
  const raw = totals.map((value) => (value / sum) * 100)
  const floors = raw.map((value) => Math.floor(value))
  let leftover = 100 - floors.reduce((acc, value) => acc + value, 0)
  const order = raw
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index)
  for (const item of order) {
    if (leftover <= 0) break
    floors[item.index] += 1
    leftover -= 1
  }
  return floors
}

const notableChange = (delta: number, total: number, previousTotal: number) => {
  const amount = Math.abs(delta)
  if (amount === 0) return false
  if (amount >= 1000) return true
  // ゼロとの行き来は割合が必ず100%になる。小さい金額は円グラフ側の注記で足りる。
  if (total === 0 || previousTotal === 0) return false
  const base = Math.max(total, previousTotal)
  return amount / base >= 0.25
}

const categoryName = (category: string | undefined) => {
  const name = category?.trim()
  return name ? name : EMPTY_NAME
}

export const buildMonthBreakdown = (receipts: readonly SpendReceipt[], month: string): MonthBreakdown => {
  const previousMonth = shiftMonth(month, -1)
  const current = new Map<string, { total: number; count: number }>()
  const previous = new Map<string, { total: number; count: number }>()
  let total = 0
  let count = 0
  let previousTotal = 0
  let previousCount = 0

  for (const receipt of receipts) {
    const visitedAt = receipt.visitedAt ?? ""
    const amount = Number.isFinite(receipt.total) ? receipt.total : 0
    const name = categoryName(receipt.category)
    if (visitedAt.startsWith(month)) {
      const row = current.get(name) ?? bucket()
      row.total += amount
      row.count += 1
      current.set(name, row)
      total += amount
      count += 1
    } else if (visitedAt.startsWith(previousMonth)) {
      const row = previous.get(name) ?? bucket()
      row.total += amount
      row.count += 1
      previous.set(name, row)
      previousTotal += amount
      previousCount += 1
    }
  }

  const names = Array.from(current.entries())
    .filter(([, row]) => row.total > 0)
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0], "ja"))
    .map(([name]) => name)
  const percents = percentShares(names.map((name) => current.get(name)?.total ?? 0))
  const slices = names
    .map((name, index) => {
      const row = current.get(name) ?? bucket()
      const earlier = previous.get(name)?.total ?? 0
      return {
        name,
        total: row.total,
        count: row.count,
        previousTotal: earlier,
        delta: row.total - earlier,
        percent: percents[index] ?? 0,
      }
    })
  const dropped = Array.from(previous.entries())
    .filter(([name, row]) => row.total > 0 && (current.get(name)?.total ?? 0) <= 0)
    .map(([name, row]) => ({
      name,
      total: 0,
      previousTotal: row.total,
      delta: -row.total,
    }))
    .sort((a, b) => b.previousTotal - a.previousTotal || a.name.localeCompare(b.name, "ja"))

  const changes: SpendChange[] = [
    ...slices.map((slice) => ({
      name: slice.name,
      total: slice.total,
      previousTotal: slice.previousTotal,
      delta: slice.delta,
    })),
    ...dropped,
  ]
  const leadChange = changes
    .filter((change) => notableChange(change.delta, change.total, change.previousTotal))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.total - a.total)[0] ?? null

  return {
    month,
    previousMonth,
    total,
    count,
    previousTotal,
    previousCount,
    hasPrevious: previousCount > 0,
    delta: total - previousTotal,
    slices,
    lead: slices[0] ?? null,
    leadChange: previousCount > 0 ? leadChange : null,
    dropped,
  }
}
