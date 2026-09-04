/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VoucherRow } from '@imani/wallet-storage'

/**
 * The owner's side of enrolment, and the subscription gate that sits on it.
 *
 * Two tickets meet here. Terminals 05 says an owner names a terminal, picks a
 * role, and issues authority for their OWN stall. Subscriptions 07 says the
 * second terminal needs a licence, refused "at enrolment rather than by hiding
 * a button" — so the gate is asserted at the point of enrolment, which is the
 * only place it counts.
 *
 * Run against the REAL gateway-minted licence, so the gate is exercised by the
 * same artefact a customer would hold rather than by a fixture this app signed
 * for itself.
 */

const saved: Array<{ privkeyHex: string; passphrase: string }> = []
vi.mock('../nap', () => ({
  keyStore: { save: async (k: string, p: string) => void saved.push({ privkeyHex: k, passphrase: p }) },
}))

const { checkEnrolment, prepareEnrolment, ENROLMENT_REFUSAL } = await import('../terminalIssue')
const { TERMINAL_ROLES } = await import('../terminalRole')
const { licenceStatus, forgetVerification } = await import('../licenceStatus')
const { forgetLicenceParses } = await import('../licences')
const { parseVoucherToken } = await import('../voucherToken')
const { beginEnrolment, completeEnrolment, forgetPendingKey, forgetTerminal, enrolledActor } =
  await import('../terminalEnrol')

const TOKEN = readFileSync(join(__dirname, 'fixtures/live-licence.token'), 'utf8').trim()
const parsed = parseVoucherToken(TOKEN)
const ISSUER = parsed.voucher.issuerPublicKey
const EXPIRES_AT = parsed.voucher.expiresAt!
/** The licence is locked to this key, so it is the stall for these tests. */
const STALL = '4728fd8ad6a2f5c8930f4065347907e22186fba6c73bd04e145dfd780b98e451'
const TERMINAL = 'c'.repeat(64)
/** Somebody else's stall, for the cross-stall attack below. */
const OTHER_STALL = 'b'.repeat(64)
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

const subscribed = (now = EXPIRES_AT - 300 * DAY) =>
  licenceStatus({ pubkey: STALL, now, issuerPublicKey: ISSUER, loadRows: async () => [row] })

const unsubscribed = () =>
  licenceStatus({
    pubkey: STALL,
    now: EXPIRES_AT - 300 * DAY,
    issuerPublicKey: ISSUER,
    loadRows: async () => [],
  })

const request = (over: Partial<Parameters<typeof checkEnrolment>[0]> = {}) => ({
  name: 'Door',
  role: TERMINAL_ROLES.REDEEM_ONLY,
  terminalPubkey: TERMINAL,
  ...over,
})

/**
 * `licence` is REQUIRED, so the overrides are partial in everything else and
 * exact in that. A blanket `Partial` would make the one input the gate reads
 * optional, which is how a test could accidentally exercise no gate at all.
 */
type Ctx = Parameters<typeof checkEnrolment>[1]
const context = (over: Partial<Omit<Ctx, 'licence'>> & Pick<Ctx, 'licence'>): Ctx => ({
  stallPubkey: STALL,
  enrolledCount: 0,
  online: true,
  ...over,
})

beforeEach(() => {
  saved.length = 0
  forgetLicenceParses()
  forgetVerification(STALL)
  forgetPendingKey()
  forgetTerminal()
  localStorage.clear()
})

afterEach(() => forgetVerification(STALL))

describe('what an owner must supply', () => {
  it('will not enrol a terminal with no name', async () => {
    const check = checkEnrolment(request({ name: '  ' }), context({ licence: await subscribed() }))
    expect(check.ready).toBe(false)
    if (!check.ready) expect(check.reason).toBe(ENROLMENT_REFUSAL.NO_NAME)
  })

  it('will not enrol a terminal with no role', async () => {
    // The first acceptance criterion. A default would be the app deciding what
    // a device may do.
    const check = checkEnrolment(request({ role: null }), context({ licence: await subscribed() }))
    expect(check.ready).toBe(false)
    if (!check.ready) expect(check.reason).toBe(ENROLMENT_REFUSAL.NO_ROLE)
  })

  it('will not enrol without a scanned terminal key', async () => {
    for (const bad of ['', 'not-a-key', 'a'.repeat(63)]) {
      const check = checkEnrolment(
        request({ terminalPubkey: bad }),
        context({ licence: await subscribed() }),
      )
      expect(check.ready).toBe(false)
    }
  })

  it('refuses to enrol the owner’s own device', async () => {
    // Terminal 1 is counted, not converted. Enrolling it would hand the stall a
    // second, weaker authority over its own business.
    const check = checkEnrolment(
      request({ terminalPubkey: STALL }),
      context({ licence: await subscribed() }),
    )
    expect(check.ready).toBe(false)
    if (!check.ready) {
      expect(check.reason).toBe(ENROLMENT_REFUSAL.SELF)
      expect(check.message).toMatch(/already trades/)
    }
  })

  it('says plainly that enrolment needs a connection', async () => {
    // The spec refuses to pre-issue unassigned credentials — those are bearer
    // authorities to the stall sitting in a drawer — so there is no degraded
    // path and the owner is told to set up before the market opens.
    const check = checkEnrolment(request(), context({ licence: await subscribed(), online: false }))
    expect(check.ready).toBe(false)
    if (!check.ready) {
      expect(check.reason).toBe(ENROLMENT_REFUSAL.OFFLINE)
      expect(check.message).toMatch(/before the market opens/)
    }
  })
})

