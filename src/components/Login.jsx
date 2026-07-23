import { useState } from 'react'
import { api, ApiError } from '../api.js'
import Logo from './Logo.jsx'

/**
 * The sign-in surface, which doubles as first-run setup.
 *
 * Which mode it is in comes from the server (`needs_setup`), not from a guess —
 * the server is the only thing that knows whether the instance has an account,
 * and the bootstrap endpoint re-checks it anyway.
 */
export default function Login({ needsSetup, onSignedIn }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError('')

    if (needsSetup && password !== confirm) {
      setError('Passwords do not match')
      return
    }

    setBusy(true)
    try {
      const user = needsSetup
        ? await api.bootstrap(username, password)
        : await api.login(username, password)
      onSignedIn(user)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong')
      setBusy(false)
    }
  }

  return (
    <div className="relative grid min-h-dvh place-items-center px-6">
      <div className="bg-grid pointer-events-none absolute inset-0" aria-hidden="true" />

      <div className="reveal relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo className="h-11 w-11" />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">Athar</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {needsSetup ? 'Create the first account on this instance' : 'Sign in to your dashboard'}
          </p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <Field
            label="Username"
            value={username}
            onChange={setUsername}
            autoComplete="username"
            autoFocus
          />
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete={needsSetup ? 'new-password' : 'current-password'}
            hint={needsSetup ? 'At least 12 characters' : undefined}
          />
          {needsSetup && (
            <Field
              label="Confirm password"
              type="password"
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
            />
          )}

          {error && (
            <p role="alert" className="rounded-md border border-negative/30 bg-negative/10 px-3 py-2 text-sm text-negative">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !username || !password}
            className="w-full rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-canvas transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Working…' : needsSetup ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <p className="mt-8 text-center text-xs leading-relaxed text-ink-faint">
          This instance stores its data on the machine it runs on.
          <br />
          Nothing here is sent anywhere else.
        </p>
      </div>
    </div>
  )
}

function Field({ label, value, onChange, type = 'text', hint, ...rest }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium tracking-wide text-ink-muted uppercase">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        className="w-full rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-accent"
        {...rest}
      />
      {hint && <span className="mt-1 block text-xs text-ink-faint">{hint}</span>}
    </label>
  )
}
