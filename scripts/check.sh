#!/usr/bin/env bash
# Single verification gate for Athar. Run this before every commit; CI runs
# the same steps (see .github/workflows/ci.yml).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0
step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

step "go: gofmt"
# gofmt -l prints the files it would change and exits 0 either way, so the exit
# status is useless as a gate — the output is the signal. Empty means formatted.
unformatted="$(gofmt -l backend/)"
if [ -n "$unformatted" ]; then
  printf 'not gofmt-formatted:\n%s\n\nrun: gofmt -w backend/\n' "$unformatted"
  fail=1
else
  echo "backend/ is gofmt-clean"
fi

step "go: build"
go build ./backend/... || fail=1

step "go: vet"
go vet ./backend/... || fail=1

# Covers the whole server, including the embedded dashboard: backend/cmd/athar
# serves it, asserts security headers and that auth cannot be bypassed;
# backend/internal/webui asserts the embed is present, non-vacuous, and
# references no external origin.
step "go: test"
go test ./backend/... || fail=1

step "tracker: up to date"
node scripts/build-tracker.mjs --check || fail=1

# The dashboard has no build step and no lint config of its own — it is
# hand-written HTML/CSS/JS with no framework to misuse. format.js and
# countries.js are the one part with real logic, and they keep their test
# coverage: node:test, no vitest, no npm install beyond the `node` binary
# already required for the tracker build above. The glob must actually match
# files: `node --test` given a bare, empty directory exits 0 having run
# nothing, which is not a passing gate.
step "dashboard: format.js / countries.js tests"
shopt -s nullglob
jstests=(scripts/jstest/*.test.mjs)
shopt -u nullglob
if [ "${#jstests[@]}" -eq 0 ]; then
  echo "no test files matched scripts/jstest/*.test.mjs"
  fail=1
else
  node --test "${jstests[@]}" || fail=1
fi

if [ "$fail" -ne 0 ]; then
  printf '\n\033[31mCHECK FAILED\033[0m\n'
  exit 1
fi
printf '\n\033[32mCHECK PASSED\033[0m\n'
