/** Number, time and money formatting shared across the dashboard. */

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const plain = new Intl.NumberFormat()

/** Formats a count: exact below 10k, compact above, where the digits stop mattering. */
export function count(n) {
  if (n === null || n === undefined) return '—'
  return n < 10_000 ? plain.format(n) : compact.format(n)
}

/** Formats a 0..1 ratio as a whole-number percentage. */
export function percent(ratio) {
  if (ratio === null || ratio === undefined) return '—'
  return `${Math.round(ratio * 100)}%`
}

/** Formats a duration in seconds as m:ss, or Xs below a minute. */
export function duration(seconds) {
  if (!seconds || seconds < 1) return '0s'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/**
 * Formats integer minor units in a currency.
 *
 * The exponent comes from Intl rather than a hardcoded /100: JPY has no minor
 * unit at all and KWD has three, so dividing by 100 is wrong for both.
 */
export function money(amountMinor, currency) {
  try {
    const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency })
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2
    return fmt.format(amountMinor / 10 ** digits)
  } catch {
    // An unknown currency code should still render a number, not throw.
    return `${plain.format(amountMinor / 100)} ${currency}`
  }
}

/** Formats a bucket timestamp for an axis label. */
export function bucketLabel(ms, interval) {
  const d = new Date(ms)
  return interval === 'day'
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : d.toLocaleTimeString(undefined, { hour: 'numeric' })
}

/** Named ranges offered by the range picker, as {from, to} in Unix ms. */
export const RANGES = [
  { key: '24h', label: '24 hours', hours: 24 },
  { key: '7d', label: '7 days', hours: 24 * 7 },
  { key: '30d', label: '30 days', hours: 24 * 30 },
  { key: '90d', label: '90 days', hours: 24 * 90 },
]

export function rangeFor(key) {
  const spec = RANGES.find((r) => r.key === key) ?? RANGES[0]
  const to = Date.now()
  return { from: to - spec.hours * 3600_000, to }
}
