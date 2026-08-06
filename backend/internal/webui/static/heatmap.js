import { el, clear } from './dom.js'
import { count, duration, bytes as formatBytes } from './format.js'
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
 * ── What the click map is drawn over ────────────────────────────────────────
 *
 * Over the page, when there is a picture of the page to draw over — and over a
 * wireframe schematic, clearly labelled as one, when there is not.
 *
 * The picture is never captured by Athar. The tracker records three things per
 * click (an x/y position as a percentage of the *document*, the viewport size,
 * and a short CSS selector) and nothing about the page's content: no DOM
 * snapshot, no HTML, no text, no form values. That boundary has not moved. What
 * moved is that an operator can now upload a capture of their own page, keyed to
 * one page and one viewport width, which this view composites underneath the
 * heat field. See backend/internal/api/pageimages.go for why upload beat both
 * tracker-side DOM capture and server-side rendering.
 *
 * ── Why the overlay lands where the click landed ────────────────────────────
 *
 * Because both sides are proportions of the same document. The tracker divides
 * pageX by documentElement.scrollWidth and pageY by the full document height; a
 * full-page capture at viewport width W is exactly one document wide and one
 * document tall. So the frame takes its aspect ratio from the *image*, the heat
 * canvas fills that same box, and a sample at (x%, y%) of the box is the pixel
 * that was pressed — independent of display size and of the capture's device
 * pixel ratio, since a 2× capture is the same document at twice the samples per
 * CSS pixel.
 *
 * Two ways that could go wrong, both guarded rather than assumed:
 *
 *   - An above-the-fold capture instead of a full-page one. Its aspect ratio is
 *     the viewport's rather than the document's, so everything below the fold
 *     would be crushed into the visible screen. checkAlignment() compares the
 *     image's ratio against the recorded viewport's and says so plainly.
 *   - Mixing viewport widths. A page laid out at 390px and one at 1440px are
 *     different documents; averaging their clicks onto one image is a lie that
 *     looks authoritative. An image is keyed by viewport width, and one is only
 *     shown when a single recorded viewport bucket is selected — "All viewports"
 *     always gets the schematic.
 *
 * ── When there is no image ─────────────────────────────────────────────────
 *
 * The wireframe: for every selector actually clicked, the bounding box of every
 * (x, y) where it was clicked, in the same coordinate space the heat canvas
 * plots in. Every box corresponds to real recorded interactions, labelled with
 * the real selector, sized to the real observed spread. It is captioned
 * "Schematic", never presented as the page, and a stale image for a different
 * viewport is never substituted for a missing one.
 */
/** @typedef {'click' | 'scroll' | 'attn'} HeatKind */

/**
 * A heatmap sample as this view consumes it. The three modes populate
 * different fields (click: x/y/selector; scroll: scroll; attn: scroll/dwell_ms)
 * of one shape, matching how the API returns them mixed in one `samples` array.
 * @typedef {Object} HeatSample
 * @property {number} [x]
 * @property {number} [y]
 * @property {string} [selector]
 * @property {number} [scroll]
 * @property {number} [dwell_ms]
 * @property {number} vw
 * @property {number} vh
 */

/** @typedef {{ key: number, label: number, samples: HeatSample[] }} ViewportBucket */

/**
 * @typedef {Object} PageImage
 * @property {string} path
 * @property {number} viewport_w
 * @property {number} image_w
 * @property {number} image_h
 * @property {number} bytes
 * @property {number} created_at
 */

/** @typedef {{ images?: PageImage[] } | null} PageImagesResponse */
/** @typedef {{ rows?: Array<{ value: string, count: number }> } | null} MetricsResponse */
/** @typedef {{ samples?: HeatSample[] } | null} HeatmapResponse */

/**
 * A caught value's type is `unknown`, not Error — this narrows it the same
 * way at every catch site in this file rather than trusting `err.message`
 * to exist.
 * @param {unknown} err
 * @returns {string | undefined}
 */
function errorMessage(err) {
  return err instanceof Error ? err.message : undefined
}

/** @type {Array<{ kind: HeatKind, label: string, blurb: string }>} */
const MODES = [
  { kind: 'click', label: 'Clicks', blurb: 'Where visitors pressed, as a density field over the page.' },
  { kind: 'scroll', label: 'Scroll depth', blurb: 'How far down the page each session reached before leaving.' },
  { kind: 'attn', label: 'Attention', blurb: 'Time spent in each tenth of the page.' },
]

