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
(function (window, document) {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var attr = function (name, fallback) {
    var v = script.getAttribute('data-' + name);
    return v === null ? fallback : v;
  };
  var flag = function (name) {
    return attr(name, 'false') === 'true';
  };

  var websiteId = attr('website-id', '');
  if (!websiteId) return;

  // Default the collector to wherever this script is served from, so a single
  // script tag is the whole integration.
  var hostUrl = attr('host-url', '') || new URL(script.src, location.href).origin;
  var endpoint = hostUrl.replace(/\/+$/, '') + '/api/send';

  var autoTrack = attr('auto-track', 'true') !== 'false';
  var heatmapOn = flag('heatmap');
  var excludeSearch = flag('exclude-search');
  var domains = attr('domains', '')
    .split(',')
    .map(function (d) { return d.trim(); })
    .filter(Boolean);

  // Do Not Track is opt-in to honour, because a self-hosted first-party
  // analytics install is a different thing from third-party tracking — but the
  // site owner gets to make that call, not this script.
  if (flag('do-not-track')) {
    var dnt = window.doNotTrack || navigator.doNotTrack || navigator.msDoNotTrack;
    if (dnt === '1' || dnt === 1 || dnt === 'yes') return;
  }
  if (domains.length && domains.indexOf(location.hostname) === -1) return;

  var screenSize = window.screen.width + 'x' + window.screen.height;
  var language = navigator.language || '';

  function currentUrl() {
    var path = location.pathname;
    return excludeSearch ? path : path + location.search;
  }

  function send(type, body) {
    var data = JSON.stringify({ type: type, payload: body });
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
    }).catch(function () { /* analytics must never break the host page */ });
  }

  function base(extra) {
    var body = {
      website: websiteId,
      hostname: location.hostname,
      screen: screenSize,
      language: language,
      url: currentUrl(),
      referrer: document.referrer,
      title: document.title
    };
    if (extra) for (var k in extra) body[k] = extra[k];
    return body;
  }

  function track(nameOrData, data) {
    if (typeof nameOrData === 'string') {
      send('event', base({ name: nameOrData, data: data || undefined }));
    } else if (nameOrData && typeof nameOrData === 'object') {
      send('event', base(nameOrData));
    } else {
      send('event', base());
    }
  }

  function revenue(amount, currency, orderId, name) {
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

  var lastUrl = '';

  function pageview() {
    var url = currentUrl();
    if (url === lastUrl) return; // a replaced state is not a new pageview
    lastUrl = url;
    if (heatmapOn) flushHeat(); // samples belong to the page they happened on
    send('event', base());
  }

  function hookHistory(method) {
    var original = window.history[method];
    if (typeof original !== 'function') return;
    window.history[method] = function () {
      var result = original.apply(this, arguments);
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
  // form values, no keystrokes.

  var heat = [];
  var maxScroll = 0;
  var attnStart = Date.now();
  var attnBand = -1;

  function docHeight() {
    var b = document.body, e = document.documentElement;
    return Math.max(b.scrollHeight, b.offsetHeight, e.clientHeight, e.scrollHeight, e.offsetHeight) || 1;
  }

  // selectorFor builds a short, stable-ish path to an element. It stops at the
  // first id, prefers a single class, and caps depth — a full path would be
  // both enormous and more brittle, not less.
  function selectorFor(el) {
    var parts = [];
    for (var i = 0; el && el.nodeType === 1 && i < 5; i++) {
      if (el.id) { parts.unshift('#' + el.id); break; }
      var part = el.nodeName.toLowerCase();
      var cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
      if (cls) part += '.' + cls;
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(' > ').slice(0, 250);
  }

  function pushHeat(sample) {
    sample.p = currentUrl();
    heat.push(sample);
    if (heat.length >= 50) flushHeat();
  }

  function flushHeat() {
    if (!heat.length) return;
    var batch = heat;
    heat = [];
    send('heat', base({ heat: batch }));
  }

  function onClick(e) {
    var h = docHeight();
    pushHeat({
      k: 'click',
      x: ((e.pageX || 0) / (document.documentElement.scrollWidth || 1)) * 100,
      y: ((e.pageY || 0) / h) * 100,
      vw: window.innerWidth,
      vh: window.innerHeight,
      sel: selectorFor(e.target)
    });
  }

  function scrollPct() {
    var h = docHeight();
    var seen = (window.scrollY || window.pageYOffset || 0) + window.innerHeight;
    return Math.min(100, (seen / h) * 100);
  }

  function onScroll() {
    var pct = scrollPct();
    if (pct > maxScroll) maxScroll = pct;

    // Attention is measured per 10% band: when the visitor moves to a new band,
    // close the previous one with the time spent there.
    var band = Math.floor(pct / 10);
    if (band !== attnBand) {
      if (attnBand >= 0) {
        var dwell = Date.now() - attnStart;
        if (dwell > 250) {
          pushHeat({ k: 'attn', s: attnBand * 10, d: dwell, vw: window.innerWidth, vh: window.innerHeight });
        }
      }
      attnBand = band;
      attnStart = Date.now();
    }
  }

  function finishHeat() {
    if (maxScroll > 0) {
      pushHeat({ k: 'scroll', s: maxScroll, vw: window.innerWidth, vh: window.innerHeight });
      maxScroll = 0;
    }
    if (attnBand >= 0) {
      var dwell = Date.now() - attnStart;
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
  window.addEventListener('pagehide', function () {
    if (heatmapOn) finishHeat();
  });
  document.addEventListener('visibilitychange', function () {
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
