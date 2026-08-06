import { el, svgEl, clear, replace } from './dom.js'
import { api, ApiError, SESSION_EXPIRED } from './api.js'
import { createThemeController } from './theme.js'
import { countryName, flagEmoji } from './countries.js'
import {
  RANGES,
  count,
  delta,
  duration,
  money,
  percent,
  persistRangeKey,
  rangeFor,
  storedRangeKey,
} from './format.js'
import { renderChart } from './chart.js'
import { renderHeatmapSection } from './heatmap.js'

/**
 * Athar dashboard — one hand-written page, no build step.
 *
 * This file is the entire client-side app: boot sequence, sign-in, the
 * per-website dashboard, and every panel on it. It replaces what used to be
 * a React tree (App.jsx + eleven components); the state machine and data
 * flow are ported as directly as vanilla DOM code allows; see each render*
 * function's comment for what it corresponds to.
 */

/** @typedef {{ id: string, name: string, domain?: string, access?: string }} Website */
/** @typedef {{ username: string }} User */
/** @typedef {{ authenticated: boolean, needs_setup?: boolean }} AuthStatus */
/** @typedef {{ visitors: number, pageviews: number, visits: number, bounce_rate: number, avg_visit_seconds: number }} Stats */
/** @typedef {{ points: import('./chart.js').ChartPoint[], interval: string }} SeriesResponse */
/** @typedef {{ totals: Array<{ currency: string, amount_minor: number }> }} RevenueResponse */
/** @typedef {{ active: number }} ActiveResponse */
/** @typedef {{ rows: Array<{ value: string, count: number }> }} MetricsResponse */

/** @typedef {{ boot: 'loading' }} BootLoading */
/** @typedef {{ boot: 'signed-out', needsSetup: boolean }} BootSignedOut */
/** @typedef {{ boot: 'error', message: string }} BootErrorState */
/** @typedef {{ boot: 'ready', user: User, websites: Website[], selectedId: string | null, rangeKey: string }} BootReady */
/** @typedef {BootLoading | BootSignedOut | BootErrorState | BootReady} AppState */

// index.html's #root is asserted present by embed_test.go
// (TestEmbeddedHTMLHasRequiredElements); this is the one place that fact
// becomes a type rather than a null check repeated at every call site.
const root = /** @type {HTMLElement} */ (document.getElementById('root'))
const theme = createThemeController()

// ── Boot ──────────────────────────────────────────────────────────────────────

/** @type {AppState} */
let state = { boot: 'loading' }

/**
 * A caught value's type is `unknown`, not Error — ApiError (thrown by
 * every api.* call) is checked first since it carries the server's actual
 * message; a plain Error covers a network/parse failure; anything else
 * (a thrown string, etc.) falls back to String().
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  if (err instanceof ApiError || err instanceof Error) return err.message
  return String(err)
}

async function boot() {
  try {
    const status = /** @type {AuthStatus} */ (await api.authStatus())
    if (status.authenticated) {
      const user = /** @type {User} */ (await api.me())
      const websites = await loadWebsites()
      state = { boot: 'ready', user, websites, selectedId: websites[0] ? websites[0].id : null, rangeKey: storedRangeKey() }
    } else {
      state = { boot: 'signed-out', needsSetup: status.needs_setup || false }
    }
  } catch (err) {
    state = { boot: 'error', message: errorMessage(err) }
  }
  paint()
}

/** @returns {Promise<Website[]>} */
async function loadWebsites() {
  return /** @type {Promise<Website[]>} */ (api.websites())
}

window.addEventListener(SESSION_EXPIRED, () => {
  state = { boot: 'signed-out', needsSetup: false }
  paint()
})

// ── Root paint ────────────────────────────────────────────────────────────────

function paint() {
  clear(root)
  if (state.boot === 'loading') {
    root.appendChild(el('div', { class: 'boot-center' }, 'Loading…'))
    return
  }
  if (state.boot === 'error') {
    root.appendChild(
      el(
        'div',
        { class: 'boot-center boot-error' },
        el('div', null,
          el('p', { class: 'boot-error-title' }, 'Could not reach the Athar server.'),
          el('p', { class: 'boot-error-detail' }, state.message),
        ),
      ),
    )
    return
  }
  if (state.boot === 'signed-out') {
    root.appendChild(renderLogin(state.needsSetup, async (user) => {
      const websites = await loadWebsites()
      state = { boot: 'ready', user, websites, selectedId: websites[0] ? websites[0].id : null, rangeKey: storedRangeKey() }
      paint()
    }))
    return
  }
  root.appendChild(renderDashboard())
}

