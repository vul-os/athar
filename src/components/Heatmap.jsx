import { useCallback, useMemo, useState } from 'react'
import { api } from '../api.js'
import { useAsyncData } from '../lib/useAsyncData.js'
import { count, duration } from '../lib/format.js'
import HeatCanvas from './HeatCanvas.jsx'

/**
 * The heatmap view — Athar's reason to exist over a pageview counter.
 *
 * Three questions, three modes:
 *
 *   Clicks    where on the page did people actually press?
 *   Scroll    how far down did they get before leaving?
 *   Attention where did they linger rather than pass through?
 *
 * A note on what is deliberately absent: there is no screenshot of the page
 * under the click map. Capturing one means capturing the DOM, and Athar's
 * tracker does not do that — no snapshot, no text, no form values. The map is
 * drawn on a proportional frame instead, and the clicked elements are listed as
 * CSS selectors beside it, which is what actually survives a redesign. Overlaying
 * on a real snapshot is roadmap work (rrweb, opt-in and separate).
 */
const MODES = [
  { kind: 'click', label: 'Clicks', blurb: 'Where visitors pressed, as a density field over the page.' },
  { kind: 'scroll', label: 'Scroll depth', blurb: 'How far down the page each session reached before leaving.' },
  { kind: 'attn', label: 'Attention', blurb: 'Time spent in each tenth of the page.' },
]

