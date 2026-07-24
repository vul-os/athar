import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ThemeContext,
  persistPreference,
  resolveTheme,
  storedPreference,
  useSystemTheme,
} from '../lib/theme.js'

/** Owns the theme preference and keeps the document in step with it. */
export default function ThemeProvider({ children }) {
  const [preference, setPreference] = useState(storedPreference)
  const systemTheme = useSystemTheme()

  // Derived, not stored: the applied theme is a pure function of the stored
  // preference and the live OS setting, so there is nothing to keep in sync.
  const resolved = resolveTheme(preference, systemTheme)

  // Writing to the document and to localStorage is genuine external-system
  // synchronisation, which is what an effect is for.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved)

    // Keep the address-bar / titlebar colour in step with the page.
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#09090B' : '#FBFAF9')
  }, [resolved])

  useEffect(() => {
    persistPreference(preference)
  }, [preference])

  const cycle = useCallback(() => {
    setPreference((current) =>
      current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light',
    )
  }, [])

  const value = useMemo(
    () => ({ preference, resolved, setPreference, cycle }),
    [preference, resolved, cycle],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
