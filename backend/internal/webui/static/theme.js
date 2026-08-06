/**
 * Theme state: 'light', 'dark', or 'system'. Vanilla port of the former
 * src/lib/theme.js + ThemeProvider.jsx — same localStorage key
 * ('athar-theme'), same three-way preference, so an existing operator's
 * choice survives the rewrite untouched.
 *
 * 'system' is a first-class stored value rather than a one-time resolution to
 * light or dark: someone whose OS flips at sunset expects the dashboard to
 * follow.
 */

/** @typedef {'light' | 'dark' | 'system'} Preference */
/** @typedef {'light' | 'dark'} Resolved */

export const STORAGE_KEY = 'athar-theme'

/**
 * Reads the stored preference, tolerating a missing or blocked localStorage.
 * @returns {Preference}
 */
export function storedPreference() {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    // Private-browsing modes can throw on access; the default is fine.
  }
  return 'system'
}

/** @param {Preference} preference */
export function persistPreference(preference) {
  try {
    localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // Not being able to persist is not worth failing over.
  }
}

function darkQuery() {
  return window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
}

/** @returns {Resolved} */
function systemTheme() {
  const q = darkQuery()
  return q && q.matches ? 'dark' : 'light'
}

/**
 * Resolves a preference plus the current system theme to the applied theme.
 * @param {Preference} preference
 * @param {Resolved} system
 * @returns {Resolved}
 */
export function resolveTheme(preference, system) {
  return preference === 'system' ? system : preference
}

/**
 * Owns the theme preference, keeps <html data-theme> and the
 * theme-color meta tag in step with it, and persists changes.
 *
 * theme-init.js (loaded synchronously in <head>, before this module) already
 * set the correct initial attribute so first paint never flashes the wrong
 * colours; this only needs to keep it in sync afterward — the OS preference
 * can change live, and the toggle button can cycle it.
 */
export function createThemeController() {
  let preference = storedPreference()
  /** @type {Set<(resolved: Resolved, preference: Preference) => void>} */
  const listeners = new Set()

  function apply() {
    const resolved = resolveTheme(preference, systemTheme())
    document.documentElement.setAttribute('data-theme', resolved)
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#09090B' : '#FBFAF9')
    for (const fn of listeners) fn(resolved, preference)
    return resolved
  }

  const query = darkQuery()
  if (query) {
    const onChange = () => {
      if (preference === 'system') apply()
    }
    query.addEventListener('change', onChange)
  }

  apply()

  return {
    get preference() {
      return preference
    },
    get resolved() {
      return resolveTheme(preference, systemTheme())
    },
    /** Cycles light -> dark -> system, as the toggle button does. */
    cycle() {
      preference = preference === 'light' ? 'dark' : preference === 'dark' ? 'system' : 'light'
      persistPreference(preference)
      apply()
    },
    /**
     * Subscribes to every resolved-theme change; returns an unsubscribe fn.
     * @param {(resolved: Resolved, preference: Preference) => void} fn
     * @returns {() => void}
     */
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
