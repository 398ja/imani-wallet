import { describe, it, expect } from 'vitest'

import {
  parseIssueRequest,
  issueBody,
  issueUrl,
  parseDeliverRequest,
  deliverBody,
  deliverUrl,
} from '../issue.js'

/**
 * Issuing a coupon, and handing it over.
 *
 * Two properties are worth being absolute about, and both are about a key
 * appearing where it should not:
 *
 *   - a coupon names the SIGNING key as issuer. One claiming another stall
 *     would be a claim that stall never agreed to, discovered by the customer,
 *     at the counter.
 *   - a delivered coupon names the STALL as sender. A customer must be able to
 *     look up who honours it, not hold a coupon from a till that may not exist
 *     next week.
 */

const CALLER = 'c'.repeat(64)
const OTHER = 'b'.repeat(64)
const CUSTOMER = 'd'.repeat(64)

describe('what to sign to mint', () => {
  const parse = (over: Record<string, unknown> = {}) =>
    parseIssueRequest({ faceValue: 1500, faceUnit: 'EUR', faceDecimals: 2, ...over }, CALLER)

  it('accepts a face value and a currency', () => {
    const r = parse()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.issuerId).toBe(CALLER)
  })

  it('reads snake_case too, since that is what the gateway speaks', () => {
    const r = parseIssueRequest({ face_value: 1500, face_unit: 'EUR' }, CALLER)
    expect(r.ok).toBe(true)
  })

  for (const field of ['issuerId', 'issuer_id', 'stallPubkey']) {
    it(`REFUSES minting in another stall's name via \`${field}\``, () => {
      const r = parse({ [field]: OTHER })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error.field).toBe(field)
        expect(r.error.detail).toMatch(/could not be honoured/)
      }
    })
  }

  it('allows a caller to name ITSELF, which is not a claim on anyone else', () => {
    expect(parse({ issuerId: CALLER }).ok).toBe(true)
  })

  it('refuses a face value of zero or less', () => {
    expect(parse({ faceValue: 0 }).ok).toBe(false)
    expect(parse({ faceValue: -1 }).ok).toBe(false)
  })

  it('refuses a fractional minor unit rather than rounding it', () => {
    // A fraction means cents were wanted and euros were sent. Rounding would
    // issue a coupon for the wrong money.
    const r = parse({ faceValue: 15.5 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.field).toBe('faceValue')
  })

  it('requires a currency', () => {
    expect(parse({ faceUnit: undefined }).ok).toBe(false)
  })

  it('defaults the expiry to a month', () => {
    const r = parse()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.expiresInDays).toBe(30)
  })
})

describe('the body it tells a caller to sign', () => {
  const body = () => {
    const r = parseIssueRequest({ faceValue: 1500, faceUnit: 'EUR', faceDecimals: 2, memo: ' hi ' }, CALLER)
    if (!r.ok) throw new Error('setup failed')
    return JSON.parse(issueBody(r.value)) as Record<string, unknown>
  }

  it('speaks the gateway\u2019s snake_case', () => {
    expect(body()).toMatchObject({ face_value: 1500, face_unit: 'EUR', face_decimals: 2 })
  })

  it('names the caller as issuer', () => {
    expect(body().issuer_id).toBe(CALLER)
  })

  it('is stable, so a signature over it stays valid', () => {
    // NIP-98 commits to a sha256 of these bytes. If the same plan serialised
    // two ways, a caller could sign one and send the other.
    const r = parseIssueRequest({ faceValue: 1500, faceUnit: 'EUR' }, CALLER)
    if (!r.ok) throw new Error('setup failed')
    expect(issueBody(r.value)).toBe(issueBody(r.value))
  })

  it('points at the wallet path, not the portal one', () => {
    // The portal path needs a session cookie no headless caller can hold: it
    // answers 500 for a NIP-98 signature that the wallet path accepts with 201.
    expect(issueUrl()).toMatch(/\/api\/v1\/wallet\/vouchers$/)
    expect(issueUrl()).not.toMatch(/portal/)
  })
})

describe('what to sign to deliver', () => {
  const parse = (over: Record<string, unknown> = {}) =>
    parseDeliverRequest(
      {
        recipientPubkey: CUSTOMER,
        token: 'cashuBabc',
        voucherId: 'v-1',
        faceValue: 1500,
        faceUnit: 'EUR',
        faceDecimals: 2,
        ...over,
      },
      CALLER,
    )

  it('accepts a recipient, a token and a voucher id', () => {
    expect(parse().ok).toBe(true)
  })

  it('REQUIRES the voucher id, because it is how a lost coupon is found', () => {
    // The whole reason issuance and delivery are two calls: a coupon can be
    // minted and undelivered, and that is only recoverable if the caller knows
    // which coupon.
    const r = parse({ voucherId: undefined })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.detail).toMatch(/undelivered coupon is found/)
  })

  it('refuses a recipient that is not a pubkey', () => {
    const r = parse({ recipientPubkey: 'someone@example.com' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.field).toBe('recipientPubkey')
  })

  for (const field of ['senderPubkey', 'sender_pubkey', 'issuerId', 'issuer_id']) {
    it(`REFUSES naming another stall as sender via \`${field}\``, () => {
      const r = parse({ [field]: OTHER })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.field).toBe(field)
    })
  }
})

describe('the delivery body', () => {
  const body = (over: Record<string, unknown> = {}) => {
    const r = parseDeliverRequest(
      {
        recipientPubkey: CUSTOMER,
        token: 'cashuBabc',
        voucherId: 'v-1',
        faceValue: 1500,
        faceUnit: 'EUR',
        faceDecimals: 2,
        ...over,
      },
      CALLER,
    )
    if (!r.ok) throw new Error(`${r.error.field}: ${r.error.detail}`)
    return JSON.parse(deliverBody(r.value, ['ws://relay:7777'])) as Record<string, unknown>
  }

  it('names the STALL as both issuer and sender', () => {
    // A terminal's own key never appears on a coupon.
    expect(body().issuer_id).toBe(CALLER)
    expect(body().sender_pubkey).toBe(CALLER)
  })

  it('addresses the customer', () => {
    expect(body().recipient_pubkey).toBe(CUSTOMER)
  })

  it('carries the relay the GATEWAY can reach', () => {
    // Not the browser's. The gateway publishes from inside the compose network,
    // where `localhost` is its own container.
    expect(body().relay_urls).toEqual(['ws://relay:7777'])
  })

  it('passes the expiry through in SECONDS', () => {
    // The gateway forwards whatever the sender supplies, so omitting it leaves
    // the received coupon with a blank expiry — and milliseconds would date it
    // fifty thousand years out.
    expect(body({ expiresAt: 1_800_000_000 }).expires_at).toBe(1_800_000_000)
  })

  it('goes to the DM endpoint on the same host as issuance', () => {
    expect(deliverUrl()).toMatch(/\/api\/v1\/dm\/tokens\/send$/)
    expect(new URL(deliverUrl()).host).toBe(new URL(issueUrl()).host)
  })
})
