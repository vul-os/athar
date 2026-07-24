import { useId, useMemo, useRef, useState } from 'react'
import { bucketLabel, count } from '../lib/format.js'

/**
 * The traffic chart: pageviews as a filled area, visitors as a line, and the
 * previous period as a faint dashed ghost behind both.
 *
 * Hand-drawn SVG rather than a charting library, for the same reason Athar
 * parses user-agents itself — this is one chart, and a dependency that ships a
 * layout engine to draw it would be most of the dashboard's bundle.
 *
 * Two design rules it follows, both of which the earlier version got wrong:
 *
 *   - The geometry is laid out in a real coordinate space with margins, so the
 *     axis labels are drawn in the same space as the data and stay legible.
 *     Stretching a 0–100 viewBox to the container (the old approach) distorts
 *     any text or circle inside it.
 *   - Only two live series, so there is no categorical palette to get wrong.
 *     Pageviews carry the accent; visitors are neutral ink; the comparison is
 *     the same shape at low contrast, which reads as "the past" without
 *     needing a third hue.
 */

const MARGIN = { top: 12, right: 8, bottom: 24, left: 44 }

export default function Chart({ points, comparison, interval, height = 260 }) {
  const gradientId = useId()
  const svgRef = useRef(null)
  const [hoverIndex, setHoverIndex] = useState(null)

  const width = 800 // viewBox width; the SVG scales to its container
  const plot = useMemo(
    () => buildPlot({ points, comparison, width, height, interval }),
    [points, comparison, width, height, interval],
  )

  if (!points?.length) {
    return (
      <div
        className="grid place-items-center rounded-lg border border-dashed border-line text-sm text-ink-faint"
        style={{ height }}
      >
        No traffic in this range
      </div>
    )
  }

  const { areaPath, linePath, visitorPath, comparePath, coords, ticks, xLabels, innerW, innerH } = plot
  const active = hoverIndex !== null ? points[hoverIndex] : null
  const activeCompare = hoverIndex !== null ? comparison?.[hoverIndex] : null

  function handleMove(event) {
    const svg = svgRef.current
    if (!svg) return
    const box = svg.getBoundingClientRect()
    // Map the pointer into viewBox space, then into a bucket index.
    const xInView = ((event.clientX - box.left) / box.width) * width
    const ratio = (xInView - MARGIN.left) / innerW
    const index = Math.round(ratio * (points.length - 1))
    setHoverIndex(Math.min(points.length - 1, Math.max(0, index)))
  }

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="w-full touch-none"
        style={{ height }}
        role="img"
        aria-label={`Traffic over time. Peak ${ticks[ticks.length - 1].value} pageviews per ${interval}.`}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Horizontal gridlines with value labels. Four lines is enough to read
            a magnitude off the chart and few enough not to become the subject. */}
        {ticks.map((tick) => (
          <g key={tick.value}>
            <line
              x1={MARGIN.left}
              y1={tick.y}
              x2={MARGIN.left + innerW}
              y2={tick.y}
              stroke="var(--color-line-soft)"
              strokeWidth="1"
            />
            <text
              x={MARGIN.left - 8}
              y={tick.y + 3.5}
              textAnchor="end"
              className="tnum"
              fontSize="10"
              fill="var(--color-ink-faint)"
            >
              {count(tick.value)}
            </text>
          </g>
        ))}

        {/* Time axis */}
        {xLabels.map((label) => (
          <text
            key={label.x}
            x={label.x}
            y={height - 6}
            textAnchor="middle"
            fontSize="10"
            fill="var(--color-ink-faint)"
          >
            {label.text}
          </text>
        ))}

        {comparePath && (
          <path
            d={comparePath}
            fill="none"
            stroke="var(--color-ink-faint)"
            strokeWidth="1.5"
            strokeDasharray="4 4"
            strokeOpacity="0.55"
            strokeLinejoin="round"
          />
        )}

        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path
          d={linePath}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          d={visitorPath}
          fill="none"
          stroke="var(--color-series-2)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {hoverIndex !== null && (
          <g>
            <line
              x1={coords[hoverIndex].x}
              y1={MARGIN.top}
              x2={coords[hoverIndex].x}
              y2={MARGIN.top + innerH}
              stroke="var(--color-ink-faint)"
              strokeWidth="1"
              strokeOpacity="0.6"
            />
            <circle
              cx={coords[hoverIndex].x}
              cy={coords[hoverIndex].y}
              r="3.5"
              fill="var(--color-accent)"
              stroke="var(--color-surface)"
              strokeWidth="2"
            />
            <circle
              cx={coords[hoverIndex].x}
              cy={coords[hoverIndex].yVisitors}
              r="3"
              fill="var(--color-series-2)"
              stroke="var(--color-surface)"
              strokeWidth="2"
            />
          </g>
        )}
      </svg>

      {/* The tooltip is HTML, not SVG: it needs to wrap, use the app's type
          scale, and stay readable regardless of how the SVG is scaled. */}
      {active && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-[9.5rem] rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-lg"
          style={{
            left: `${(coords[hoverIndex].x / width) * 100}%`,
            transform:
              coords[hoverIndex].x > width * 0.7 ? 'translateX(-105%)' : 'translateX(12px)',
          }}
        >
          <div className="mb-1 font-medium text-ink">{bucketLabel(active.t, interval, true)}</div>
          <Row swatch="var(--color-accent)" label="Pageviews" value={count(active.pageviews)} />
          <Row swatch="var(--color-series-2)" label="Visitors" value={count(active.visitors)} />
          {activeCompare && (
            <Row
              swatch="var(--color-ink-faint)"
              label="Previous"
              value={count(activeCompare.pageviews)}
              dashed
            />
          )}
        </div>
      )}

      <Legend hasComparison={Boolean(comparePath)} />
    </div>
  )
}

