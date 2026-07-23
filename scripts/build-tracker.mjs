#!/usr/bin/env node
/**
 * build-tracker.mjs — minify the tracking script.
 *
 * backend/internal/tracker/athar.js is the readable source; this produces
 * athar.min.js next to it, which is what the Go binary embeds and what visitors'
 * browsers actually download.
 *
 * The minified file is COMMITTED, not gitignored. That is deliberate: a Go
 * toolchain alone should be enough to build a working Athar binary, without also
 * requiring Node. CI re-runs this and fails if the committed file has drifted
 * from the source (`--check`), so the two cannot silently disagree.
 *
 * Usage:
 *   node scripts/build-tracker.mjs           # write athar.min.js
 *   node scripts/build-tracker.mjs --check   # verify it is up to date
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'backend/internal/tracker/athar.js')
const OUT = join(ROOT, 'backend/internal/tracker/athar.min.js')

const check = process.argv.includes('--check')

const banner = '/*! Athar tracker | MIT OR Apache-2.0 | https://github.com/vul-os/athar */'

const result = await build({
  entryPoints: [SRC],
  bundle: false,
  minify: true,
  format: 'iife',
  target: ['es2018'], // wide browser support; the script must never be the thing that breaks a page
  legalComments: 'none',
  banner: { js: banner },
  write: false,
})

const minified = result.outputFiles[0].text

if (check) {
  if (!existsSync(OUT)) {
    console.error('[tracker] athar.min.js is missing — run: npm run build:tracker')
    process.exit(1)
  }
  const current = readFileSync(OUT, 'utf8')
  if (current !== minified) {
    console.error('[tracker] athar.min.js is out of date with athar.js — run: npm run build:tracker')
    process.exit(1)
  }
  console.log('[tracker] athar.min.js is up to date')
  process.exit(0)
}

writeFileSync(OUT, minified)

const raw = Buffer.byteLength(minified)
const gz = gzipSync(minified, { level: 9 }).length
console.log(`[tracker] athar.min.js  ${raw} B raw  ${gz} B gzipped`)
