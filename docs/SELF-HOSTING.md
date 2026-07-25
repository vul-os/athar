# Self-hosting

Athar binds `127.0.0.1` by default. This document covers reaching it from
outside `localhost`, and the two settings — `trust_proxy_headers` and
`--secure-cookies` — that only make sense once you do.

## Why loopback by default

The default is deliberately restrictive even though Athar's whole job is
receiving beacons from the internet. The intended path to public
reachability is a tunnel or a reverse proxy, both of which reach loopback
without Athar itself ever binding a public interface — so "I ran `./athar`"
never accidentally means "I opened a port to the internet." Anyone who
genuinely wants Athar to bind `0.0.0.0` directly can set `host` explicitly;
nobody should do it by accident.

## Option 1: reverse proxy (nginx, Caddy, …)

Point a reverse proxy at `127.0.0.1:3100` and terminate TLS there. A minimal
Caddy example:

```
analytics.example.com {
    reverse_proxy 127.0.0.1:3100
}
```

Once traffic reaches Athar over HTTPS via the proxy:

- Set `trust_proxy_headers: true` **only if** your proxy is configured to
  overwrite (not merely append to) `X-Forwarded-For` / `X-Real-IP` — see
  below.
- Run Athar with `--secure-cookies` so the session and CSRF cookies are
  marked `Secure`.

## Option 2: a tunnel (cloudflared, ngrok, Ephor)

A tunnel dials *out* from the machine running Athar, so nothing needs to be
opened inbound on that machine's network — useful behind NAT, on a home
connection, or anywhere you'd rather not manage port forwarding.

```bash
# cloudflared, as one example
cloudflared tunnel --url http://127.0.0.1:3100
```

The tunnel provider's edge terminates TLS, so the same guidance as the
reverse-proxy case applies: enable `trust_proxy_headers` only if the tunnel
client rewrites the forwarding headers rather than appending to them, and
run with `--secure-cookies` once the public URL is HTTPS (it will be, for
any of the tunnel options above).

## `trust_proxy_headers`

```json
{ "trust_proxy_headers": true }
```

Default: **`false`**. This is a security-relevant default, not a convenience
default, and it's worth understanding exactly why.

`backend/internal/geoip.ClientIP` decides where the "client IP" comes from:

- When `false` (the default), it uses **only** the TCP socket peer address —
  whoever the OS says actually opened the connection. A request cannot lie
  about this field.
- When `true`, it trusts the **leftmost** entry of `X-Forwarded-For`, or
  `X-Real-IP`, over the socket peer.

The IP feeds two things: the GeoIP lookup, and the visitor-identity hash
(see [PRIVACY.md](PRIVACY.md)). If Athar is reachable *directly* — no proxy
in front of it — and `trust_proxy_headers` is `true`, any visitor can set
`X-Forwarded-For` to whatever they like on their own request, which lets
them forge their apparent country and inject an arbitrary "IP" into their
own visitor hash computation. That's a low-severity but real integrity
issue for reporting accuracy, which is why the flag defaults off.

Turn it on **only** when Athar genuinely sits behind a proxy or tunnel
client that itself overwrites (not appends to) the forwarding header before
the request reaches Athar — which is the normal, correct behaviour for a
reverse proxy or tunnel client, but is a property of *your* proxy
configuration that Athar has no way to verify from its side. If you're
unsure whether your proxy overwrites versus appends, leave this `false` and
accept that GeoIP will resolve the proxy's own address instead of the
visitor's, rather than risk trusting a header a visitor controls.

## HTTPS and `--secure-cookies`

`--secure-cookies` marks the session cookie and the CSRF cookie `Secure`,
meaning browsers will only ever send them over HTTPS. It defaults to `false`
purely so `http://localhost:3100` works during local setup and development
— every real deployment reachable over the network should run with
`--secure-cookies` once HTTPS is in place (via a reverse proxy or a tunnel
provider that terminates TLS, per the options above; Athar itself does not
speak TLS directly).

## See also

- [docs/CONFIGURATION.md](CONFIGURATION.md) — the full config reference.
- [docs/PRIVACY.md](PRIVACY.md) — what the client IP is used for, and why it
  matters that `trust_proxy_headers` be accurate.
- [docs/DEPLOYMENT-POSTGRES.md](DEPLOYMENT-POSTGRES.md) — running against
  Postgres instead of the SQLite default.
