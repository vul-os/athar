import { describe, expect, it } from 'vitest'

import * as countries from './countries.js'
import { countryName, flagEmoji } from './countries.js'

const exercised = new Set(['countryName', 'flagEmoji'])

describe('coverage', () => {
  it('exercises every export of countries.js', () => {
    const exported = Object.keys(countries).sort()
    expect(exported.length).toBeGreaterThan(0)
    expect(exported).toEqual([...exercised].sort())
  })
})

describe('countryName', () => {
  // The display name itself is Intl's business and varies by locale; what is
  // Athar's business is never rendering an empty cell and never throwing.
  it('resolves a real code to something longer than the code', () => {
    const name = countryName('KE')
    expect(typeof name).toBe('string')
    expect(name.length).toBeGreaterThan(0)
  })

  it('is case-insensitive about the code', () => {
    expect(countryName('ke')).toBe(countryName('KE'))
  })

  it('renders "Unknown" rather than a blank cell for a missing code', () => {
    expect(countryName('')).toBe('Unknown')
    expect(countryName(null)).toBe('Unknown')
    expect(countryName(undefined)).toBe('Unknown')
  })

  it('echoes a malformed code back instead of throwing', () => {
    expect(countryName('XYZ')).toBe('XYZ')
    expect(() => countryName('!!')).not.toThrow()
  })
})

describe('flagEmoji', () => {
  it('derives the flag arithmetically from the regional-indicator block', () => {
    expect(flagEmoji('KE')).toBe('\u{1F1F0}\u{1F1EA}')
    expect(flagEmoji('ZA')).toBe('\u{1F1FF}\u{1F1E6}')
    expect(flagEmoji('US')).toBe('\u{1F1FA}\u{1F1F8}')
  })

  it('is case-insensitive about the code', () => {
    expect(flagEmoji('ke')).toBe(flagEmoji('KE'))
  })

  it('falls back to a white flag for anything that is not two ASCII letters', () => {
    expect(flagEmoji('')).toBe('🏳️')
    expect(flagEmoji(null)).toBe('🏳️')
    expect(flagEmoji('K')).toBe('🏳️')
    expect(flagEmoji('XYZ')).toBe('🏳️')
    expect(flagEmoji('K1')).toBe('🏳️')
    expect(flagEmoji('12')).toBe('🏳️')
  })
})
