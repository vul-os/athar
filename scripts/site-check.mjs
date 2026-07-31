#!/usr/bin/env node
/**
 * site-check.mjs — the marketing site's own verification gate.
 *
 * Three things this page has broken before, each checked here rather than by
 * eye:
 *
 *   OVERFLOW. `body { overflow-x: hidden }` hides a real horizontal overflow
 *   instead of preventing it, so `scrollWidth` is useless as a signal. This
 *   walks every element and measures getBoundingClientRect().right against the
 *   viewport — the only measurement the hidden overflow cannot mask. Two
 *   things are exempt: .hero-rings and its circles, which bleed deliberately,
 *   and content inside a container that scrolls on its own (a code block, the
 *   comparison table), which is contained rather than overflowing.
 *
 *   REVEAL. Scroll-reveal has stranded content at opacity:0 before — 47 of 70
 *   elements, after a single instant scrollTo, and they never recovered. Seven
 *   ways of jumping down the page are exercised at four widths, asserting both
 *   that nothing on screen is invisible and that nothing anywhere stays
 *   invisible once the end of the document has been reached.
 *
 *   CONTRAST. Every text/background pair on the page, computed from the real
 *   rendered styles (walking up for the first non-transparent backdrop) rather
 *   than from the values a stylesheet comment claims.
 *
 * Usage:
 *   node scripts/site-check.mjs            check, and write screenshots
 *   node scripts/site-check.mjs --quiet    check only
 */

import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = join(ROOT, 'site')
const SHOTS = process.env.SHOT_DIR || join(ROOT, '.site-check')

const WIDTHS = [1440, 1024, 768, 390]
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}

function startServer() {
  const server = createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0])
    if (p.endsWith('/')) p += 'index.html'
    const file = join(SITE, p)
    if (!file.startsWith(SITE) || !existsSync(file)) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)))
}

