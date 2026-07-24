#!/usr/bin/env node
/**
 * screenshots.mjs — regenerate the screenshots used by the README and the
 * marketing site.
 *
 * Self-contained and reproducible: it builds the binary, generates a backdated
 * demo dataset into a throwaway database, boots the server against it, drives
 * headless Chromium in both themes, and tears everything down. Nothing touches
 * the developer's own database, and a re-run produces the same images.
 *
 * The dataset comes from `backend/cmd/athar-demo`, which writes through the
 * store package. That indirection exists for one reason: the collector stamps
 * `time.Now()` on every beacon, so seeding over HTTP can only ever produce a
 * single hour of traffic — a flat line with one spike, which showcases nothing.
 *
 * It also acts as a boot guard: any console error or uncaught exception while
 * capturing fails the run.
 *
 * Usage:
 *   npm run screenshots
 *
 * Requires: Go, Node, and Chromium (`npx playwright install chromium`).
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs/screenshots')
const SITE_OUT = join(ROOT, 'site/screenshots')

const PORT = 3187
const BASE = `http://127.0.0.1:${PORT}`
const USER = 'demo'
const PASS = 'athar-demo-password'

const BINARY = join(ROOT, process.platform === 'win32' ? 'athar.exe' : 'athar')

// Which range the captures use. Override to compare options: RANGE='7 days'.
const RANGE_LABEL = process.env.RANGE || '30 days'

async function waitForServer(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(BASE + '/api/health')).ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('server did not become healthy in time')
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(SITE_OUT, { recursive: true })

  console.log('[shots] building…')
  execFileSync('npm', ['run', 'build:tracker'], { cwd: ROOT, stdio: 'inherit' })
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
  execFileSync('node', ['scripts/build-binary.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ATHAR_VERSION: 'demo' },
  })
  if (!existsSync(BINARY)) throw new Error('binary was not produced')

  const workdir = mkdtempSync(join(tmpdir(), 'athar-shots-'))
  const dbPath = join(workdir, 'athar.db')

  console.log('[shots] generating 30 days of demo data…')
  execFileSync(
    'go',
    ['run', './backend/cmd/athar-demo', '-db', dbPath, '-days', '30', '-user', USER, '-password', PASS],
    { cwd: ROOT, stdio: 'inherit' },
  )

  console.log(`[shots] booting on ${BASE}`)
  const server = spawn(BINARY, ['-db', dbPath], {
    cwd: workdir,
    env: { ...process.env, ATHAR_PORT: String(PORT), ATHAR_HOST: '127.0.0.1' },
    stdio: 'ignore',
  })

  let browser
  const errors = []

  try {
    await waitForServer()
    browser = await chromium.launch()

    /**
     * Opens a signed-in dashboard page in the given theme.
     *
     * The theme is written to localStorage before the first navigation so the
     * pre-paint init script picks it up — setting it afterwards would capture a
     * transition rather than a settled page.
     */
    const openDashboard = async (theme, viewport) => {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 2 })
      page.on('pageerror', (e) => errors.push(`${theme}: ${e.message}`))
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`${theme}: ${m.text()}`)
      })

      await page.addInitScript((t) => localStorage.setItem('athar-theme', t), theme)
      await page.goto(BASE + '/', { waitUntil: 'networkidle' })
      await page.fill('input[autocomplete="username"]', USER)
      await page.fill('input[type="password"]', PASS)
      await page.click('button[type="submit"]')
      // Wait for the headline metrics rather than a fixed delay, so a slow
      // query cannot produce a screenshot of a half-loaded dashboard.
      await page.waitForSelector('text=Pageviews', { timeout: 15000 })

      // Capture 30 days rather than the app's 7-day default.
      //
      // This was chosen by comparing both: at 7 days the previous-period ghost
      // still contains the demo dataset's spike day, and since both series
      // share a y-axis (they must — comparing them on different scales would
      // be a lie), the live data gets squashed into the bottom fifth of the
      // chart. 30 days puts the spike in the live series where it belongs.
      await page.getByRole('button', { name: RANGE_LABEL, exact: true }).click()
      await page.waitForTimeout(1800)
      return page
    }

    const shots = []

    // ── Dashboard, both themes ──────────────────────────────────────────────
    for (const theme of ['dark', 'light']) {
      const page = await openDashboard(theme, { width: 1440, height: 1000 })
      await page.screenshot({ path: join(OUT, `dashboard-${theme}.png`) })
      shots.push(`dashboard-${theme}`)

      // Full page, for anyone who wants to see the whole thing at once.
      if (theme === 'dark') {
        await page.screenshot({ path: join(OUT, 'dashboard-full.png'), fullPage: true })
        shots.push('dashboard-full')
      }

      // ── Heatmap: the differentiator, so it gets its own framed shots ──────
      const picker = page.locator('select[aria-label="Page to show heatmap for"]')
      const options = await picker.locator('option').allTextContents()
      // Prefer a content page over "/" — a pricing or docs page makes a more
      // legible click map than a homepage that everyone lands on.
      const preferred = options.find((o) => o.includes('/pricing')) ?? options[0]
      if (preferred) {
        await picker.selectOption({ label: preferred })
        await page.waitForTimeout(1500)
      }

      const section = page.locator('section', { hasText: 'Heatmaps' }).first()
      await section.scrollIntoViewIfNeeded()
      await page.waitForTimeout(600)
      await section.screenshot({ path: join(OUT, `heatmap-clicks-${theme}.png`) })
      shots.push(`heatmap-clicks-${theme}`)

      if (theme === 'dark') {
        for (const [mode, name] of [
          ['Scroll depth', 'heatmap-scroll'],
          ['Attention', 'heatmap-attention'],
        ]) {
          await page.getByRole('button', { name: mode, exact: true }).click()
          await page.waitForTimeout(1200)
          await section.screenshot({ path: join(OUT, `${name}.png`) })
          shots.push(name)
        }
      }
      await page.close()
    }

    // ── Sign-in and mobile ──────────────────────────────────────────────────
    const login = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
    login.on('pageerror', (e) => errors.push(`login: ${e.message}`))
    await login.addInitScript(() => localStorage.setItem('athar-theme', 'dark'))
    await login.goto(BASE + '/', { waitUntil: 'networkidle' })
    await login.screenshot({ path: join(OUT, 'login.png') })
    await login.close()
    shots.push('login')

    const mobile = await openDashboard('dark', { width: 402, height: 874 })
    await mobile.screenshot({ path: join(OUT, 'mobile.png'), fullPage: true })
    await mobile.close()
    shots.push('mobile')

    if (errors.length) {
      throw new Error(`the dashboard logged errors while capturing:\n  ${errors.join('\n  ')}`)
    }

    for (const name of shots) console.log(`[shots]   docs/screenshots/${name}.png`)

    // The marketing site is self-contained, so it needs its own copies rather
    // than links into docs/.
    for (const name of ['dashboard-dark', 'heatmap-clicks-dark']) {
      cpSync(join(OUT, `${name}.png`), join(SITE_OUT, `${name}.png`))
    }
    console.log('[shots]   site/screenshots/{dashboard-dark,heatmap-clicks-dark}.png')
  } finally {
    if (browser) await browser.close()
    server.kill('SIGTERM')
    rmSync(workdir, { recursive: true, force: true })
    rmSync(BINARY, { force: true })
  }

  console.log('[shots] done')
}

await main()
