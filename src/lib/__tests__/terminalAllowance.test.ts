/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VoucherRow } from '@imani/wallet-storage'

import {
  ENROL_REFUSAL,
  FREE_TERMINALS,
  mayEnrol,
  remainingTerminals,
} from '../terminalAllowance'
import { forgetVerification, licenceStatus } from '../licenceStatus'
import { forgetLicenceParses } from '../licences'
import { parseVoucherToken } from '../voucherToken'

/**
 * The free-terminal rule, on a REAL licence.
 *
 * Run against the token a running gateway actually minted rather than a
 * fixture this app signed for itself, because the rule's whole input is
 * "does the licence grant terminals", and that answer travels through the
 * signed metadata, the verifier and the grace window before it gets here.
 *
 * The GATE — refusing at the moment of enrolment — is not here and cannot be:
 * the terminals enrolment screen does not exist yet. What is here is the rule
 * that screen will ask.
 */

const TOKEN = readFileSync(join(__dirname, 'fixtures/live-licence.token'), 'utf8').trim()
const parsed = parseVoucherToken(TOKEN)
const ISSUER = parsed.voucher.issuerPublicKey
const EXPIRES_AT = parsed.voucher.expiresAt!
const CUSTOMER = '4728fd8ad6a2f5c8930f4065347907e22186fba6c73bd04e145dfd780b98e451'
const DAY = 86_400

const row: VoucherRow = {
  token_id: 'live-licence',
  token: TOKEN,
  amount: 4000,
  face_value: 4000,
  face_unit: 'GBP',
  face_decimals: 2,
  token_amount: 4000,
  issuer_id: ISSUER,
  status: 'active',
  created_at: '2026-09-04T00:00:00.000Z',
  updated_at: '2026-09-04T00:00:00.000Z',
}

/** Status with the real licence held. */
const withLicence = (now: number) =>
  licenceStatus({ pubkey: CUSTOMER, now, issuerPublicKey: ISSUER, loadRows: async () => [row] })

/** Status for a stall that has never subscribed. */
const noLicence = () =>
  licenceStatus({
    pubkey: CUSTOMER,
    now: EXPIRES_AT - 300 * DAY,
    issuerPublicKey: ISSUER,
    loadRows: async () => [],
  })

beforeEach(() => {
  forgetLicenceParses()
  forgetVerification(CUSTOMER)
})

afterEach(() => {
  forgetVerification(CUSTOMER)
})

describe('a stall with no subscription', () => {
  it('may enrol its first terminal, which is the free one', async () => {
    const status = await noLicence()
    expect(mayEnrol(status, 0)).toEqual({ allowed: true })
  })

  it('is refused the second, and told what the limit is', async () => {
    const status = await noLicence()
    const decision = mayEnrol(status, FREE_TERMINALS)

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toBe(ENROL_REFUSAL.AT_FREE_LIMIT)
      // Names the limit AND the way to lift it — the ticket asks for both,
      // and a refusal without the second is a dead end.
      expect(decision.message).toContain('free till')
      expect(decision.message).toContain('subscription')
      expect(decision.message).toContain('get in touch')
    }
  })

  it('reassures that the owner’s own device is unaffected', async () => {
    // "The owner's own device continues to work exactly as before and is never
    // asked to enrol." A merchant reading a refusal must not think their till
    // is about to stop.
    const status = await noLicence()
    const decision = mayEnrol(status, FREE_TERMINALS)

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.message).toMatch(/this device .*keeps working/i)
  })
})

describe('a stall holding the real licence', () => {
  it('may enrol, with no further check', async () => {
    const status = await withLicence(EXPIRES_AT - 300 * DAY)
    expect(mayEnrol(status, 0)).toEqual({ allowed: true })
  })

  it('may keep enrolling: the licence is per STALL, not per terminal', async () => {
    // "One voucher, however many terminals." A numeric cap here would be the
    // rejected per-terminal pricing reintroduced by accident.
    const status = await withLicence(EXPIRES_AT - 300 * DAY)
    for (const count of [1, 2, 5, 50]) {
      expect(mayEnrol(status, count)).toEqual({ allowed: true })
    }
    expect(remainingTerminals(status, 50)).toBe(Infinity)
  })
})

describe('a stall whose subscription lapsed', () => {
  it('is refused a NEW terminal, and told renewing fixes it', async () => {
    const status = await withLicence(EXPIRES_AT + DAY)
    const decision = mayEnrol(status, FREE_TERMINALS)

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      // A different sentence from the never-subscribed one: renewing and
      // buying send a merchant to different actions.
      expect(decision.reason).toBe(ENROL_REFUSAL.LAPSED)
      expect(decision.message).toContain('Renewing')
    }
  })

  it('never says the stall stops trading', async () => {
    // A lapse takes tills, never trade. This is the sentence that must not
    // frighten someone into thinking they cannot sell tomorrow.
    const status = await withLicence(EXPIRES_AT + DAY)
    const decision = mayEnrol(status, FREE_TERMINALS)

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.message).toMatch(/keeps trading/i)
      expect(decision.message).not.toMatch(/closed|suspended|cannot sell/i)
    }
  })

  it('still allows the free one, because a lapse suspends rather than revokes', async () => {
    // Dropping to the free allowance is the design; dropping below it would be
    // taking away what the stall had before it ever subscribed.
    const status = await withLicence(EXPIRES_AT + DAY)
    expect(mayEnrol(status, 0)).toEqual({ allowed: true })
  })
})

describe('how many are left', () => {
  it('counts down to the free limit without a subscription', async () => {
    const status = await noLicence()
    expect(remainingTerminals(status, 0)).toBe(FREE_TERMINALS)
    expect(remainingTerminals(status, FREE_TERMINALS)).toBe(0)
  })

  it('never goes negative, however many are somehow enrolled', async () => {
    // A stall that subscribed, enrolled several, then lapsed. The number is for
    // display; a negative would render as nonsense.
    const status = await withLicence(EXPIRES_AT + DAY)
    expect(remainingTerminals(status, 9)).toBe(0)
  })
})
