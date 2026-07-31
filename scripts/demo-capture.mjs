#!/usr/bin/env node
/**
 * demo-capture.mjs — render the fictional site in scripts/demo-site/ and
 * produce the two things that have to agree with each other:
 *
 *   1. a full-page PNG per (page, viewport width), which is what an operator
 *      would upload as the heatmap's page capture; and
 *   2. the document-relative geometry of the elements people click on, which
 *      is what backend/cmd/athar-demo's click clusters are authored from.
 *
 * Those two outputs are why this file exists rather than a hand-cropped
 * screenshot. A demo heatmap drawn over a demo page is only worth showing if
 * the heat lands on the buttons; keeping the geometry measurable means the
 * clusters can be re-derived from the page instead of guessed at, whenever the
 * page changes.
 *
 * The measurement mirrors the tracker's own arithmetic exactly — x over
 * documentElement.scrollWidth, y over the same max() of five height properties
 * athar.js uses — so a percentage printed here is the percentage the tracker
 * would have recorded for a click at that point. Anything else would be a
 * second, subtly different definition of "where on the page", which is the one
 * bug this whole feature cannot afford.
 *
 * Development only. Nothing here ships in the binary.
 *
 * Usage:
 *   node scripts/demo-capture.mjs --measure     print the geometry table
 *   node scripts/demo-capture.mjs --out DIR     write PNGs (and the table)
 */

import { createServer } from 'node:http'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = join(ROOT, 'scripts/demo-site')

/** The routes the demo dataset records pageviews for, and their source files. */
const ROUTES = {
  '/': 'index.html',
  '/pricing': 'pricing.html',
  '/site.css': 'site.css',
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' }

/**
 * The pages that get a capture, and the viewport widths they get one at.
 *
 * 1920 and 1440 are the two widths the demo dataset's own screen sizes cluster
 * into (see devWeights in backend/cmd/athar-demo/main.go): 1920 covers the
 * Windows/Linux population, 1440 the 1440/1512/1536 Mac one. They land in
 * different ~150px viewport buckets in the dashboard, which is what makes the
 * viewport picker switch between two *different real captures* rather than
 * between a capture and nothing.
 *
 * Mobile is deliberately absent. The demo's click clusters describe the desktop
 * layout, and a 390px capture of a page that reflows would put that heat in the
 * wrong place — exactly the authoritative-looking lie the feature exists to
 * avoid. The mobile bucket falls back to the schematic, and says so.
 */
export const CAPTURES = [
  { path: '/', width: 1920 },
  { path: '/', width: 1440 },
  { path: '/pricing', width: 1920 },
]

/**
 * Element groups whose positions the demo's click clusters are derived from.
 * The selector string is the one the tracker's selectorFor() would produce for
 * that element, so the demo data's `selector` column matches what a real click
 * on this page would have recorded.
 */
const GROUPS = {
  '/': [
    { name: 'nav', selector: 'header > nav a.nav-link', css: 'header.site nav.main a.nav-link' },
    { name: 'cta', selector: 'main > section.hero button.cta', css: 'section.hero button.cta' },
    { name: 'cards', selector: 'section.catalogue article.card button', css: 'section.catalogue .card button' },
    { name: 'footer', selector: 'footer > div a', css: 'footer.site .links a' },
  ],
  '/pricing': [
    { name: 'nav', selector: 'header > nav a.nav-link', css: 'header.site nav.main a.nav-link' },
    { name: 'plan-left', selector: 'main > section.plans div.plan-card button', css: '.plan-row > .plan-card:nth-child(1) button' },
    { name: 'plan-mid', selector: 'main > section.plans div.plan-card button', css: '.plan-row > .plan-card:nth-child(2) button' },
    { name: 'plan-right', selector: 'main > section.plans div.plan-card button', css: '.plan-row > .plan-card:nth-child(3) button' },
    { name: 'footer', selector: 'footer > div a', css: 'footer.site .links a' },
  ],
}

function startServer() {
  const server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0]
    const file = ROUTES[path]
    if (!file) {
      res.writeHead(404).end('not found')
      return
    }
    const ext = file.slice(file.lastIndexOf('.'))
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    res.end(readFileSync(join(SITE, file)))
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)))
}

