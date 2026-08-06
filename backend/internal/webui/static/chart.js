import { svgEl, el, clear } from './dom.js'
import { bucketLabel, count } from './format.js'

/**
 * The traffic chart: pageviews as a filled area, visitors as a line, and the
 * previous period as a faint dashed ghost behind both.
 *
 * Hand-drawn SVG rather than a charting library, for the same reason Athar
 * parses user-agents itself — this is one chart, and a dependency that ships
 * a layout engine to draw it would dwarf the rest of the dashboard.
 *
 * Two design rules, both ported unchanged from the React version:
 *
 *   - The geometry is laid out in a real coordinate space with margins, so
 *     the axis labels are drawn in the same space as the data and stay
 *     legible. Stretching a 0-100 viewBox to the container would distort
 *     any text or circle inside it.
 *   - Only two live series, so there is no categorical palette to get wrong.
 *     Pageviews carry the accent; visitors are neutral ink; the comparison
 *     is the same shape at low contrast, which reads as "the past" without
 *     needing a third hue.
 */

/** @typedef {{ t: number, pageviews: number, visitors: number }} ChartPoint */

const MARGIN = { top: 12, right: 8, bottom: 24, left: 44 }
const WIDTH = 800 // viewBox width; the SVG scales to its container
const TICK_COUNT = 4
const STEP_CANDIDATES = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]

/**
 * Picks an axis maximum whose quarters are also round numbers.
 *
 * Rounding the *maximum* alone is not enough: a peak of 40 rounds to 50,
 * whose quarters are 12.5 and 37.5, and the axis ends up reading
 * 0 / 13 / 25 / 38 / 50. Rounding the *step* instead and multiplying by four
 * gives 0 / 10 / 20 / 30 / 40 — values someone would actually say out loud.
 * @param {number} value
 * @returns {number}
 */
function niceCeiling(value) {
  if (value <= 4) return 4

  const rawStep = value / TICK_COUNT
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))

  for (const candidate of STEP_CANDIDATES) {
    const step = candidate * magnitude
    if (!Number.isInteger(step)) continue
    if (step >= rawStep) return step * TICK_COUNT
  }
  return magnitude * 10 * TICK_COUNT
}

/**
 * Projects the series into SVG coordinates and derives the axes.
 * @param {{ points: ChartPoint[], comparison: ChartPoint[] | null | undefined, width: number, height: number, interval: string | undefined }} args
 */
function buildPlot({ points, comparison, width, height, interval }) {
  const innerW = width - MARGIN.left - MARGIN.right
  const innerH = height - MARGIN.top - MARGIN.bottom

  const peak = Math.max(
    1,
    ...points.map((p) => p.pageviews),
    ...(comparison || []).map((p) => p.pageviews),
  )
  const top = niceCeiling(peak)

  /** @param {number} i */
  const x = (i) => MARGIN.left + (points.length > 1 ? (i / (points.length - 1)) * innerW : innerW / 2)
  /** @param {number} value */
  const y = (value) => MARGIN.top + innerH - (value / top) * innerH

  const coords = points.map((p, i) => ({
    x: x(i),
    y: y(p.pageviews),
    yVisitors: y(p.visitors),
  }))

  /** @param {number[]} values */
  const line = (values) =>
    values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ')

  const linePath = line(points.map((p) => p.pageviews))
  const visitorPath = line(points.map((p) => p.visitors))
  const areaPath = `${linePath} L${x(points.length - 1).toFixed(2)},${(MARGIN.top + innerH).toFixed(2)} L${MARGIN.left},${(MARGIN.top + innerH).toFixed(2)} Z`

  const comparePath =
    comparison && comparison.length === points.length ? line(comparison.map((p) => p.pageviews)) : null

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
    value: Math.round(top * fraction),
    y: y(top * fraction),
  }))

  const step = Math.max(1, Math.ceil(points.length / 6))
  const xLabels = []
  for (let i = 0; i < points.length; i += step) {
    xLabels.push({ x: x(i), text: bucketLabel(points[i].t, interval, false) })
  }

  return { areaPath, linePath, visitorPath, comparePath, coords, ticks, xLabels, innerW, innerH }
}

