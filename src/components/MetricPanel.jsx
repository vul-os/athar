import { useCallback } from 'react'
import { api } from '../api.js'
import { useAsyncData } from '../lib/useAsyncData.js'
import { count } from '../lib/format.js'

/**
 * A "top N" breakdown, rendered as labelled bars.
 *
 * Bars are proportional to the leader rather than to the total: these lists are
 * truncated to N rows, so a share-of-total reading would be wrong the moment
 * there is an N+1th row. Relative-to-leader is honest about what is shown.
 */
export default function MetricPanel({ websiteId, metric, title, range, tabs, onMetricChange }) {
  const load = useCallback(
    () => api.metrics(websiteId, metric, range),
    [websiteId, metric, range],
  )
  const { data, error, loading } = useAsyncData(load)

  const rows = data?.rows ?? null
  const max = rows?.length ? Math.max(...rows.map((r) => r.count)) : 1

  return (
    <section className="rounded-lg border border-line bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
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

      <div className="px-4 py-3">
        {error && <p className="py-6 text-center text-sm text-negative">{error.message}</p>}
        {!error && loading && <p className="py-6 text-center text-sm text-ink-faint">Loading…</p>}
        {!error && rows?.length === 0 && (
          <p className="py-6 text-center text-sm text-ink-faint">Nothing recorded yet</p>
        )}

        {rows?.length > 0 && (
          <ol className="space-y-1">
            {rows.map((row) => (
              <li key={row.value} className="relative flex items-center justify-between gap-4 rounded px-2 py-1.5">
                {/* The bar is a background layer so the label always sits on
                    top of it and stays readable at any width. */}
                <div
                  className="absolute inset-y-0 left-0 rounded bg-accent/12"
                  style={{ width: `${(row.count / max) * 100}%` }}
                  aria-hidden="true"
                />
                <span className="relative truncate text-sm text-ink" title={row.value}>
                  {row.value}
                </span>
                <span className="tnum relative shrink-0 text-sm text-ink-muted">{count(row.count)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  )
}
