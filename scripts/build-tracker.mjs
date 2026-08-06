#!/usr/bin/env node
/**
 * build-tracker.mjs — compile the tracking script.
 *
 * backend/internal/tracker/athar.ts is the typed source. This produces two
 * committed build outputs next to it:
 *
 *   athar.js      readable, type-stripped, comments intact — embedded and
 *                 served at `?source=1` so a visitor can read exactly what
 *                 is running (see backend/internal/tracker/tracker.go).
 *   athar.min.js  minified — what the Go binary embeds and what visitors'
 *                 browsers actually download.
 *
 * athar.js is produced with the TypeScript compiler itself (not esbuild):
 * esbuild's transform strips ALL regular comments even with minify off, which
 * would silently gut the "readable, commented original" the source-serving
 * feature promises. tsc's transpile keeps them.
 *
 * Both files are COMMITTED, not gitignored. That is deliberate: a Go
 * toolchain alone should be enough to build a working Athar binary, without
 * also requiring Node. CI re-runs this and fails if either committed file has
 * drifted from athar.ts (`--check`), so they can never silently disagree.
 *
 * Usage:
 *   node scripts/build-tracker.mjs           # write athar.js + athar.min.js
 *   node scripts/build-tracker.mjs --check   # verify both are up to date
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import ts from 'typescript'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'backend/internal/tracker/athar.ts')
const OUT_READABLE = join(ROOT, 'backend/internal/tracker/athar.js')
const OUT_MIN = join(ROOT, 'backend/internal/tracker/athar.min.js')

const check = process.argv.includes('--check')

const banner = '/*! Athar tracker | MIT OR Apache-2.0 | https://github.com/vul-os/athar */\n'

// ── Readable copy: strip types, keep everything else ────────────────────────

const srcText = readFileSync(SRC, 'utf8')

const transpiled = ts.transpileModule(srcText, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2018,
    module: ts.ModuleKind.ESNext,
    removeComments: false,
    // Matches the source's own inner 'use strict' — without this, tsc adds
    // a second, redundant top-of-file 'use strict' prologue.
    alwaysStrict: false,
    ignoreDeprecations: '6.0',
  },
  reportDiagnostics: true,
  fileName: SRC,
})

const tsErrors = transpiled.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error) ?? []
if (tsErrors.length) {
  console.error('[tracker] athar.ts failed to transpile:')
  for (const d of tsErrors) {
    console.error('  ' + ts.flattenDiagnosticMessageText(d.messageText, '\n'))
  }
  process.exit(1)
}

const readable = banner + transpiled.outputText

// ── Minified copy: esbuild already transpiles TS natively, no new dependency ─

const result = await build({
  entryPoints: [SRC],
  bundle: false,
  minify: true,
  format: 'iife',
  target: ['es2018'], // wide browser support; the script must never be the thing that breaks a page
  legalComments: 'none',
  banner: { js: banner.trimEnd() },
  write: false,
  // Compiler options inline, not read from backend/internal/tracker/tsconfig.json:
  // that tsconfig sets "strict" (for `tsc --noEmit`), and esbuild auto-discovering
  // it would inject an extra top-of-file "use strict" the pre-TypeScript build
  // never had. The minified output must depend only on athar.ts, not on a
  // typecheck-only config file that happens to sit next to it.
  tsconfigRaw: '{}',
})

const minified = result.outputFiles[0].text

if (check) {
  let ok = true
  for (const [label, out, want] of [
    ['athar.js', OUT_READABLE, readable],
    ['athar.min.js', OUT_MIN, minified],
  ]) {
    if (!existsSync(out)) {
      console.error(`[tracker] ${label} is missing — run: npm run build:tracker`)
      ok = false
      continue
    }
    const current = readFileSync(out, 'utf8')
    if (current !== want) {
      console.error(`[tracker] ${label} is out of date with athar.ts — run: npm run build:tracker`)
      ok = false
    }
  }
  if (!ok) process.exit(1)
  console.log('[tracker] athar.js and athar.min.js are up to date')
  process.exit(0)
}

writeFileSync(OUT_READABLE, readable)
writeFileSync(OUT_MIN, minified)

const readableRaw = Buffer.byteLength(readable)
const raw = Buffer.byteLength(minified)
const gz = gzipSync(minified, { level: 9 }).length
console.log(`[tracker] athar.js      ${readableRaw} B raw`)
console.log(`[tracker] athar.min.js  ${raw} B raw  ${gz} B gzipped`)
