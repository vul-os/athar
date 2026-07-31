// Node-native tests for backend/internal/webui/static/format.js.
//
// format.js is plain, dependency-free JS (Intl + Date + localStorage), so it
// runs unmodified in the browser (loaded as an ES module by the dashboard)
// and here under Node's built-in test runner — no vitest, no npm install,
// nothing beyond the `node` binary already required to build the tracker:
//
//   node --test scripts/jstest/
//
// This is a line-for-line port of the vitest suite that used to live at
// src/lib/format.test.js, translated to node:assert/strict. The two things
// that suite was deliberate about still apply here:
//
//   Locale. count/money/bucketLabel go through Intl with the ambient locale,
//   so each locale-sensitive expectation is built from an explicit Intl
//   formatter in the test rather than a pinned string.
//
//   Coverage. `exercisesEveryExport` asserts every export of format.js is
//   named here, so a new export without a test fails the suite instead of
//   quietly widening the untested surface.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import * as format from '../../backend/internal/webui/static/format.js'
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
} from '../../backend/internal/webui/static/format.js'

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
    assert.ok(exported.length > 0)
    assert.deepStrictEqual(exported, [...exercised].sort())
  })
})

describe('count', () => {
  const plain = new Intl.NumberFormat()
  const compact = new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  })

  it('renders an em dash for a missing value rather than 0 or NaN', () => {
    assert.strictEqual(count(null), '—')
    assert.strictEqual(count(undefined), '—')
  })

  it('keeps 0 as a real zero, not a missing value', () => {
    assert.strictEqual(count(0), plain.format(0))
  })

  it('is exact below the 10k threshold and compact at or above it', () => {
    assert.strictEqual(count(9_999), plain.format(9_999))
    assert.strictEqual(count(10_000), compact.format(10_000))
    assert.strictEqual(count(1_250_000), compact.format(1_250_000))
  })
})

describe('percent', () => {
  it('renders a 0..1 ratio as a whole-number percentage', () => {
    assert.strictEqual(percent(0), '0%')
    assert.strictEqual(percent(0.5), '50%')
    assert.strictEqual(percent(1), '100%')
  })

  it('rounds to the nearest whole percent', () => {
    assert.strictEqual(percent(0.126), '13%')
    assert.strictEqual(percent(0.124), '12%')
  })

  it('renders an em dash for a missing value', () => {
    assert.strictEqual(percent(null), '—')
    assert.strictEqual(percent(undefined), '—')
  })
})

describe('duration', () => {
  it('floors sub-second and falsy values to 0s', () => {
    assert.strictEqual(duration(0), '0s')
    assert.strictEqual(duration(0.4), '0s')
    assert.strictEqual(duration(null), '0s')
    assert.strictEqual(duration(undefined), '0s')
  })

  it('uses bare seconds below a minute', () => {
    assert.strictEqual(duration(1), '1s')
    assert.strictEqual(duration(59), '59s')
    assert.strictEqual(duration(59.6), '1m 00s')
  })

  it('zero-pads the seconds field so times stay column-aligned', () => {
    assert.strictEqual(duration(60), '1m 00s')
    assert.strictEqual(duration(65), '1m 05s')
    assert.strictEqual(duration(3599), '59m 59s')
  })

  it('switches to hours and zero-pads the minutes field', () => {
    assert.strictEqual(duration(3600), '1h 00m')
    assert.strictEqual(duration(3600 + 5 * 60), '1h 05m')
    assert.strictEqual(duration(26 * 3600 + 30 * 60), '26h 30m')
  })
})

describe('money', () => {
  const asCurrency = (minor, currency) => {
    const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency })
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2
    return fmt.format(minor / 10 ** digits)
  }

  it('divides by the currency exponent, not always by 100', () => {
    assert.strictEqual(money(4999, 'USD'), asCurrency(4999, 'USD'))
    // JPY has no minor unit: 4999 minor units is ¥4,999, not ¥49.99.
    assert.strictEqual(money(4999, 'JPY'), asCurrency(4999, 'JPY'))
    // KWD has three: 4999 minor units is 4.999 dinars.
    assert.strictEqual(money(4999, 'KWD'), asCurrency(4999, 'KWD'))
  })

  it('never throws on an unknown currency code', () => {
    const out = money(4999, 'ZZZ')
    assert.strictEqual(typeof out, 'string')
    assert.ok(out.includes('ZZZ'))
  })
})

describe('bucketLabel', () => {
  const ms = Date.UTC(2026, 6, 24, 15, 0, 0)

  it('picks a date-only label for day buckets and a time label for hour buckets', () => {
    const d = new Date(ms)
    assert.strictEqual(
      bucketLabel(ms, 'day'),
      d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    )
    assert.strictEqual(
      bucketLabel(ms, 'hour'),
      d.toLocaleTimeString(undefined, { hour: 'numeric' }),
    )
  })

  it('gives the tooltip form more context than the axis form', () => {
    assert.notStrictEqual(bucketLabel(ms, 'day', true), bucketLabel(ms, 'day'))
    assert.notStrictEqual(bucketLabel(ms, 'hour', true), bucketLabel(ms, 'hour'))
  })

  it('treats any non-"day" interval as an hour bucket', () => {
    assert.strictEqual(bucketLabel(ms, 'hour'), bucketLabel(ms, undefined))
  })
})

describe('delta', () => {
  it('returns null when there is no previous period to compare against', () => {
    assert.strictEqual(delta(10, 0), null)
    assert.strictEqual(delta(10, null), null)
    assert.strictEqual(delta(10, undefined), null)
  })

  it('labels a rise with + and a fall with U+2212 MINUS SIGN', () => {
    assert.deepStrictEqual(delta(118, 100), { value: 18, label: '+18%' })
    assert.deepStrictEqual(delta(96, 100), { value: -4, label: '−4%' })
    assert.ok(!delta(96, 100).label.includes('-'))
  })

  it('labels no change as +0%', () => {
    assert.deepStrictEqual(delta(100, 100), { value: 0, label: '+0%' })
  })
})

describe('rangeFor', () => {
  it('returns from/to in Unix ms spanning the named window', () => {
    const before = Date.now()
    const { from, to } = rangeFor('24h')
    const after = Date.now()

    assert.ok(to >= before)
    assert.ok(to <= after)
    assert.strictEqual(to - from, 24 * 3600_000)
  })

  it('spans every named range by its declared width', () => {
    for (const spec of RANGES) {
      const { from, to } = rangeFor(spec.key)
      assert.strictEqual(to - from, spec.hours * 3600_000)
    }
  })

  it('falls back to the 7-day default for an unknown key', () => {
    const { from, to } = rangeFor('not-a-range')
    assert.strictEqual(to - from, 24 * 7 * 3600_000)
  })
})

describe('range persistence', () => {
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
      assert.strictEqual(storedRangeKey(), '30d')
    })
  })

  it('defaults to 7d when nothing is stored', () => {
    withStorage(memoryStorage(), () => {
      assert.strictEqual(storedRangeKey(), '7d')
    })
  })

  it('ignores a stored value that is not a known range', () => {
    withStorage(memoryStorage(), () => {
      persistRangeKey('9000d')
      assert.strictEqual(storedRangeKey(), '7d')
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
      assert.doesNotThrow(() => persistRangeKey('30d'))
      assert.strictEqual(storedRangeKey(), '7d')
    })
  })
})