boot()

// ── Login / bootstrap ────────────────────────────────────────────────────────
// Port of Login.jsx: which mode this is in comes from the server
// (needs_setup), never guessed client-side.

/**
 * @param {boolean} needsSetup
 * @param {(user: User) => Promise<void>} onSignedIn
 * @returns {HTMLElement}
 */
function renderLogin(needsSetup, onSignedIn) {
  let busy = false

  const usernameField = field('Username', 'text', { autocomplete: 'username', autofocus: true })
  const passwordField = field('Password', 'password', {
    autocomplete: needsSetup ? 'new-password' : 'current-password',
    hint: needsSetup ? 'At least 12 characters' : null,
  })
  const confirmField = needsSetup ? field('Confirm password', 'password', { autocomplete: 'new-password' }) : null

  const errorBox = el('p', { class: 'form-error', role: 'alert', style: 'display:none' })
  const submitBtn = /** @type {HTMLButtonElement} */ (
    el('button', { type: 'submit', class: 'btn btn-primary btn-block' }, needsSetup ? 'Create account' : 'Sign in')
  )

  const form = el(
    'form',
    { class: 'login-form' },
    usernameField.row,
    passwordField.row,
    confirmField ? confirmField.row : null,
    errorBox,
    submitBtn,
  )

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    errorBox.style.display = 'none'

    const username = usernameField.input.value
    const password = passwordField.input.value
    if (needsSetup && confirmField && password !== confirmField.input.value) {
      errorBox.textContent = 'Passwords do not match'
      errorBox.style.display = ''
      return
    }
    if (busy) return
    busy = true
    submitBtn.disabled = true
    submitBtn.textContent = 'Working…'
    try {
      const user = /** @type {User} */ (
        needsSetup ? await api.bootstrap(username, password) : await api.login(username, password)
      )
      await onSignedIn(user)
    } catch (err) {
      errorBox.textContent = err instanceof ApiError ? err.message : 'Something went wrong'
      errorBox.style.display = ''
      busy = false
      submitBtn.disabled = false
      submitBtn.textContent = needsSetup ? 'Create account' : 'Sign in'
    }
  })

  return el(
    'div',
    { class: 'login-page' },
    el(
      'div',
      { class: 'login-card' },
      el(
        'div',
        { class: 'login-brand' },
        logoMark(44),
        el('h1', { class: 'login-title' }, 'Athar'),
        el('p', { class: 'login-subtitle' }, needsSetup ? 'Create the first account on this instance' : 'Sign in to your dashboard'),
      ),
      form,
      el(
        'p',
        { class: 'login-footnote' },
        'This instance stores its data on the machine it runs on.',
        el('br'),
        'Nothing here is sent anywhere else.',
      ),
    ),
  )
}

/**
 * @param {string} label
 * @param {string} type
 * @param {{ autocomplete?: string | null, autofocus?: boolean, hint?: string | null }} [opts]
 * @returns {{ row: HTMLElement, input: HTMLInputElement }}
 */
function field(label, type, opts) {
  opts = opts || {}
  const input = /** @type {HTMLInputElement} */ (
    el('input', {
      type,
      required: true,
      class: 'text-input',
      autocomplete: opts.autocomplete || null,
      autofocus: opts.autofocus || false,
    })
  )
  const row = el(
    'label',
    { class: 'field' },
    el('span', { class: 'field-label' }, label),
    input,
    opts.hint ? el('span', { class: 'field-hint' }, opts.hint) : null,
  )
  return { row, input }
}

// ── Dashboard shell ───────────────────────────────────────────────────────────
// Port of App.jsx's post-boot render + Header().