/** WCAG 2.1 relative luminance and contrast ratio. */
function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function ratio(fg, bg) {
  const a = luminance(fg)
  const b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
function parseRGB(s) {
  const m = String(s).match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
  return { rgb: parts.slice(0, 3), a: parts.length > 3 ? parts[3] : 1 }
}
/** Composites a possibly-translucent foreground over an opaque backdrop. */
function over(fg, bg) {
  return fg.rgb.map((c, i) => Math.round(c * fg.a + bg[i] * (1 - fg.a)))
}

async function collectContrast(page) {
  const raw = await page.evaluate(() => {
    // One representative node per distinct text role, named so a failure says
    // which rule to go and fix.
    const targets = {
      'body text (.lead)': '.lead',
      'body strong (.lead b)': '.lead b',
      'headline (h1)': 'h1',
      'headline accent (h1 em)': 'h1 em',
      'plate title (.plate h2)': '.plate h2',
      'plate accent (.plate h2 em)': '.plate h2 em',
      'register label (.register .label)': '.register .label',
      'register number (.register .no)': '.register .no',
      'depth stamp (.register .depth)': '.register .depth',
      'depth value (.register .depth b)': '.register .depth b',
      'hero eyebrow': '.hero-eyebrow',
      'hero sub': '.hero-sub',
      'strip label (.strip i)': '.strip i',
      'strip numeral (.strip i b)': '.strip i b',
      'figure caption (.figcap)': '.figcap',
      'figure caption number': '.figcap .n',
      'figure caption strong': '.figcap b',
      'chrome address (.frame .addr)': '.frame .addr',
      'nav link': '.nav-links a',
      'nav link active': '.nav-links a.active',
      'ghost link (.ghlink)': '.ghlink',
      'primary button': '.btn-primary',
      'ghost button': '.btn-ghost',
      'row key (.row .k, dt)': '.rows dt',
      'row value (.row dd)': '.rows dd',
      'row value strong': '.rows b',
      'inline code': '.rows dd code',
      'cols3 heading': '.cols3 h4',
      'cols3 body': '.cols3 p',
      'checklist item': '.checklist li',
      'callout body': '.callout',
      'callout strong': '.callout b',
      'callout link': '.callout a',
      'pending callout link': '.callout.pend a',
      'lead link': '.lead a',
      'seam node title': '.seam-node b',
      'seam node detail': '.seam-node div span',
      'seam badge': '.seam-core .badge',
      'seam tag': '.seam-tag',
      'ledger head (shipped)': '.lcol.shipped .lhead b',
      'ledger head (on main)': '.lcol.inmain .lhead b',
      'ledger head (not built)': '.lcol.planned .lhead b',
      'ledger row': '.lrow',
      'ledger row strong': '.lrow b',
      'status quote': '.statusquote',
      'table head': 'table.cmp thead th',
      'table cell': 'table.cmp tbody td',
      'table us row': 'table.cmp tr.us td',
      'table yes': '.yes',
      'table no': '.no',
      'table partial': '.partial',
      'step number': '.steps .num',
      'step title': '.steps b',
      'step body': '.steps span',
      'reading key': '.trace-cell .k',
      'reading number': '.trace-cell .n',
      'reading detail': '.trace-cell .d',
      'reading head': '.trace-head',
      'reading foot': '.trace-foot',
      'footer text': '.foot .left',
      'footer link': '.foot .links a',
      'colophon': '.colophon',
    }

    function backdrop(el) {
      let node = el
      while (node && node !== document.documentElement) {
        const bg = getComputedStyle(node).backgroundColor
        const m = String(bg).match(/rgba?\(([^)]+)\)/)
        if (m) {
          const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
          const alpha = p.length > 3 ? p[3] : 1
          if (alpha >= 0.999) return p.slice(0, 3)
          if (alpha > 0) {
            // A translucent surface: composite it onto whatever is under it.
            const under = backdrop(node.parentElement || document.body)
            return p.slice(0, 3).map((c, i) => Math.round(c * alpha + under[i] * (1 - alpha)))
          }
        }
        node = node.parentElement
      }
      const m = String(getComputedStyle(document.body).backgroundColor).match(/rgba?\(([^)]+)\)/)
      return m ? m[1].split(/[,\s/]+/).filter(Boolean).map(Number).slice(0, 3) : [255, 255, 255]
    }

    const out = []
    for (const [name, sel] of Object.entries(targets)) {
      const el = document.querySelector(sel)
      if (!el) {
        out.push({ name, sel, missing: true })
        continue
      }
      const cs = getComputedStyle(el)
      out.push({
        name,
        sel,
        color: cs.color,
        bg: backdrop(el),
        size: parseFloat(cs.fontSize),
        weight: Number(cs.fontWeight) || 400,
      })
    }
    return out
  })

  return raw.map((r) => {
    if (r.missing) return r
    const fg = parseRGB(r.color)
    const composited = over(fg, r.bg)
    // WCAG "large text": >= 18.66px bold, or >= 24px.
    const large = r.size >= 24 || (r.size >= 18.66 && r.weight >= 700)
    return { ...r, ratio: ratio(composited, r.bg), large, floor: large ? 3.0 : 4.5 }
  })
}

async function checkOverflow(page, width) {
  return page.evaluate((vw) => {
    const bad = []
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      // The one sanctioned bleed: the hero's ring mark, and the circles
      // inside it, run past the right edge on purpose.
      if (el.closest('.hero-rings')) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      // Content wider than its own scroll container is not page overflow — a
      // code block and the comparison table are meant to scroll inside
      // themselves. This deliberately refuses to honour body/html's own
      // overflow-x:hidden, which is exactly the mask that has hidden a real
      // bug on this page before.
      let scroller = null
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const ox = getComputedStyle(a).overflowX
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') { scroller = a; break }
      }
      if (scroller && scroller.getBoundingClientRect().right <= vw + 0.5) continue
      if (r.right > vw + 0.5 || r.left < -0.5) {
        bad.push({
          tag: el.tagName.toLowerCase(),
          cls: el.className && typeof el.className === 'string' ? el.className.slice(0, 60) : '',
          text: (el.textContent || '').trim().slice(0, 40),
          parent: el.parentElement ? el.parentElement.tagName.toLowerCase() + '.' + (el.parentElement.className || '') : '',
          left: Math.round(r.left),
          right: Math.round(r.right),
        })
      }
    }
    return {
      bad: bad.slice(0, 12),
      count: bad.length,
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }
  }, width)
}

