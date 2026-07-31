#!/usr/bin/env node
/**
 * site-screenshots.mjs — regenerate site/screenshots/*.png, the six product
 * captures the marketing landing page embeds (overview, click heatmap and
 * schematic fallback, each in both themes).
 *
 * Deliberately separate from scripts/screenshots.mjs, which owns
 * docs/screenshots/ at a different size and aspect. Everything here is taken
 * at deviceScaleFactor 2 against a fixed 1440×900 viewport. The overview is a
 * viewport shot (2880×1800); the heatmap panels are element captures, because
 * once a real page is under the heat field the panel takes the *document's*
 * aspect ratio and is taller than a screen — cropping the page out of a panel
 * whose whole point is the page would be a strange thing to publish. Whatever
 * dimensions come out, the landing's <img width/height> must state them, so
 * the box is reserved before the file arrives.
 *
 * It also does the thing the click-heatmap capture now depends on, end to end:
 *
 *   1. renders scripts/demo-site/ (the fictional Demo Shop the demo dataset
 *      describes) full-page at 1920 and 1440 CSS pixels;
 *   2. uploads those PNGs to the running instance as page images, through the
 *      real authenticated API, exactly as an operator would;
 *   3. asserts the overlay actually lines up before taking a single screenshot.
 *
 * Step 3 is not decoration. A misaligned heatmap is worse than no heatmap: it
 * looks authoritative and it lies. The check measures the rendered geometry and
 * then reads the heat canvas's own pixels at the coordinates where the demo
 * page's real buttons are, and fails the run if the heat is not there.
 *
 * Usage:
 *   node scripts/site-screenshots.mjs
 *
 * Requires: Go, Node, Chromium (`npx playwright install chromium`).
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

import { capture } from './demo-capture.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'site/screenshots')

const PORT = 3188
const BASE = `http://127.0.0.1:${PORT}`
const USER = 'demo'
const PASS = 'athar-demo-password'
const BINARY = join(ROOT, process.platform === 'win32' ? 'athar-site-shots.exe' : 'athar-site-shots')

/** The viewport the landing's screenshots are taken at, and their scale. */
const SHOT = { width: 1440, height: 900 }

async function waitForServer(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(BASE + '/api/health')).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('server did not become healthy in time')
}

async function signIn(page) {
  await page.goto(BASE + '/', { waitUntil: 'networkidle' })
  await page.fill('input[autocomplete="username"]', USER)
  await page.fill('input[type="password"]', PASS)
  await page.click('button[type="submit"]')
  await page.waitForSelector('text=Pageviews', { timeout: 15000 })
}

/**
 * Uploads one capture through the dashboard's own origin, so it goes through
 * the same session cookie and CSRF double-submit an operator's browser would.
 * Uploading with a hand-rolled cookie jar from Node would exercise a path
 * nothing else uses and prove less.
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

/** Selects a page and a viewport bucket in the heatmap panel. */
async function selectHeatmap(page, pathLabel, viewportMatch) {
  const pageSelect = page.locator('select[aria-label="Page to show heatmap for"]')
  const options = await pageSelect.locator('option').allTextContents()
  const wanted = options.find((o) => o.trim().startsWith(pathLabel + ' '))
  if (!wanted) throw new Error(`heatmap page picker has no ${pathLabel} (saw: ${options.join(' | ')})`)
  await pageSelect.selectOption({ label: wanted })
  await page.waitForTimeout(900)

  const vpSelect = page.locator('select[aria-label="Recorded viewport width"]')
  if (await vpSelect.count()) {
    const vpOptions = await vpSelect.locator('option').allTextContents()
    const target = vpOptions.find((o) => o.includes(viewportMatch))
    if (!target) throw new Error(`viewport picker has no ${viewportMatch} (saw: ${vpOptions.join(' | ')})`)
    await vpSelect.selectOption({ label: target })
    await page.waitForTimeout(900)
  }
}

/**
 * The alignment proof.
 *
 * Two independent assertions, because they fail in different ways:
 *
 *   Geometry — the page image, the wire layer and the heat canvas must occupy
 *   the identical box. Any disagreement is a constant offset applied to every
 *   sample, which is invisible by eye and wrong everywhere.
 *
 *   Pixels — for each element the demo dataset clusters clicks on, read the heat
 *   canvas at that element's own document-relative position and confirm it is
 *   hot; read a deliberately empty region and confirm it is not. This is the
 *   assertion that would catch a coordinate system that is self-consistent but
 *   describes the wrong thing.
 */
