/**
 * Athar tracker — https://github.com/vul-os/athar
 *
 * Cookieless by construction. This script sets no cookie, reads no cookie,
 * writes nothing to localStorage or sessionStorage, and holds no identifier of
 * any kind. Visitor identity is derived server-side from a daily rotating salt,
 * so there is nothing here for a visitor to clear and nothing to consent to.
 *
 * Usage:
 *   <script defer src="https://analytics.example.com/athar.js"
 *           data-website-id="YOUR_WEBSITE_ID"></script>
 *
 * Attributes:
 *   data-website-id   (required) the website id from your Athar dashboard
 *   data-host-url     send beacons elsewhere than where the script is hosted
 *   data-domains      comma-separated allowlist of hostnames to track
 *   data-auto-track   "false" to disable automatic pageviews
 *   data-heatmap      "true" to collect click / scroll / attention samples
 *   data-do-not-track "true" to honour the browser's Do Not Track signal
 *   data-exclude-search "true" to drop query strings before sending
 *
 * API (available once loaded):
 *   athar.track()                      send a pageview for the current URL
 *   athar.track(name)                  send a named custom event
 *   athar.track(name, data)            …with properties
 *   athar.revenue(amount, currency, orderId, name)  send a revenue event
 */

// Ambient augmentation: this file has no import/export, so TypeScript treats
// it as a global script and merges this straight into the real lib.dom
// Window interface — exactly the shape the IIFE below installs.
interface Window {
  athar?: {
    track: (nameOrData?: string | Record<string, unknown>, data?: unknown) => void;
    revenue: (amount: number, currency?: string, orderId?: string, name?: string) => void;
  };
}