export default function Heatmap({ website, range }) {
  const [kind, setKind] = useState('click')
  const [path, setPath] = useState(null)

  // The page list drives the picker. Reusing the top-pages metric means the
  // dropdown is ordered by traffic, which is the order someone wants to
  // investigate pages in anyway.
  const loadPages = useCallback(
    () => api.metrics(website.id, 'path', range, 25),
    [website.id, range],
  )
  const { data: pagesData } = useAsyncData(loadPages)
  const pages = pagesData?.rows ?? []

  const selectedPath = path ?? pages[0]?.value ?? null

  const loadHeat = useCallback(
    () => (selectedPath ? api.heatmap(website.id, selectedPath, kind, range) : Promise.resolve(null)),
    [website.id, selectedPath, kind, range],
  )
  const { data, error, loading } = useAsyncData(loadHeat)
  const samples = data?.samples ?? []

  const mode = MODES.find((m) => m.kind === kind)

  return (
    <section className="panel overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-line-soft px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight">Heatmaps</h2>

        <select
          value={selectedPath ?? ''}
          onChange={(e) => setPath(e.target.value)}
          className="max-w-[18rem] min-w-0 flex-1 truncate rounded-md border border-line bg-raised px-2.5 py-1.5 font-mono text-xs text-ink outline-none focus:border-accent"
          aria-label="Page to show heatmap for"
        >
          {pages.length === 0 && <option value="">No pages yet</option>}
          {pages.map((page) => (
            <option key={page.value} value={page.value}>
              {page.value}  ({page.count})
            </option>
          ))}
        </select>

        <div className="ml-auto flex gap-0.5 rounded-md bg-raised p-0.5">
          {MODES.map((m) => (
            <button
              key={m.kind}
              onClick={() => setKind(m.kind)}
              className={`rounded px-2.5 py-1 text-xs transition ${
                m.kind === kind ? 'bg-line text-ink' : 'text-ink-faint hover:text-ink-muted'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </header>

      <p className="border-b border-line-soft px-4 py-2 text-xs text-ink-faint">{mode.blurb}</p>

      <div className="p-4">
        {error && <Empty>{error.message}</Empty>}
        {!error && loading && <Empty>Loading…</Empty>}
        {!error && !loading && samples.length === 0 && (
          <Empty>
            No {mode.label.toLowerCase()} recorded for this page yet. Add{' '}
            <code className="font-mono text-ink-muted">data-heatmap="true"</code> to your script tag.
          </Empty>
        )}

        {!error && !loading && samples.length > 0 && (
          <>
            {kind === 'click' && <ClickMap samples={samples} path={selectedPath} />}
            {kind === 'scroll' && <ScrollDepth samples={samples} />}
            {kind === 'attn' && <Attention samples={samples} />}
          </>
        )}
      </div>
    </section>
  )
}

function Empty({ children }) {
  return (
    <div className="grid min-h-[14rem] place-items-center rounded-lg border border-dashed border-line px-6 text-center text-sm text-ink-faint">
      <p>{children}</p>
    </div>
  )
}

// ── Clicks ────────────────────────────────────────────────────────────────────

function ClickMap({ samples, path }) {
  // The frame's aspect ratio comes from the viewports actually reported, so a
  // mostly-mobile page is drawn tall and a desktop page wide. A fixed ratio
  // would distort where the clusters sit relative to each other.
  const ratio = useMemo(() => {
    const withViewport = samples.filter((s) => s.vw > 0 && s.vh > 0)
    if (!withViewport.length) return 16 / 10
    const mean =
      withViewport.reduce((sum, s) => sum + s.vw / s.vh, 0) / withViewport.length
    return Math.min(2, Math.max(0.5, mean))
  }, [samples])

  const topElements = useMemo(() => {
    const counts = new Map()
    for (const sample of samples) {
      if (!sample.selector) continue
      counts.set(sample.selector, (counts.get(sample.selector) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([selector, n]) => ({ selector, count: n }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
  }, [samples])

  const max = topElements[0]?.count ?? 1

  return (
    <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
      <div>
        <div
          className="relative overflow-hidden rounded-lg border border-line bg-raised"
          style={{ aspectRatio: ratio }}
        >
          {/* A neutral page frame: a hairline grid and a browser-ish top bar,
              enough to read positions against without pretending to be a
              screenshot of the real page. */}
          <div className="absolute inset-x-0 top-0 flex h-7 items-center gap-1.5 border-b border-line bg-surface px-3">
            <span className="h-2 w-2 rounded-full bg-line" />
            <span className="h-2 w-2 rounded-full bg-line" />
            <span className="h-2 w-2 rounded-full bg-line" />
            <span className="ml-2 truncate font-mono text-[10px] text-ink-faint">{path}</span>
          </div>
          <div
            className="absolute inset-x-0 bottom-0 top-7"
            style={{
              backgroundImage:
                'linear-gradient(to right, var(--color-line-soft) 1px, transparent 1px), linear-gradient(to bottom, var(--color-line-soft) 1px, transparent 1px)',
              backgroundSize: '10% 8%',
            }}
          />
          <HeatCanvas samples={samples} className="absolute inset-x-0 bottom-0 top-7" />
        </div>

        <div className="mt-2 flex items-center justify-between gap-3 text-xs text-ink-faint">
          <span className="tnum">{count(samples.length)} clicks</span>
          <Ramp />
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium tracking-wide text-ink-faint uppercase">
          Most clicked elements
        </h3>
        {topElements.length === 0 ? (
          <p className="text-sm text-ink-faint">No element selectors recorded.</p>
        ) : (
          <ol className="space-y-1">
            {topElements.map((element) => (
              <li
                key={element.selector}
                className="relative flex items-center justify-between gap-3 rounded px-2 py-1.5"
              >
                <div
                  className="absolute inset-y-0 left-0 rounded bg-accent-wash"
                  style={{ width: `${(element.count / max) * 100}%` }}
                  aria-hidden="true"
                />
                <span
                  className="relative truncate font-mono text-xs text-ink"
                  title={element.selector}
                >
                  {element.selector}
                </span>
                <span className="tnum relative shrink-0 text-xs text-ink-muted">
                  {count(element.count)}
                </span>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          Selectors are recorded alongside coordinates, so a click map still means
          something after the page is redesigned.
        </p>
      </div>
    </div>
  )
}

function Ramp() {
  return (
    <span className="flex items-center gap-2">
      <span>Cold</span>
      <span
        className="h-2 w-24 rounded-full"
        style={{
          background:
            'linear-gradient(to right, rgb(40,90,210), rgb(40,190,200), rgb(60,200,110), rgb(235,175,55), rgb(225,55,45))',
        }}
      />
      <span>Hot</span>
    </span>
  )
}

// ── Scroll depth ──────────────────────────────────────────────────────────────

/**
 * The classic drop-off curve: of everyone who opened the page, what share
 * reached each depth.
 *
 * It is cumulative on purpose. A histogram of "where each session stopped" has
 * the same data but answers a question nobody asks; "62% of people never saw
 * your pricing table" is the sentence this chart exists to produce.
 */
function ScrollDepth({ samples }) {
  const bands = useMemo(() => {
    const total = samples.length || 1
    return Array.from({ length: 10 }, (_, i) => {
      const depth = (i + 1) * 10
      const reached = samples.filter((s) => s.scroll >= depth - 5).length
      return { depth, reached, share: reached / total }
    })
  }, [samples])

  // The fold: the depth the median visitor reached.
  const median = useMemo(() => {
    const found = bands.find((b) => b.share < 0.5)
    return found ? found.depth : 100
  }, [bands])

  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <div className="overflow-hidden rounded-lg border border-line">
        {bands.map((band) => (
          <div key={band.depth} className="relative flex items-center gap-3 border-b border-line-soft px-3 py-2 last:border-b-0">
            {/* Width alone encodes the magnitude. The bar used to also scale
                its opacity, which made a full row bright enough to swallow the
                label sitting on top of it. */}
            <div
              className="absolute inset-y-0 left-0 bg-accent-wash"
              style={{ width: `${band.share * 100}%` }}
              aria-hidden="true"
            />
            <span className="tnum relative w-10 shrink-0 text-xs text-ink-muted">{band.depth}%</span>
            <span className="tnum relative text-sm text-ink">{Math.round(band.share * 100)}%</span>
            <span className="relative ml-auto text-xs text-ink-muted">
              {count(band.reached)} sessions
            </span>
          </div>
        ))}
      </div>

      <div className="space-y-3 text-sm">
        <div className="rounded-lg border border-line bg-raised px-4 py-3">
          <div className="text-xs font-medium tracking-wide text-ink-faint uppercase">
            Median depth
          </div>
          <div className="tnum mt-1 text-2xl font-medium text-accent">{median}%</div>
          <p className="mt-1 text-xs text-ink-faint">
            Half of sessions never scrolled past this point.
          </p>
        </div>
        <p className="text-xs leading-relaxed text-ink-faint">
          Depth is the furthest point each session reached, as a percentage of the
          full document — so it stays comparable across screen sizes.
        </p>
      </div>
    </div>
  )
}

// ── Attention ─────────────────────────────────────────────────────────────────

function Attention({ samples }) {
  const bands = useMemo(() => {
    const totals = new Array(10).fill(0)
    const counts = new Array(10).fill(0)

    for (const sample of samples) {
      const index = Math.min(9, Math.max(0, Math.floor(sample.scroll / 10)))
      totals[index] += sample.dwell_ms ?? 0
      counts[index] += 1
    }
    const peak = Math.max(1, ...totals)
    return totals.map((total, i) => ({
      from: i * 10,
      to: (i + 1) * 10,
      totalMs: total,
      meanMs: counts[i] ? total / counts[i] : 0,
      share: total / peak,
    }))
  }, [samples])

  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <div className="overflow-hidden rounded-lg border border-line">
        {bands.map((band) => (
          <div key={band.from} className="relative flex items-center gap-3 border-b border-line-soft px-3 py-2 last:border-b-0">
            {/* Width alone encodes the magnitude. The bar used to also scale
                its opacity, which made a full row bright enough to swallow the
                label sitting on top of it. */}
            <div
              className="absolute inset-y-0 left-0 bg-accent-wash"
              style={{ width: `${band.share * 100}%` }}
              aria-hidden="true"
            />
            <span className="tnum relative w-16 shrink-0 text-xs text-ink-muted">
              {band.from}–{band.to}%
            </span>
            <span className="tnum relative text-sm text-ink">{duration(band.meanMs / 1000)}</span>
            <span className="relative ml-auto text-xs text-ink-muted">average dwell</span>
          </div>
        ))}
      </div>

      <p className="text-xs leading-relaxed text-ink-faint">
        Attention is measured as time spent with each tenth of the page in view.
        A band that holds people far down the page is usually worth moving up;
        a band everyone skims past is usually worth cutting.
      </p>
    </div>
  )
}