/**
 * Ways of arriving somewhere far down the page in one go. Each is a way the
 * IntersectionObserver can miss an element entirely: it recomputes at whatever
 * the next check happens to be, not continuously, so a single large jump can
 * take an element from "not yet visible" straight to "already scrolled past".
 */
const REVEAL_TRIGGERS = {
  'instant scrollTo (two-thirds down)': async (page) => {
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight * 0.66, behavior: 'instant' }))
  },
  'instant scrollTo (bottom)': async (page) => {
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }))
  },
  'End key': async (page) => {
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = 'auto'
      document.body.tabIndex = -1
      document.body.focus()
    })
    await page.keyboard.press('End')
  },
  'fast wheel fling': async (page) => {
    for (let i = 0; i < 14; i++) await page.mouse.wheel(0, 3000)
  },
  'scrollbar drag (large jumps)': async (page) => {
    for (const f of [0.2, 0.9, 0.35, 1.0]) {
      await page.evaluate((x) => window.scrollTo(0, document.body.scrollHeight * x), f)
      await page.waitForTimeout(60)
    }
  },
  'hash jump to the last plate': async (page) => {
    await page.evaluate(() => {
      location.hash = '#reading'
    })
  },
  'hash jump, then back to the top': async (page) => {
    await page.evaluate(() => {
      location.hash = '#heatmaps'
    })
    await page.waitForTimeout(400)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  },
}

/**
 * Counts elements that are on screen right now and still invisible. This is the
 * assertion that actually matters — "nothing the reader can see is at
 * opacity:0" — and it is the one the earlier bounded-window sweep failed.
 */
const VISIBLE_STRANDED = () =>
  [...document.querySelectorAll('.rv:not(.in)')].filter((el) => {
    const r = el.getBoundingClientRect()
    return r.bottom > 0 && r.top < window.innerHeight
  }).length