const TOP_ELEMENTS_LIMIT = 8

/** Widths within this many pixels of each other are one device class. */
const VIEWPORT_BUCKET_PX = 150

/**
 * @param {HTMLElement} container
 * @param {{ api: typeof import('./api.js').api, websiteId: string, range: import('./api.js').DateRange, canWrite?: boolean }} args
 */
export function renderHeatmapSection(container, { api, websiteId, range, canWrite = false }) {
  /** @type {HeatKind} */
  let kind = 'click'
  /** @type {string | null} */
  let path = null
  // null means "choose for me": the first bucket that has a page capture, else
  // all viewports. An explicit choice by the operator is preserved.
  /** @type {string | null} */
  let viewportBucket = null
  let gen = 0
  /** @type {{ destroy(): void } | null} */
  let canvasHandle = null
  /** @type {PageImage[]} */
  let pageImages = []

  const section = el('section', { class: 'panel heatmap' })
  const header = el('header', { class: 'heatmap-header' })
  const pageSelect = /** @type {HTMLSelectElement} */ (
    el('select', { class: 'select heatmap-page-select', 'aria-label': 'Page to show heatmap for' })
  )
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
              void loadHeat()
            },
          },
          m.label,
        ),
      )
    }
  }

  /**
   * Loads the page-capture index. Metadata only — the bytes arrive later via an
   * <img src>, and only for the one image actually shown, so a site with fifty
   * captures does not pay for forty-nine it is not looking at.
   */
  async function loadPageImages() {
    try {
      const data = /** @type {PageImagesResponse} */ (await api.pageImages(websiteId))
      pageImages = (data && data.images) || []
    } catch {
      // A missing index is not a reason to fail the whole view: the click map
      // degrades to the schematic, which is exactly what it did before images
      // existed.
      pageImages = []
    }
  }

  async function loadPages() {
    try {
      const data = /** @type {MetricsResponse} */ (await api.metrics(websiteId, 'path', range, 25))
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
        pageSelect.value = path || ''
      }
    } catch {
      path = null
    }
    void loadHeat()
  }
  pageSelect.addEventListener('change', () => {
    path = pageSelect.value
    viewportBucket = null
    void loadHeat()
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
      const data = /** @type {HeatmapResponse} */ (await api.heatmap(websiteId, path, kind, range))
      if (myGen !== gen) return
      const samples = (data && data.samples) || []
      if (samples.length === 0) {
        const mode = MODES.find((m) => m.kind === kind)
        const modeLabel = mode ? mode.label.toLowerCase() : 'data'
        clear(body)
        body.appendChild(
          el(
            'div',
            { class: 'state state-dashed' },
            el(
              'p',
              null,
              `No ${modeLabel} recorded for this page yet. Add `,
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
      renderState(body, 'error', 'Could not load heatmap', errorMessage(err))
    }
  }

  /**
   * @param {HTMLElement} root
   * @param {HeatSample[]} allSamples
   * @param {string} currentPath
   */
  function renderClickMap(root, allSamples, currentPath) {
    const buckets = bucketizeViewports(allSamples)
    const imagesHere = pageImages.filter((img) => img.path === currentPath)
    let samples = allSamples

    // Resolve "choose for me" once per render: land on a viewport that has a
    // real page under it when one exists, so the default view is the good one
    // rather than the schematic.
    if (viewportBucket === null) {
      const withImage = buckets.find((b) => imageForBucket(imagesHere, b))
      viewportBucket = withImage ? String(withImage.key) : buckets.length === 1 ? String(buckets[0].key) : 'all'
    }

    const wrap = el('div', { class: 'heatmap-grid' })
    const left = el('div', null)
    const right = el('div', null)

    const frameOuter = el('div', { class: 'heat-frame-outer' })
    const backdropBadge = el('span', { class: 'heat-badge' })
    const topbar = el(
      'div',
      { class: 'heat-topbar' },
      el('span', { class: 'heat-topbar-dot' }),
      el('span', { class: 'heat-topbar-dot' }),
      el('span', { class: 'heat-topbar-dot' }),
      el('span', { class: 'heat-topbar-path mono', title: currentPath }, currentPath),
      backdropBadge,
    )
    const frame = el('div', { class: 'heat-frame' })
    const pageLayer = el('div', { class: 'heat-page-layer' })
    const wireLayer = el('div', { class: 'heat-wire-layer' })
    const canvasLayer = el('div', { class: 'heat-canvas-layer' })
    frame.appendChild(pageLayer)
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

    // The viewport picker appears whenever any viewport was recorded, not only
    // when several were: with page captures it is also the control that chooses
    // which capture you are looking at, so hiding it on a single-viewport site
    // would hide the backdrop switch too.
    /** @type {HTMLSelectElement | null} */
    let vpSelect = null
    if (buckets.length > 0) {
      vpSelect = /** @type {HTMLSelectElement} */ (
        el('select', { class: 'select heat-viewport-select', 'aria-label': 'Recorded viewport width' })
      )
      if (buckets.length > 1) {
        vpSelect.appendChild(el('option', { value: 'all' }, `All viewports (${allSamples.length} samples)`))
      }
      for (const b of buckets) {
        const img = imageForBucket(imagesHere, b)
        vpSelect.appendChild(
          el(
            'option',
            { value: String(b.key) },
            `~${b.label}px wide (${b.samples.length} samples)${img ? ' · page capture' : ''}`,
          ),
        )
      }
      vpSelect.value = viewportBucket || 'all'
      vpSelect.addEventListener('change', () => {
        viewportBucket = /** @type {HTMLSelectElement} */ (vpSelect).value
        paint()
      })
      const pickerRow = el(
        'div',
        { class: 'heat-viewport-row' },
        el('label', { class: 'heat-viewport-label' }, 'Viewport'),
        vpSelect,
      )
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
    const captureSlot = el('div', null)
    right.appendChild(captureSlot)

    wrap.appendChild(left)
    wrap.appendChild(right)
    root.appendChild(wrap)

    /** @type {ReturnType<typeof mountHeatCanvas> | null} */
    let handle = null
    let imgEl = null

    function paint() {
      const bucket = buckets.find((b) => String(b.key) === viewportBucket) || null
      samples = bucket ? bucket.samples : allSamples
      const image = bucket ? imageForBucket(imagesHere, bucket) : null

      const withViewport = samples.filter((s) => s.vw > 0 && s.vh > 0)
      const meanW = withViewport.length ? Math.round(withViewport.reduce((s, v) => s + v.vw, 0) / withViewport.length) : 0
      const meanH = withViewport.length ? Math.round(withViewport.reduce((s, v) => s + v.vh, 0) / withViewport.length) : 0

      clear(pageLayer)
      clear(wireLayer)
      imgEl = null

      if (image) {
        // The frame becomes the document's shape, because that is the space the
        // samples are percentages of. Nothing else in this function needs to
        // know about scale: the canvas fills the same box.
        frame.style.aspectRatio = String(image.image_w / image.image_h)
        frame.classList.add('has-page')
        imgEl = el('img', {
          class: 'heat-page-img',
          src: api.pageImageURL(websiteId, currentPath, image.viewport_w),
          alt: `Capture of ${currentPath} at ${image.viewport_w}px wide`,
          decoding: 'async',
        })
        pageLayer.appendChild(imgEl)
        backdropBadge.textContent = 'Page capture'
        backdropBadge.className = 'heat-badge heat-badge-real'
      } else {
        // The schematic's frame keeps the recorded viewport's proportions; its
        // vertical axis is still the whole document, which the caption says.
        let ratio = 16 / 10
        if (withViewport.length) {
          const mean = withViewport.reduce((sum, s) => sum + s.vw / s.vh, 0) / withViewport.length
          ratio = Math.min(2, Math.max(0.5, mean))
        }
        frame.style.aspectRatio = String(ratio)
        frame.classList.remove('has-page')
        backdropBadge.textContent = 'Schematic'
        backdropBadge.className = 'heat-badge heat-badge-schematic'

        for (const box of selectorBoxes(samples)) {
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
      }

      if (handle) handle.destroy()
      handle = mountHeatCanvas(canvasLayer)
      handle.setSamples(
        /** @type {import('./heatcanvas.js').HeatPoint[]} */ (
          samples.filter((s) => typeof s.x === 'number' && typeof s.y === 'number')
        ),
      )

      clear(caption)
      if (image) {
        caption.appendChild(
          el(
            'span',
            null,
            `Real page — a capture of ${currentPath} at ${image.viewport_w}px wide, uploaded ${shortDate(image.created_at)}. `,
            'Click positions are percentages of the document and this capture is one document tall, so every point sits where it was pressed.',
          ),
        )
        const warning = checkAlignment(image, meanW, meanH)
        if (warning) caption.appendChild(el('span', { class: 'heat-caption-warn' }, ` ${warning}`))
      } else {
        caption.textContent =
          (meanW ? `Schematic at ~${meanW}px wide — ` : 'Schematic — ') +
          'not a picture of the page. Boxes are the bounding box of each selector’s own recorded clicks, ' +
          'and the vertical axis is the whole document, not one screen.'
      }

      clickCountEl.textContent = `${count(samples.length)} clicks`

      /** @type {Map<string, number>} */
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

      renderCapturePanel(captureSlot, {
        api,
        websiteId,
        canWrite,
        path: currentPath,
        image,
        bucket,
        suggestedWidth: meanW || (bucket ? bucket.label : 0),
        onChanged: async () => {
          await loadPageImages()
          // onChanged's own contract is `() => Promise<void>` and both call
          // sites (upload/delete below) await it — awaiting here too means
          // the caller's disabled/status-text state actually reflects when
          // the reload finished, not just when it started.
          await loadHeat()
        },
      })
    }

    paint()

    return {
      destroy() {
        if (handle) handle.destroy()
      },
    }
  }

  /**
   * @param {HTMLElement} root
   * @param {HeatSample[]} samples
   */
  function renderScrollDepth(root, samples) {
    const total = samples.length || 1
    const bands = Array.from({ length: 10 }, (_, i) => {
      const depth = (i + 1) * 10
      const reached = samples.filter((s) => (s.scroll || 0) >= depth - 5).length
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

  /**
   * @param {HTMLElement} root
   * @param {HeatSample[]} samples
   */
  function renderAttention(root, samples) {
    /** @type {number[]} */
    const totals = new Array(10).fill(0)
    /** @type {number[]} */
    const counts = new Array(10).fill(0)
    for (const s of samples) {
      const index = Math.min(9, Math.max(0, Math.floor((s.scroll || 0) / 10)))
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
  // Nothing awaits renderHeatmapSection's caller; both loadPageImages and
  // loadPages already swallow their own failures internally (see their
  // try/catch bodies above), so there's nothing a .catch here would add.
  void loadPageImages().then(loadPages)

  return {
    destroy() {
      if (canvasHandle) canvasHandle.destroy()
    },
  }
}

// ── Page captures ────────────────────────────────────────────────────────────

/**
 * The panel that explains — and, for an editor, changes — what is under the
 * heat field.
 *
 * The privacy note is not decoration and does not hide behind a disclosure
 * triangle. Athar's claim is that nothing about a page's content is ever
 * collected, and that claim survives this feature only because the capture is
 * something a human deliberately uploads. Anyone who can put an image here needs
 * to know, at the moment they do it, that they are choosing what every other
 * dashboard user of this website will see.
 */
/**
 * @param {HTMLElement} slot
 * @param {{
 *   api: typeof import('./api.js').api,
 *   websiteId: string,
 *   canWrite: boolean,
 *   path: string,
 *   image: PageImage | null,
 *   bucket: ViewportBucket | null,
 *   suggestedWidth: number,
 *   onChanged: () => Promise<void>,
 * }} args
 */
function renderCapturePanel(slot, { api, websiteId, canWrite, path, image, bucket, suggestedWidth, onChanged }) {
  clear(slot)
  const panel = el('div', { class: 'capture-panel' })
  panel.appendChild(el('h3', { class: 'heatmap-side-title' }, 'Page capture'))

  if (image) {
    panel.appendChild(
      el(
        'p',
        { class: 'capture-status' },
        el('span', { class: 'capture-status-dot is-on' }),
        `${image.image_w}×${image.image_h}, ${formatBytes(image.bytes)}, captured at ${image.viewport_w}px wide.`,
      ),
    )
  } else if (bucket) {
    panel.appendChild(
      el(
        'p',
        { class: 'capture-status' },
        el('span', { class: 'capture-status-dot' }),
        `No capture for ~${bucket.label}px. The map below is a schematic.`,
      ),
    )
  } else {
    panel.appendChild(
      el(
        'p',
        { class: 'capture-status' },
        el('span', { class: 'capture-status-dot' }),
        'Pick a single viewport width above to attach or view a capture. A capture is never shown across mixed viewports — the same page laid out at 390px and 1440px is not the same picture.',
      ),
    )
    slot.appendChild(panel)
    return
  }

  if (!canWrite) {
    panel.appendChild(
      el('p', { class: 'capture-note' }, 'Only an editor or owner of this website can add or remove a capture.'),
    )
    slot.appendChild(panel)
    return
  }

  const status = el('p', { class: 'capture-feedback' })
  const widthInput = /** @type {HTMLInputElement} */ (
    el('input', {
      class: 'text-input capture-width',
      type: 'number',
      min: '200',
      max: '8000',
      step: '1',
      value: String(image ? image.viewport_w : suggestedWidth || 1440),
      'aria-label': 'Viewport width the capture was taken at, in CSS pixels',
    })
  )
  const fileInput = /** @type {HTMLInputElement} */ (
    el('input', {
      class: 'capture-file',
      type: 'file',
      accept: 'image/png,image/jpeg',
      'aria-label': 'Full-page capture of this page (PNG or JPEG)',
    })
  )

  async function uploadCapture() {
    const file = fileInput.files && fileInput.files[0]
    if (!file) {
      status.textContent = 'Choose a PNG or JPEG first.'
      status.className = 'capture-feedback is-error'
      return
    }
    const vw = Number(widthInput.value)
    if (!Number.isFinite(vw) || vw < 200 || vw > 8000) {
      status.textContent = 'Viewport width must be between 200 and 8000 CSS pixels.'
      status.className = 'capture-feedback is-error'
      return
    }
    uploadBtn.disabled = true
    status.textContent = 'Uploading…'
    status.className = 'capture-feedback'
    try {
      await api.putPageImage(websiteId, path, vw, file)
      await onChanged()
    } catch (err) {
      uploadBtn.disabled = false
      status.textContent = errorMessage(err) || 'Upload failed.'
      status.className = 'capture-feedback is-error'
    }
  }
  const uploadBtn = /** @type {HTMLButtonElement} */ (
    el(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        onclick: () => {
          void uploadCapture()
        },
      },
      image ? 'Replace capture' : 'Upload capture',
    )
  )

  const row = el('div', { class: 'capture-row' }, fileInput, el('div', { class: 'capture-row-end' }, widthInput, uploadBtn))
  panel.appendChild(row)
  panel.appendChild(
    el(
      'p',
      { class: 'capture-hint' },
      'Full-page capture, taken at the viewport width on the right. Most browsers: developer tools → device toolbar → set the width → “Capture full size screenshot”.',
    ),
  )
  panel.appendChild(status)

  if (image) {
    const capturedImage = image
    async function removeCapture() {
      status.textContent = 'Removing…'
      status.className = 'capture-feedback'
      try {
        await api.deletePageImage(websiteId, path, capturedImage.viewport_w)
        await onChanged()
      } catch (err) {
        status.textContent = errorMessage(err) || 'Could not remove the capture.'
        status.className = 'capture-feedback is-error'
      }
    }
    panel.appendChild(
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm capture-remove',
          onclick: () => {
            void removeCapture()
          },
        },
        'Remove capture',
      ),
    )
  }

  panel.appendChild(
    el(
      'p',
      { class: 'capture-privacy' },
      el('strong', null, 'This is the one image Athar stores, and you are choosing it. '),
      'The tracker still captures no DOM, no text and no form values, and this server never fetches your site — a capture exists only because someone uploaded it. ' +
        'It is stored in your own database and served only to signed-in users of this website, so capture the page as a logged-out visitor sees it: anything on screen, ' +
        'including a real customer’s name, basket or order, becomes visible to every viewer of this dashboard.',
    ),
  )

  slot.appendChild(panel)
}

/**
 * Reports, in words an operator can act on, the two ways a capture can be the
 * wrong picture. Returns null when nothing is wrong.
 *
 * The aspect-ratio test is the one that matters: an above-the-fold screenshot
 * has roughly the viewport's own ratio, and stretching one to fill a frame the
 * samples treat as the whole document would put every below-the-fold click in
 * the wrong place while looking entirely plausible.
 * @param {PageImage} image
 * @param {number} meanViewportW
 * @param {number} meanViewportH
 * @returns {string | null}
 */
function checkAlignment(image, meanViewportW, meanViewportH) {
  if (!image.image_w || !image.image_h) return null

  if (meanViewportW > 0 && meanViewportH > 0) {
    const imageRatio = image.image_w / image.image_h
    const viewportRatio = meanViewportW / meanViewportH
    if (Math.abs(imageRatio - viewportRatio) / viewportRatio < 0.08) {
      return (
        'This capture has almost exactly the recorded viewport’s proportions, so it may be a single screen rather ' +
        'than the full page. If it is, clicks below the fold are being drawn in the wrong place — recapture it full-page.'
      )
    }
  }

  const scale = image.image_w / image.viewport_w
  const nearestWhole = Math.round(scale)
  if (nearestWhole < 1 || Math.abs(scale - nearestWhole) > 0.02) {
    return (
      `This capture is ${image.image_w}px wide for a declared ${image.viewport_w}px viewport (${scale.toFixed(2)}×). ` +
      'Alignment still holds — positions are proportions — but the declared width is probably not the one it was taken at.'
    )
  }
  return null
}

/**
 * Matches a bucket to an image, preferring the capture nearest its widths.
 * @param {PageImage[]} images
 * @param {ViewportBucket} bucket
 * @returns {PageImage | null}
 */
function imageForBucket(images, bucket) {
  const inBucket = images.filter((img) => viewportBucketKey(img.viewport_w) === bucket.key)
  if (inBucket.length === 0) return null
  return inBucket.reduce((best, img) =>
    Math.abs(img.viewport_w - bucket.label) < Math.abs(best.viewport_w - bucket.label) ? img : best,
  )
}

/**
 * @param {number | null | undefined} ms
 * @returns {string}
 */
function shortDate(ms) {
  if (!ms) return 'recently'
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return 'recently'
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

/**
 * @param {HTMLElement} root
 * @param {'empty' | 'loading' | 'error'} kindOf
 * @param {string} title
 * @param {string} [hint]
 */
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
 * The bucket a viewport width belongs to. Exported shape, in the sense that a
 * stored page image is matched to recorded samples through this function and
 * nothing else — so the two sides can never drift into disagreeing about which
 * widths are "the same layout".
 * @param {number} vw
 * @returns {number}
 */
export function viewportBucketKey(vw) {
  return Math.round(vw / VIEWPORT_BUCKET_PX) * VIEWPORT_BUCKET_PX
}

/**
 * Groups samples by recorded viewport width into ~150px-wide buckets — wide
 * enough that jitter within one real device class collapses to one bucket,
 * narrow enough to keep 390 / 768 / 1024 / 1440-ish viewports distinct.
 *
 * Each bucket carries a `label`: the most common *actual* width in it, not the
 * rounded key. A picker offering "~1950px" for a population of 1920px screens
 * describes a width nobody has; the key is an implementation detail and stays
 * one.
 * @param {HeatSample[]} samples
 * @returns {ViewportBucket[]}
 */
function bucketizeViewports(samples) {
  const withVw = samples.filter((s) => s.vw > 0)
  if (withVw.length === 0) return []
  /** @type {Map<number, HeatSample[]>} */
  const groups = new Map()
  for (const s of withVw) {
    const key = viewportBucketKey(s.vw)
    let bucket = groups.get(key)
    if (!bucket) {
      bucket = []
      groups.set(key, bucket)
    }
    bucket.push(s)
  }
  return [...groups.entries()]
    .map(([key, samplesForKey]) => {
      /** @type {Map<number, number>} */
      const freq = new Map()
      for (const s of samplesForKey) freq.set(s.vw, (freq.get(s.vw) || 0) + 1)
      let label = key
      let best = -1
      for (const [vw, n] of freq) {
        if (n > best) {
          best = n
          label = vw
        }
      }
      return { key, label, samples: samplesForKey }
    })
    .sort((a, b) => b.samples.length - a.samples.length)
}

/**
 * Bounding box per selector, built only from the (x, y) positions actually
 * recorded for that selector — never from an assumed layout. Padded a
 * little so a single-point box is still visible, and capped to the same
 * top-N the "most clicked elements" list shows.
 * @param {HeatSample[]} samples
 * @returns {Array<{ selector: string, count: number, x0: number, x1: number, y0: number, y1: number }>}
 */
function selectorBoxes(samples) {
  /** @type {Map<string, HeatSample[]>} */
  const bySelector = new Map()
  for (const s of samples) {
    if (!s.selector) continue
    let pts = bySelector.get(s.selector)
    if (!pts) {
      pts = []
      bySelector.set(s.selector, pts)
    }
    pts.push(s)
  }
  const boxes = [...bySelector.entries()].map(([selector, pts]) => {
    const xs = pts.map((p) => p.x || 0)
    const ys = pts.map((p) => p.y || 0)
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