describe('the subscription gate, at the point of enrolment', () => {
  it('allows the first terminal free', async () => {
    const check = checkEnrolment(request(), context({ licence: await unsubscribed() }))
    expect(check.ready).toBe(true)
  })

  it('refuses the second without a licence, and says how to lift it', async () => {
    // Subscriptions 07's first criterion, asserted where the ticket demands it:
    // at enrolment, not by a hidden button.
    const check = checkEnrolment(
      request(),
      context({ licence: await unsubscribed(), enrolledCount: 1 }),
    )

    expect(check.ready).toBe(false)
    if (!check.ready) {
      expect(check.reason).toBe(ENROLMENT_REFUSAL.NOT_ALLOWED)
      expect(check.message).toMatch(/free till/)
      expect(check.message).toMatch(/get in touch/)
    }
  })

  it('allows the second WITH the real licence, and no further check', async () => {
    const check = checkEnrolment(
      request(),
      context({ licence: await subscribed(), enrolledCount: 1 }),
    )
    expect(check.ready).toBe(true)
  })

  it('refuses again once the subscription has lapsed', async () => {
    const check = checkEnrolment(
      request(),
      context({ licence: await subscribed(EXPIRES_AT + DAY), enrolledCount: 1 }),
    )

    expect(check.ready).toBe(false)
    if (!check.ready) expect(check.message).toMatch(/Renewing/)
  })
})

describe('the authority that is issued', () => {
  it('is for the owner’s stall, taken from the session and not the form', async () => {
    // The fifth criterion, made structural: there is no field in which an owner
    // could name a different stall.
    const credential = prepareEnrolment(request(), context({ licence: await subscribed() }))

    expect(credential.stallPubkey).toBe(STALL)
    // `permissions` is optional on the credential type — a credential read off
    // the wire may not carry them — but one we PREPARED always must.
    expect(credential.permissions).toBeDefined()
    expect(credential.permissions!.every((p) => p.endsWith(`:${STALL}`))).toBe(true)
  })

  it('cannot be issued for another stall, however the form is filled in', async () => {
    /**
     * The fifth criterion, attacked rather than confirmed. A caller that tried
     * to smuggle a stall through the request must be ignored — the stall is who
     * the owner IS, taken from the session, and a screen that accepted it as
     * input could grant away someone else's business.
     */
    const smuggled = {
      ...request(),
      stallPubkey: OTHER_STALL,
      issuerPubkey: OTHER_STALL,
      stall: OTHER_STALL,
    } as unknown as Parameters<typeof prepareEnrolment>[0]

    const credential = prepareEnrolment(smuggled, context({ licence: await subscribed() }))

    expect(credential.stallPubkey).toBe(STALL)
    expect(JSON.stringify(credential)).not.toContain(OTHER_STALL)
  })

  it('is locked to the key the device showed, so the returned QR is safe', async () => {
    const credential = prepareEnrolment(request(), context({ licence: await subscribed() }))
    expect(credential.lockedTo).toBe(TERMINAL)
  })

  it('carries the role the owner picked, and only its permissions', async () => {
    const credential = prepareEnrolment(
      request({ role: TERMINAL_ROLES.REDEEM_ONLY }),
      context({ licence: await subscribed() }),
    )

    expect(credential.role).toBe(TERMINAL_ROLES.REDEEM_ONLY)
    expect(credential.permissions).toEqual([`voucher:redeem:${STALL}`])
  })

  it('refuses to be prepared at all when the check would fail', async () => {
    // Never a partial credential: an authority nobody can account for is worse
    // than a failure.
    const ctx = context({ licence: await subscribed() })
    expect(() => prepareEnrolment(request({ role: null }), ctx)).toThrow()
  })
})

describe('the whole handshake', () => {
  it('enrols a device end to end, and it acts for the stall', async () => {
    /**
     * Both sides of the exchange, joined: the device shows a key, the owner
     * issues authority for it, and the device stores and reuses it.
     *
     * This is the property neither ticket can assert alone — that what the
     * owner produces is exactly what the device accepts.
     */
    const code = beginEnrolment()

    const credential = prepareEnrolment(
      request({ terminalPubkey: code.terminalPubkey, role: TERMINAL_ROLES.ISSUE_AND_REDEEM }),
      context({ licence: await subscribed() }),
    )

    await completeEnrolment(credential, 'a passphrase', credential.name)

    const actor = enrolledActor()
    expect(actor).not.toBeNull()
    expect(actor!.stallPubkey).toBe(STALL)
    expect(actor!.terminalPubkey).toBe(code.terminalPubkey)
    expect(actor!.role).toBe(TERMINAL_ROLES.ISSUE_AND_REDEEM)
  })

  it('produces a credential another device cannot use', async () => {
    // The photographed-QR case, end to end: authority issued for one terminal
    // is worthless to a second.
    const enrolled = beginEnrolment()
    const credential = prepareEnrolment(
      request({ terminalPubkey: enrolled.terminalPubkey }),
      context({ licence: await subscribed() }),
    )

    // A different device starts its own enrolment and tries to use it.
    forgetPendingKey()
    beginEnrolment()

    await expect(completeEnrolment(credential, 'a passphrase')).rejects.toThrow(
      /not a valid authority/,
    )
    expect(saved).toEqual([])
  })
})
