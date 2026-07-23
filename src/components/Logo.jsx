/**
 * The Athar mark: three offset rings, densest at the point of contact and
 * fading outward — a trace spreading from where something landed. أثر means
 * both "trace" and "impact", and the mark is meant to read as either.
 */
export default function Logo({ className = 'h-8 w-8' }) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="Athar">
      <rect width="32" height="32" rx="8" fill="#141417" />
      <circle cx="16" cy="16" r="3" fill="var(--color-accent, #e9a23b)" />
      <circle cx="16" cy="16" r="7" fill="none" stroke="var(--color-accent, #e9a23b)"
              strokeOpacity="0.55" strokeWidth="1.6" />
      <circle cx="16" cy="16" r="11" fill="none" stroke="var(--color-accent, #e9a23b)"
              strokeOpacity="0.22" strokeWidth="1.2" />
    </svg>
  )
}
