# Changelog

## Unreleased

**Heatmap-over-page-capture underlay.** The click heatmap can now render its density field over a real picture of the page: an editor or owner uploads a full-page PNG/JPEG capture through the dashboard, keyed to one page and one recorded viewport width (`PUT /api/websites/{id}/page-image?path=&viewport=`, plus matching `GET`/`GET .../page-images`/`DELETE` routes — see [API](./api.md#page-captures)). This is operator-supplied upload, not automatic capture: the tracker did not change, and still records only a click's position, viewport size and CSS selector, never page content or a screenshot. A new migration (`page_images`, base64-encoded image bytes in a `TEXT` column — see [Architecture](./architecture.md#the-storage-seam)) stores one capture per (website, path, viewport width), replaced rather than accumulated, cascading on website deletion. With no matching capture, the view falls back to the wireframe schematic, badged as one — see [Heatmaps](./heatmaps.md#page-captures) and [Privacy](./privacy.md#page-captures-an-operators-own-choice-not-the-trackers) for the privacy consequence the dashboard states at the moment of upload.

Dashboard rewritten from React + Vite + Tailwind to hand-written HTML/CSS and plain ES modules, embedded directly via `go:embed` (`backend/internal/webui/static/`) instead of a built bundle staged in at compile time — see [Architecture](./architecture.md#one-binary). `go build ./...` alone (no Node, no npm install) now produces a binary with a fully working dashboard; there is no dev server any more — the dev loop is `go run ./backend/cmd/athar`, editing `backend/internal/webui/static/*` directly.

The dashboard's PWA (`manifest.webmanifest`, service worker, app icons) was removed in the same rewrite — the dashboard is now a plain web page, not an installable or offline-capable app. Bringing back installability (a web manifest and icons, without the service worker's offline cache) is tracked on the [Roadmap](./roadmap.md); it hasn't shipped.

## v0.1.0 — initial scaffold

First working version of Athar: a single Go binary with an embedded dashboard, cookieless daily-salted visitor identification, click/scroll/attention heatmaps, local GeoIP resolution, custom events, revenue tracking, per-website roles with revocable share links, argon2id-backed dashboard accounts with CSRF-protected sessions, and a SQLite-by-default / Postgres-by-config store. The dashboard at this release was a React/Vite single-page app, embedded as a built bundle; see Unreleased, above, for the rewrite since.

See [Roadmap](./roadmap.md) for what's deliberately not in this release yet.
