#!/usr/bin/env node
/**
 * build-binary.mjs — produce the single static Athar binary, with the
 * marketing site embedded.
 *
 * The dashboard itself needs none of this: it is hand-written HTML/CSS/JS
 * embedded via go:embed in backend/internal/webui, so `go build ./...` alone
 * (no tags, no Node) already produces a binary that serves a fully working
 * dashboard. This script exists only for the release shape that also bundles
 * the marketing site (site/), which is served from disk in a plain `go
 * build` and embedded only under the `embed_site` tag — see
 * backend/cmd/athar/site_embed.go / site_dev.go.
 *
 * Go's embed directive can only reach files inside the package directory, so
 * site/ is staged into backend/cmd/athar/ for the compile and removed
 * afterwards, keeping the staged copy out of the working tree between
 * builds.
 *
 * Run `npm run build:tracker` first (or `npm run build`, which does both) so
 * the embedded tracker script reflects any edits to athar.ts.
 */

import { rmSync, cpSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = join(ROOT, 'backend/cmd/athar')

const stagedSite = join(PKG, 'site')

const binary = process.platform === 'win32' ? 'athar.exe' : 'athar'
const version = process.env.ATHAR_VERSION || 'dev'

function cleanup() {
  rmSync(stagedSite, { recursive: true, force: true })
}

// Start from a clean slate: a leftover staged copy from an interrupted build
// would silently embed a stale marketing site.
cleanup()

try {
  mkdirSync(stagedSite, { recursive: true })
  cpSync(join(ROOT, 'site'), stagedSite, { recursive: true })

  execFileSync(
    'go',
    [
      'build',
      '-tags', 'embed_site',
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
