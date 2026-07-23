#!/usr/bin/env node
/**
 * build-binary.mjs — produce the single static Athar binary.
 *
 * Go's embed directive can only reach files inside the package directory, so the
 * built dashboard (dist/) and the marketing site (site/) are staged into
 * backend/cmd/athar/ for the compile and removed afterwards. This mirrors how
 * the sibling Vulos products build, and keeps the staged copies out of the
 * working tree between builds.
 *
 * Run `npm run build` (Vite) and `npm run build:tracker` first — `npm run
 * build:all` does all three in order.
 */

import { existsSync, rmSync, cpSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = join(ROOT, 'backend/cmd/athar')

const stagedDist = join(PKG, 'dist')
const stagedSite = join(PKG, 'site')

const binary = process.platform === 'win32' ? 'athar.exe' : 'athar'
const version = process.env.ATHAR_VERSION || 'dev'

function cleanup() {
  rmSync(stagedDist, { recursive: true, force: true })
  rmSync(stagedSite, { recursive: true, force: true })
}

if (!existsSync(join(ROOT, 'dist/index.html'))) {
  console.error('[build] dist/ is missing or empty — run `npm run build` first')
  process.exit(1)
}

// Start from a clean slate: a leftover staged copy from an interrupted build
// would silently embed stale assets.
cleanup()

try {
  mkdirSync(stagedDist, { recursive: true })
  cpSync(join(ROOT, 'dist'), stagedDist, { recursive: true })
  cpSync(join(ROOT, 'site'), stagedSite, { recursive: true })

  execFileSync(
    'go',
    [
      'build',
      '-tags', 'embed_frontend',
      '-trimpath',
      '-ldflags', `-s -w -X main.Version=${version}`,
      '-o', join(ROOT, binary),
      './backend/cmd/athar',
    ],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0' } },
  )

  console.log(`[build] ./${binary} (version ${version})`)
} finally {
  // Always unstage, including after a failed compile.
  cleanup()
}