async function verifyAlignment(page, expectPoints) {
  const result = await page.evaluate((points) => {
    const frame = document.querySelector('.heat-frame')
    const img = document.querySelector('.heat-page-img')
    const canvas = document.querySelector('.heat-canvas')
    if (!frame || !img || !canvas) return { error: 'heat frame, page image or canvas missing' }

    const fr = frame.getBoundingClientRect()
    const ir = img.getBoundingClientRect()
    const cr = canvas.getBoundingClientRect()
    const geometry = {
      frame: { w: fr.width, h: fr.height, x: fr.x, y: fr.y },
      imageOffset: { dx: ir.x - fr.x, dy: ir.y - fr.y, dw: ir.width - fr.width, dh: ir.height - fr.height },
      canvasOffset: { dx: cr.x - fr.x, dy: cr.y - fr.y, dw: cr.width - fr.width, dh: cr.height - fr.height },
      imageAspect: img.naturalWidth / img.naturalHeight,
      frameAspect: fr.width / fr.height,
    }

    // Read the accumulated field back out of the canvas. Same-origin, drawn
    // only from gradients, so it is not tainted.
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const dpr = canvas.width / cr.width
    const heatAt = (xPct, yPct) => {
      const px = Math.round((xPct / 100) * cr.width * dpr)
      const py = Math.round((yPct / 100) * cr.height * dpr)
      const d = ctx.getImageData(
        Math.min(Math.max(px, 0), canvas.width - 1),
        Math.min(Math.max(py, 0), canvas.height - 1),
        1,
        1,
      ).data
      return { r: d[0], g: d[1], b: d[2], a: d[3] }
    }

    const readings = points.map((p) => ({ ...p, heat: heatAt(p.x, p.y) }))
    return { geometry, readings }
  }, expectPoints)

  if (result.error) throw new Error(`[align] ${result.error}`)

  const g = result.geometry
  const worst = Math.max(
    Math.abs(g.imageOffset.dx), Math.abs(g.imageOffset.dy),
    Math.abs(g.imageOffset.dw), Math.abs(g.imageOffset.dh),
    Math.abs(g.canvasOffset.dx), Math.abs(g.canvasOffset.dy),
    Math.abs(g.canvasOffset.dw), Math.abs(g.canvasOffset.dh),
  )
  console.log(`[align] frame ${g.frame.w.toFixed(2)}×${g.frame.h.toFixed(2)}px`)
  console.log(`[align] image aspect ${g.imageAspect.toFixed(5)} vs frame aspect ${g.frameAspect.toFixed(5)}`)
  console.log(`[align] worst image/canvas edge disagreement with the frame: ${worst.toFixed(4)}px`)
  if (worst > 0.5) {
    throw new Error(`[align] layers disagree by ${worst.toFixed(3)}px — every sample would be offset`)
  }
  if (Math.abs(g.imageAspect - g.frameAspect) / g.frameAspect > 0.002) {
    throw new Error('[align] the frame is not the image\'s aspect ratio — the page is being stretched')
  }

  for (const r of result.readings) {
    // Alpha carries the density (heatcanvas.js encodes intensity redundantly as
    // alpha), so it is the honest scalar to threshold on rather than a hue.
    const label = `${r.name.padEnd(12)} at (${r.x.toFixed(1)}%, ${r.y.toFixed(1)}%)`
    console.log(`[align] ${label} alpha=${String(r.heat.a).padStart(3)} rgb(${r.heat.r},${r.heat.g},${r.heat.b})`)
    if (r.hot && r.heat.a < 120) {
      throw new Error(`[align] expected heat on ${r.name} but the canvas is cold there (alpha ${r.heat.a})`)
    }
    if (!r.hot && r.heat.a > 100) {
      throw new Error(`[align] expected no heat at the control point ${r.name} (alpha ${r.heat.a})`)
    }
  }
  console.log('[align] OK — the field sits on the elements it was recorded from')
}

