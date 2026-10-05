import type { MonthBreakdown, SpendSlice } from "../lib/monthBreakdown"

const fallbackColors = ["#94a3b8", "#fb7185", "#f59e0b", "#38bdf8", "#a78bfa", "#ec4899", "#14b8a6", "#8b5cf6"]

const yen = (value: number) =>
  new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(value)

const point = (radius: number, angle: number) => {
  const radians = ((angle - 90) * Math.PI) / 180
  return [50 + radius * Math.cos(radians), 50 + radius * Math.sin(radians)] as const
}

const slicePath = (start: number, end: number) => {
  const sweep = end - start
  if (sweep >= 359.99) return "full" as const
  if (sweep <= 0) return null
  const large = sweep > 180 ? 1 : 0
  const [x1, y1] = point(42, start)
  const [x2, y2] = point(42, end)
  return `M 50 50 L ${x1.toFixed(2)} ${y1.toFixed(2)} A 42 42 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`
}

const sliceNote = (slice: SpendSlice, hasPrevious: boolean) => {
  if (!hasPrevious) return `${slice.percent}%`
  if (slice.previousTotal === 0) return `${slice.percent}% · 先月はなし`
  if (slice.delta === 0) return `${slice.percent}% · 先月と同じ`
  const amount = yen(Math.abs(slice.delta))
  const direction = slice.delta > 0 ? "多い" : "少ない"
  return `${slice.percent}% · 先月より ${amount} ${direction}`
}

export const CategoryBreakdown = ({
  breakdown,
  colors,
}: {
  breakdown: MonthBreakdown
  colors: ReadonlyMap<string, string>
}) => {
  const headline = !breakdown.hasPrevious
    ? "先月の支出はありません。"
    : breakdown.delta === 0
      ? "先月と同じ金額です。"
      : breakdown.delta > 0
        ? `先月より ${yen(breakdown.delta)} 多いです。`
        : `先月より ${yen(Math.abs(breakdown.delta))} 少ないです。`

  if (breakdown.slices.length === 0) {
    return (
      <div id="category-breakdown" className="mt-3 rounded-2xl border border-white/10 p-3">
        <p className="text-sm text-slate-300">この月の支出はまだありません。</p>
        {breakdown.hasPrevious && <p className="mt-1 text-sm text-slate-400">先月は {yen(breakdown.previousTotal)} でした。</p>}
      </div>
    )
  }

  let angle = 0
  const arcs = breakdown.slices.map((slice) => {
    const start = angle
    const end = angle + (slice.percent / 100) * 360
    angle = end
    return { slice, start, end }
  })

  return (
    <div id="category-breakdown" className="mt-3 rounded-2xl border border-white/10 p-3">
      <p className="text-center text-sm text-slate-200">{headline}</p>
      <svg viewBox="0 0 100 100" className="mx-auto mt-3 h-40 w-40" aria-hidden="true">
        {arcs.map(({ slice, start, end }, index) => {
          const color = colors.get(slice.name) ?? fallbackColors[index % fallbackColors.length]
          const path = slicePath(start, end)
          if (path === "full") return <circle key={slice.name} cx="50" cy="50" r="42" fill={color} />
          if (!path) return null
          return <path key={slice.name} d={path} fill={color} />
        })}
      </svg>
      <ul className="mt-3 space-y-2">
        {breakdown.slices.map((slice, index) => {
          const color = colors.get(slice.name) ?? fallbackColors[index % fallbackColors.length]
          return (
            <li key={slice.name} className="flex items-start justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                <span className="truncate text-slate-100">{slice.name}</span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-white">{yen(slice.total)}</span>
                <span className="block text-xs text-slate-400">{sliceNote(slice, breakdown.hasPrevious)}</span>
              </span>
            </li>
          )
        })}
      </ul>
      {breakdown.dropped.length > 0 && (
        <p className="mt-3 text-xs leading-relaxed text-slate-400">
          先月にあって今月はないもの: {breakdown.dropped.slice(0, 2).map((row) => `${row.name} ${yen(row.previousTotal)}`).join("、")}
        </p>
      )}
    </div>
  )
}
