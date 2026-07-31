#!/usr/bin/env node
/**
 * screenshots.mjs — regenerate the docs/screenshots/ captures embedded in
 * the README.
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
 * Before opening the dashboard, it also uploads a real page capture for
 * `/pricing` — the page the click-heatmap screenshot uses — the same way an
 * operator would, through the authenticated PUT route. Without this, the
 * heatmap panel would render the wireframe schematic, which is honest but not
 * what this feature looks like when there's a capture behind it; the whole
 * point of README's heatmap screenshot is to show the real-page overlay. The
 * capture itself is rendered from scripts/demo-site/pricing.html by
 * scripts/demo-capture.mjs — the same renderer scripts/site-screenshots.mjs
 * uses for the marketing site's captures — at 1920px and 1440px wide, which
 * are the two viewport widths the demo dataset's own screen-size distribution
 * clusters into (see devWeights in backend/cmd/athar-demo/main.go), so the
 * uploaded captures land in the same viewport buckets the recorded heat
 * samples do.
 *
 * It also acts as a boot guard: any console error or uncaught exception while
 * capturing fails the run.
 *
 * site/screenshots/ is deliberately out of scope here. Those are the
 * marketing site's hero/heatmap panel captures, taken by hand at the exact
 * 2880×1800 the landing page's <img width/height> reserve — a fixed 1440×900
 * viewport at deviceScaleFactor 2, cropped to just the panel in question, not
 * this script's 1440×1000-viewport dashboard-shaped shot. An earlier version
 * of this script copied its own docs/ output in there under the old
 * (pre-rewrite) filenames; that copy step clobbered the real captures with
 * the wrong aspect ratio the one time it was tried during this rewrite and
 * has been removed for good. Recapture site/screenshots/ by hand if it ever
 * needs updating (`node scripts/site-screenshots.mjs`).
 *
 * Usage:
 *   npm run screenshots
 *
 * Requires: Go, Node, and Chromium (`npx playwright install chromium`).
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

import { capture } from './demo-capture.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs/screenshots')

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

/**
 * Uploads one page capture through the dashboard's own origin, so it goes
 * through the same session cookie and CSRF double-submit an operator's
 * browser would — mirrors scripts/site-screenshots.mjs's uploadCapture.
 */
async function uploadCapture(page, websiteId, path, viewportW, pngBase64) {
  return page.evaluate(
    async ({ websiteId, path, viewportW, pngBase64 }) => {
      const bin = atob(pngBase64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const csrf = (document.cookie.match(/(?:^|;\s*)athar_csrf=([^;]*)/) || [])[1] || ''
      const url = `/api/websites/${websiteId}/page-image?path=${encodeURIComponent(path)}&viewport=${viewportW}`
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png', 'X-Athar-CSRF': decodeURIComponent(csrf) },
        body: new Blob([bytes], { type: 'image/png' }),
        credentials: 'same-origin',
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(`upload ${path}@${viewportW} failed: ${res.status} ${JSON.stringify(body)}`)
      return body
    },
    { websiteId, path, viewportW, pngBase64 },
  )
}

async function main() {
  mkdirSync(OUT, { recursive: true })

  console.log('[shots] rendering the demo page capture…')
  // Only the /pricing page is needed: it's the page the click-heatmap
  // screenshot below uses. 1920 and 1440 match the demo dataset's own
  // screen-size distribution — see the module doc.
  const allCaptures = await capture({})
  const captures = allCaptures.filter((c) => c.path === '/pricing')
  for (const c of captures) {
    console.log(`[shots]   ${c.path} @ ${c.width}px → ${c.docW}×${c.docH}, ${(c.png.length / 1024).toFixed(0)} KB`)
  }

  console.log('[shots] building…')
  execFileSync('npm', ['run', 'build:tracker'], { cwd: ROOT, stdio: 'inherit' })
  // No `npm run build` step: the dashboard is hand-written HTML/CSS/JS
  // embedded straight into the binary (backend/internal/webui), not a Vite
  // build artifact. build-binary.mjs only needs to stage the marketing site.
  execFileSync('node', ['scripts/build-binary.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ATHAR_VERSION: 'demo' },
  })
  if (!existsSync(BINARY)) throw new Error('binary was not produced')

  const workdir = mkdtempSync(join(tmpdir(), 'athar-shots-'))
  const dbPath = join(workdir, 'athar.db')

  console.log('[shots] generating 30 days of demo data…')
  const seedOut = execFileSync(
    'go',
    ['run', './backend/cmd/athar-demo', '-db', dbPath, '-days', '30', '-user', USER, '-password', PASS],
    { cwd: ROOT, encoding: 'utf8' },
  )
  process.stdout.write(seedOut)
  const websiteId = (seedOut.match(/website_id=([0-9a-f]+)/) || [])[1]
  if (!websiteId) throw new Error(`could not read website_id from athar-demo output:\n${seedOut}`)

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

    // ── Upload the /pricing page capture, as an operator would ──────────────
    // Must happen before the heatmap screenshot below, and needs its own
    // signed-in page since uploading is a write (editor access + CSRF).
    const uploader = await browser.newPage()
    uploader.on('pageerror', (e) => errors.push(`upload: ${e.message}`))
    await uploader.goto(BASE + '/', { waitUntil: 'networkidle' })
    await uploader.fill('input[autocomplete="username"]', USER)
    await uploader.fill('input[type="password"]', PASS)
    await uploader.click('button[type="submit"]')
    await uploader.waitForSelector('text=Pageviews', { timeout: 15000 })
    for (const c of captures) {
      const meta = await uploadCapture(uploader, websiteId, c.path, c.width, c.png.toString('base64'))
      console.log(`[shots] uploaded ${c.path} @ ${c.width}px → ${meta.image_w}×${meta.image_h}, ${meta.bytes} bytes`)
    }
    await uploader.close()

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
  } finally {
    if (browser) await browser.close()
    server.kill('SIGTERM')
    rmSync(workdir, { recursive: true, force: true })
    rmSync(BINARY, { force: true })
  }

  console.log('[shots] done')
}

await main()
