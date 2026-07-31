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

const root = document.getElementById('root')
const theme = createThemeController()

// ── Boot ──────────────────────────────────────────────────────────────────────

let state = { boot: 'loading' }

async function boot() {
  try {
    const status = await api.authStatus()
    if (status.authenticated) {
      const user = await api.me()
      const websites = await loadWebsites()
      state = { boot: 'ready', user, websites, selectedId: websites[0] ? websites[0].id : null, rangeKey: storedRangeKey() }
    } else {
      state = { boot: 'signed-out', needsSetup: status.needs_setup }
    }
  } catch (err) {
    state = { boot: 'error', message: err instanceof ApiError ? err.message : String((err && err.message) || err) }
  }
  paint()
}

async function loadWebsites() {
  return api.websites()
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

function renderLogin(needsSetup, onSignedIn) {
  let busy = false

  const usernameField = field('Username', 'text', { autocomplete: 'username', autofocus: true })
  const passwordField = field('Password', 'password', {
    autocomplete: needsSetup ? 'new-password' : 'current-password',
    hint: needsSetup ? 'At least 12 characters' : null,
  })
  const confirmField = needsSetup ? field('Confirm password', 'password', { autocomplete: 'new-password' }) : null

  const errorBox = el('p', { class: 'form-error', role: 'alert', style: 'display:none' })
  const submitBtn = el('button', { type: 'submit', class: 'btn btn-primary btn-block' }, needsSetup ? 'Create account' : 'Sign in')

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
    if (needsSetup && password !== confirmField.input.value) {
      errorBox.textContent = 'Passwords do not match'
      errorBox.style.display = ''
      return
    }
    if (busy) return
    busy = true
    submitBtn.disabled = true
    submitBtn.textContent = 'Working…'
    try {
      const user = needsSetup ? await api.bootstrap(username, password) : await api.login(username, password)
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

function field(label, type, opts) {
  opts = opts || {}
  const input = el('input', {
    type,
    required: true,
    class: 'text-input',
    autocomplete: opts.autocomplete || null,
    autofocus: opts.autofocus || false,
  })
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

function renderDashboard() {
  const wrap = el('div', { class: 'app-shell' })
  const header = el('header', { class: 'topbar' })
  const topbarInner = el('div', { class: 'wrap topbar-inner' })
  header.appendChild(topbarInner)

  topbarInner.appendChild(el('span', { class: 'brand' }, logoMark(28), el('span', { class: 'brand-word' }, 'Athar')))

  const websites = state.websites
  let websiteSelect = null
  if (websites.length > 0) {
    websiteSelect = el('select', { class: 'select topbar-select', 'aria-label': 'Website' })
    for (const site of websites) websiteSelect.appendChild(el('option', { value: site.id }, site.name))
    websiteSelect.value = state.selectedId || websites[0].id
    websiteSelect.addEventListener('change', () => {
      state.selectedId = websiteSelect.value
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
          class: 'segmented-btn' + (r.key === state.rangeKey ? ' is-active' : ''),
          onclick: () => {
            state.rangeKey = r.key
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
      title: `Signed in as ${state.user.username}`,
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

  let activeVisitorsStop = null
  let overviewStop = null

  function paintMain() {
    if (activeVisitorsStop) activeVisitorsStop()
    if (overviewStop) overviewStop()
    clear(main)

    const selected = websites.find((w) => w.id === state.selectedId) || null

    if (websites.length === 0) {
      main.appendChild(
        renderAddWebsite((site) => {
          state.websites = [site]
          websites.push(site)
          state.selectedId = site.id
          // Rebuild the whole shell: the header needs a website select now.
          replace(root, renderDashboard())
        }),
      )
      activeSlot.style.display = 'none'
      return
    }
    if (!selected) return

    activeVisitorsStop = mountActiveVisitors(activeSlot, selected.id)

    const range = rangeFor(state.rangeKey)
    overviewStop = renderOverview(main, selected, range)
  }

  paintMain()
  return wrap
}

function updateThemeButton(btn) {
  const pref = theme.preference
  const label = pref === 'light' ? 'Light' : pref === 'dark' ? 'Dark' : 'System'
  btn.title = `Theme: ${label} — click to change`
  btn.setAttribute('aria-label', `Theme: ${label}. Click to change.`)
  clear(btn)
  btn.appendChild(themeIcon(pref))
}

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

/** Realtime "N now" readout, polled while the tab is visible. Port of App.jsx's ActiveVisitors. */
function mountActiveVisitors(slot, websiteId) {
  let stopped = false
  let timer = null

  async function poll() {
    if (document.visibilityState !== 'visible') return
    try {
      const res = await api.active(websiteId)
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

function renderAddWebsite(onCreated) {
  let busy = false
  const nameInput = el('input', { class: 'text-input', placeholder: 'My site', required: true, autofocus: true })
  const domainInput = el('input', { class: 'text-input', placeholder: 'example.com', required: true })
  const errorBox = el('p', { class: 'form-error', style: 'display:none' })
  const submitBtn = el('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Create website')

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
      const site = await api.createWebsite(nameInput.value, domainInput.value)
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

function renderOverview(main, website, range) {
  let stopped = false
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
      const [stats, series, revenue, previousStats, previousSeries] = await Promise.all([
        api.stats(website.id, range),
        api.series(website.id, range),
        api.revenue(website.id, range),
        api.stats(website.id, previousRange),
        api.series(website.id, previousRange),
      ])
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
        heatmapHandle = renderHeatmapSection(heatmapSlot, { api, websiteId: website.id, range })
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

/** A headline metric tile: value, delta vs the previous period, sparkline. */
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
 */
function mountMetricPanel({ websiteId, range, title, tabs, emptyLabel, fixedMetric }) {
  let metric = fixedMetric || (tabs && tabs[0].metric)
  let gen = 0

  const tabBar = tabs ? el('div', { class: 'segmented segmented-sm' }) : null
  const header = el('header', { class: 'panel-header' }, el('h2', { class: 'panel-title' }, title), tabBar)
  const body = el('div', { class: 'metric-panel-body' })
  const node = el('section', { class: 'panel metric-panel' }, header, body)

  function paintTabs() {
    if (!tabBar) return
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
      const data = await api.metrics(websiteId, metric, range, 8)
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
