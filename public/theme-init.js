/**
 * Resolves the theme before first paint.
 *
 * This is a separate file rather than an inline <script> on purpose: Athar
 * serves `script-src 'self'` with no 'unsafe-inline', so an inline script is
 * blocked outright — the theme would silently fall back and every load would
 * flash the wrong colours. Keeping it external satisfies the CSP without
 * weakening it, and without a build-time hash to keep in sync.
 *
 * It must stay synchronous and stay in <head>, before the stylesheet paints.
 */
;(function () {
  try {
    var stored = localStorage.getItem('athar-theme') || 'system'
    var dark =
      stored === 'dark' ||
      (stored === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  } catch (e) {
    // localStorage can throw in private-browsing modes; light is the default.
    document.documentElement.setAttribute('data-theme', 'light')
  }
})()