async function main() {
  const quiet = process.argv.includes('--quiet')
  const server = await startServer()
  const base = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch()
  let failures = 0
  if (!quiet) mkdirSync(SHOTS, { recursive: true })

  try {
    // ── Contrast, both themes ───────────────────────────────────────────────
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      await page.addInitScript((t) => localStorage.setItem('athar-site-theme', t), theme)
      await page.goto(base + '/index.html', { waitUntil: 'networkidle' })
      await page.evaluate(() => document.querySelectorAll('.rv').forEach((e) => e.classList.add('in')))
      await page.waitForTimeout(200)

      const rows = await collectContrast(page)
      console.log(`\n── contrast · ${theme} ────────────────────────────────────────────`)
      for (const r of rows) {
        if (r.missing) {
          console.log(`  MISSING  ${r.name}  (${r.sel})`)
          failures++
          continue
        }
        const ok = r.ratio >= r.floor
        if (!ok) failures++
        console.log(
          `  ${ok ? 'ok  ' : 'FAIL'} ${r.ratio.toFixed(2).padStart(6)}:1  (floor ${r.floor.toFixed(1)})  ${r.name}`,
        )
      }
      await page.close()
    }

    // ── Overflow, every width, both themes ──────────────────────────────────
    console.log('\n── horizontal overflow (measured on every element rect) ──────────')
    for (const theme of ['dark', 'light']) {
      for (const width of WIDTHS) {
        const page = await browser.newPage({ viewport: { width, height: 900 } })
        await page.addInitScript((t) => localStorage.setItem('athar-site-theme', t), theme)
        await page.goto(base + '/index.html', { waitUntil: 'networkidle' })
        await page.evaluate(() => document.querySelectorAll('.rv').forEach((e) => e.classList.add('in')))
        await page.waitForTimeout(200)
        const res = await checkOverflow(page, width)
        const ok = res.count === 0
        if (!ok) failures++
        console.log(
          `  ${ok ? 'ok  ' : 'FAIL'} ${theme.padEnd(5)} ${String(width).padStart(4)}px  ` +
            `offending elements: ${res.count}  scrollWidth ${res.docScrollWidth}`,
        )
        for (const b of res.bad) console.log(`         <${b.tag} class="${b.cls}"> "${b.text}" in ${b.parent} left=${b.left} right=${b.right}`)
        if (!quiet && theme === 'dark') {
          await page.screenshot({ path: join(SHOTS, `landing-${width}.png`), fullPage: true })
        }
        if (!quiet && width === 1440) {
          await page.screenshot({ path: join(SHOTS, `landing-1440-${theme}.png`), fullPage: true })
        }
        await page.close()
      }
    }

    // ── Reveal, every trigger, every width ──────────────────────────────────
    //
    // Two assertions per trigger, because they catch different failures:
    //
    //   VISIBLE  — after the jump, nothing within the viewport may still be at
    //   opacity:0. Content below the fold legitimately has not revealed yet;
    //   content the reader is looking at never may.
    //
    //   RECOVERS — then drive to the very bottom. Nothing anywhere may still be
    //   stranded. This is the exact pathology the sweep's lower bound caused:
    //   elements that had been jumped past could never satisfy the condition
    //   again, so they stayed invisible for the rest of the session.
    console.log('\n── scroll-reveal (no element may be stranded at opacity:0) ───────')
    for (const width of WIDTHS) {
      for (const [name, trigger] of Object.entries(REVEAL_TRIGGERS)) {
        const page = await browser.newPage({ viewport: { width, height: 900 } })
        await page.goto(base + '/index.html', { waitUntil: 'networkidle' })
        const total = await page.locator('.rv').count()

        await trigger(page)
        await page.waitForTimeout(1000)
        const visible = await page.evaluate(VISIBLE_STRANDED)

        await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }))
        await page.waitForTimeout(700)
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
        await page.waitForTimeout(500)
        const stranded = await page.evaluate(
          () => document.querySelectorAll('.rv:not(.in)').length,
        )

        const ok = visible === 0 && stranded === 0
        if (!ok) failures++
        console.log(
          `  ${ok ? 'ok  ' : 'FAIL'} ${String(width).padStart(4)}px  ${name.padEnd(34)} ` +
            `on-screen stranded: ${visible}   after reaching the end: ${stranded}/${total}`,
        )
        await page.close()
      }
    }

    // ── Reduced motion must genuinely disable animation ─────────────────────
    console.log('\n── prefers-reduced-motion ────────────────────────────────────────')
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
      await page.goto(base + '/index.html', { waitUntil: 'networkidle' })
      await page.waitForTimeout(400)
      const res = await page.evaluate(() => {
        const durations = new Set()
        for (const el of document.querySelectorAll('*')) {
          const cs = getComputedStyle(el)
          for (const d of cs.transitionDuration.split(',')) durations.add(d.trim())
          for (const d of cs.animationDuration.split(',')) durations.add(d.trim())
        }
        const overLong = [...durations].filter((d) => {
          const n = parseFloat(d)
          if (Number.isNaN(n)) return false
          return d.endsWith('ms') ? n > 1 : n > 0.001
        })
        return { overLong, htmlScroll: getComputedStyle(document.documentElement).scrollBehavior }
      })
      const ok = res.overLong.length === 0
      if (!ok) failures++
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} every transition/animation duration is effectively zero`)
      if (!ok) console.log(`         still animating: ${res.overLong.join(', ')}`)
      console.log(`  ${res.htmlScroll === 'auto' ? 'ok  ' : 'FAIL'} scroll-behavior is ${res.htmlScroll}`)
      if (res.htmlScroll !== 'auto') failures++
      await page.close()
    }

    // ── No external origin, no analytics ────────────────────────────────────
    console.log('\n── self-containment ──────────────────────────────────────────────')
    {
      const external = []
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      page.on('request', (r) => {
        if (!r.url().startsWith(base) && !r.url().startsWith('data:')) external.push(r.url())
      })
      await page.goto(base + '/index.html', { waitUntil: 'networkidle' })
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await page.waitForTimeout(1500)
      const ok = external.length === 0
      if (!ok) failures++
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${external.length} request(s) left the origin`)
      for (const u of external) console.log(`         ${u}`)
      await page.close()
    }
  } finally {
    await browser.close()
    server.close()
  }

  console.log(failures === 0 ? '\nSITE CHECK PASSED' : `\nSITE CHECK FAILED — ${failures} problem(s)`)
  if (failures !== 0) process.exitCode = 1
}

await main()
