import { useState } from 'react'
import { api } from '../api.js'

/** First-run empty state: create a website and get the snippet for it. */
export default function AddWebsite({ onCreated }) {
  const [name, setName] = useState('')
  const [domain, setDomain] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      onCreated(await api.createWebsite(name, domain))
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="reveal mx-auto max-w-md rounded-lg border border-line bg-surface p-6">
      <h2 className="text-lg font-semibold tracking-tight">Add your first website</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Athar starts collecting as soon as the script is on the page.
      </p>

      <form onSubmit={submit} className="mt-5 space-y-3">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium tracking-wide text-ink-muted uppercase">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My site"
            required
            autoFocus
            className="w-full rounded-md border border-line bg-raised px-3 py-2.5 text-sm outline-none transition placeholder:text-ink-faint focus:border-accent"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium tracking-wide text-ink-muted uppercase">Domain</span>
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="example.com"
            required
            className="w-full rounded-md border border-line bg-raised px-3 py-2.5 text-sm outline-none transition placeholder:text-ink-faint focus:border-accent"
          />
        </label>

        {error && <p className="text-sm text-negative">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-canvas transition hover:bg-accent/90 disabled:opacity-40"
        >
          {busy ? 'Creating…' : 'Create website'}
        </button>
      </form>
    </div>
  )
}

/** The script tag for a website, with a copy button. */
export function Snippet({ website }) {
  const [copied, setCopied] = useState(false)

  const tag = `<script defer src="${window.location.origin}/athar.js" data-website-id="${website.id}"></script>`

  async function copy() {
    try {
      await navigator.clipboard.writeText(tag)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard access can be denied; the snippet is selectable regardless.
    }
  }

  return (
    <div className="rounded-lg border border-line bg-surface">
      <header className="flex items-center justify-between border-b border-line-soft px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight">Tracking snippet</h2>
        <button
          onClick={copy}
          className="rounded-md border border-line bg-raised px-2.5 py-1 text-xs text-ink-muted transition hover:border-accent hover:text-ink"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </header>
      <div className="overflow-x-auto px-4 py-3">
        <code className="font-mono text-xs whitespace-pre text-ink-muted">{tag}</code>
      </div>
      <p className="border-t border-line-soft px-4 py-3 text-xs text-ink-faint">
        Add <code className="font-mono text-ink-muted">data-heatmap="true"</code> to collect click,
        scroll and attention heatmaps.
      </p>
    </div>
  )
}
