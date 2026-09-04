/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VoucherRow } from '@imani/wallet-storage'

import {
  STOPPED_BY_LAPSE_MESSAGE,
  mayServe,
  servingTerminals,
  terminalsStoppedByLapse,
} from '../lapseService'
import { mayEnrol, ENROL_REFUSAL, FREE_TERMINALS } from '../terminalAllowance'
import { forgetVerification, licenceStatus } from '../licenceStatus'
import { forgetLicenceParses } from '../licences'
import { parseVoucherToken } from '../voucherToken'
import { TERMINAL_ROLES } from '../terminalRole'
import type { TerminalRecord } from '../terminalRoster'

/**
 * A lapse takes tills, never trade.
 *
 * Run against the licence a REAL gateway minted, the same fixture
 * `terminalAllowance.test.ts` uses, because the spec asks for this to be
 * "tested by lapsing with terminals live and asserting the till still serves,
 * not by asserting the licence returns false". So the lapse here is a real
 * expiry travelling through the signed metadata, the verifier and the grace
 * window, with a real roster on the other side.
 *
 * The properties are all about what a lapse does NOT do. That is the whole
 * ticket: this is where the design is either kind or punitive.
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

/** Subscribed and current. */
const live = () =>
  licenceStatus({
    pubkey: CUSTOMER,
    now: EXPIRES_AT - DAY,
    issuerPublicKey: ISSUER,
    loadRows: async () => [row],
  })

/**
 * Subscribed, then lapsed.
 *
 * Past the expiry AND past the grace window, so this is a genuine lapse rather
 * than a device that merely cannot check right now. The licence is still in the
 * wallet, exactly as it would be in life — nothing burns it.
 */
const lapsed = () =>
  licenceStatus({
    pubkey: CUSTOMER,
    now: EXPIRES_AT + 30 * DAY,
    issuerPublicKey: ISSUER,
    loadRows: async () => [row],
  })

const OLDEST = 'a'.repeat(64)
const MIDDLE = 'b'.repeat(64)
const NEWEST = 'c'.repeat(64)

function roster(): TerminalRecord[] {
  return [
    // Deliberately out of order, so a rule that relies on array position
    // rather than on enrolment time is caught.
    { terminalPubkey: NEWEST, name: 'Newest', role: TERMINAL_ROLES.REDEEM_ONLY, enrolledAt: 3000 },
    { terminalPubkey: OLDEST, name: 'Oldest', role: TERMINAL_ROLES.ISSUE_AND_REDEEM, enrolledAt: 1000 },
    { terminalPubkey: MIDDLE, name: 'Middle', role: TERMINAL_ROLES.REDEEM_ONLY, enrolledAt: 2000 },
  ]
}

beforeEach(() => {
  forgetLicenceParses()
  forgetVerification(CUSTOMER)
})
afterEach(() => forgetVerification(CUSTOMER))

describe('while the subscription is live', () => {
  it('every terminal serves, because the licence names no number', async () => {
    // Sold per STALL. A count here would be per-terminal pricing arriving by
    // the back door, which the spec rejected explicitly.
    const status = await live()
    expect(servingTerminals(status, roster())).toHaveLength(3)
  })

  it('serves a terminal whichever one is asked about', async () => {
    const status = await live()
    for (const key of [OLDEST, MIDDLE, NEWEST]) {
      expect(mayServe(status, roster(), key).serving).toBe(true)
    }
  })
})

describe('when it lapses', () => {
  it('leaves the free till serving', async () => {
    /**
     * The criterion the spec singles out. A lapsed stall keeps exactly what an
     * unsubscribed one starts with, rather than being left worse off for having
     * once paid — and a billing problem must never close a stall.
     */
    const status = await lapsed()
    const serving = servingTerminals(status, roster())

    expect(serving).toHaveLength(FREE_TERMINALS)
    expect(mayServe(status, roster(), OLDEST).serving).toBe(true)
  })

  it('stops the extra tills', async () => {
    const status = await lapsed()

    expect(mayServe(status, roster(), MIDDLE).serving).toBe(false)
    expect(mayServe(status, roster(), NEWEST).serving).toBe(false)
  })

  it('keeps the same till serving every time it is asked', async () => {
    // A rule that shuffled would stop a different device each time anyone
    // looked, which from behind a counter is indistinguishable from a broken
    // app. Oldest-first, checked against a deliberately unsorted roster.
    const status = await lapsed()
    for (let i = 0; i < 5; i += 1) {
      expect(servingTerminals(status, roster())[0].terminalPubkey).toBe(OLDEST)
    }
  })

  it('says how many tills would stop, for a warning before it happens', async () => {
    const status = await lapsed()
    expect(terminalsStoppedByLapse(status, roster())).toBe(2)
    expect(terminalsStoppedByLapse(await live(), roster())).toBe(0)
  })
})

