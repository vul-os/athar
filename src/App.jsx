import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, SESSION_EXPIRED } from './api.js'
import Login from './components/Login.jsx'
import Logo from './components/Logo.jsx'
import Overview from './components/Overview.jsx'
import AddWebsite, { Snippet } from './components/AddWebsite.jsx'
import ThemeToggle from './components/ThemeToggle.jsx'
import { RANGES, count, rangeFor } from './lib/format.js'

export default function App() {
  const [boot, setBoot] = useState({ state: 'loading' })
  const [user, setUser] = useState(null)
  const [websites, setWebsites] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [rangeKey, setRangeKey] = useState('24h')

  // The absolute {from,to} window is derived from the named range, and memoised
  // so its identity is stable. A fresh object on every render would re-fire
  // every data effect downstream, in a loop.
  const range = useMemo(() => rangeFor(rangeKey), [rangeKey])

  const loadWebsites = useCallback(async () => {
    const sites = await api.websites()
    setWebsites(sites)
    setSelectedId((current) => current ?? sites[0]?.id ?? null)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const status = await api.authStatus()
        if (cancelled) return

        if (status.authenticated) {
          const me = await api.me()
          if (cancelled) return
          setUser(me)
          await loadWebsites()
          if (!cancelled) setBoot({ state: 'ready' })
        } else {
          setBoot({ state: 'signed-out', needsSetup: status.needs_setup })
        }
      } catch (err) {
        if (!cancelled) setBoot({ state: 'error', message: err.message })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loadWebsites])

  // A 401 from anywhere means the session ended; drop straight back to sign-in
  // rather than leaving a dashboard on screen that can no longer load anything.
  useEffect(() => {
    const onExpired = () => {
      setUser(null)
      setWebsites([])
      setBoot({ state: 'signed-out', needsSetup: false })
    }
    window.addEventListener(SESSION_EXPIRED, onExpired)
    return () => window.removeEventListener(SESSION_EXPIRED, onExpired)
  }, [])

  async function handleSignedIn(signedInUser) {
    setUser(signedInUser)
    await loadWebsites()
    setBoot({ state: 'ready' })
  }

  async function handleSignOut() {
    await api.logout().catch(() => {})
    setUser(null)
    setWebsites([])
    setSelectedId(null)
    setBoot({ state: 'signed-out', needsSetup: false })
  }

  if (boot.state === 'loading') {
    return <div className="grid min-h-dvh place-items-center text-sm text-ink-faint">Loading…</div>
  }
  if (boot.state === 'error') {
    return (
      <div className="grid min-h-dvh place-items-center px-6 text-center">
        <div>
          <p className="text-sm text-negative">Could not reach the Athar server.</p>
          <p className="mt-1 text-xs text-ink-faint">{boot.message}</p>
        </div>
      </div>
    )
  }
  if (boot.state === 'signed-out') {
    return <Login needsSetup={boot.needsSetup} onSignedIn={handleSignedIn} />
  }

  const selected = websites.find((w) => w.id === selectedId) ?? null

  return (
    <div className="min-h-dvh">
      <Header
        user={user}
        websites={websites}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onSignOut={handleSignOut}
        rangeKey={rangeKey}
        onRangeChange={setRangeKey}
        websiteId={selected?.id}
      />

      <main className="mx-auto max-w-6xl px-4 py-6 md:px-6">
        {websites.length === 0 ? (
          <AddWebsite
            onCreated={(site) => {
              setWebsites([site])
              setSelectedId(site.id)
            }}
          />
        ) : selected ? (
          <div className="space-y-4">
            <Overview website={selected} range={range} />
            <Snippet website={selected} />
          </div>
        ) : null}
      </main>

      <footer className="mx-auto max-w-6xl px-4 pb-8 text-xs text-ink-faint md:px-6">
        Athar · your data, on your machine ·{' '}
        <a
          href="https://github.com/vul-os/athar"
          target="_blank"
          rel="noopener noreferrer"
          className="underline-offset-2 hover:text-ink-muted hover:underline"
        >
          source
        </a>
      </footer>
    </div>
  )
}

function Header({ user, websites, selectedId, onSelect, onSignOut, rangeKey, onRangeChange, websiteId }) {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3 md:px-6">
        <Logo className="h-7 w-7 shrink-0" />

        {websites.length > 0 && (
          <select
            value={selectedId ?? ''}
            onChange={(e) => onSelect(e.target.value)}
            className="max-w-[14rem] rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
          >
            {websites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        )}

        {websiteId && <ActiveVisitors websiteId={websiteId} />}

        <div className="ml-auto flex items-center gap-2">
          <div className="flex gap-0.5 rounded-md bg-raised p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => onRangeChange(r.key)}
                className={`rounded px-2 py-1 text-xs transition ${
                  r.key === rangeKey ? 'bg-line text-ink' : 'text-ink-faint hover:text-ink-muted'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          <ThemeToggle />

          <button
            onClick={onSignOut}
            title={`Signed in as ${user.username}`}
            className="rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-muted transition hover:border-accent hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  )
}

/** The realtime readout, polled while the tab is visible. */
function ActiveVisitors({ websiteId }) {
  const [active, setActive] = useState(null)

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      // Polling a hidden tab is pure waste — and on a phone it is battery the
      // dashboard has no business spending.
      if (document.visibilityState !== 'visible') return
      try {
        const res = await api.active(websiteId)
        if (!cancelled) setActive(res.active)
      } catch {
        // Transient failures are not worth surfacing on a realtime badge.
      }
    }

    poll()
    const timer = setInterval(poll, 15_000)
    document.addEventListener('visibilitychange', poll)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [websiteId])

  if (active === null) return null

  return (
    <span className="flex items-center gap-1.5 text-xs text-ink-muted" title="Visitors in the last 5 minutes">
      <span className={`h-1.5 w-1.5 rounded-full ${active > 0 ? 'bg-positive' : 'bg-ink-faint'}`} />
      <span className="tnum">{count(active)}</span> now
    </span>
  )
}