function Row({ swatch, label, value, dashed = false }) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <span className="flex items-center gap-1.5 text-ink-muted">
        <span
          className="inline-block h-0.5 w-3 rounded-full"
          style={{
            background: dashed ? 'none' : swatch,
            borderTop: dashed ? `2px dashed ${swatch}` : 'none',
          }}
        />
        {label}
      </span>
      <span className="tnum text-ink">{value}</span>
    </div>
  )
}

function Legend({ hasComparison }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-4 text-xs text-ink-faint">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-3.5 rounded-full bg-accent" />
        Pageviews
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-3.5 rounded-full bg-series-2" />
        Visitors
      </span>
      {hasComparison && (
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-3.5"
            style={{ borderTop: '2px dashed var(--color-ink-faint)' }}
          />
          Previous period
        </span>
      )}
    </div>
  )
}

/** Projects the series into SVG coordinates and derives the axes. */
function buildPlot({ points, comparison, width, height, interval }) {
  const innerW = width - MARGIN.left - MARGIN.right
  const innerH = height - MARGIN.top - MARGIN.bottom

  const peak = Math.max(
    1,
    ...points.map((p) => p.pageviews),
    ...(comparison ?? []).map((p) => p.pageviews),
  )
  const top = niceCeiling(peak)

  const x = (i) => MARGIN.left + (points.length > 1 ? (i / (points.length - 1)) * innerW : innerW / 2)
  const y = (value) => MARGIN.top + innerH - (value / top) * innerH

  const coords = points.map((p, i) => ({
    x: x(i),
    y: y(p.pageviews),
    yVisitors: y(p.visitors),
  }))

  const line = (values) =>
    values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ')

  const linePath = line(points.map((p) => p.pageviews))
  const visitorPath = line(points.map((p) => p.visitors))
  const areaPath = `${linePath} L${x(points.length - 1).toFixed(2)},${(MARGIN.top + innerH).toFixed(2)} L${MARGIN.left},${(MARGIN.top + innerH).toFixed(2)} Z`

  // Only draw the comparison when it covers the same number of buckets;
  // a mismatched length would silently misalign the two periods.
  const comparePath =
    comparison?.length === points.length ? line(comparison.map((p) => p.pageviews)) : null

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
    value: Math.round(top * fraction),
    y: y(top * fraction),
  }))

  // Roughly six labels, always including the first and last bucket.
  const step = Math.max(1, Math.ceil(points.length / 6))
  const xLabels = []
  for (let i = 0; i < points.length; i += step) {
    xLabels.push({ x: x(i), text: bucketLabel(points[i].t, interval, false) })
  }

  return { areaPath, linePath, visitorPath, comparePath, coords, ticks, xLabels, innerW, innerH }
}

/**
 * Picks an axis maximum whose quarters are also round numbers.
 *
 * Rounding the *maximum* alone is not enough: a peak of 40 rounds to 50, whose
 * quarters are 12.5 and 37.5, and the axis ends up reading 0 / 13 / 25 / 38 / 50.
 * Rounding the *step* instead and multiplying by four gives 0 / 10 / 20 / 30 / 40
 * — values someone would actually say out loud.
 */
function niceCeiling(value) {
  if (value <= 4) return 4

  const rawStep = value / TICK_COUNT
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))

  // Smallest candidate step that covers the data. The wider set (3, 4, 1.5…)
  // exists to keep headroom tight: with only 1/2/5, a peak of 120 would round
  // up to 200 and two-fifths of the chart would be empty.
  for (const candidate of STEP_CANDIDATES) {
    const step = candidate * magnitude
    // Counts are whole numbers, so a fractional gridline label would be noise.
    if (!Number.isInteger(step)) continue
    if (step >= rawStep) return step * TICK_COUNT
  }
  return magnitude * 10 * TICK_COUNT
}

const TICK_COUNT = 4
const STEP_CANDIDATES = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