/** @returns {HTMLElement} */
function renderDashboard() {
  // renderDashboard is only ever called while state.boot === 'ready' (see
  // paint()) — this makes that invariant explicit for the type checker
  // instead of narrowing `state` itself, which a nested closure like
  // paintMain() below can't do across the function boundary.
  const s = /** @type {BootReady} */ (state)

  const wrap = el('div', { class: 'app-shell' })
  const header = el('header', { class: 'topbar' })
  const topbarInner = el('div', { class: 'wrap topbar-inner' })
  header.appendChild(topbarInner)

  topbarInner.appendChild(el('span', { class: 'brand' }, logoMark(28), el('span', { class: 'brand-word' }, 'Athar')))

  const websites = s.websites
  /** @type {HTMLSelectElement | null} */
  let websiteSelect = null
  if (websites.length > 0) {
    websiteSelect = /** @type {HTMLSelectElement} */ (
      el('select', { class: 'select topbar-select', 'aria-label': 'Website' })
    )
    for (const site of websites) websiteSelect.appendChild(el('option', { value: site.id }, site.name))
    websiteSelect.value = s.selectedId || websites[0].id
    websiteSelect.addEventListener('change', () => {
      s.selectedId = /** @type {HTMLSelectElement} */ (websiteSelect).value
      paintMain()
    })
    topbarInner.appendChild(websiteSelect)
  }

  const activeSlot = el('span', { class: 'active-visitors', style: 'display:none' })
  topbarInner.appendChild(activeSlot)

  const spacer = el('div', { class: 'topbar-spacer' })
  topbarInner.appendChild(spacer)

  const rangeBar = el('div', { class: 'segmented' })
  for (const r of RANGES) {
    rangeBar.appendChild(
      el(
        'button',
        {
          type: 'button',
          class: 'segmented-btn' + (r.key === s.rangeKey ? ' is-active' : ''),
          onclick: () => {
            s.rangeKey = r.key
            persistRangeKey(r.key)
            for (const btn of rangeBar.children) btn.classList.remove('is-active')
            paintMain()
          },
        },
        r.label,
      ),
    )
  }
  topbarInner.appendChild(rangeBar)

  const themeBtn = el('button', {
    type: 'button',
    class: 'icon-btn',
    onclick: () => theme.cycle(),
  })
  updateThemeButton(themeBtn)
  theme.onChange(() => updateThemeButton(themeBtn))
  topbarInner.appendChild(themeBtn)

  const signOutBtn = el(
    'button',
    {
      type: 'button',
      class: 'btn btn-ghost',
      title: `Signed in as ${s.user.username}`,
      onclick: async () => {
        try {
          await api.logout()
        } catch {
          // Sign-out proceeds locally regardless of the network round trip.
        }
        state = { boot: 'signed-out', needsSetup: false }
        paint()
      },
    },
    'Sign out',
  )
  topbarInner.appendChild(signOutBtn)

  wrap.appendChild(header)

  const main = el('main', { class: 'wrap main' })
  wrap.appendChild(main)

  wrap.appendChild(
    el(
      'footer',
      { class: 'wrap footer' },
      'Athar · your data, on your machine · ',
      el('a', { href: 'https://github.com/vul-os/athar', target: '_blank', rel: 'noopener noreferrer' }, 'source'),
    ),
  )

  /** @type {(() => void) | null} */
  let activeVisitorsStop = null
  /** @type {(() => void) | null} */
  let overviewStop = null

  function paintMain() {
    if (activeVisitorsStop) activeVisitorsStop()
    if (overviewStop) overviewStop()
    clear(main)

    const selected = websites.find((w) => w.id === s.selectedId) || null

    if (websites.length === 0) {
      main.appendChild(
        renderAddWebsite((site) => {
          s.websites = [site]
          websites.push(site)
          s.selectedId = site.id
          // Rebuild the whole shell: the header needs a website select now.
          replace(root, renderDashboard())
        }),
      )
      activeSlot.style.display = 'none'
      return
    }
    if (!selected) return

    activeVisitorsStop = mountActiveVisitors(activeSlot, selected.id)

    const range = rangeFor(s.rangeKey)
    overviewStop = renderOverview(main, selected, range)
  }

  paintMain()
  return wrap
}

/** @param {HTMLElement} btn */
function updateThemeButton(btn) {
  const pref = theme.preference
  const label = pref === 'light' ? 'Light' : pref === 'dark' ? 'Dark' : 'System'
  btn.title = `Theme: ${label} — click to change`
  btn.setAttribute('aria-label', `Theme: ${label}. Click to change.`)
  clear(btn)
  btn.appendChild(themeIcon(pref))
}

