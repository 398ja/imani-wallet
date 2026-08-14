import { describe, expect, it } from 'vitest'

import {
  MIN_PASSPHRASE,
  passphraseStrength,
  validateConfirmation,
  validateHandle,
  validatePassphrase,
  validateWebsite,
} from '../validate'

describe('validateHandle', () => {
  it('accepts lowercase letters, digits and underscores', () => {
    expect(validateHandle('alice')).toBeUndefined()
    expect(validateHandle('farm_stand_7')).toBeUndefined()
  })

  it('rejects the hyphen', () => {
    // Not a style choice. bottin's own form allows `-`, but the gateway's
    // POST /api/v1/nip05 validates ^[a-z0-9_]+$ and rejects it. Accepting one
    // here would fail only at the claim, after a key had been minted.
    expect(validateHandle('farm-stand')).toBeDefined()
  })

  it('rejects uppercase, spaces and punctuation', () => {
    expect(validateHandle('Alice')).toBeDefined()
    expect(validateHandle('farm stand')).toBeDefined()
    expect(validateHandle('alice@example.com')).toBeDefined()
  })

  it('rejects empty and over-long handles', () => {
    expect(validateHandle('')).toBeDefined()
    expect(validateHandle('   ')).toBeDefined()
    expect(validateHandle('a'.repeat(64))).toBeUndefined()
    expect(validateHandle('a'.repeat(65))).toBeDefined()
  })
})

describe('validatePassphrase', () => {
  it('enforces the minimum length', () => {
    expect(validatePassphrase('a'.repeat(MIN_PASSPHRASE - 1))).toBeDefined()
    expect(validatePassphrase('a'.repeat(MIN_PASSPHRASE))).toBeUndefined()
  })

  it('does not trim — spaces are legitimate passphrase characters', () => {
    expect(validatePassphrase('        ')).toBeUndefined()
  })
})

describe('validateConfirmation', () => {
  it('requires an exact match', () => {
    expect(validateConfirmation('market-day', 'market-day')).toBeUndefined()
    expect(validateConfirmation('market-day', 'market-Day')).toBeDefined()
    expect(validateConfirmation('market-day', 'market-day ')).toBeDefined()
  })
})

describe('validateWebsite', () => {
  it('treats empty as valid — the field is optional', () => {
    expect(validateWebsite('')).toBeUndefined()
    expect(validateWebsite('   ')).toBeUndefined()
  })

  it('accepts http and https', () => {
    expect(validateWebsite('https://example.com')).toBeUndefined()
    expect(validateWebsite('http://example.com/farm')).toBeUndefined()
  })

  it('rejects javascript: and other schemes', () => {
    // This value lands in an href. A scheme check is the guard, not decoration.
    expect(validateWebsite('javascript:alert(1)')).toBeDefined()
    expect(validateWebsite('data:text/html,<script>')).toBeDefined()
    expect(validateWebsite('ftp://example.com')).toBeDefined()
  })

  it('rejects text that is not a URL at all', () => {
    expect(validateWebsite('example.com')).toBeDefined()
  })
})

describe('passphraseStrength', () => {
  it('scores short passphrases weak', () => {
    expect(passphraseStrength('abc')).toBe('weak')
  })

  it('scores a long all-lowercase passphrase only fair', () => {
    // Documenting bottin's scoring, not endorsing it: length contributes at
    // most 2 of 5, so a 25-character passphrase scores below a short one with
    // mixed case, a digit and a symbol. That is backwards as security advice.
    // Kept for parity because the meter is advisory — nothing gates on it
    // beyond MIN_PASSPHRASE — and changing it silently would diverge the two
    // apps' UX. Revisit if the meter ever gates anything.
    expect(passphraseStrength('correcthorsebatterystaple')).toBe('fair')
  })

  it('reaches strong with length and variety', () => {
    expect(passphraseStrength('Market-Day-2026!')).toBe('strong')
  })

  it('never throws on an empty value', () => {
    expect(passphraseStrength('')).toBe('weak')
  })
})
