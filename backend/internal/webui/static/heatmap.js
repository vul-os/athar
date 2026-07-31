import { el, svgEl, clear } from './dom.js'
import { count, duration } from './format.js'
import { mountHeatCanvas } from './heatcanvas.js'

/**
 * The heatmap view — Athar's reason to exist over a pageview counter.
 *
 * Three questions, three modes:
 *
 *   Clicks    where on the page did people actually press?
 *   Scroll    how far down did they get before leaving?
 *   Attention where did they linger rather than pass through?
 *
 * ── Why clicks render over a wireframe, not a blank canvas ──────────────────
 *
 * The tracker (backend/internal/tracker/athar.js) never captures the page
 * itself: no DOM snapshot, no screenshot, no HTML, no text. It records three
 * things per click — an (x, y) position as a percentage of the *document*,
 * the viewport size at the time, and a short CSS selector for the element
 * pressed (see `selectorFor` in athar.js). That is a deliberate privacy
 * boundary, not an oversight, and this view does not try to paper over it
 * with a fabricated screenshot.
 *
 * What it draws instead is reconstructed *from that same recorded data*: for
 * every selector that was actually clicked, the bounding box of every (x, y)
 * where it was clicked becomes a labelled dashed rectangle, in the exact
 * coordinate space the heat canvas already plots in — so a box drawn from
 * "sel=nav a.nav-link, seen at x=48-52%, y=3-5%" and the hot spot the canvas
 * paints there are the same clicks, guaranteed aligned by construction. That
 * is honest in a way a generic lorem-ipsum skeleton would not be: every box
 * on screen corresponds to real recorded interactions, labelled with the
 * real selector, sized to the real observed spread — never to an assumed
 * page layout. Where nothing was recorded, nothing is drawn.
 *
 * The frame is sized to the recorded viewport's aspect ratio, and a picker
 * lets an operator narrow to one recorded viewport width when more than one
 * was seen (a page that renders very differently at 390px and 1440px should
 * not have those clicks smeared into one average shape).
 *
 * ── What it would take to show the real page instead ─────────────────────
 *
 * To composite the heat field over an actual screenshot of the page as it
 * looked when clicked, the tracker would need to capture and upload a visual
 * snapshot (e.g. a DOM-to-canvas render, or a same-origin screenshot API) at
 * beacon time, keyed to the page's markup revision so old samples do not get
 * misaligned against a redesigned layout, and the backend would need to
 * store and serve that image per (site, path, revision) with its own
 * retention policy. That is real, invasive, roadmap-sized work (something
 * closer to rrweb), and it is deliberately not what Athar collects today —
 * see the tracker's own doc comment on why nothing about page content is
 * ever captured.
 */
const MODES = [
  { kind: 'click', label: 'Clicks', blurb: 'Where visitors pressed, as a density field over the page.' },
  { kind: 'scroll', label: 'Scroll depth', blurb: 'How far down the page each session reached before leaving.' },
  { kind: 'attn', label: 'Attention', blurb: 'Time spent in each tenth of the page.' },
]

const TOP_ELEMENTS_LIMIT = 8

