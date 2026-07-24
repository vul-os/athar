import { useTheme } from '../lib/theme.js'

/**
 * Cycles light → dark → system.
 *
 * The icon shows the *current* state rather than the next one. A button that
 * previews its own effect is a small puzzle every single time; a button that
 * reports state is readable at a glance, and the tooltip covers the rest.
 */
export default function ThemeToggle() {
  const { preference, cycle } = useTheme()

  const label =
    preference === 'light' ? 'Light' : preference === 'dark' ? 'Dark' : 'System'

  return (
    <button
      onClick={cycle}
      title={`Theme: ${label} — click to change`}
      aria-label={`Theme: ${label}. Click to change.`}
      className="grid h-8 w-8 place-items-center rounded-md border border-line text-ink-muted transition hover:border-accent hover:text-ink"
    >
      {preference === 'light' && <SunIcon />}
      {preference === 'dark' && <MoonIcon />}
      {preference === 'system' && <SystemIcon />}
    </button>
  )
}

const strokeProps = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
}

function SunIcon() {
  return (
    <svg {...strokeProps}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg {...strokeProps}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  )
}

function SystemIcon() {
  return (
    <svg {...strokeProps}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  )
}
