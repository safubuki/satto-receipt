import type { LineInsights } from "../lib/monthBreakdown"

const yen = (value: number) =>
  new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(value)

const shortDate = (visitedAt: string) => {
  const [, month, day] = visitedAt.split("-")
  if (!month || !day) return visitedAt
  return `${Number(month)}/${Number(day)}`
}

const place = (store: string, visitedAt: string) => {
  const date = shortDate(visitedAt)
  return store === "店名なし" ? date : `${date} ${store}`
}

const SourceNames = ({ name, sources }: { name: string; sources: string[] }) => {
  if (sources.length === 0 || (sources.length === 1 && sources[0] === name)) return null
  return <p className="text-xs leading-relaxed text-slate-400">{sources.join("、")}</p>
}

export const LineInsightsPanel = ({ insights }: { insights: LineInsights }) => {
  if (insights.receiptCount === 0) {
    return <p id="line-insights" className="mt-3 text-sm text-slate-300">この月のレシートはまだありません。</p>
  }
  if (insights.receiptsWithItems === 0) {
    return (
      <p id="line-insights" className="mt-3 text-sm leading-relaxed text-slate-300">
        この月のレシートに明細がないので、同じ品の繰り返しや単価の差は見えません。
      </p>
    )
  }

  return (
    <div id="line-insights" className="mt-3 space-y-4 rounded-2xl border border-white/10 p-3 text-sm leading-relaxed text-slate-200">
      <p>
        明細があるレシートは {insights.receiptsWithItems}件 / {insights.receiptCount}件です。明細の合計は {yen(insights.lineTotal)} です。
      </p>
      {insights.topItems.length > 0 && (
        <section>
          <h3 className="font-semibold text-white">金額が大きい品</h3>
          {insights.topSharePercent !== null && (
            <p className="mt-1">上位{insights.topItems.length}品で、明細の金額の {insights.topSharePercent}% です。</p>
          )}
          <ul className="mt-1 space-y-1">
            {insights.topItems.map((item) => (
              <li key={item.name}>
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0">{item.name}</span>
                  <span className="shrink-0 text-white">{yen(item.amount)}</span>
                </div>
                <SourceNames name={item.name} sources={item.sources} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h3 className="font-semibold text-white">繰り返している品</h3>
        {insights.repeats.length === 0 ? (
          <p className="mt-1">同じ品を2回以上買った記録は、この月の明細にはありません。</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {insights.repeats.map((item) => (
              <li key={item.name}>
                <p>
                  {item.name}を{item.receiptCount}回（数量{item.quantity}、{yen(item.amount)}）
                </p>
                <SourceNames name={item.name} sources={item.sources} />
              </li>
            ))}
          </ul>
        )}
      </section>
      {insights.priceGaps.length > 0 && (
        <section>
          <h3 className="font-semibold text-white">同じ品の単価の差</h3>
          <ul className="mt-1 space-y-2">
            {insights.priceGaps.map((gap) => (
              <li key={gap.name}>
                <p>
                  {gap.name}は {yen(gap.low.unitPrice)}（{place(gap.low.store, gap.low.visitedAt)}）と {yen(gap.high.unitPrice)}（{place(gap.high.store, gap.high.visitedAt)}）。差は {yen(gap.gap)} です。
                </p>
                <SourceNames name={gap.name} sources={gap.sources} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