(function (window: Window, document: Document) {
  'use strict';

  const script = document.currentScript as HTMLScriptElement | null;
  if (!script) return;

  const attr = function (name: string, fallback: string): string {
    // `script` was reassigned above from `var` to `const` while adding this
    // repo's first lint pass — TypeScript narrows a never-reassigned const
    // across nested function bodies, so the non-null check on line 43 now
    // carries in here without an assertion (it didn't with `var`).
    const v = script.getAttribute('data-' + name);
    return v === null ? fallback : v;
  };
  const flag = function (name: string): boolean {
    return attr(name, 'false') === 'true';
  };

  const websiteId = attr('website-id', '');
  if (!websiteId) return;

  // Default the collector to wherever this script is served from, so a single
  // script tag is the whole integration.
  const hostUrl = attr('host-url', '') || new URL(script.src, location.href).origin;
  const endpoint = hostUrl.replace(/\/+$/, '') + '/api/send';

  const autoTrack = attr('auto-track', 'true') !== 'false';
  const heatmapOn = flag('heatmap');
  const excludeSearch = flag('exclude-search');
  const domains = attr('domains', '')
    .split(',')
    .map(function (d: string): string { return d.trim(); })
    .filter(Boolean);

  // Do Not Track is opt-in to honour, because a self-hosted first-party
  // analytics install is a different thing from third-party tracking — but the
  // site owner gets to make that call, not this script.
  //
  // window.doNotTrack and navigator.msDoNotTrack are long-dead, non-standard
  // signals (old Firefox / IE) that never made it into lib.dom's types; the
  // local interfaces below type them as "maybe a string" without widening
  // anything else. dnt itself stays `unknown` because browsers disagreed on
  // whether the value was the string "1"/"yes" or, in some ancient builds,
  // the number 1 — the runtime check below still covers both.
  interface LegacyWindow extends Window {
    doNotTrack?: string;
  }
  interface LegacyNavigator extends Navigator {
    msDoNotTrack?: string;
  }
  if (flag('do-not-track')) {
    const dnt: unknown = (window as LegacyWindow).doNotTrack || navigator.doNotTrack || (navigator as LegacyNavigator).msDoNotTrack;
    if (dnt === '1' || dnt === 1 || dnt === 'yes') return;
  }
  if (domains.length && domains.indexOf(location.hostname) === -1) return;

  const screenSize = window.screen.width + 'x' + window.screen.height;
  const language = navigator.language || '';

  function currentUrl(): string {
    const path = location.pathname;
    return excludeSearch ? path : path + location.search;
  }

  function send(type: string, body: Record<string, unknown>): void {
    const data = JSON.stringify({ type: type, payload: body });
    // sendBeacon survives the page unloading, which is exactly when the last
    // (and most interesting) samples are flushed. fetch is the fallback.
    if (navigator.sendBeacon) {
      // A Blob with an explicit type keeps this a CORS-simple request, so the
      // browser skips the preflight round trip.
      navigator.sendBeacon(endpoint, new Blob([data], { type: 'text/plain' }));
      return;
    }
    fetch(endpoint, {
      method: 'POST',
      body: data,
      headers: { 'Content-Type': 'text/plain' },
      keepalive: true,
      credentials: 'omit',
      mode: 'no-cors'
    }).catch(function (): void { /* analytics must never break the host page */ });
  }

  function base(extra?: Record<string, unknown>): Record<string, unknown> {
    const body: Record<string, unknown> = {
      website: websiteId,
      hostname: location.hostname,
      screen: screenSize,
      language: language,
      url: currentUrl(),
      referrer: document.referrer,
      title: document.title
    };
    if (extra) for (const k in extra) body[k] = extra[k];
    return body;
  }

  function track(nameOrData?: string | Record<string, unknown>, data?: unknown): void {
    if (typeof nameOrData === 'string') {
      send('event', base({ name: nameOrData, data: data || undefined }));
    } else if (nameOrData && typeof nameOrData === 'object') {
      send('event', base(nameOrData));
    } else {
      send('event', base());
    }
  }

  function revenue(amount: number, currency?: string, orderId?: string, name?: string): void {
    send('event', base({
      name: name || 'purchase',
      revenue: {
        amount: Number(amount) || 0,
        currency: currency || 'USD',
        order_id: orderId || ''
      }
    }));
  }

  // ── Automatic pageviews, including client-side routing ────────────────────

  let lastUrl = '';

  function pageview(): void {
    const url = currentUrl();
    if (url === lastUrl) return; // a replaced state is not a new pageview
    lastUrl = url;
    if (heatmapOn) flushHeat(); // samples belong to the page they happened on
    send('event', base());
  }

  function hookHistory(method: 'pushState' | 'replaceState'): void {
    // Extracted so it can be forwarded via .apply(this, ...) below — the
    // rule can't see that .apply(this, ...) explicitly rebinds `this` to
    // the real History object every call, which is why this is fine
    // despite being "torn off" here. See the eslint.config.js override for
    // this file.
    const original = window.history[method];
    if (typeof original !== 'function') return;
    window.history[method] = function (this: History, ...args: unknown[]) {
      // pushState/replaceState take a fixed 3-arg tuple in lib.dom's types,
      // but this wrapper genuinely forwards whatever the caller passed
      // (including callers that rely on the loose 2-arg pre-standard form),
      // so the rest-params array is cast rather than re-typed as that exact
      // tuple.
      const result = original.apply(this, args as unknown as Parameters<typeof original>);
      // Defer so the framework's own router runs first and location is settled.
      setTimeout(pageview, 0);
      return result;
    };
  }

  // ── Heatmaps ──────────────────────────────────────────────────────────────
  //
  // Positions are stored as percentages of the *document*, not pixels of the
  // viewport, so a map recorded on a phone and one recorded on a desktop
  // overlay onto the same page. The CSS selector of the clicked element rides
  // along, which is what lets a click map stay meaningful after a layout change.
  //
  // Nothing about the page content is captured: no DOM snapshot, no text, no
  // form values, no keystrokes. That is still true now that the dashboard can
  // draw a click map over a picture of the page — the picture is a screenshot
  // an operator uploads to their own instance by hand, never anything this
  // script produces or sends. See backend/internal/api/pageimages.go.

  type HeatKind = 'click' | 'scroll' | 'attn';

  interface HeatSample {
    k: HeatKind;
    p?: string; // current URL, stamped on by pushHeat
    x?: number; // click only
    y?: number; // click only
    sel?: string; // click only
    s?: number; // scroll depth % (scroll) or band start % (attn)
    d?: number; // dwell ms (attn only)
    vw: number;
    vh: number;
  }

  let heat: HeatSample[] = [];
  let maxScroll = 0;
  let attnStart = Date.now();
  let attnBand = -1;

  function docHeight(): number {
    const b = document.body, e = document.documentElement;
    return Math.max(b.scrollHeight, b.offsetHeight, e.clientHeight, e.scrollHeight, e.offsetHeight) || 1;
  }

  // selectorFor builds a short, stable-ish path to an element. It stops at the
  // first id, prefers a single class, and caps depth — a full path would be
  // both enormous and more brittle, not less.
  function selectorFor(el: Element | null): string {
    const parts: string[] = [];
    for (let i = 0; el && el.nodeType === 1 && i < 5; i++) {
      if (el.id) { parts.unshift('#' + el.id); break; }
      let part = el.nodeName.toLowerCase();
      const cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
      if (cls) part += '.' + cls;
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(' > ').slice(0, 250);
  }

  function pushHeat(sample: HeatSample): void {
    sample.p = currentUrl();
    heat.push(sample);
    if (heat.length >= 50) flushHeat();
  }

  function flushHeat(): void {
    if (!heat.length) return;
    const batch = heat;
    heat = [];
    send('heat', base({ heat: batch }));
  }

  function onClick(e: MouseEvent): void {
    const h = docHeight();
    pushHeat({
      k: 'click',
      x: ((e.pageX || 0) / (document.documentElement.scrollWidth || 1)) * 100,
      y: ((e.pageY || 0) / h) * 100,
      vw: window.innerWidth,
      vh: window.innerHeight,
      // Click targets are always Elements in practice (Document/Window are
      // not click targets a listener on `document` with capture will see).
      sel: selectorFor(e.target as Element | null)
    });
  }

  function scrollPct(): number {
    const h = docHeight();
    const seen = (window.scrollY || window.pageYOffset || 0) + window.innerHeight;
    return Math.min(100, (seen / h) * 100);
  }

  function onScroll(): void {
    const pct = scrollPct();
    if (pct > maxScroll) maxScroll = pct;

    // Attention is measured per 10% band: when the visitor moves to a new band,
    // close the previous one with the time spent there.
    const band = Math.floor(pct / 10);
    if (band !== attnBand) {
      if (attnBand >= 0) {
        const dwell = Date.now() - attnStart;
        if (dwell > 250) {
          pushHeat({ k: 'attn', s: attnBand * 10, d: dwell, vw: window.innerWidth, vh: window.innerHeight });
        }
      }
      attnBand = band;
      attnStart = Date.now();
    }
  }

  function finishHeat(): void {
    if (maxScroll > 0) {
      pushHeat({ k: 'scroll', s: maxScroll, vw: window.innerWidth, vh: window.innerHeight });
      maxScroll = 0;
    }
    if (attnBand >= 0) {
      const dwell = Date.now() - attnStart;
      if (dwell > 250) {
        pushHeat({ k: 'attn', s: attnBand * 10, d: dwell, vw: window.innerWidth, vh: window.innerHeight });
      }
      attnBand = -1;
      attnStart = Date.now();
    }
    flushHeat();
  }

  // ── Wire up ───────────────────────────────────────────────────────────────

  window.athar = { track: track, revenue: revenue };

  if (heatmapOn) {
    document.addEventListener('click', onClick, true);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll(); // record the band the visitor lands in
  }

  // pagehide rather than unload: it is the event that actually fires on mobile
  // Safari, and it is compatible with the back/forward cache.
  window.addEventListener('pagehide', function (): void {
    if (heatmapOn) finishHeat();
  });
  document.addEventListener('visibilitychange', function (): void {
    if (document.visibilityState === 'hidden' && heatmapOn) finishHeat();
  });

  if (autoTrack) {
    hookHistory('pushState');
    hookHistory('replaceState');
    window.addEventListener('popstate', pageview);

    if (document.readyState === 'complete') {
      pageview();
    } else {
      window.addEventListener('load', pageview);
    }
  }
})(window, document);
