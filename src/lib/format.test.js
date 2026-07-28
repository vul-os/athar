import { describe, expect, it } from 'vitest'

import * as format from './format.js'
import {
  RANGES,
  bucketLabel,
  count,
  delta,
  duration,
  money,
  percent,
  persistRangeKey,
  rangeFor,
  storedRangeKey,
} from './format.js'

/**
 * Unit tests for the dashboard's formatting layer.
 *
 * Two things about how this file is written are deliberate.
 *
 * **Locale.** `count`, `money` and `bucketLabel` go through `Intl` with the
 * ambient locale, so their exact output is a property of the machine, not of
 * Athar. Rather than pinning `en-US` (which would make the suite assert
 * something the product never guarantees) or asserting nothing (which would
 * make the gate pass by doing nothing), each locale-sensitive expectation is
 * built from an explicit `Intl` formatter here in the test. That still catches
 * every bug the function can actually have — wrong threshold, wrong currency
 * exponent, wrong interval branch — because those are choices `format.js`
 * makes, not choices `Intl` makes.
 *
 * **Coverage.** `exercisesEveryExport` below asserts that every export of
 * format.js is named in this file. Adding an export without a test fails the
 * suite rather than quietly widening the untested surface.
 */

const exercised = new Set([
  'count',
  'percent',
  'duration',
  'money',
  'bucketLabel',
  'delta',
  'RANGES',
  'rangeFor',
  'storedRangeKey',
  'persistRangeKey',
])

describe('coverage', () => {
  it('exercises every export of format.js', () => {
    const exported = Object.keys(format).sort()
    expect(exported.length).toBeGreaterThan(0)
    expect(exported).toEqual([...exercised].sort())
  })
})

describe('count', () => {
  const plain = new Intl.NumberFormat()
  const compact = new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  })

  it('renders an em dash for a missing value rather than 0 or NaN', () => {
    expect(count(null)).toBe('—')
    expect(count(undefined)).toBe('—')
  })

  it('keeps 0 as a real zero, not a missing value', () => {
    expect(count(0)).toBe(plain.format(0))
  })

  it('is exact below the 10k threshold and compact at or above it', () => {
    expect(count(9_999)).toBe(plain.format(9_999))
    expect(count(10_000)).toBe(compact.format(10_000))
    expect(count(1_250_000)).toBe(compact.format(1_250_000))
  })
})

describe('percent', () => {
  it('renders a 0..1 ratio as a whole-number percentage', () => {
    expect(percent(0)).toBe('0%')
    expect(percent(0.5)).toBe('50%')
    expect(percent(1)).toBe('100%')
  })

  it('rounds to the nearest whole percent', () => {
    expect(percent(0.126)).toBe('13%')
    expect(percent(0.124)).toBe('12%')
  })

  it('renders an em dash for a missing value', () => {
    expect(percent(null)).toBe('—')
    expect(percent(undefined)).toBe('—')
  })
})

describe('duration', () => {
  it('floors sub-second and falsy values to 0s', () => {
    expect(duration(0)).toBe('0s')
    expect(duration(0.4)).toBe('0s')
    expect(duration(null)).toBe('0s')
    expect(duration(undefined)).toBe('0s')
  })

  it('uses bare seconds below a minute', () => {
    expect(duration(1)).toBe('1s')
    expect(duration(59)).toBe('59s')
    expect(duration(59.6)).toBe('1m 00s')
  })

  it('zero-pads the seconds field so times stay column-aligned', () => {
    expect(duration(60)).toBe('1m 00s')
    expect(duration(65)).toBe('1m 05s')
    expect(duration(3599)).toBe('59m 59s')
  })

  it('switches to hours and zero-pads the minutes field', () => {
    expect(duration(3600)).toBe('1h 00m')
    expect(duration(3600 + 5 * 60)).toBe('1h 05m')
    expect(duration(26 * 3600 + 30 * 60)).toBe('26h 30m')
  })
})

