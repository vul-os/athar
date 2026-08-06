/**
 * Country display helpers.
 *
 * Names come from Intl.DisplayNames, so they are localised by the browser and
 * there is no 250-row lookup table to carry in the bundle or keep current.
 * Flags are derived arithmetically from the country code rather than shipped as
 * images: the regional-indicator block sits at a fixed offset from ASCII, so
 * "KE" maps to 🇰🇪 with two character-code additions and no asset request.
 */

/** @type {Intl.DisplayNames | null} */
let displayNames = null
try {
  displayNames = new Intl.DisplayNames(undefined, { type: 'region' })
} catch {
  // Intl.DisplayNames is very widely supported; if it is missing we fall back
  // to showing the raw code, which is still meaningful.
}

/**
 * Turns an ISO 3166-1 alpha-2 code into a readable country name.
 * @param {string | null | undefined} code
 * @returns {string}
 */
export function countryName(code) {
  if (!code || code.length !== 2) return code || 'Unknown'
  try {
    return displayNames?.of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}

/**
 * Turns an ISO 3166-1 alpha-2 code into its flag emoji.
 * @param {string | null | undefined} code
 * @returns {string}
 */
export function flagEmoji(code) {
  if (!code || code.length !== 2) return '🏳️'

  const upper = code.toUpperCase()
  if (!/^[A-Z]{2}$/.test(upper)) return '🏳️'

  // 0x1F1E6 is REGIONAL INDICATOR SYMBOL LETTER A; 0x41 is ASCII 'A'.
  const offset = 0x1f1e6 - 0x41
  return String.fromCodePoint(upper.charCodeAt(0) + offset, upper.charCodeAt(1) + offset)
}