/**
 * @param {import('./theme.js').Preference} pref
 * @returns {SVGElement}
 */
function themeIcon(pref) {
  const common = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }
  if (pref === 'light') {
    return svgEl('svg', common,
      svgEl('circle', { cx: 12, cy: 12, r: 4 }),
      svgEl('path', { d: 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' }))
  }
  if (pref === 'dark') {
    return svgEl('svg', common, svgEl('path', { d: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z' }))
  }
  return svgEl('svg', common,
    svgEl('rect', { x: 2, y: 3, width: 20, height: 14, rx: 2 }),
    svgEl('path', { d: 'M8 21h8M12 17v4' }))
}

/**
 * @param {number} size
 * @returns {SVGElement}
 */
function logoMark(size) {
  return svgEl(
    'svg',
    { viewBox: '0 0 32 32', width: size, height: size, class: 'logo-mark', role: 'img', 'aria-label': 'Athar' },
    svgEl('rect', { width: 32, height: 32, rx: 8, class: 'logo-bg' }),
    svgEl('circle', { cx: 16, cy: 16, r: 3, class: 'logo-dot' }),
    svgEl('circle', { cx: 16, cy: 16, r: 7, class: 'logo-ring logo-ring-1' }),
    svgEl('circle', { cx: 16, cy: 16, r: 11, class: 'logo-ring logo-ring-2' }),
  )
}

/**
 * Realtime "N now" readout, polled while the tab is visible. Port of App.jsx's ActiveVisitors.
 * @param {HTMLElement} slot
 * @param {string} websiteId
 * @returns {() => void}
 */
function mountActiveVisitors(slot, websiteId) {
  let stopped = false
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null

  async function poll() {
    if (document.visibilityState !== 'visible') return
    try {
      const res = /** @type {ActiveResponse} */ (await api.active(websiteId))
      if (stopped) return
      clear(slot)
      slot.style.display = ''
      slot.appendChild(el('span', { class: 'active-dot' + (res.active > 0 ? ' is-live' : '') }))
      slot.appendChild(el('span', { class: 'tnum' }, count(res.active)))
      slot.appendChild(document.createTextNode(' now'))
      slot.title = 'Visitors in the last 5 minutes'
    } catch {
      // Transient failures are not worth surfacing on a realtime badge.
    }
  }
  poll()
  timer = setInterval(poll, 15000)
  document.addEventListener('visibilitychange', poll)

  return () => {
    stopped = true
    clearInterval(timer)
    document.removeEventListener('visibilitychange', poll)
    slot.style.display = 'none'
  }
}

// ── Add website (first-run empty state) ──────────────────────────────────────

/** @param {(site: Website) => void} onCreated */
function renderAddWebsite(onCreated) {
  let busy = false
  const nameInput = /** @type {HTMLInputElement} */ (
    el('input', { class: 'text-input', placeholder: 'My site', required: true, autofocus: true })
  )
  const domainInput = /** @type {HTMLInputElement} */ (
    el('input', { class: 'text-input', placeholder: 'example.com', required: true })
  )
  const errorBox = el('p', { class: 'form-error', style: 'display:none' })
  const submitBtn = /** @type {HTMLButtonElement} */ (
    el('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Create website')
  )

  const form = el(
    'form',
    { class: 'add-website-form' },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Name'), nameInput),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Domain'), domainInput),
    errorBox,
    submitBtn,
  )
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (busy) return
    busy = true
    errorBox.style.display = 'none'
    submitBtn.disabled = true
    submitBtn.textContent = 'Creating…'
    try {
      const site = /** @type {Website} */ (await api.createWebsite(nameInput.value, domainInput.value))
      onCreated(site)
    } catch (err) {
      errorBox.textContent = err instanceof ApiError ? err.message : String(err)
      errorBox.style.display = ''
      busy = false
      submitBtn.disabled = false
      submitBtn.textContent = 'Create website'
    }
  })

  return el(
    'div',
    { class: 'add-website-card' },
    el('h2', { class: 'add-website-title' }, 'Add your first website'),
    el('p', { class: 'add-website-sub' }, 'Athar starts collecting as soon as the script is on the page.'),
    form,
  )
}

/** @param {Website} website */
function renderSnippet(website) {
  const tag = `<script defer src="${window.location.origin}/athar.js" data-website-id="${website.id}"></script>`
  const copyBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, 'Copy')
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(tag)
      copyBtn.textContent = 'Copied'
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1800)
    } catch {
      // Clipboard access can be denied; the snippet is selectable regardless.
    }
  })
  return el(
    'div',
    { class: 'panel snippet-panel' },
    el('header', { class: 'panel-header' }, el('h2', { class: 'panel-title' }, 'Tracking snippet'), copyBtn),
    el('div', { class: 'snippet-code-wrap' }, el('code', { class: 'snippet-code mono' }, tag)),
    el(
      'p',
      { class: 'snippet-hint' },
      'Add ', el('code', { class: 'mono' }, 'data-heatmap="true"'), ' to collect click, scroll and attention heatmaps.',
    ),
  )
}