describe('money', () => {
  // Minor units are integers on the wire; the exponent is per-currency, which
  // is the whole reason this helper exists instead of a /100.
  const asCurrency = (minor, currency) => {
    const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency })
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2
    return fmt.format(minor / 10 ** digits)
  }

  it('divides by the currency exponent, not always by 100', () => {
    expect(money(4999, 'USD')).toBe(asCurrency(4999, 'USD'))
    // JPY has no minor unit: 4999 minor units is ¥4,999, not ¥49.99.
    expect(money(4999, 'JPY')).toBe(asCurrency(4999, 'JPY'))
    // KWD has three: 4999 minor units is 4.999 dinars.
    expect(money(4999, 'KWD')).toBe(asCurrency(4999, 'KWD'))
  })

  it('never throws on an unknown currency code', () => {
    const out = money(4999, 'ZZZ')
    expect(typeof out).toBe('string')
    expect(out).toContain('ZZZ')
  })
})

describe('bucketLabel', () => {
  const ms = Date.UTC(2026, 6, 24, 15, 0, 0)

  it('picks a date-only label for day buckets and a time label for hour buckets', () => {
    const d = new Date(ms)
    expect(bucketLabel(ms, 'day')).toBe(
      d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    )
    expect(bucketLabel(ms, 'hour')).toBe(
      d.toLocaleTimeString(undefined, { hour: 'numeric' }),
    )
  })

  it('gives the tooltip form more context than the axis form', () => {
    expect(bucketLabel(ms, 'day', true)).not.toBe(bucketLabel(ms, 'day'))
    expect(bucketLabel(ms, 'hour', true)).not.toBe(bucketLabel(ms, 'hour'))
  })

  it('treats any non-"day" interval as an hour bucket', () => {
    expect(bucketLabel(ms, 'hour')).toBe(bucketLabel(ms, undefined))
  })
})

describe('delta', () => {
  it('returns null when there is no previous period to compare against', () => {
    // Dividing by zero would render "+Infinity%" next to a stat tile.
    expect(delta(10, 0)).toBeNull()
    expect(delta(10, null)).toBeNull()
    expect(delta(10, undefined)).toBeNull()
  })

  it('labels a rise with + and a fall with U+2212 MINUS SIGN', () => {
    expect(delta(118, 100)).toEqual({ value: 18, label: '+18%' })
    expect(delta(96, 100)).toEqual({ value: -4, label: '−4%' })
    expect(delta(96, 100).label).not.toContain('-')
  })

  it('labels no change as +0%', () => {
    expect(delta(100, 100)).toEqual({ value: 0, label: '+0%' })
  })
})

describe('rangeFor', () => {
  it('returns from/to in Unix ms spanning the named window', () => {
    const before = Date.now()
    const { from, to } = rangeFor('24h')
    const after = Date.now()

    expect(to).toBeGreaterThanOrEqual(before)
    expect(to).toBeLessThanOrEqual(after)
    expect(to - from).toBe(24 * 3600_000)
  })

  it('spans every named range by its declared width', () => {
    for (const spec of RANGES) {
      const { from, to } = rangeFor(spec.key)
      expect(to - from).toBe(spec.hours * 3600_000)
    }
  })

  it('falls back to the 7-day default for an unknown key', () => {
    const { from, to } = rangeFor('not-a-range')
    expect(to - from).toBe(24 * 7 * 3600_000)
  })
})

describe('range persistence', () => {
  // A minimal localStorage stand-in: vitest runs in Node, where there is none.
  const withStorage = (impl, fn) => {
    const had = 'localStorage' in globalThis
    const previous = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', {
      value: impl,
      configurable: true,
      writable: true,
    })
    try {
      return fn()
    } finally {
      if (had) globalThis.localStorage = previous
      else delete globalThis.localStorage
    }
  }

  const memoryStorage = () => {
    const map = new Map()
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
    }
  }

  it('round-trips a chosen range', () => {
    withStorage(memoryStorage(), () => {
      persistRangeKey('30d')
      expect(storedRangeKey()).toBe('30d')
    })
  })

  it('defaults to 7d when nothing is stored', () => {
    withStorage(memoryStorage(), () => {
      expect(storedRangeKey()).toBe('7d')
    })
  })

  it('ignores a stored value that is not a known range', () => {
    withStorage(memoryStorage(), () => {
      persistRangeKey('9000d')
      expect(storedRangeKey()).toBe('7d')
    })
  })

  it('survives a storage that throws, as private browsing does', () => {
    const hostile = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
    }
    withStorage(hostile, () => {
      expect(() => persistRangeKey('30d')).not.toThrow()
      expect(storedRangeKey()).toBe('7d')
    })
  })
})
