import { useCallback, useMemo } from 'react'
import { api } from '../api.js'
import { useAsyncData } from '../lib/useAsyncData.js'
import { countryName, flagEmoji } from '../lib/countries.js'
import { count } from '../lib/format.js'

/**
 * A "top N" breakdown, rendered as labelled bars.
 *
 * Bars are proportional to the leader, not to the total. These lists are
 * truncated to N rows, so a share-of-total reading would be wrong the moment an
 * N+1th row exists — but the *share* shown as text is computed against the true
 * total the API reports, so the number stays honest even where the bar is only
 * relative.
 */
export default function MetricPanel({
  websiteId,
  metric,
  title,
  range,
  tabs,
  onMetricChange,
  flags = false,
  emptyLabel,
}) {
  const load = useCallback(
    () => api.metrics(websiteId, metric, range, 8),
    [websiteId, metric, range],
  )
  const { data, error, loading } = useAsyncData(load)

  const rows = data?.rows ?? null
  const max = rows?.length ? Math.max(...rows.map((r) => r.count)) : 1
  const total = useMemo(() => rows?.reduce((sum, r) => sum + r.count, 0) ?? 0, [rows])

  return (
    <section className="panel flex flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {tabs && (
          <div className="flex gap-0.5 rounded-md bg-raised p-0.5">
            {tabs.map((tab) => (
              <button
                key={tab.metric}
                onClick={() => onMetricChange(tab.metric)}
                className={`rounded px-2 py-1 text-xs transition ${
                  tab.metric === metric ? 'bg-line text-ink' : 'text-ink-faint hover:text-ink-muted'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="flex-1 px-4 py-3">
        {error && <Message tone="error">{error.message}</Message>}
        {!error && loading && <Message>Loading…</Message>}
        {!error && !loading && rows?.length === 0 && <Message>Nothing recorded yet</Message>}

        {rows?.length > 0 && (
          <ol className="space-y-0.5">
            {rows.map((row) => {
              const label = flags ? countryName(row.value) : row.value || emptyLabel || row.value
              const share = total ? Math.round((row.count / total) * 100) : 0

              return (
                <li
                  key={row.value}
                  className="relative flex items-center gap-3 rounded px-2 py-1.5"
                >
                  <div
                    className="absolute inset-y-0 left-0 rounded bg-accent-wash"
                    style={{ width: `${(row.count / max) * 100}%` }}
                    aria-hidden="true"
                  />
                  {flags && (
                    <span className="relative shrink-0 text-sm" aria-hidden="true">
                      {flagEmoji(row.value)}
                    </span>
                  )}
                  <span className="relative min-w-0 flex-1 truncate text-sm text-ink" title={label}>
                    {label}
                  </span>
                  <span className="tnum relative shrink-0 text-xs text-ink-faint">{share}%</span>
                  <span className="tnum relative w-12 shrink-0 text-right text-sm text-ink-muted">
                    {count(row.count)}
                  </span>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </section>
  )
}

function Message({ children, tone }) {
  return (
    <p className={`py-8 text-center text-sm ${tone === 'error' ? 'text-negative' : 'text-ink-faint'}`}>
      {children}
    </p>
  )
}