// ── Overview: stat tiles, chart, heatmap, metric panels ──────────────────────
// Port of Overview.jsx. Returns a stop() that cancels in-flight loads and
// tears down live widgets (the heat canvas's ResizeObserver) when the
// caller replaces this section.

/**
 * @param {HTMLElement} main
 * @param {Website} website
 * @param {import('./api.js').DateRange} range
 * @returns {() => void}
 */
function renderOverview(main, website, range) {
  let stopped = false
  /** @type {{ destroy(): void } | null} */
  let heatmapHandle = null

  const statGrid = el('div', { class: 'stat-grid' })
  const revenueRow = el('div', { class: 'revenue-row', style: 'display:none' })
  const chartPanel = el('section', { class: 'panel chart-panel' })
  const chartBody = el('div', null)
  chartPanel.appendChild(chartBody)
  const heatmapSlot = el('div', null)
  const metricsGrid = el('div', { class: 'metrics-grid' })

  main.appendChild(statGrid)
  main.appendChild(revenueRow)
  main.appendChild(chartPanel)
  main.appendChild(heatmapSlot)
  main.appendChild(metricsGrid)

  // Placeholder tiles while data loads.
  const tileSpecs = [
    { label: 'Visitors', accent: true },
    { label: 'Pageviews' },
    { label: 'Sessions' },
    { label: 'Bounce rate' },
    { label: 'Avg. visit' },
  ]
  const tileNodes = tileSpecs.map((spec) => statTile(spec.label, null, null, spec.accent))
  for (const t of tileNodes) statGrid.appendChild(t.node)
  chartBody.appendChild(el('div', { class: 'chart-empty' }, 'Loading…'))

  ;(async () => {
    const span = range.to - range.from
    const previousRange = { from: range.from - span, to: range.from }
    try {
      const [stats, series, revenue, previousStats, previousSeries] = /** @type {[Stats, SeriesResponse, RevenueResponse, Stats, SeriesResponse]} */ (
        await Promise.all([
          api.stats(website.id, range),
          api.series(website.id, range),
          api.revenue(website.id, range),
          api.stats(website.id, previousRange),
          api.series(website.id, previousRange),
        ])
      )
      if (stopped) return

      const views = (series.points || []).map((p) => p.pageviews)
      const visitors = (series.points || []).map((p) => p.visitors)

      tileNodes[0].update(count(stats.visitors), stats.visitors, previousStats.visitors, visitors, false)
      tileNodes[1].update(count(stats.pageviews), stats.pageviews, previousStats.pageviews, views, false)
      tileNodes[2].update(count(stats.visits), stats.visits, previousStats.visits, null, false)
      tileNodes[3].update(percent(stats.bounce_rate), stats.bounce_rate, previousStats.bounce_rate, null, true)
      tileNodes[4].update(duration(stats.avg_visit_seconds), stats.avg_visit_seconds, previousStats.avg_visit_seconds, null, false)

      const totals = (revenue && revenue.totals) || []
      clear(revenueRow)
      if (totals.length > 0) {
        revenueRow.style.display = ''
        for (const total of totals) {
          const t = statTile(`Revenue · ${total.currency}`, money(total.amount_minor, total.currency), null, true)
          t.node.classList.add('revenue-tile')
          revenueRow.appendChild(t.node)
        }
      } else {
        revenueRow.style.display = 'none'
      }

      renderChart(chartBody, { points: series.points, comparison: previousSeries.points, interval: series.interval })

      if (!heatmapHandle) {
        // canWrite gates the page-capture uploader: adding a capture changes
        // what every other viewer of this website sees, so it is an editor
        // action. The server enforces it too (AccessWrite on PUT/DELETE) —
        // this only keeps a viewer from being shown a control that would 404.
        heatmapHandle = renderHeatmapSection(heatmapSlot, {
          api,
          websiteId: website.id,
          range,
          canWrite: website.access === 'owner' || website.access === 'editor',
        })
      }
    } catch (err) {
      if (stopped) return
      clear(main)
      main.appendChild(
        el('div', { class: 'state state-error' }, el('div', { class: 'state-title' }, 'Could not load this dashboard'),
          el('div', { class: 'state-detail' }, err instanceof ApiError ? err.message : String(err))),
      )
    }
  })()

  clear(metricsGrid)
  metricsGrid.appendChild(mountMetricPanel({ websiteId: website.id, range, title: 'Pages', tabs: [
    { metric: 'path', label: 'Top' },
    { metric: 'entry_path', label: 'Entry' },
    { metric: 'exit_path', label: 'Exit' },
  ] }).node)
  metricsGrid.appendChild(mountMetricPanel({ websiteId: website.id, range, title: 'Sources', emptyLabel: 'Direct', tabs: [
    { metric: 'referrer', label: 'Referrers' },
    { metric: 'utm_source', label: 'Source' },
    { metric: 'utm_medium', label: 'Medium' },
    { metric: 'utm_campaign', label: 'Campaign' },
  ] }).node)
  metricsGrid.appendChild(mountMetricPanel({ websiteId: website.id, range, title: 'Technology', tabs: [
    { metric: 'browser', label: 'Browser' },
    { metric: 'os', label: 'OS' },
    { metric: 'device', label: 'Device' },
    { metric: 'screen', label: 'Screen' },
  ] }).node)
  metricsGrid.appendChild(mountMetricPanel({ websiteId: website.id, range, title: 'Places', tabs: [
    { metric: 'country', label: 'Country' },
    { metric: 'region', label: 'Region' },
    { metric: 'city', label: 'City' },
    { metric: 'language', label: 'Language' },
  ] }).node)
  metricsGrid.appendChild(mountMetricPanel({ websiteId: website.id, range, title: 'Custom events', tabs: null, fixedMetric: 'event' }).node)

  main.appendChild(renderSnippet(website))

  return () => {
    stopped = true
    if (heatmapHandle) heatmapHandle.destroy()
  }
}

