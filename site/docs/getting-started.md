# Getting started

Athar is a self-hosted web analytics tool with heatmaps and ecommerce tooling. It ships as a single static Go binary with the React dashboard embedded — there is no separate frontend server, no message queue, and no managed service to sign up for.

## Run it

```
git clone https://github.com/vul-os/athar.git
cd athar
npm install && npm run build:all
./athar
```

`npm run build:all` builds the tracker script, the dashboard bundle, and the Go binary in one pass. `./athar` then:

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

## Go public

Athar binds `127.0.0.1` by default, which means it isn't reachable from the internet until you point something at it. That's deliberate — see [Configuration](./configuration.md#host--port). The two normal ways to get beacons flowing from a real site:

- a tunnel (cloudflared, ngrok, Vulos Relay) pointed at `127.0.0.1:3100`
- a reverse proxy (nginx, Caddy) terminating TLS and forwarding to loopback

Either way, once traffic reaches Athar over a proxy, set `trust_proxy_headers` correctly — see [Configuration](./configuration.md#trust_proxy_headers) before you do.

## Next

- [Install](./install.md) — build requirements, Docker-free build, running as a service
- [Privacy](./privacy.md) — exactly what is and isn't collected, and why
- [Configuration](./configuration.md) — every config key, env var and flag
- [API](./api.md) — the full REST surface
