#!/usr/bin/env node
/**
 * screenshots.mjs — regenerate the dashboard screenshots used by the README and
 * the marketing site.
 *
 * It is fully self-contained and reproducible: it builds the binary, boots it
 * against a throwaway database in a temp directory, seeds a plausible demo
 * dataset over the real ingest endpoint, drives the dashboard in headless
 * Chromium, and tears everything down. Nothing touches the developer's own
 * database, and re-running it produces the same shots.
 *
 * The seeded data is deliberately shaped like a small real site rather than a
 * showcase — the screenshots in a README should look like what someone will
 * actually see on day one.
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

// A fixed seed so successive runs produce the same picture. Math.random would
// make every regeneration a visual diff for no reason.
let seed = 20260724
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const pick = (xs) => xs[Math.floor(rand() * xs.length)]

const UAS = [
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', '2560x1440'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', '1920x1080'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0', '1920x1080'],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0', '1920x1200'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', '1512x982'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', '393x852'],
  ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36', '412x915'],
  ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/604.1', '1024x1366'],
]

const PATHS = [
  ['/', 26], ['/pricing', 14], ['/docs/getting-started', 11], ['/blog/why-self-host', 9],
  ['/features', 7], ['/docs/api', 6], ['/checkout', 5], ['/blog/changelog-0-1', 4],
]

const REFERRERS = [
  'https://news.ycombinator.com/item?id=42', 'https://www.google.com/search?q=self+hosted+analytics',
  'https://lobste.rs/', 'https://mastodon.social/@someone/1', 'https://duckduckgo.com/', '', '', '',
]

const LANGS = ['en-GB', 'en-US', 'de-DE', 'fr-FR', 'sw-KE', 'nl-NL']

function weightedPaths() {
  const pool = []
  for (const [path, weight] of PATHS) for (let i = 0; i < weight; i++) pool.push(path)
  return pool
}

async function post(path, body, headers = {}) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** Sends one beacon as a given user agent. */
async function beacon(payload, ua) {
  return fetch(BASE + '/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'User-Agent': ua },
    body: JSON.stringify(payload),
  })
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/api/health')
      if (res.ok) return
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

  // ── Build ───────────────────────────────────────────────────────────────
  console.log('[shots] building…')
  execFileSync('npm', ['run', 'build:tracker'], { cwd: ROOT, stdio: 'inherit' })
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
  execFileSync('node', ['scripts/build-binary.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ATHAR_VERSION: 'demo' },
  })

  const binary = join(ROOT, process.platform === 'win32' ? 'athar.exe' : 'athar')
  if (!existsSync(binary)) throw new Error('binary was not produced')

  // ── Boot against a throwaway database ───────────────────────────────────
  const workdir = mkdtempSync(join(tmpdir(), 'athar-shots-'))
  console.log(`[shots] booting on ${BASE} (data in ${workdir})`)

  const server = spawn(binary, [], {
    cwd: workdir,
    env: { ...process.env, ATHAR_PORT: String(PORT), ATHAR_HOST: '127.0.0.1' },
    stdio: 'ignore',
  })

  let browser
  try {
    await waitForServer()

    // ── Seed ──────────────────────────────────────────────────────────────
    console.log('[shots] seeding demo data…')
    const bootstrapRes = await post('/api/auth/bootstrap', { username: USER, password: PASS })
    if (!bootstrapRes.ok) throw new Error(`bootstrap failed: ${bootstrapRes.status}`)

    const cookies = bootstrapRes.headers.getSetCookie().map((c) => c.split(';')[0])
    const cookieHeader = cookies.join('; ')
    const csrf = cookies.find((c) => c.startsWith('athar_csrf='))?.split('=')[1] ?? ''
    const authHeaders = { Cookie: cookieHeader, 'X-Athar-CSRF': csrf }

    const siteRes = await post('/api/websites', { name: 'Demo Shop', domain: 'demo.example' }, authHeaders)
    const site = await siteRes.json()
    if (!site.id) throw new Error(`website creation failed: ${JSON.stringify(site)}`)

    const paths = weightedPaths()

    // The collector rate-limits per source address (60 burst, 5/s sustained),
    // which is exactly what it should do — so pace the seeding to stay under
    // it rather than firing everything at once and losing most of it.
    let sent = 0
    for (let i = 0; i < 220; i++) {
      const [ua, screen] = pick(UAS)
      await beacon({
        type: 'event',
        payload: {
          website: site.id,
          hostname: 'demo.example',
          screen,
          language: pick(LANGS),
          url: rand() < 0.25 ? `${pick(paths)}?utm_source=newsletter&utm_medium=email&utm_campaign=launch` : pick(paths),
          referrer: pick(REFERRERS),
          title: 'Demo Shop',
        },
      }, ua)
      sent++
      if (sent % 4 === 0) await new Promise((r) => setTimeout(r, 900))
    }

    // Ecommerce: a handful of purchases plus cart activity.
    for (const [order, amount] of [['A-1041', 149.97], ['A-1042', 39.0], ['A-1043', 89.5], ['A-1044', 24.99]]) {
      const [ua] = pick(UAS)
      await beacon({
        type: 'event',
        payload: {
          website: site.id, hostname: 'demo.example', url: '/checkout', name: 'purchase',
          data: { plan: 'pro' },
          revenue: { currency: 'USD', amount, order_id: order },
        },
      }, ua)
      await new Promise((r) => setTimeout(r, 300))
    }
    for (let i = 0; i < 6; i++) {
      const [ua] = pick(UAS)
      await beacon({
        type: 'event',
        payload: { website: site.id, hostname: 'demo.example', url: '/pricing', name: 'add_to_cart', data: { sku: `SKU-${i}` } },
      }, ua)
      await new Promise((r) => setTimeout(r, 300))
    }

    // Heatmap samples on the pricing page.
    for (let i = 0; i < 12; i++) {
      const [ua] = pick(UAS)
      await beacon({
        type: 'heat',
        payload: {
          website: site.id, hostname: 'demo.example', url: '/pricing',
          heat: [
            { k: 'click', x: 20 + rand() * 60, y: 10 + rand() * 70, vw: 1440, vh: 900, sel: 'main > section.plans > button.cta' },
            { k: 'scroll', s: 40 + rand() * 60 },
          ],
        },
      }, ua)
      await new Promise((r) => setTimeout(r, 300))
    }

    // ── Capture ───────────────────────────────────────────────────────────
    console.log('[shots] capturing…')
    browser = await chromium.launch()
    const errors = []

    const shoot = async (name, { width, height, fullPage = false, before } = {}) => {
      const page = await browser.newPage({
        viewport: { width: width ?? 1440, height: height ?? 960 },
        deviceScaleFactor: 2,
      })
      page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`${name}: ${m.text()}`)
      })

      await page.goto(BASE + '/', { waitUntil: 'networkidle' })
      if (before) await before(page)
      await page.waitForTimeout(900)
      await page.screenshot({ path: join(OUT, `${name}.png`), fullPage })
      await page.close()
      console.log(`[shots]   docs/screenshots/${name}.png`)
    }

    const signIn = async (page) => {
      await page.fill('input[autocomplete="username"]', USER)
      await page.fill('input[type="password"]', PASS)
      await page.click('button[type="submit"]')
      await page.waitForTimeout(1800)
    }

    await shoot('login')
    await shoot('dashboard', { before: signIn })
    await shoot('dashboard-full', { fullPage: true, before: signIn })
    await shoot('mobile', {
      width: 402, height: 874, fullPage: true,
      before: signIn,
    })
    await shoot('breakdowns', {
      before: async (page) => {
        await signIn(page)
        // Scroll the breakdown panels into frame.
        await page.evaluate(() => window.scrollBy(0, 520))
      },
    })

    if (errors.length) {
      throw new Error(`the dashboard logged errors while capturing:\n  ${errors.join('\n  ')}`)
    }

    // The marketing site is self-contained, so it needs its own copy rather
    // than a link into docs/.
    cpSync(join(OUT, 'dashboard.png'), join(SITE_OUT, 'dashboard.png'))
    cpSync(join(OUT, 'breakdowns.png'), join(SITE_OUT, 'breakdowns.png'))
    console.log('[shots]   site/screenshots/{dashboard,breakdowns}.png')
  } finally {
    if (browser) await browser.close()
    server.kill('SIGTERM')
    rmSync(workdir, { recursive: true, force: true })
    rmSync(join(ROOT, process.platform === 'win32' ? 'athar.exe' : 'athar'), { force: true })
  }

  console.log('[shots] done')
}

await main()