/**
 * A headline metric tile: value, delta vs the previous period, sparkline.
 * @param {string} label
 * @param {string | null} value
 * @param {number | null} current
 * @param {boolean} [accent]
 * @returns {{
 *   node: HTMLElement,
 *   update(formatted: string | null | undefined, currentVal: number | undefined, previousVal: number | null | undefined, series: number[] | null, invert: boolean): void,
 * }}
 */
function statTile(label, value, current, accent) {
  const labelEl = el('span', { class: 'stat-label' }, label)
  const deltaEl = el('span', { class: 'stat-delta', style: 'display:none' })
  const valueEl = el('span', { class: 'stat-value' + (accent ? ' stat-value-accent' : '') }, value === null ? '—' : value)
  const sparkSlot = el('span', { class: 'stat-spark-slot' })
  const node = el(
    'div',
    { class: 'stat-tile' + (accent ? ' stat-tile-accent' : '') },
    el('div', { class: 'stat-tile-top' }, labelEl, deltaEl),
    el('div', { class: 'stat-tile-bottom' }, valueEl, sparkSlot),
  )
  return {
    node,
    update(formatted, currentVal, previousVal, series, invert) {
      valueEl.textContent = formatted === null || formatted === undefined ? '—' : formatted
      const d = currentVal !== undefined && previousVal ? delta(currentVal, previousVal) : null
      if (d && d.value !== 0) {
        const good = invert ? d.value < 0 : d.value > 0
        deltaEl.textContent = d.label
        deltaEl.className = 'stat-delta ' + (good ? 'stat-delta-good' : 'stat-delta-bad')
        deltaEl.style.display = ''
        deltaEl.title = 'Compared with the previous period of the same length'
      } else {
        deltaEl.style.display = 'none'
      }
      clear(sparkSlot)
      if (series && series.length > 1) sparkSlot.appendChild(sparkline(series, accent))
    },
  }
}

