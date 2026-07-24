import { delta } from '../lib/format.js'

/**
 * A headline metric: value, change against the previous period, and a sparkline.
 *
 * The sparkline is the reason this is a component rather than a styled div. A
 * bare number answers "how many"; the same number beside its own shape answers
 * "and is that normal", which is the question someone opening an analytics
 * dashboard actually has.
 */
export default function StatTile({
  label,
  value,
  current,
  previous,
  series,
  accent = false,
  invertDelta = false,
  className = '',
}) {
  const change = current !== undefined && previous ? delta(current, previous) : null

  // For most metrics up is good. For bounce rate it is the opposite, and
  // colouring a rising bounce rate green would be actively misleading.
  const good = change ? (invertDelta ? change.value < 0 : change.value > 0) : null

  return (
    <div className={`flex flex-col justify-between gap-2 bg-surface px-4 py-3 ${className}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium tracking-wide text-ink-faint uppercase">{label}</span>
        {change && change.value !== 0 && (
          <span
            className={`tnum shrink-0 text-xs font-medium ${good ? 'text-positive' : 'text-negative'}`}
            title="Compared with the previous period of the same length"
          >
            {change.label}
          </span>
        )}
      </div>

      <div className="flex items-end justify-between gap-3">
        <span className={`tnum text-2xl leading-none font-medium ${accent ? 'text-accent' : 'text-ink'}`}>
          {value ?? <span className="text-ink-faint">—</span>}
        </span>
        {series?.length > 1 && <Sparkline values={series} accent={accent} />}
      </div>
    </div>
  )
}

/** A minimal trend line. No axes: it conveys shape, and shape only. */
function Sparkline({ values, accent }) {
  const width = 64
  const height = 22
  const max = Math.max(1, ...values)

  const step = width / (values.length - 1)
  const path = values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - (v / max) * height).toFixed(1)}`)
    .join(' ')

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0 overflow-visible"
      aria-hidden="true"
    >
      <path
        d={path}
        fill="none"
        stroke={accent ? 'var(--color-accent)' : 'var(--color-ink-faint)'}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={accent ? 1 : 0.7}
      />
    </svg>
  )
}