export function renderHeatmapSection(container, { api, websiteId, range }) {
  let kind = 'click'
  let path = null
  let viewportBucket = 'all'
  let gen = 0
  let canvasHandle = null

  const section = el('section', { class: 'panel heatmap' })
  const header = el('header', { class: 'heatmap-header' })
  const pageSelect = el('select', { class: 'select heatmap-page-select', 'aria-label': 'Page to show heatmap for' })
  const modeBar = el('div', { class: 'segmented' })
  header.appendChild(el('h2', { class: 'panel-title' }, 'Heatmaps'))
  header.appendChild(pageSelect)
  header.appendChild(modeBar)

  const blurb = el('p', { class: 'heatmap-blurb' })
  const body = el('div', { class: 'heatmap-body' })

  section.appendChild(header)
  section.appendChild(blurb)
  section.appendChild(body)
  container.appendChild(section)

  function paintModeBar() {
    clear(modeBar)
    for (const m of MODES) {
      modeBar.appendChild(
        el(
          'button',
          {
            type: 'button',
            class: 'segmented-btn' + (m.kind === kind ? ' is-active' : ''),
            onclick: () => {
              if (kind === m.kind) return
              kind = m.kind
              paintModeBar()
              blurb.textContent = m.blurb
              loadHeat()
            },
          },
          m.label,
        ),
      )
    }
  }

  async function loadPages() {
    try {
      const data = await api.metrics(websiteId, 'path', range, 25)
      const pages = (data && data.rows) || []
      clear(pageSelect)
      if (pages.length === 0) {
        pageSelect.appendChild(el('option', { value: '' }, 'No pages yet'))
        path = null
      } else {
        for (const p of pages) {
          pageSelect.appendChild(el('option', { value: p.value }, `${p.value}  (${p.count})`))
        }
        if (!path || !pages.some((p) => p.value === path)) path = pages[0].value
        pageSelect.value = path
      }
    } catch (err) {
      path = null
    }
    loadHeat()
  }
  pageSelect.addEventListener('change', () => {
    path = pageSelect.value
    viewportBucket = 'all'
    loadHeat()
  })

  async function loadHeat() {
    const myGen = ++gen
    if (canvasHandle) {
      canvasHandle.destroy()
      canvasHandle = null
    }
    if (!path) {
      renderState(body, 'empty', 'No pages yet', 'Once the tracker sends pageviews, pages will appear here.')
      return
    }
    renderState(body, 'loading', 'Loading…')
    try {
      const data = await api.heatmap(websiteId, path, kind, range)
      if (myGen !== gen) return
      const samples = (data && data.samples) || []
      if (samples.length === 0) {
        const mode = MODES.find((m) => m.kind === kind)
        clear(body)
        body.appendChild(
          el(
            'div',
            { class: 'state state-dashed' },
            el(
              'p',
              null,
              `No ${mode.label.toLowerCase()} recorded for this page yet. Add `,
              el('code', { class: 'mono' }, 'data-heatmap="true"'),
              ' to your script tag.',
            ),
          ),
        )
        return
      }
      clear(body)
      if (kind === 'click') canvasHandle = renderClickMap(body, samples, path)
      else if (kind === 'scroll') renderScrollDepth(body, samples)
      else renderAttention(body, samples)
    } catch (err) {
      if (myGen !== gen) return
      renderState(body, 'error', 'Could not load heatmap', err && err.message)
    }
  }

  function renderClickMap(root, allSamples, currentPath) {
    const buckets = bucketizeViewports(allSamples)
    let samples = allSamples

    const wrap = el('div', { class: 'heatmap-grid' })
    const left = el('div', null)
    const right = el('div', null)

    const frameOuter = el('div', { class: 'heat-frame-outer' })
    const topbar = el(
      'div',
      { class: 'heat-topbar' },
      el('span', { class: 'heat-topbar-dot' }),
      el('span', { class: 'heat-topbar-dot' }),
      el('span', { class: 'heat-topbar-dot' }),
      el('span', { class: 'heat-topbar-path mono', title: currentPath }, currentPath),
    )
    const frame = el('div', { class: 'heat-frame' })
    const wireLayer = el('div', { class: 'heat-wire-layer' })
    const canvasLayer = el('div', { class: 'heat-canvas-layer' })
    frame.appendChild(wireLayer)
    frame.appendChild(canvasLayer)
    frameOuter.appendChild(topbar)
    frameOuter.appendChild(frame)
    left.appendChild(frameOuter)

    const caption = el('p', { class: 'heat-caption' })
    left.appendChild(caption)

    const footRow = el('div', { class: 'heat-foot-row' })
    const clickCountEl = el('span', { class: 'tnum' })
    footRow.appendChild(clickCountEl)
    footRow.appendChild(rampLegend())
    left.appendChild(footRow)

    let vpSelect = null
    if (buckets.length > 1) {
      vpSelect = el('select', { class: 'select heat-viewport-select', 'aria-label': 'Recorded viewport width' })
      vpSelect.appendChild(el('option', { value: 'all' }, `All viewports (${allSamples.length} samples)`))
      for (const b of buckets) {
        vpSelect.appendChild(el('option', { value: String(b.key) }, `~${b.key}px wide (${b.samples.length} samples)`))
      }
      vpSelect.addEventListener('change', () => {
        viewportBucket = vpSelect.value
        paint()
      })
      const pickerRow = el('div', { class: 'heat-viewport-row' },
        el('label', { class: 'heat-viewport-label' }, 'Viewport'), vpSelect)
      left.insertBefore(pickerRow, frameOuter)
    }

    const rightTitle = el('h3', { class: 'heatmap-side-title' }, 'Most clicked elements')
    const elementsList = el('ol', { class: 'bar-list' })
    right.appendChild(rightTitle)
    right.appendChild(elementsList)
    right.appendChild(
      el(
        'p',
        { class: 'heatmap-note' },
        'Selectors are recorded alongside coordinates, so a click map still means something after the page is redesigned.',
      ),
    )

    wrap.appendChild(left)
    wrap.appendChild(right)
    root.appendChild(wrap)

    let handle = null

    function paint() {
      samples = viewportBucket === 'all' ? allSamples : (buckets.find((b) => String(b.key) === viewportBucket) || {}).samples || allSamples

      // Aspect ratio from the active sample set's recorded viewports — a
      // mostly-mobile filter renders tall, a desktop one wide.
      const withViewport = samples.filter((s) => s.vw > 0 && s.vh > 0)
      let ratio = 16 / 10
      if (withViewport.length) {
        const mean = withViewport.reduce((sum, s) => sum + s.vw / s.vh, 0) / withViewport.length
        ratio = Math.min(2, Math.max(0.5, mean))
      }
      frame.style.aspectRatio = String(ratio)

      // Wireframe: bounding box per selector, built only from real recorded
      // coordinates for the active sample set.
      clear(wireLayer)
      const boxes = selectorBoxes(samples)
      for (const box of boxes) {
        wireLayer.appendChild(
          el(
            'div',
            {
              class: 'wireframe-box',
              style: `left:${box.x0}%;top:${box.y0}%;width:${Math.max(box.x1 - box.x0, 3)}%;height:${Math.max(box.y1 - box.y0, 2.2)}%`,
              title: `${box.selector} — ${box.count} click${box.count === 1 ? '' : 's'}`,
            },
            el('span', { class: 'wireframe-box-label mono' }, box.selector),
          ),
        )
      }

      if (handle) handle.destroy()
      handle = mountHeatCanvas(canvasLayer)
      handle.setSamples(samples.filter((s) => typeof s.x === 'number' && typeof s.y === 'number'))

      const meanW = withViewport.length ? Math.round(withViewport.reduce((s, v) => s + v.vw, 0) / withViewport.length) : 0
      const meanH = withViewport.length ? Math.round(withViewport.reduce((s, v) => s + v.vh, 0) / withViewport.length) : 0
      caption.textContent =
        (meanW && meanH ? `Schematic at ~${meanW}×${meanH}px — ` : 'Schematic — ') +
        'reconstructed from recorded click positions and selectors. No page screenshot is ever captured.'

      clickCountEl.textContent = `${count(samples.length)} clicks`

      const counts = new Map()
      for (const s of samples) {
        if (!s.selector) continue
        counts.set(s.selector, (counts.get(s.selector) || 0) + 1)
      }
      const topElements = [...counts.entries()]
        .map(([selector, n]) => ({ selector, count: n }))
        .sort((a, b) => b.count - a.count)
        .slice(0, TOP_ELEMENTS_LIMIT)
      const max = topElements[0] ? topElements[0].count : 1

      clear(elementsList)
      if (topElements.length === 0) {
        elementsList.appendChild(el('li', { class: 'bar-list-empty' }, 'No element selectors recorded.'))
      } else {
        for (const element of topElements) {
          elementsList.appendChild(
            el(
              'li',
              { class: 'bar-row', title: element.selector },
              el('span', { class: 'bar-row-fill', style: `width:${(element.count / max) * 100}%` }),
              el('span', { class: 'bar-row-label mono' }, element.selector),
              el('span', { class: 'bar-row-value tnum' }, count(element.count)),
            ),
          )
        }
      }
    }

    paint()

    return {
      destroy() {
        if (handle) handle.destroy()
      },
    }
  }

  function renderScrollDepth(root, samples) {
    const total = samples.length || 1
    const bands = Array.from({ length: 10 }, (_, i) => {
      const depth = (i + 1) * 10
      const reached = samples.filter((s) => s.scroll >= depth - 5).length
      return { depth, reached, share: reached / total }
    })
    const foundMedian = bands.find((b) => b.share < 0.5)
    const median = foundMedian ? foundMedian.depth : 100

    const wrap = el('div', { class: 'heatmap-grid heatmap-grid-bands' })
    const bandList = el('div', { class: 'band-list' })
    for (const band of bands) {
      bandList.appendChild(
        el(
          'div',
          { class: 'band-row' },
          el('span', { class: 'band-row-fill', style: `width:${band.share * 100}%` }),
          el('span', { class: 'band-row-depth tnum' }, `${band.depth}%`),
          el('span', { class: 'band-row-share tnum' }, `${Math.round(band.share * 100)}%`),
          el('span', { class: 'band-row-count' }, `${count(band.reached)} sessions`),
        ),
      )
    }
    const side = el(
      'div',
      { class: 'heatmap-side' },
      el(
        'div',
        { class: 'callout' },
        el('div', { class: 'callout-label' }, 'Median depth'),
        el('div', { class: 'callout-value' }, `${median}%`),
        el('p', { class: 'callout-hint' }, 'Half of sessions never scrolled past this point.'),
      ),
      el(
        'p',
        { class: 'heatmap-note' },
        'Depth is the furthest point each session reached, as a percentage of the full document — so it stays comparable across screen sizes.',
      ),
    )
    wrap.appendChild(bandList)
    wrap.appendChild(side)
    root.appendChild(wrap)
  }

  function renderAttention(root, samples) {
    const totals = new Array(10).fill(0)
    const counts = new Array(10).fill(0)
    for (const s of samples) {
      const index = Math.min(9, Math.max(0, Math.floor(s.scroll / 10)))
      totals[index] += s.dwell_ms || 0
      counts[index] += 1
    }
    const peak = Math.max(1, ...totals)
    const bands = totals.map((tot, i) => ({
      from: i * 10,
      to: (i + 1) * 10,
      meanMs: counts[i] ? tot / counts[i] : 0,
      share: tot / peak,
    }))

    const wrap = el('div', { class: 'heatmap-grid heatmap-grid-bands' })
    const bandList = el('div', { class: 'band-list' })
    for (const band of bands) {
      bandList.appendChild(
        el(
          'div',
          { class: 'band-row' },
          el('span', { class: 'band-row-fill', style: `width:${band.share * 100}%` }),
          el('span', { class: 'band-row-depth tnum' }, `${band.from}–${band.to}%`),
          el('span', { class: 'band-row-share tnum' }, duration(band.meanMs / 1000)),
          el('span', { class: 'band-row-count' }, 'average dwell'),
        ),
      )
    }
    const side = el(
      'div',
      { class: 'heatmap-side' },
      el(
        'p',
        { class: 'heatmap-note' },
        'Attention is measured as time spent with each tenth of the page in view. A band that holds people far down the page is usually worth moving up; a band everyone skims past is usually worth cutting.',
      ),
    )
    wrap.appendChild(bandList)
    wrap.appendChild(side)
    root.appendChild(wrap)
  }

  paintModeBar()
  blurb.textContent = MODES[0].blurb
  loadPages()

  return {
    destroy() {
      if (canvasHandle) canvasHandle.destroy()
    },
  }
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function rampLegend() {
  return el(
    'span',
    { class: 'heat-ramp-legend' },
    el('span', null, 'Cold'),
    el('span', { class: 'heat-ramp-swatch' }),
    el('span', null, 'Hot'),
  )
}

function renderState(root, kindOf, title, hint) {
  clear(root)
  root.appendChild(
    el(
      'div',
      { class: 'state' + (kindOf === 'error' ? ' state-error' : '') },
      el('div', { class: 'state-title' }, title),
      hint ? el('div', { class: 'state-hint' }, hint) : null,
    ),
  )
}

/**
 * Groups samples by recorded viewport width into ~150px-wide buckets — wide
 * enough that jitter within one real device class collapses to one bucket,
 * narrow enough to keep 390 / 768 / 1024 / 1440-ish viewports distinct.
 */
function bucketizeViewports(samples) {
  const withVw = samples.filter((s) => s.vw > 0)
  if (withVw.length === 0) return []
  const groups = new Map()
  for (const s of withVw) {
    const key = Math.round(s.vw / 150) * 150
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(s)
  }
  return [...groups.entries()]
    .map(([key, samplesForKey]) => ({ key, samples: samplesForKey }))
    .sort((a, b) => b.samples.length - a.samples.length)
}

/**
 * Bounding box per selector, built only from the (x, y) positions actually
 * recorded for that selector — never from an assumed layout. Padded a
 * little so a single-point box is still visible, and capped to the same
 * top-N the "most clicked elements" list shows.
 */
function selectorBoxes(samples) {
  const bySelector = new Map()
  for (const s of samples) {
    if (!s.selector) continue
    if (!bySelector.has(s.selector)) bySelector.set(s.selector, [])
    bySelector.get(s.selector).push(s)
  }
  const boxes = [...bySelector.entries()].map(([selector, pts]) => {
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    const pad = 1.5
    return {
      selector,
      count: pts.length,
      x0: Math.max(0, Math.min(...xs) - pad),
      x1: Math.min(100, Math.max(...xs) + pad),
      y0: Math.max(0, Math.min(...ys) - pad),
      y1: Math.min(100, Math.max(...ys) + pad),
    }
  })
  return boxes.sort((a, b) => b.count - a.count).slice(0, TOP_ELEMENTS_LIMIT)
}