async function main() {
  mkdirSync(OUT, { recursive: true })

  console.log('[site-shots] rendering the demo site…')
  const captures = await capture({})
  for (const c of captures) {
    console.log(`[site-shots]   ${c.path} @ ${c.width}px → ${c.docW}×${c.docH}, ${(c.png.length / 1024).toFixed(0)} KB`)
  }

  console.log('[site-shots] building…')
  execFileSync('npm', ['run', 'build:tracker'], { cwd: ROOT, stdio: 'inherit' })
  execFileSync('go', ['build', '-o', BINARY, './backend/cmd/athar'], { cwd: ROOT, stdio: 'inherit' })
  if (!existsSync(BINARY)) throw new Error('binary was not produced')

  const workdir = mkdtempSync(join(tmpdir(), 'athar-site-shots-'))
  const dbPath = join(workdir, 'athar.db')

  console.log('[site-shots] seeding 30 days of demo data…')
  const seedOut = execFileSync(
    'go',
    ['run', './backend/cmd/athar-demo', '-db', dbPath, '-days', '30', '-user', USER, '-password', PASS],
    { cwd: ROOT, encoding: 'utf8' },
  )
  const websiteId = (seedOut.match(/website_id=([0-9a-f]+)/) || [])[1]
  if (!websiteId) throw new Error(`could not read website_id from athar-demo output:\n${seedOut}`)

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

    // ── Upload the captures, as an operator would ───────────────────────────
    const uploader = await browser.newPage({ viewport: SHOT })
    uploader.on('pageerror', (e) => errors.push(`upload: ${e.message}`))
    await signIn(uploader)
    for (const c of captures) {
      const meta = await uploadCapture(uploader, websiteId, c.path, c.width, c.png.toString('base64'))
      console.log(`[site-shots] uploaded ${c.path} @ ${c.width}px → ${meta.image_w}×${meta.image_h}, ${meta.bytes} bytes`)
    }
    await uploader.close()

    // ── Capture, both themes ────────────────────────────────────────────────
    const shots = []
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({ viewport: SHOT, deviceScaleFactor: 2 })
      page.on('pageerror', (e) => errors.push(`${theme}: ${e.message}`))
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`${theme}: ${m.text()}`)
      })
      await page.addInitScript((t) => localStorage.setItem('athar-theme', t), theme)
      await signIn(page)
      await page.getByRole('button', { name: '30 days', exact: true }).click()
      await page.waitForTimeout(1600)

      // Overview: scroll to the top, capture the viewport.
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(OUT, `dashboard-${theme}.png`) })
      shots.push(`dashboard-${theme}`)

      // Heatmap over the real page.
      await selectHeatmap(page, '/pricing', '1920px wide')
      const section = page.locator('section.heatmap')
      await section.scrollIntoViewIfNeeded()
      await page.waitForTimeout(900)

      if (theme === 'dark') {
        // The clusters athar-demo generates for /pricing, from the measured
        // geometry of scripts/demo-site/pricing.html. The control point is a
        // stretch of body copy nobody clusters on.
        await verifyAlignment(page, [
          { name: 'nav', x: 51.7, y: 4.4, hot: true },
          { name: 'plan-left', x: 22.6, y: 45.1, hot: true },
          { name: 'plan-mid', x: 50.0, y: 47.3, hot: true },
          { name: 'plan-right', x: 77.4, y: 47.3, hot: true },
          { name: 'footer', x: 49.8, y: 95.2, hot: true },
          { name: 'empty-margin', x: 4.0, y: 70.0, hot: false },
        ])
      }

      // The sticky topbar would otherwise overlay the top of the panel in an
      // element capture, hiding the mode bar and the page picker. Unsticking it
      // costs nothing here: these captures are of the panel, not of scrolling.
      await page.addStyleTag({ content: '.topbar{position:static !important}' })

      // The heatmap panel is taller than the shot viewport once a real page is
      // under it — the frame takes the *document's* aspect ratio, and a
      // document is taller than a screen. So this one is an element capture,
      // not a viewport capture: cropping the page out of a panel whose whole
      // point is the page would be an odd screenshot to put on a landing page.
      await section.screenshot({ path: join(OUT, `heatmap-click-${theme}.png`) })
      shots.push(`heatmap-click-${theme}`)

      // The honest fallback, captured deliberately: /docs/getting-started has
      // no page in scripts/demo-site/, so no capture was ever uploaded for it
      // and the view says "schematic" rather than borrowing another page's
      // picture. That behaviour is worth showing on the landing, not hiding.
      await selectHeatmap(page, '/docs/getting-started', '1920px wide')
      await section.scrollIntoViewIfNeeded()
      await page.waitForTimeout(900)
      const badge = await page.locator('.heat-badge').innerText()
      if (badge.trim().toLowerCase() !== 'schematic') {
        throw new Error(`/docs/getting-started should have no capture, but the badge reads "${badge}"`)
      }
      await section.screenshot({ path: join(OUT, `heatmap-schematic-${theme}.png`) })
      shots.push(`heatmap-schematic-${theme}`)

      await page.close()
    }

    if (errors.length) throw new Error(`the dashboard logged errors while capturing:\n  ${errors.join('\n  ')}`)
    for (const name of shots) console.log(`[site-shots]   site/screenshots/${name}.png`)
  } finally {
    if (browser) await browser.close()
    server.kill('SIGTERM')
    rmSync(workdir, { recursive: true, force: true })
    rmSync(BINARY, { force: true })
  }
  console.log('[site-shots] done')
}

await main()