/**
 * Measures one element group in the tracker's own coordinate space.
 *
 * Returns the mean centre and the standard deviation of the group's members,
 * both as percentages of the document — which is precisely the (CX, CY, SigmaX,
 * SigmaY) shape athar-demo's heatCluster takes, so the numbers transcribe
 * without a conversion step anyone could get wrong.
 */
async function measure(page, groups) {
  return page.evaluate((defs) => {
    const docW = document.documentElement.scrollWidth || 1
    const b = document.body
    const e = document.documentElement
    const docH = Math.max(b.scrollHeight, b.offsetHeight, e.clientHeight, e.scrollHeight, e.offsetHeight) || 1

    const out = []
    for (const def of defs) {
      const nodes = [...document.querySelectorAll(def.css)]
      if (nodes.length === 0) continue
      const pts = nodes.map((node) => {
        const r = node.getBoundingClientRect()
        return {
          x: ((r.left + r.width / 2 + window.scrollX) / docW) * 100,
          y: ((r.top + r.height / 2 + window.scrollY) / docH) * 100,
          w: (r.width / docW) * 100,
          h: (r.height / docH) * 100,
        }
      })
      const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length
      const sd = (xs) => {
        if (xs.length < 2) return 0
        const m = mean(xs)
        return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length)
      }
      const cx = mean(pts.map((p) => p.x))
      const cy = mean(pts.map((p) => p.y))
      // The spread a click cluster should have is the spread of the *targets*
      // plus roughly a third of one target's own size — people press near the
      // middle of a button, not uniformly across it, and not outside it.
      const sigmaX = Math.max(sd(pts.map((p) => p.x)), mean(pts.map((p) => p.w)) / 3)
      const sigmaY = Math.max(sd(pts.map((p) => p.y)), mean(pts.map((p) => p.h)) / 3)
      out.push({
        name: def.name,
        selector: def.selector,
        n: nodes.length,
        cx, cy, sigmaX, sigmaY,
        docW, docH,
      })
    }
    return out
  }, groups)
}

export async function capture({ outDir = null } = {}) {
  const server = await startServer()
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  const browser = await chromium.launch()
  const results = []

  try {
    for (const { path, width } of CAPTURES) {
      // deviceScaleFactor 1: a page capture is a backdrop that gets scaled into
      // a panel a few hundred pixels wide, so a 2× capture would quadruple the
      // bytes stored for detail nothing renders. Alignment is unaffected either
      // way — the mapping is proportional, not pixel-for-pixel.
      const page = await browser.newPage({ viewport: { width, height: 1080 }, deviceScaleFactor: 1 })
      await page.goto(base + path, { waitUntil: 'networkidle' })
      const geometry = await measure(page, GROUPS[path] || [])
      const png = await page.screenshot({ fullPage: true, type: 'png' })
      const size = await page.evaluate(() => {
        const b = document.body
        const e = document.documentElement
        return {
          w: document.documentElement.scrollWidth,
          h: Math.max(b.scrollHeight, b.offsetHeight, e.clientHeight, e.scrollHeight, e.offsetHeight),
        }
      })
      await page.close()

      let file = null
      if (outDir) {
        mkdirSync(outDir, { recursive: true })
        file = join(outDir, `${path === '/' ? 'home' : path.slice(1).replace(/\//g, '-')}-${width}.png`)
        writeFileSync(file, png)
      }
      results.push({ path, width, png, file, docW: size.w, docH: size.h, geometry })
    }
  } finally {
    await browser.close()
    server.close()
  }
  return results
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const outIdx = process.argv.indexOf('--out')
  const outDir = outIdx >= 0 ? resolve(process.argv[outIdx + 1]) : null
  const results = await capture({ outDir })

  for (const r of results) {
    console.log(`\n${r.path} @ ${r.width}px — document ${r.docW}×${r.docH} (aspect ${(r.docW / r.docH).toFixed(3)})`)
    if (r.file) console.log(`  wrote ${r.file} (${(r.png.length / 1024).toFixed(0)} KB)`)
    for (const g of r.geometry) {
      console.log(
        `  ${g.name.padEnd(11)} n=${String(g.n).padEnd(2)} ` +
          `CX: ${g.cx.toFixed(1).padStart(5)}, CY: ${g.cy.toFixed(1).padStart(5)}, ` +
          `SigmaX: ${g.sigmaX.toFixed(1).padStart(4)}, SigmaY: ${g.sigmaY.toFixed(1).padStart(4)}   ${g.selector}`,
      )
    }
  }
}
