# Privacy

Heatmaps and behavioural capture are only ethical because the site owner self-hosts and holds the data. This page is not a claim that Athar is "zero-knowledge" or "content-blind" — the operator running an Athar instance can see their own visitors' analytics, plainly, because that's the point of running it. What Athar removes is everything that doesn't need to exist for that: a persistent identifier, a third-party lookup, a raw IP sitting in a table.

## No cookie, ever

The tracker sets no cookie and reads no cookie. It writes nothing to `localStorage` or `sessionStorage`. There is no client-side identifier at all — nothing for a visitor to clear, and nothing to ask consent for under the ePrivacy directive's cookie rule, because no non-essential cookie is ever placed.

## Visitor identity: the daily salt

Athar still needs to tell "the same visitor, twice" from "two different visitors" — that's what unique-visitor counts and bounce rate are computed from. It does this with a hash computed at request time, never stored client-side:

```text
salt    = HMAC-SHA256(instance_secret, "YYYY-MM-DD")   # UTC day, recomputed at midnight
visitor = HMAC-SHA256(salt, website_id || ip || user_agent)
```

`instance_secret` is 32 random bytes generated once per Athar instance and persisted in its settings table. Everything else is recomputed from request data.

Three properties fall out of this construction, and each is load-bearing:

- **Unlinkable across days.** The salt rotates every UTC midnight. Today's hash for a given visitor has no derivable relationship to yesterday's — cross-day tracking isn't a missing feature, it's mathematically absent from what's stored.
- **No cross-site profile.** The website id sits *inside* the hash, ahead of a domain separator so fields can't run together. The same person visiting two sites tracked by one Athar instance produces two unrelated hashes. The operator's own database cannot be used to link that visitor's behaviour across their sites.
- **A real reset switch.** The instance secret is the one long-lived value in this whole scheme. Deleting it (the `ingest_secret` row in settings) permanently severs the link to every previous day's hashes — the intended way to hard-reset visitor identity for an instance.

## The IP touches exactly two things, then it's gone

At ingest, the raw client IP is used for two computations — the visitor hash above, and a local GeoIP lookup — and then it is out of scope. It is never written to the database, never written to a log, and never returned in any API response.

## GeoIP is local

Country, region and city are resolved in-process from a MaxMind-format `.mmdb` file (DB-IP Lite or GeoLite2 both work) that you point Athar at with `geoip_path`. There is no network call and no third-party lookup service involved — resolution happens against a file on disk. If no `.mmdb` is configured, geography fields are simply empty; Athar does not fetch one for you (licensing and file size are both reasons not to bundle it).

## Bots are dropped, not recorded

Requests whose user agent matches known bot/crawler patterns are dropped at ingest — answered with the same `204 No Content` as a real beacon, so a crawler has no signal that it's being filtered and no reason to spoof a different UA. Nothing about a dropped bot request is stored.

## What is stored, per visit

A visit row carries: the visitor hash, hostname, browser/OS/device/screen/language (all parsed or self-reported, none inferred from anything hidden), country/region/city (from GeoIP, if configured), referrer, UTM parameters, and timestamps. Never a raw IP, never a cookie value, never anything from `localStorage`.

## Cookieless, no-PII — not a compliance certificate

The result of the above is that a default Athar install is cookieless and collects no personal data by the usual definitions, which is a GDPR-friendly default: **no cookie banner is needed for that default configuration.** That is a description of the software's behaviour, not a claim that any particular deployment is "GDPR compliant" — compliance is a property of how an operator configures, discloses and operates their instance (what they put in `data-*` attributes, what they say in a privacy policy, whether `trust_proxy_headers` is on correctly), not something the software alone can certify.

## Account & session security

Separately from visitor tracking, the *dashboard* has real accounts: argon2id password hashing (64 MiB memory, `t=2`, following OWASP's floor with memory raised for a login form used a few times a day), server-side sessions where only a SHA-256 hash of the session token is stored (reading the database yields no usable cookie value), double-submit CSRF on every state-changing route, and login rate-limiting keyed on *both* username and client address — keying on username alone lets an attacker lock out a known account by guessing at it; keying on address alone lets a botnet spray one password across many accounts. See [API](./api.md) for the CSRF header and [Configuration](./configuration.md) for `trust_proxy_headers`.

## Data retention

`retention_days` (0 by default, meaning keep forever) deletes whole visitor *sessions* older than the window, which cascades to their events, heatmap samples and revenue rows — a retention pass that deleted only events would leave sessions behind and skew every bounce-rate calculation computed afterward. Retention runs once an hour in the background.

## Public share links

A website's dashboard can be shared read-only via an unguessable share id (`GET /api/share/{shareID}/stats`). Turning sharing off and back on mints a *fresh* id rather than reviving the old one — disabling sharing is a real revocation, not cosmetic.

## Page captures: an operator's own choice, not the tracker's

The click heatmap can render over a real picture of the page instead of only a wireframe (see [Heatmaps](./heatmaps.md#page-captures)). That picture is never something the tracker collects — nothing above changes: the tracker still records only a click's position as a document-relative percentage plus a short CSS selector, never DOM content, never text, never a screenshot, and the server never fetches the tracked site to make one itself.

The capture is a screenshot an **operator** deliberately takes of their own page and uploads through the dashboard (`PUT /api/websites/{id}/page-image`), stored in their own database — one per (website, path, viewport width), in a `page_images` table only an authenticated editor or owner can write to. It's served back only to signed-in users of that website, never publicly.

Because it's stored in the operator's own database and visible to every signed-in viewer of that website, whatever is on screen when it's captured — a real visitor's name, a basket, an order — becomes visible to all of them too. The dashboard states this at the moment of upload and recommends capturing the page as a logged-out visitor would see it. That's a choice about what the operator puts in their own database, same as any other data they might store there; it's not a tracker behaviour, and no visitor's browser is involved in producing it.
