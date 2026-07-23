# Security Policy

Athar is self-hosted web analytics: an unauthenticated collector endpoint
facing the open internet, a dashboard with real login sessions, and a set of
privacy guarantees (no cookies, no raw IP at rest, unlinkable-across-days
visitor hashes) that are the whole reason the project exists. Reports against
any of that are taken seriously and handled with priority.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

- Preferred: [GitHub private vulnerability reporting](https://github.com/vul-os/athar/security/advisories/new) on `vul-os/athar`.
- Alternatively, email **vulosorg@gmail.com** with `[athar security]` in the subject.

Include what you can: affected area (the collector, auth/session, share
links, the privacy construction, a specific API route), reproduction steps,
and impact as you understand it. You'll get an acknowledgement within **72
hours** and a status update at least every **14 days** until resolution.
Please give a reasonable window to ship a fix before public disclosure —
we'll credit you in the release notes unless you'd rather stay anonymous.

## Scope

Especially interested in:

- **The unauthenticated collector endpoint** (`/api/send` by default) — it
  has no login by design, so any bug here is reachable by anyone on the
  internet. Beacon parsing, rate limiting, and the bot filter all matter.
- **Authentication, sessions & CSRF** — bypassing login, forging or hijacking
  a dashboard session, or a state-changing request that isn't covered by the
  double-submit CSRF check.
- **Share-link scoping** — a public share link must never be pivotable into
  another website's data, or into the authenticated API. Every share handler
  is expected to resolve its website strictly from the share id in the URL,
  never from a caller-supplied website id.
- **The privacy guarantees themselves.** This is the category we care most
  about. Anything that lets a stored visitor hash be reversed back to an IP
  address, or that lets visitor hashes be linked across the daily salt
  rotation, or that lets one operator correlate a visitor across two
  different websites on their own instance, **is a security bug** — not a
  privacy nice-to-have — regardless of how it's found (timing, a stored
  side-channel, a logic error in the hash construction, whatever). Report it
  as a vulnerability, not a feature request.
- **SQL injection via the metrics/reporting parameters** — `?metric=`,
  `?interval=`, and friends are expected to be strictly validated against a
  fixed allow-list before touching a query; anything that gets past that is
  in scope.

Out of scope: vulnerabilities requiring an already-compromised host, and
issues in third-party services an operator chooses to configure around Athar
(a tunnel provider, a reverse proxy, a GeoIP database source).

## Supported versions

Athar is pre-1.0 (currently v0.1.0). Only the latest release and `main`
receive fixes; there is no long-term-support branch yet.
