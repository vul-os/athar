import { useCallback, useState } from 'react'
import { api } from '../api.js'
import Chart from './Chart.jsx'
import MetricPanel from './MetricPanel.jsx'
import StatTile from './StatTile.jsx'
import Heatmap from './Heatmap.jsx'
import { useAsyncData } from '../lib/useAsyncData.js'
import { count, duration, money, percent } from '../lib/format.js'

/** The per-website dashboard: headline metrics, traffic, breakdowns, heatmaps. */
export default function Overview({ website, range }) {
  const [pageMetric, setPageMetric] = useState('path')
  const [sourceMetric, setSourceMetric] = useState('referrer')
  const [techMetric, setTechMetric] = useState('browser')
  const [placeMetric, setPlaceMetric] = useState('country')

  // One loader for everything above the breakdowns. They are always shown
  // together, so resolving them together avoids the panel arriving in stages —
  // and the comparison request has to be issued alongside the current one
  // anyway, since every tile needs both to show a delta.
  const load = useCallback(async () => {
    const span = range.to - range.from
    const previousRange = { from: range.from - span, to: range.from }

    const [stats, series, revenue, previousStats, previousSeries] = await Promise.all([
      api.stats(website.id, range),
      api.series(website.id, range),
      api.revenue(website.id, range),
      api.stats(website.id, previousRange),
      api.series(website.id, previousRange),
    ])
    return { stats, series, revenue: revenue.totals, previousStats, previousSeries }
  }, [website.id, range])

  const { data, error } = useAsyncData(load)

  const stats = data?.stats ?? null
  const previous = data?.previousStats ?? null
  const series = data?.series ?? null
  const revenue = data?.revenue ?? null

  // The sparkline in each tile is the same series the chart draws, so the two
  // can never tell different stories about the same period.
  const views = series?.points?.map((p) => p.pageviews) ?? []
  const visitors = series?.points?.map((p) => p.visitors) ?? []

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
        <StatTile
          label="Visitors"
          value={stats && count(stats.visitors)}
          current={stats?.visitors}
          previous={previous?.visitors}
          series={visitors}
          accent
        />
        <StatTile
          label="Pageviews"
          value={stats && count(stats.pageviews)}
          current={stats?.pageviews}
          previous={previous?.pageviews}
          series={views}
        />
        <StatTile
          label="Sessions"
          value={stats && count(stats.visits)}
          current={stats?.visits}
          previous={previous?.visits}
        />
        <StatTile
          label="Bounce rate"
          value={stats && percent(stats.bounce_rate)}
          current={stats?.bounce_rate}
          previous={previous?.bounce_rate}
          // A rising bounce rate is bad news, so the delta colouring flips.
          invertDelta
        />
        <StatTile
          label="Avg. visit"
          value={stats && duration(stats.avg_visit_seconds)}
          current={stats?.avg_visit_seconds}
          previous={previous?.avg_visit_seconds}
        />
      </div>

      {revenue?.length > 0 && (
        // Flex rather than a fixed grid: most sites report a single currency,
        // and a five-column grid holding one tile leaves a dead block where the
        // other four would be.
        <div className="flex flex-wrap gap-px overflow-hidden rounded-lg border border-line bg-line">
          {revenue.map((total) => (
            <StatTile
              key={total.currency}
              label={`Revenue · ${total.currency}`}
              value={money(total.amount_minor, total.currency)}
              accent
              className="min-w-[12rem] flex-1"
            />
          ))}
        </div>
      )}

      <section className="panel p-4">
        {series ? (
          <Chart
            points={series.points}
            comparison={data?.previousSeries?.points}
            interval={series.interval}
          />
        ) : (
          <div className="grid h-[260px] place-items-center text-sm text-ink-faint">Loading…</div>
        )}
      </section>

      <Heatmap website={website} range={range} />

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
          emptyLabel="Direct"
          tabs={[
            { metric: 'referrer', label: 'Referrers' },
            { metric: 'utm_source', label: 'Source' },
            { metric: 'utm_medium', label: 'Medium' },
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
          flags={placeMetric === 'country'}
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
