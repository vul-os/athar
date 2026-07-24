import { useCallback, useState } from 'react'
import { api } from '../api.js'
import Chart from './Chart.jsx'
import MetricPanel from './MetricPanel.jsx'
import { useAsyncData } from '../lib/useAsyncData.js'
import { count, duration, money, percent } from '../lib/format.js'

/** The per-website dashboard: headline metrics, traffic chart, breakdowns. */
export default function Overview({ website, range }) {
  const [pageMetric, setPageMetric] = useState('path')
  const [sourceMetric, setSourceMetric] = useState('referrer')
  const [techMetric, setTechMetric] = useState('browser')
  const [placeMetric, setPlaceMetric] = useState('country')

  // One loader for the three headline queries: they are always shown together,
  // so resolving them together avoids the panel updating in three stages.
  const load = useCallback(async () => {
    const [stats, series, revenue] = await Promise.all([
      api.stats(website.id, range),
      api.series(website.id, range),
      api.revenue(website.id, range),
    ])
    return { stats, series, revenue: revenue.totals }
  }, [website.id, range])

  const { data, error } = useAsyncData(load)
  const stats = data?.stats ?? null
  const series = data?.series ?? null
  const revenue = data?.revenue ?? null

  if (error) {
    return (
      <div className="rounded-lg border border-negative/30 bg-negative/10 px-4 py-3 text-sm text-negative">
        {error.message}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-5">
        <Stat label="Visitors" value={stats && count(stats.visitors)} accent />
        <Stat label="Pageviews" value={stats && count(stats.pageviews)} />
        <Stat label="Sessions" value={stats && count(stats.visits)} />
        <Stat label="Bounce rate" value={stats && percent(stats.bounce_rate)} />
        <Stat label="Avg. visit" value={stats && duration(stats.avg_visit_seconds)} />
      </div>

      {revenue?.length > 0 && (
        // Flex rather than a fixed grid: most sites report a single currency,
        // and a five-column grid holding one tile leaves a dead grey block
        // where the other four would be.
        <div className="flex flex-wrap gap-px overflow-hidden rounded-lg border border-line bg-line">
          {revenue.map((total) => (
            <Stat
              key={total.currency}
              label={`Revenue · ${total.currency}`}
              value={money(total.amount_minor, total.currency)}
              accent
              className="min-w-[12rem] flex-1"
            />
          ))}
        </div>
      )}

      <section className="rounded-lg border border-line bg-surface p-4">
        {series ? (
          <Chart points={series.points} interval={series.interval} />
        ) : (
          <div className="grid h-[200px] place-items-center text-sm text-ink-faint">Loading…</div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <MetricPanel
          websiteId={website.id}
          range={range}
          title="Pages"
          metric={pageMetric}
          onMetricChange={setPageMetric}
          tabs={[
            { metric: 'path', label: 'Top' },
            { metric: 'entry_path', label: 'Entry' },
            { metric: 'exit_path', label: 'Exit' },
          ]}
        />
        <MetricPanel
          websiteId={website.id}
          range={range}
          title="Sources"
          metric={sourceMetric}
          onMetricChange={setSourceMetric}
          tabs={[
            { metric: 'referrer', label: 'Referrers' },
            { metric: 'utm_source', label: 'Source' },
            { metric: 'utm_campaign', label: 'Campaign' },
          ]}
        />
        <MetricPanel
          websiteId={website.id}
          range={range}
          title="Technology"
          metric={techMetric}
          onMetricChange={setTechMetric}
          tabs={[
            { metric: 'browser', label: 'Browser' },
            { metric: 'os', label: 'OS' },
            { metric: 'device', label: 'Device' },
            { metric: 'screen', label: 'Screen' },
          ]}
        />
        <MetricPanel
          websiteId={website.id}
          range={range}
          title="Places"
          metric={placeMetric}
          onMetricChange={setPlaceMetric}
          tabs={[
            { metric: 'country', label: 'Country' },
            { metric: 'region', label: 'Region' },
            { metric: 'city', label: 'City' },
            { metric: 'language', label: 'Language' },
          ]}
        />
        <MetricPanel websiteId={website.id} range={range} title="Custom events" metric="event" />
      </div>
    </div>
  )
}

function Stat({ label, value, accent = false, className = '' }) {
  return (
    <div className={`bg-surface px-4 py-3 ${className}`}>
      <div className="text-xs font-medium tracking-wide text-ink-faint uppercase">{label}</div>
      <div className={`tnum mt-1 text-2xl font-medium ${accent ? 'text-accent' : 'text-ink'}`}>
        {value ?? <span className="text-ink-faint">—</span>}
      </div>
    </div>
  )
}
