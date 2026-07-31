# Getting started

Athar is a self-hosted web analytics tool with heatmaps and ecommerce tooling. It ships as a single static Go binary with a hand-written HTML/CSS/JS dashboard embedded via `go:embed` — there is no separate frontend server, no message queue, and no managed service to sign up for.

## Run it

```bash
git clone https://github.com/vul-os/athar.git
cd athar
npm install && npm run build
./athar
```

`npm run build` runs `build:tracker` (rebuilds the tracker script) then `build:binary` (compiles the Go binary). The dashboard itself has no build step — it's plain files embedded straight into the binary — so `go build -o athar ./backend/cmd/athar` alone, with no Node involved, also produces a fully working binary; see [Install](./install.md#build) for the difference. `./athar` then:

- listens on `http://127.0.0.1:3100` (loopback only — see [Configuration](./configuration.md#host--port) for why)
- stores data to `./athar.db`, a SQLite file created on first run
- serves the dashboard at `/`

Open `http://127.0.0.1:3100` in a browser. The first visit shows a setup form instead of a login — filling it in creates the instance's one admin account. There is no separate "create account" flow after that: [bootstrap](./api.md#post-apiauthbootstrap) only works while the instance has zero users.

## Add a website

From the dashboard, create a website with a name and a domain. That gives you a website id and a ready-to-paste script tag:

```html
<script defer src="https://analytics.example.com/athar.js"
        data-website-id="YOUR_WEBSITE_ID"></script>
```

Put it in your site's `<head>`, or anywhere before `</body>`. It's the whole integration — see [Tracker script](./tracker.md) for every `data-*` attribute, including `data-heatmap="true"` to also collect heatmaps.

## Optional: upload a page capture

Once click heatmap samples exist for a page, the heatmap view can draw the density field over a real picture of that page instead of only a wireframe. This is a manual, per-page, per-viewport-width step — an editor or owner takes a **full-page** screenshot (not just the visible fold — click positions are percentages of the whole document) and uploads it from the panel next to the heatmap. Nothing about the tracker changes to support this, and the server never fetches your site itself. Because the capture is stored in this instance's own database and shown to every signed-in viewer of the website, capture the page as a logged-out visitor would see it — see [Privacy](./privacy.md#page-captures-an-operators-own-choice-not-the-trackers) and [Heatmaps](./heatmaps.md#page-captures). Skipping this is fine: without a capture, the heatmap shows the wireframe schematic.

## Go public

Athar binds `127.0.0.1` by default, which means it isn't reachable from the internet until you point something at it. That's deliberate — see [Configuration](./configuration.md#host--port). The two normal ways to get beacons flowing from a real site:

- a tunnel (cloudflared, ngrok, Ephor) pointed at `127.0.0.1:3100`
- a reverse proxy (nginx, Caddy) terminating TLS and forwarding to loopback

Either way, once traffic reaches Athar over a proxy, set `trust_proxy_headers` correctly — see [Configuration](./configuration.md#trust_proxy_headers) before you do.

## Next

- [Install](./install.md) — build requirements, Docker-free build, running as a service
- [Privacy](./privacy.md) — exactly what is and isn't collected, and why
- [Configuration](./configuration.md) — every config key, env var and flag
- [API](./api.md) — the full REST surface