let gradientSeq = 0

/**
 * Renders the chart into `container`, replacing whatever it held. Returns a
 * destroy() to remove listeners — callers rebuild wholesale on new data
 * rather than diffing, so lifecycle is just "call again with fresh props".
 * @param {HTMLElement} container
 * @param {{ points: ChartPoint[], comparison?: ChartPoint[] | null, interval: string | undefined, height?: number }} args
 * @returns {() => void}
 */
export function renderChart(container, { points, comparison, interval, height = 260 }) {
  clear(container)

  if (!points || points.length === 0) {
    container.appendChild(
      el(
        'div',
        { class: 'chart-empty', style: `height:${height}px` },
        'No traffic in this range',
      ),
    )
    return () => {}
  }

  const plot = buildPlot({ points, comparison, width: WIDTH, height, interval })
  const { areaPath, linePath, visitorPath, comparePath, coords, ticks, xLabels, innerW, innerH } = plot
  const gradientId = `chart-grad-${++gradientSeq}`

  const wrap = el('div', { class: 'chart' })

  const gridGroup = ticks.map((tick) =>
    svgEl(
      'g',
      null,
      svgEl('line', {
        x1: MARGIN.left,
        y1: tick.y,
        x2: MARGIN.left + innerW,
        y2: tick.y,
        class: 'chart-grid',
      }),
      svgEl(
        'text',
        { x: MARGIN.left - 8, y: tick.y + 3.5, 'text-anchor': 'end', class: 'chart-axis-label tnum' },
        count(tick.value),
      ),
    ),
  )

  const xLabelGroup = xLabels.map((label) =>
    svgEl(
      'text',
      { x: label.x, y: height - 6, 'text-anchor': 'middle', class: 'chart-axis-label' },
      label.text,
    ),
  )

  const hoverLine = svgEl('line', {
    class: 'chart-hover-line',
    y1: MARGIN.top,
    y2: MARGIN.top + innerH,
    style: 'display:none',
  })
  const hoverDotViews = svgEl('circle', { class: 'chart-dot chart-dot-views', r: 3.5, style: 'display:none' })
  const hoverDotVisitors = svgEl('circle', { class: 'chart-dot chart-dot-visitors', r: 3, style: 'display:none' })

  const svg = svgEl(
    'svg',
    {
      viewBox: `0 0 ${WIDTH} ${height}`,
      class: 'chart-svg',
      style: `height:${height}px`,
      role: 'img',
      'aria-label': `Traffic over time. Peak ${ticks[ticks.length - 1].value} pageviews per ${interval}.`,
    },
    svgEl(
      'defs',
      null,
      svgEl(
        'linearGradient',
        { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 },
        svgEl('stop', { offset: '0%', class: 'chart-area-stop-start' }),
        svgEl('stop', { offset: '100%', class: 'chart-area-stop-end' }),
      ),
    ),
    gridGroup,
    xLabelGroup,
    comparePath ? svgEl('path', { d: comparePath, class: 'chart-compare' }) : null,
    svgEl('path', { d: areaPath, fill: `url(#${gradientId})` }),
    svgEl('path', { d: linePath, class: 'chart-line-views' }),
    svgEl('path', { d: visitorPath, class: 'chart-line-visitors' }),
    hoverLine,
    hoverDotViews,
    hoverDotVisitors,
  )

  const tooltip = el('div', { class: 'chart-tooltip', style: 'display:none' })

  /** @param {number} index */
  function showHover(index) {
    const c = coords[index]
    hoverLine.setAttribute('x1', String(c.x))
    hoverLine.setAttribute('x2', String(c.x))
    hoverLine.style.display = ''
    hoverDotViews.setAttribute('cx', String(c.x))
    hoverDotViews.setAttribute('cy', String(c.y))
    hoverDotViews.style.display = ''
    hoverDotVisitors.setAttribute('cx', String(c.x))
    hoverDotVisitors.setAttribute('cy', String(c.yVisitors))
    hoverDotVisitors.style.display = ''

    const point = points[index]
    const prev = comparison && comparison[index]
    const rows = [
      el(
        'div',
        { class: 'chart-tooltip-row' },
        el('span', { class: 'chart-tooltip-swatch chart-tooltip-swatch-views' }),
        el('span', { class: 'chart-tooltip-label' }, 'Pageviews'),
        el('span', { class: 'chart-tooltip-value tnum' }, count(point.pageviews)),
      ),
      el(
        'div',
        { class: 'chart-tooltip-row' },
        el('span', { class: 'chart-tooltip-swatch chart-tooltip-swatch-visitors' }),
        el('span', { class: 'chart-tooltip-label' }, 'Visitors'),
        el('span', { class: 'chart-tooltip-value tnum' }, count(point.visitors)),
      ),
    ]
    if (prev) {
      rows.push(
        el(
          'div',
          { class: 'chart-tooltip-row' },
          el('span', { class: 'chart-tooltip-swatch chart-tooltip-swatch-compare' }),
          el('span', { class: 'chart-tooltip-label' }, 'Previous'),
          el('span', { class: 'chart-tooltip-value tnum' }, count(prev.pageviews)),
        ),
      )
    }
    clear(tooltip)
    tooltip.appendChild(el('div', { class: 'chart-tooltip-title' }, bucketLabel(point.t, interval, true)))
    for (const r of rows) tooltip.appendChild(r)
    tooltip.style.display = ''
    const pct = (c.x / WIDTH) * 100
    tooltip.style.left = `${pct}%`
    tooltip.style.transform = c.x > WIDTH * 0.7 ? 'translateX(-105%)' : 'translateX(12px)'
  }

  function hideHover() {
    hoverLine.style.display = 'none'
    hoverDotViews.style.display = 'none'
    hoverDotVisitors.style.display = 'none'
    tooltip.style.display = 'none'
  }

  /** @param {number} clientX */
  function indexFromClientX(clientX) {
    const box = svg.getBoundingClientRect()
    const xInView = ((clientX - box.left) / box.width) * WIDTH
    const ratio = (xInView - MARGIN.left) / innerW
    const index = Math.round(ratio * (points.length - 1))
    return Math.min(points.length - 1, Math.max(0, index))
  }

  /** @param {MouseEvent} e */
  const onMove = (e) => showHover(indexFromClientX(e.clientX))
  const onLeave = () => hideHover()
  /** @param {TouchEvent} e */
  const onTouch = (e) => {
    if (e.touches && e.touches[0]) showHover(indexFromClientX(e.touches[0].clientX))
  }
  svg.addEventListener('mousemove', onMove)
  svg.addEventListener('mouseleave', onLeave)
  svg.addEventListener('touchstart', onTouch, { passive: true })
  svg.addEventListener('touchmove', onTouch, { passive: true })
  svg.addEventListener('touchend', onLeave)

  const legend = el(
    'div',
    { class: 'chart-legend' },
    el('span', { class: 'chart-legend-item' }, el('span', { class: 'chart-legend-swatch chart-tooltip-swatch-views' }), 'Pageviews'),
    el('span', { class: 'chart-legend-item' }, el('span', { class: 'chart-legend-swatch chart-tooltip-swatch-visitors' }), 'Visitors'),
    comparePath
      ? el('span', { class: 'chart-legend-item' }, el('span', { class: 'chart-legend-swatch chart-legend-swatch-dashed' }), 'Previous period')
      : null,
  )

  wrap.appendChild(svg)
  wrap.appendChild(tooltip)
  wrap.appendChild(legend)
  container.appendChild(wrap)

  return () => {
    svg.removeEventListener('mousemove', onMove)
    svg.removeEventListener('mouseleave', onLeave)
    svg.removeEventListener('touchstart', onTouch)
    svg.removeEventListener('touchmove', onTouch)
    svg.removeEventListener('touchend', onLeave)
  }
}
