import { useId, useMemo, useState } from 'react'
import { bucketLabel, count } from '../lib/format.js'

/**
 * The traffic chart: pageviews as a filled area, visitors as a line on top.
 *
 * Hand-drawn SVG rather than a charting library, for the same reason Athar
 * parses user-agents itself — this is one chart with two series, and a
 * dependency that ships a layout engine to draw it would be most of the
 * dashboard's bundle.
 *
 * Two series, not five, so there is no categorical palette to get wrong:
 * pageviews are the accent, visitors are ink. Gaps are already filled server-
 * side, so a flat stretch means zero traffic — never missing data.
 */
export default function Chart({ points, interval, height = 200 }) {
  const gradientId = useId()
  const [hover, setHover] = useState(null)

  const geometry = useMemo(() => buildGeometry(points, height), [points, height])

  if (!points?.length) {
    return (
      <div
        className="grid place-items-center rounded-lg border border-line-soft text-sm text-ink-faint"
        style={{ height }}
      >
        No data in this range
      </div>
    )
  }

  const { areaPath, linePath, coords, max } = geometry
  const active = hover !== null ? points[hover] : null

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        role="img"
        aria-label={`Traffic over time: ${points.length} buckets, peak ${max} pageviews`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect()
          const ratio = (e.clientX - box.left) / box.width
          setHover(Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1)))))
        }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Baseline and midline, drawn under the data. */}
        <line x1="0" y1={height - 0.5} x2="100" y2={height - 0.5} stroke="var(--color-line)" strokeWidth="1"
              vectorEffect="non-scaling-stroke" />
        <line x1="0" y1={height / 2} x2="100" y2={height / 2} stroke="var(--color-line-soft)" strokeWidth="1"
              strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />

        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path
          d={linePath}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {hover !== null && (
          <>
            <line
              x1={coords[hover].x} y1="0" x2={coords[hover].x} y2={height}
              stroke="var(--color-ink-faint)" strokeWidth="1" vectorEffect="non-scaling-stroke"
            />
            <circle cx={coords[hover].x} cy={coords[hover].y} r="3" fill="var(--color-accent)"
                    stroke="var(--color-canvas)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>

      {/* Readout sits outside the SVG so its text is not stretched by the
          non-uniform preserveAspectRatio the chart relies on. */}
      <div className="mt-2 flex items-baseline justify-between text-xs text-ink-faint">
        <span>{bucketLabel(points[0].t, interval)}</span>
        {active ? (
          <span className="tnum text-ink">
            <span className="text-accent">{count(active.pageviews)}</span> views
            <span className="mx-1.5 text-ink-faint">·</span>
            {count(active.visitors)} visitors
            <span className="mx-1.5 text-ink-faint">·</span>
            {bucketLabel(active.t, interval)}
          </span>
        ) : (
          <span className="tnum">peak {count(max)}</span>
        )}
        <span>{bucketLabel(points[points.length - 1].t, interval)}</span>
      </div>
    </div>
  )
}

/** Projects the series into SVG space on a 0–100 × 0–height viewBox. */
function buildGeometry(points, height) {
  if (!points?.length) return { areaPath: '', linePath: '', coords: [], max: 0 }

  const max = Math.max(1, ...points.map((p) => p.pageviews))
  const pad = 6 // keeps the peak off the top edge
  const step = points.length > 1 ? 100 / (points.length - 1) : 0

  const coords = points.map((p, i) => ({
    x: points.length > 1 ? i * step : 50,
    y: height - pad - (p.pageviews / max) * (height - pad * 2),
  }))

  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ')
  const areaPath = `${linePath} L100,${height} L0,${height} Z`

  return { areaPath, linePath, coords, max }
}