describe('a lapse revokes nothing', () => {
  it('does not touch the roster', async () => {
    /**
     * The property the whole ticket turns on. If a lapse burned or revoked
     * anything, renewal would mean re-enrolling every device by hand — a
     * punishment for someone who has just paid.
     */
    const before = roster()
    const snapshot = JSON.stringify(before)

    const status = await lapsed()
    servingTerminals(status, before)
    mayServe(status, before, NEWEST)
    terminalsStoppedByLapse(status, before)

    expect(JSON.stringify(before)).toBe(snapshot)
    expect(before.every((t) => t.revokedAt === undefined)).toBe(true)
  })

  it('does not reorder the caller’s own list', async () => {
    // The roster is what the owner's screen is about to render. Sorting in
    // place would silently rearrange it under them.
    const mine = roster()
    const status = await lapsed()
    servingTerminals(status, mine)

    expect(mine.map((t) => t.name)).toEqual(['Newest', 'Oldest', 'Middle'])
  })

  it('restores every terminal on renewal, with no re-enrolment', async () => {
    // The same roster objects, untouched throughout: lapse, then renew.
    const mine = roster()
    expect(servingTerminals(await lapsed(), mine)).toHaveLength(1)

    forgetVerification(CUSTOMER)
    forgetLicenceParses()

    expect(servingTerminals(await live(), mine)).toHaveLength(3)
    expect(mayServe(await live(), mine, NEWEST).serving).toBe(true)
  })
})

describe('what staff on a stopped till are told', () => {
  it('says the till is not authorised and points at the owner', async () => {
    // The terminal never checks a licence and never carries one, so this
    // cannot diagnose a subscription. It says what is true from the terminal's
    // point of view, and names the only action available to whoever holds it.
    const status = await lapsed()
    const decision = mayServe(status, roster(), NEWEST)

    expect(decision.serving).toBe(false)
    if (!decision.serving) {
      expect(decision.message).toMatch(/not authorised/)
      expect(decision.message).toMatch(/stall owner/)
    }
  })

  it('does not blame the device', () => {
    // Staff who believe the hardware failed go looking for a charger instead
    // of the owner.
    expect(STOPPED_BY_LAPSE_MESSAGE).not.toMatch(/error|broken|failed|fault/i)
  })

  it('does not leak the stall’s billing to whoever is holding the till', () => {
    // A terminal may be in someone else's hands. "Your subscription ended" is
    // the owner's business, and the terminal has no standing to say it.
    expect(STOPPED_BY_LAPSE_MESSAGE).not.toMatch(/subscription|payment|expired|renew/i)
  })
})

describe('growth freezes, trade does not', () => {
  it('refuses a new enrolment while lapsed', async () => {
    const status = await lapsed()
    const decision = mayEnrol(status, 1)

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe(ENROL_REFUSAL.LAPSED)
  })

  it('tells a lapsed owner to renew, not to buy something they own', async () => {
    const status = await lapsed()
    const decision = mayEnrol(status, 1)
    if (!decision.allowed) expect(decision.message).toMatch(/Renewing/)
  })

  it('never suggests the stall has stopped trading', async () => {
    const status = await lapsed()
    const decision = mayEnrol(status, 1)
    if (!decision.allowed) expect(decision.message).toMatch(/keeps trading/)
  })
})

describe('an unknown terminal', () => {
  it('is refused rather than served', async () => {
    // Revoked and unrecognised together. An unknown row is not evidence of
    // authority, so both must stop.
    const status = await live()
    expect(mayServe(status, roster(), 'f'.repeat(64)).serving).toBe(false)
  })

  it('does not take the free slot from a real one', async () => {
    const status = await lapsed()
    const withRevoked: TerminalRecord[] = [
      { ...roster()[1], revokedAt: 5000 },
      ...roster().filter((t) => t.terminalPubkey !== OLDEST),
    ]

    // OLDEST was revoked, so the allowance falls to the next oldest rather
    // than being spent on a terminal that is no longer in service.
    expect(servingTerminals(status, withRevoked)[0].terminalPubkey).toBe(MIDDLE)
  })
})
