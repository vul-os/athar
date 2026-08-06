/**
 * Resolves the theme before first paint.
 *
 * A separate, non-module, synchronous <script src> rather than an inline
 * <script> or a type="module" one: Athar serves `script-src 'self'` with no
 * 'unsafe-inline', so an inline script is blocked outright, and a module
 * script is deferred by default — either would let the page paint once in
 * the wrong colours before this ran. Keeping it external, classic, and in
 * <head> satisfies the CSP without weakening it and runs before the
 * stylesheet paints anything.
 *
 * Same localStorage key ('athar-theme') the rest of the dashboard uses, so
 * this and theme.js can never disagree about which key holds the preference.
 */
;(function () {
  try {
    var stored = localStorage.getItem('athar-theme') || 'system'
    var dark =
      stored === 'dark' ||
      (stored === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  } catch {
    // localStorage can throw in private-browsing modes; light is the default.
    document.documentElement.setAttribute('data-theme', 'light')
  }
})()
