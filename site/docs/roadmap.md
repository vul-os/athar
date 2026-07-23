# Roadmap

Athar is a v0.1 scaffold. Everything documented elsewhere on this site is implemented and working; this page is the honest list of what isn't yet.

## Planned, not yet built

- **Two-factor authentication (TOTP).** The schema already has a slot for a TOTP secret per user (`store.User.TOTPSecret`), and the public user shape already reports whether one is enrolled — but the enrollment flow and the login-time challenge are not built. Right now that field is always empty and login is password-only.
- **Session insight (rrweb).** Click, scroll and attention heatmaps need no DOM capture — they are coordinates, and that is all today's tracker collects. Rendering a heatmap *overlaid on the page it describes*, and session insight more generally, does need a snapshot, and the plan is to build that on [rrweb](https://github.com/rrweb-io/rrweb) (MIT). It will be strictly opt-in, shipped as a separate module rather than added to the 1.6 KB default tracker, and the cookieless/no-DOM-capture path described in [Privacy](./privacy.md) stays the default. Until it lands, treat every "no DOM snapshot" statement on this site as describing what is shipped today — because it is.
- **Funnels UI.** The data to build funnels from (custom events with properties, pageviews with paths) is already collected; there's no funnel-definition or visualization surface in the dashboard yet.
- **Teams UI.** Per-website roles (owner/editor/viewer) exist and are enforced by the API today — see [API](./api.md#websites) — but there's no dashboard screen yet for inviting a teammate to a specific website; grants are currently a backend capability without a frontend for managing them.
- **Packaged distribution.** No Docker image, no downloadable release binary yet — [Install](./install.md) is build-from-source only.

## Also worth knowing

- Revenue reporting is totals-per-currency over a time range today (see [Ecommerce](./ecommerce.md)) — no product/SKU breakdown, no cart funnel.
- GeoIP data (`.mmdb`) is not bundled and must be supplied by the operator — see [Self-hosting](./self-hosting.md#geoip).

If a feature isn't listed as implemented on the [Getting started](./getting-started.md), [Tracker script](./tracker.md), [Heatmaps](./heatmaps.md), [Ecommerce](./ecommerce.md), [Privacy](./privacy.md), or [API](./api.md) pages, treat it as not built yet rather than assuming it's just undocumented.
