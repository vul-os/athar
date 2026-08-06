/** Number, time and money formatting shared across the dashboard. */

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const plain = new Intl.NumberFormat()

/**
 * Formats a count: exact below 10k, compact above, where the digits stop mattering.
 * @param {number | null | undefined} n
 * @returns {string}
 */
export function count(n) {
  if (n === null || n === undefined) return '—'
  return n < 10_000 ? plain.format(n) : compact.format(n)
}

/**
 * Formats a 0..1 ratio as a whole-number percentage.
 * @param {number | null | undefined} ratio
 * @returns {string}
 */
export function percent(ratio) {
  if (ratio === null || ratio === undefined) return '—'
  return `${Math.round(ratio * 100)}%`
}

/**
 * Formats a duration in seconds as m:ss, or Xs below a minute.
 * @param {number | null | undefined} seconds
 * @returns {string}
 */
export function duration(seconds) {
  if (!seconds || seconds < 1) return '0s'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/**
 * Formats a byte count for a human reading a file size.
 *
 * Binary units (1 KB here means 1024 bytes), which is what a browser's own
 * download UI and every file manager on a developer's machine report, so a
 * capture that shows as "412 KB" in the dashboard matches what they saw when
 * they took it. One decimal place from MB up: "1.4 MB" is useful, "1.437 MB"
 * is noise, and "1434 KB" is arithmetic the reader should not have to do.
 * @param {number | null | undefined} n
 * @returns {string}
 */
export function bytes(n) {
  if (n === null || n === undefined) return '—'
  if (n < 1024) return `${Math.round(n)} B`
  const kb = n / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/**
 * Formats integer minor units in a currency.
 *
 * The exponent comes from Intl rather than a hardcoded /100: JPY has no minor
 * unit at all and KWD has three, so dividing by 100 is wrong for both.
 * @param {number} amountMinor
 * @param {string} currency
 * @returns {string}
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

/**
 * Formats a bucket timestamp.
 *
 * `full` is for a tooltip, where the reader wants to know exactly which bucket
 * they are pointing at; the short form is for an axis, where labels have to fit
 * next to each other. Deriving both from the interval rather than the caller
 * keeps the axis and the tooltip from disagreeing about what a bucket is.
 * @param {number} ms
 * @param {string | undefined} interval
 * @param {boolean} [full]
 * @returns {string}
 */
export function bucketLabel(ms, interval, full = false) {
  const d = new Date(ms)
  const isDay = interval === 'day'

  if (full) {
    return isDay
      ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
      : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
  }
  return isDay
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : d.toLocaleTimeString(undefined, { hour: 'numeric' })
}

/**
 * Formats a signed percentage change, e.g. "+18%" / "−4%".
 * @param {number} current
 * @param {number | null | undefined} previous
 * @returns {{ value: number, label: string } | null}
 */
export function delta(current, previous) {
  if (!previous) return null
  const change = (current - previous) / previous
  if (!Number.isFinite(change)) return null
  const rounded = Math.round(change * 100)
  // U+2212 MINUS SIGN, not a hyphen: it aligns with digits at this weight.
  return { value: rounded, label: `${rounded >= 0 ? '+' : '−'}${Math.abs(rounded)}%` }
}

/** Named ranges offered by the range picker, as {from, to} in Unix ms. */
export const RANGES = [
  { key: '24h', label: '24 hours', hours: 24 },
  { key: '7d', label: '7 days', hours: 24 * 7 },
  { key: '30d', label: '30 days', hours: 24 * 30 },
  { key: '90d', label: '90 days', hours: 24 * 90 },
]

/**
 * @param {string} key
 * @returns {{ from: number, to: number }}
 */
export function rangeFor(key) {
  const spec = RANGES.find((r) => r.key === key) ?? DEFAULT_RANGE_SPEC
  const to = Date.now()
  return { from: to - spec.hours * 3600_000, to }
}

/**
 * The range a dashboard opens on when nobody has chosen one.
 *
 * Seven days rather than twenty-four hours. A day is the right default for a
 * high-traffic site, but Athar's typical instance is someone's own project on
 * their own box, and a day of that traffic is too thin to read: the chart has
 * few enough buckets to look like noise, and one page's clicks are too sparse
 * to form a heat field — so the feature people install Athar for looks broken
 * on the first visit. A week is dense enough to show shape without losing
 * recency, and the choice is remembered after the first change anyway.
 */
const DEFAULT_RANGE_KEY = '7d'
const DEFAULT_RANGE_SPEC = RANGES.find((r) => r.key === DEFAULT_RANGE_KEY) ?? RANGES[0]

const RANGE_STORAGE_KEY = 'athar-range'

/** Reads the remembered range, falling back to the default. */
export function storedRangeKey() {
  try {
    const value = localStorage.getItem(RANGE_STORAGE_KEY)
    if (RANGES.some((r) => r.key === value)) return value
  } catch {
    // Private-browsing modes can throw; the default is fine.
  }
  return DEFAULT_RANGE_KEY
}

/**
 * Remembers the chosen range, so the default only ever matters once.
 * @param {string} key
 */
export function persistRangeKey(key) {
  try {
    localStorage.setItem(RANGE_STORAGE_KEY, key)
  } catch {
    // Not being able to persist is not worth failing over.
  }
}
