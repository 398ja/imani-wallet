import { describe, it, expect } from 'vitest'

import {
  parseGenerateRequest,
  generateBody,
  generateUrl,
  parseLookupRequest,
  byCodeUrl,
  publicUrl,
} from '../cashback.js'

/**
 * Cashback.
 *
 * The endpoints are couriers, so what these test is the parsing — and most of
 * it exists to refuse things the PORTAL would answer badly. Its idempotency key
 * is a `java.util.UUID`, and anything else comes back as a 500 with a stack
 * trace about string length, from a host the caller never addressed directly.
 */

describe('generating cashback', () => {
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
  const parse = (over: Record<string, unknown> = {}) =>
    parseGenerateRequest({ amountMinor: 500, unit: 'EUR', idempotencyKey: uuid, ...over })

  it('accepts an amount, a currency and a key', () => {
    expect(parse().ok).toBe(true)
  })

  it('REQUIRES an idempotency key rather than inventing one', () => {
    // A key this service generated would differ on every retry, which is the
    // opposite of what it is for: the caller must be able to repeat a request
    // that may already have succeeded, without generating a second cashback.
    const r = parse({ idempotencyKey: undefined })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.field).toBe('idempotencyKey')
      expect(r.error.detail).toMatch(/repeat/)
    }
  })

  it('refuses one that is not a UUID, before the portal 500s on it', () => {
    const r = parse({ idempotencyKey: 'probe-1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.detail).toMatch(/36-character/)
  })

  it('refuses an amount of zero or less', () => {
    expect(parse({ amountMinor: 0 }).ok).toBe(false)
    expect(parse({ amountMinor: -100 }).ok).toBe(false)
  })

  it('refuses a fractional minor unit rather than rounding it', () => {
    expect(parse({ amountMinor: 5.5 }).ok).toBe(false)
  })

  it('refuses a unit longer than the portal accepts', () => {
    // `@Size(max = 8)` there. Caught here, where the message is about the field
    // the caller sent rather than a validation envelope.
    expect(parse({ unit: 'TOOLONGUNIT' }).ok).toBe(false)
  })

  it('refuses a memo longer than the portal accepts', () => {
    expect(parse({ memo: 'x'.repeat(281) }).ok).toBe(false)
    expect(parse({ memo: 'x'.repeat(280) }).ok).toBe(true)
  })

  it('refuses an expiry of zero days', () => {
    expect(parse({ expiryDays: 0 }).ok).toBe(false)
    expect(parse({ expiryDays: 30 }).ok).toBe(true)
  })
})

describe('the body it tells a caller to sign', () => {
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
  const body = (over: Record<string, unknown> = {}) => {
    const r = parseGenerateRequest({ amountMinor: 500, unit: 'EUR', idempotencyKey: uuid, ...over })
    if (!r.ok) throw new Error(`${r.error.field}: ${r.error.detail}`)
    return JSON.parse(generateBody(r.value)) as Record<string, unknown>
  }

  it('carries the portal\u2019s field names', () => {
    expect(body()).toMatchObject({ amountMinor: 500, unit: 'EUR', idempotencyKey: uuid })
  })

  it('omits an absent memo rather than sending null', () => {
    // An explicit null is one more thing that has to match byte for byte on a
    // retry, and NIP-98 commits to a hash of these bytes.
    expect('memo' in body()).toBe(false)
    expect(body({ memo: 'thanks' }).memo).toBe('thanks')
  })

  it('is stable, so a signature over it stays valid', () => {
    const r = parseGenerateRequest({ amountMinor: 500, unit: 'EUR', idempotencyKey: uuid })
    if (!r.ok) throw new Error('setup failed')
    expect(generateBody(r.value)).toBe(generateBody(r.value))
  })

  it('goes to the PORTAL, not gateway-core', () => {
    // gateway-core's `/api/v1/cashback/generate` answers `API key required`,
    // and probing THAT is what made this ticket look blocked on an auth model.
    expect(generateUrl()).toMatch(/\/api\/v1\/portal\/cashback\/generate$/)
  })
})

describe('looking a code up', () => {
  it('accepts a canonical code', () => {
    expect(parseLookupRequest({ code: 'CB-ABCD-EF' }).ok).toBe(true)
  })

  it('accepts a lowercase one, because a person typed it off a receipt', () => {
    // The portal canonicalises. Refusing here would reject something that works.
    expect(parseLookupRequest({ code: 'cb-abcd-ef' }).ok).toBe(true)
  })

  it('requires a code', () => {
    const r = parseLookupRequest({})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.field).toBe('code')
  })

  it('refuses something that could not be a code', () => {
    expect(parseLookupRequest({ code: 'no spaces' }).ok).toBe(false)
    expect(parseLookupRequest({ code: 'ab' }).ok).toBe(false)
  })

  it('escapes the code into the URL', () => {
    // It reaches a path segment, and a caller typing a slash should not be able
    // to address a different endpoint.
    expect(byCodeUrl('a/b')).toMatch(/by-code\/a%2Fb$/)
  })

  it('points at the by-code and public read paths', () => {
    expect(byCodeUrl('CB-ABCD-EF')).toMatch(/\/api\/v1\/portal\/cashback\/by-code\//)
    expect(publicUrl('ref')).toMatch(/\/api\/v1\/portal\/cashback\/public\//)
  })
})
