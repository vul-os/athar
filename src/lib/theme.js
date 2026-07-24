import { createContext, useContext, useSyncExternalStore } from 'react'

/**
 * Theme state: 'light', 'dark', or 'system'.
 *
 * 'system' is a first-class stored value rather than a one-time resolution to
 * light or dark. Someone whose OS flips at sunset expects the dashboard to
 * follow; collapsing their choice to whichever theme happened to be active when
 * they picked it silently breaks that.
 */
export const STORAGE_KEY = 'athar-theme'

export const ThemeContext = createContext(null)

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used inside a ThemeProvider')
  return context
}

/** Reads the stored preference, tolerating a missing or blocked localStorage. */
export function storedPreference() {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    // Private-browsing modes can throw on access; the default is fine.
  }
  return 'system'
}

export function persistPreference(preference) {
  try {
    localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // Not being able to persist is not worth failing over.
  }
}

const darkQuery = () => window.matchMedia?.('(prefers-color-scheme: dark)') ?? null

/**
 * Subscribes to the OS colour-scheme preference.
 *
 * useSyncExternalStore rather than an effect that calls setState: matchMedia is
 * exactly the "external store" this hook exists for. Mirroring it into state
 * means a render where React's value and the OS disagree, and an extra cascading
 * render every time it changes.
 */
export function useSystemTheme() {
  return useSyncExternalStore(
    (onChange) => {
      const query = darkQuery()
      query?.addEventListener('change', onChange)
      return () => query?.removeEventListener('change', onChange)
    },
    () => (darkQuery()?.matches ? 'dark' : 'light'),
    () => 'light', // server/prerender fallback
  )
}

/** Resolves a preference plus the current system theme to the applied theme. */
export function resolveTheme(preference, systemTheme) {
  return preference === 'system' ? systemTheme : preference
}