/**
 * @param {number[]} values
 * @param {boolean} [accent]
 * @returns {SVGElement}
 */
function sparkline(values, accent) {
  const width = 64
  const height = 22
  const max = Math.max(1, ...values)
  const step = width / (values.length - 1)
  const path = values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - (v / max) * height).toFixed(1)}`)
    .join(' ')
  return svgEl(
    'svg',
    { width, height, viewBox: `0 0 ${width} ${height}`, class: 'sparkline', 'aria-hidden': 'true' },
    svgEl('path', { d: path, class: 'sparkline-path' + (accent ? ' sparkline-path-accent' : '') }),
  )
}

/**
 * A "top N" breakdown panel. Port of MetricPanel.jsx: bars proportional to
 * the leader (not the total, since the list is truncated), share computed
 * against the API's true total so the percentage stays honest regardless.
 * @param {{
 *   websiteId: string,
 *   range: import('./api.js').DateRange,
 *   title: string,
 *   tabs: Array<{ metric: string, label: string }> | null,
 *   emptyLabel?: string,
 *   fixedMetric?: string,
 * }} args
 * @returns {{ node: HTMLElement }}
 */
function mountMetricPanel({ websiteId, range, title, tabs, emptyLabel, fixedMetric }) {
  /** @type {string} */
  let metric = fixedMetric || (tabs && tabs[0] ? tabs[0].metric : '')
  let gen = 0

  const tabBar = tabs ? el('div', { class: 'segmented segmented-sm' }) : null
  const header = el('header', { class: 'panel-header' }, el('h2', { class: 'panel-title' }, title), tabBar)
  const body = el('div', { class: 'metric-panel-body' })
  const node = el('section', { class: 'panel metric-panel' }, header, body)

  function paintTabs() {
    if (!tabBar || !tabs) return
    clear(tabBar)
    for (const t of tabs) {
      tabBar.appendChild(
        el(
          'button',
          {
            type: 'button',
            class: 'segmented-btn' + (t.metric === metric ? ' is-active' : ''),
            onclick: () => {
              if (metric === t.metric) return
              metric = t.metric
              paintTabs()
              load()
            },
          },
          t.label,
        ),
      )
    }
  }

  async function load() {
    const myGen = ++gen
    clear(body)
    body.appendChild(el('p', { class: 'metric-message' }, 'Loading…'))
    try {
      const data = /** @type {MetricsResponse | null} */ (await api.metrics(websiteId, metric, range, 8))
      if (myGen !== gen) return
      const rows = (data && data.rows) || []
      clear(body)
      if (rows.length === 0) {
        body.appendChild(el('p', { class: 'metric-message' }, 'Nothing recorded yet'))
        return
      }
      const max = Math.max(...rows.map((r) => r.count))
      const total = rows.reduce((sum, r) => sum + r.count, 0)
      const flags = metric === 'country'
      const list = el('ol', { class: 'bar-list' })
      for (const row of rows) {
        const label = flags ? countryName(row.value) : row.value || emptyLabel || row.value
        const share = total ? Math.round((row.count / total) * 100) : 0
        list.appendChild(
          el(
            'li',
            { class: 'bar-row', title: label },
            el('span', { class: 'bar-row-fill', style: `width:${(row.count / max) * 100}%` }),
            flags ? el('span', { class: 'bar-row-flag' }, flagEmoji(row.value)) : null,
            el('span', { class: 'bar-row-label' }, label),
            el('span', { class: 'bar-row-share tnum' }, `${share}%`),
            el('span', { class: 'bar-row-value tnum' }, count(row.count)),
          ),
        )
      }
      body.appendChild(list)
    } catch (err) {
      if (myGen !== gen) return
      clear(body)
      body.appendChild(el('p', { class: 'metric-message metric-message-error' }, err instanceof ApiError ? err.message : String(err)))
    }
  }

  paintTabs()
  load()
  return { node }
}
