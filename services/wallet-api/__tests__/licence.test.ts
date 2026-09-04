import { describe, it, expect, afterEach } from 'vitest'

import { parseLicenceRequest, checkLicence, licenceIssuerPubkey } from '../licence.js'

/**
 * Checking a licence, over HTTP and entirely offline.
 *
 * ADR 0007 decides a licence is a voucher we sold, verified locally: no licence
 * server, no phone-home, no honeypot of who-runs-what. So the tests that matter
 * are about what this endpoint REFUSES to become — it must not look anything up,
 * and it must not grant on anything a caller merely asserts.
 */

const CALLER = 'c'.repeat(64)
const OTHER = 'b'.repeat(64)
const NOW = 1_800_000_000

describe('the issuer key', () => {
  const saved = process.env.WALLET_API_LICENCE_ISSUER_PUBKEY

  afterEach(() => {
    if (saved === undefined) delete process.env.WALLET_API_LICENCE_ISSUER_PUBKEY
    else process.env.WALLET_API_LICENCE_ISSUER_PUBKEY = saved
  })

  it('has NO default', () => {
    // A default would be a licence check that passes for a voucher anyone
    // minted — the one failure the licence package exists to prevent, and it
    // refuses to default for the same reason.
    delete process.env.WALLET_API_LICENCE_ISSUER_PUBKEY
    expect(licenceIssuerPubkey()).toBeNull()
  })

  it('refuses a value that is not a pubkey rather than using it', () => {
    process.env.WALLET_API_LICENCE_ISSUER_PUBKEY = 'not-a-key'
    expect(licenceIssuerPubkey()).toBeNull()
  })

  it('accepts a real one, case-insensitively', () => {
    process.env.WALLET_API_LICENCE_ISSUER_PUBKEY = 'A'.repeat(64)
    expect(licenceIssuerPubkey()).toBe('a'.repeat(64))
  })
})

describe('reading the request', () => {
  const parse = (over: Record<string, unknown> = {}) =>
    parseLicenceRequest({ token: 'cashuBabc', ...over }, CALLER, NOW)

  it('requires a token', () => {
    const r = parseLicenceRequest({}, CALLER, NOW)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.field).toBe('token')
  })

  it('checks against the SIGNING key, not a presenter in the body', () => {
    // A licence is locked to a key and the holder must prove they have it. Over
    // HTTP the signature IS that proof, so reading a presenter from the body
    // would let anyone pass with a licence they merely copied.
    const r = parse({ presenter: OTHER })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.field).toBe('presenter')
  })

  it('allows a caller to name itself', () => {
    expect(parse({ presenter: CALLER }).ok).toBe(true)
  })

  it('takes a clock from the caller, so expiry is testable', () => {
    const r = parse({ now: 123 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.now).toBe(123)
  })

  it('requires the grant on a last verification, not a bare yes', () => {
    // The window carries the GRANT it last saw, so a device coming out of an
    // outage keeps the features it was entitled to rather than a blanket yes.
    const r = parse({ lastVerification: { at: NOW - 60, granted: true } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.field).toBe('lastVerification.grant')
  })

  it('accepts a well-formed last verification', () => {
    const r = parse({
      lastVerification: { at: NOW - 60, grant: { features: ['terminals'], expiresAt: NOW + 60, pilot: false } },
    })
    expect(r.ok).toBe(true)
  })
})

describe('checking a licence', () => {
  const ISSUER = 'a'.repeat(64)

  const check = (over: Record<string, unknown> = {}) => {
    const parsed = parseLicenceRequest({ token: 'cashuBnonsense', ...over }, CALLER, NOW)
    if (!parsed.ok) throw new Error(`${parsed.error.field}: ${parsed.error.detail}`)
    return checkLicence(parsed.value, ISSUER)
  }

  it('grants nothing for something that is not a voucher', () => {
    // Plain ecash takes this path legitimately, so it must be an answer rather
    // than a crash.
    const v = check()
    expect(v.granted).toBe(false)
    expect(v.reason).toBeTruthy()
  })

  it('grants nothing on an empty grace window', () => {
    // The window only carries a licence that WAS verified. Nothing plus nothing
    // is still nothing.
    expect(check({ lastVerification: undefined }).granted).toBe(false)
  })

  it('does not let a stale grace window rescue an answered refusal', () => {
    // The line the licence package draws: an EXPIRED voucher was ANSWERED, and
    // softening that would sell a month for free. The window is for an outage.
    const v = check({
      lastVerification: {
        at: NOW - 10,
        grant: { features: ['terminals'], expiresAt: NOW + 10_000, pilot: false },
      },
    })
    expect(v.granted).toBe(false)
  })

  it('reports no features when it grants nothing', () => {
    // Absent, not an empty list presented as a grant.
    expect(check().features).toBeUndefined()
  })

  it('never reports a licence as spendable value', () => {
    // A licence carries a face value like any voucher. Reporting it as a
    // balance is how a subscription becomes money.
    expect(JSON.stringify(check())).not.toMatch(/balance|spendable/i)
  })
})
