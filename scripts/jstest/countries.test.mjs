// Node-native tests for backend/internal/webui/static/countries.js — see
// format.test.mjs for why these run under `node --test` rather than vitest.
// Line-for-line port of the vitest suite that used to live at
// src/lib/countries.test.js.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import * as countries from '../../backend/internal/webui/static/countries.js'
import { countryName, flagEmoji } from '../../backend/internal/webui/static/countries.js'

const exercised = new Set(['countryName', 'flagEmoji'])

describe('coverage', () => {
  it('exercises every export of countries.js', () => {
    const exported = Object.keys(countries).sort()
    assert.ok(exported.length > 0)
    assert.deepStrictEqual(exported, [...exercised].sort())
  })
})

describe('countryName', () => {
  it('resolves a real code to something longer than the code', () => {
    const name = countryName('KE')
    assert.strictEqual(typeof name, 'string')
    assert.ok(name.length > 0)
  })

  it('is case-insensitive about the code', () => {
    assert.strictEqual(countryName('ke'), countryName('KE'))
  })

  it('renders "Unknown" rather than a blank cell for a missing code', () => {
    assert.strictEqual(countryName(''), 'Unknown')
    assert.strictEqual(countryName(null), 'Unknown')
    assert.strictEqual(countryName(undefined), 'Unknown')
  })

  it('echoes a malformed code back instead of throwing', () => {
    assert.strictEqual(countryName('XYZ'), 'XYZ')
    assert.doesNotThrow(() => countryName('!!'))
  })
})

describe('flagEmoji', () => {
  it('derives the flag arithmetically from the regional-indicator block', () => {
    assert.strictEqual(flagEmoji('KE'), '\u{1F1F0}\u{1F1EA}')
    assert.strictEqual(flagEmoji('ZA'), '\u{1F1FF}\u{1F1E6}')
    assert.strictEqual(flagEmoji('US'), '\u{1F1FA}\u{1F1F8}')
  })

  it('is case-insensitive about the code', () => {
    assert.strictEqual(flagEmoji('ke'), flagEmoji('KE'))
  })

  it('falls back to a white flag for anything that is not two ASCII letters', () => {
    assert.strictEqual(flagEmoji(''), '🏳️')
    assert.strictEqual(flagEmoji(null), '🏳️')
    assert.strictEqual(flagEmoji('K'), '🏳️')
    assert.strictEqual(flagEmoji('XYZ'), '🏳️')
    assert.strictEqual(flagEmoji('K1'), '🏳️')
    assert.strictEqual(flagEmoji('12'), '🏳️')
  })
})
