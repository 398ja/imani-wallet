/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Issuance refuses before it mints.
 *
 * `actor.test.ts` proves `mayIssue` answers correctly. What only this file can
 * prove is the ORDERING the ticket asks for: a terminal that may not sell is
 * stopped before a voucher exists, not after one has been minted and
 * abandoned — and never by a check that runs after the money has moved.
 *
 * `registration.test.ts` is the prior art the spec names: collaborators mocked
 * at the module boundary, asserting that nothing happens before the thing that
 * authorises it.
 */

const calls: string[] = []
/** Bodies too: the DM payload is where the issuer is actually stamped. */
const bodies: Array<Record<string, unknown>> = []

vi.mock('../nip98', () => ({
  signedFetch: async (path: string, _method?: string, body?: Record<string, unknown>) => {
    calls.push(path)
    if (body) bodies.push(body)
    return {
      ok: true,
      json: async () => ({
        items: [{ voucher_id: 'v1', status: 'ISSUED', token: 'cashuBx' }],
        voucher_id: 'v1',
        status: 'ISSUED',
        token: 'cashuBx',
        expires_at: 1_900_000_000,
      }),
      text: async () => '',
    }
  },
}))

vi.mock('../wallet', () => ({
  getWallet: () => ({ addTransaction: async () => {} }),
  notifyWalletChanged: () => {},
}))

vi.mock('../relay', () => ({ INTERNAL_RELAY_URL: 'ws://relay.test' }))

const { issueAndDeliver } = await import('../issue')
const { ownerActor, terminalActor } = await import('../actor')
const { TERMINAL_ROLES, grantFor } = await import('../terminalRole')
const { openSession, SESSION_KIND } = await import('../terminalSession')

/**
 * A live, full-authority session.
 *
 * Passed explicitly so these tests keep testing what they were written for —
 * the ROLE rule and the issuer stamp. Without it every terminal here would be
 * refused for having no session (terminals ticket 07), and the refusals below
 * would pass for a reason nobody intended.
 */
const live = (actor: Parameters<typeof openSession>[0]) =>
  openSession(actor, SESSION_KIND.FULL, Date.now())

const STALL = 'a'.repeat(64)
const DEVICE = 'c'.repeat(64)

const params = {
  faceValueMinor: 500,
  currency: 'GBP',
  expiryDays: 90,
  recipientPubkey: 'e'.repeat(64),
}

beforeEach(() => {
  calls.length = 0
  bodies.length = 0
})

describe('a terminal that may not sell', () => {
  it('is refused BEFORE anything is minted', async () => {
    const redeemOnly = terminalActor(
      {
        stallPubkey: STALL,
        role: TERMINAL_ROLES.REDEEM_ONLY,
        lockedTo: DEVICE,
        permissions: grantFor(TERMINAL_ROLES.REDEEM_ONLY, STALL),
      },
      DEVICE,
    )!

    await expect(issueAndDeliver({ ...params, actor: redeemOnly, session: live(redeemOnly) })).rejects.toThrow(
      /not set up to sell/,
    )

    // The ordering assertion: no request left the device at all. A check after
    // `createVoucher` would leave a minted voucher with nobody to deliver it
    // to, which is worse than refusing.
    expect(calls).toEqual([])
  })

  it('is told what to do about it, in words a stallholder can act on', async () => {
    const redeemOnly = terminalActor(
      {
        stallPubkey: STALL,
        role: TERMINAL_ROLES.REDEEM_ONLY,
        lockedTo: DEVICE,
        permissions: grantFor(TERMINAL_ROLES.REDEEM_ONLY, STALL),
      },
      DEVICE,
    )!

    await expect(issueAndDeliver({ ...params, actor: redeemOnly, session: live(redeemOnly) })).rejects.toThrow(
      /Ask the stall owner/,
    )
  })
})

describe('what the coupon is stamped with', () => {
  /**
   * The ticket's first criterion, and the one only an end-to-end call can
   * check: "A coupon issued through a credential carries the stall named in
   * that credential."
   *
   * Asserted on the DM payload rather than on `issuingStall`, because that is
   * the artefact the customer receives. A version that read the actor correctly
   * and then stamped the terminal's own key would pass every unit test in
   * actor.test.ts and still hand customers coupons from an issuer that stops
   * existing at the next re-enrolment.
   */
  it('carries the STALL when a terminal issued it, never the terminal key', async () => {
    const till = terminalActor(
      {
        stallPubkey: STALL,
        role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
        lockedTo: DEVICE,
        permissions: grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL),
      },
      DEVICE,
    )!

    await issueAndDeliver({ ...params, actor: till, session: live(till) })

    const dm = bodies.find((b) => 'issuer_id' in b)
    expect(dm).toBeDefined()
    expect(dm!.issuer_id).toBe(STALL)
    expect(dm!.sender_pubkey).toBe(STALL)
    // The disposable key must appear nowhere on the coupon.
    expect(JSON.stringify(dm)).not.toContain(DEVICE)
  })

  it('carries the stall when the owner issued it', async () => {
    await issueAndDeliver({ ...params, actor: ownerActor(STALL)! })

    const dm = bodies.find((b) => 'issuer_id' in b)
    expect(dm!.issuer_id).toBe(STALL)
  })
})

describe('an owner issuing on their own device', () => {
  it('is not refused, and reaches the portal', async () => {
    /**
     * The fourth acceptance criterion: unaffected by this ticket.
     *
     * Only the FIRST call is asserted. The full saga polls for a token and then
     * for an expiry — waits whose timing `issue.ts` documents as load-bearing —
     * and reproducing them here would test the gateway's settlement schedule
     * rather than this ticket's question, which is whether the owner is let
     * through at all.
     */
    void issueAndDeliver({ ...params, actor: ownerActor(STALL)! }).catch(() => {})

    // Let the first await settle.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls[0]).toBe('/api/v1/portal/vouchers')
  })
})

/**
 * The enforcement point, attacked directly.
 *
 * "The hiding is the courtesy, not the control" (terminals ticket 07). These
 * bypass the UI entirely and call `issueAndDeliver` the way a modified client
 * or a stale open tab would — which is the only way to show the refusal is real
 * rather than a hidden button.
 *
 * Every one asserts `calls` is EMPTY, because a refusal that happens after a
 * mint has left a voucher nobody can deliver.
 */
describe('a request made around the UI is refused, not merely hidden', () => {
  const till = () =>
    terminalActor(
      {
        stallPubkey: STALL,
        role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
        lockedTo: DEVICE,
        permissions: grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL),
      },
      DEVICE,
    )!

  it('refuses a terminal whose trading day has rolled over', async () => {
    const actor = till()
    const expired = openSession(actor, SESSION_KIND.FULL, Date.now() - 13 * 3600 * 1000)

    await expect(issueAndDeliver({ ...params, actor, session: expired })).rejects.toThrow(
      /signing in again/,
    )
    expect(calls).toEqual([])
  })

  it('refuses a terminal on reduced authority, whatever its role allows', async () => {
    // The mint was unreachable at login. Issuance is value-bearing: a coupon
    // minted on an authority nobody could check is money created on a guess.
    const actor = till()
    const reduced = openSession(actor, SESSION_KIND.REDUCED, Date.now())

    await expect(issueAndDeliver({ ...params, actor, session: reduced })).rejects.toThrow(
      /reaches the network/,
    )
    expect(calls).toEqual([])
  })

  it('refuses a terminal that simply omits the session', async () => {
    /**
     * The likeliest bypass, and the one a default would open. If a missing
     * session read as "fine", every check here could be skipped by forgetting
     * a field — so it must be refused, not defaulted.
     */
    await expect(issueAndDeliver({ ...params, actor: till() })).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('tells staff the recoverable thing first', async () => {
    // A redeem-only terminal whose session ALSO expired hears "sign in again",
    // not "this till cannot sell". One of those is actionable; sending staff
    // to the owner with the other is a wasted trip.
    const redeemOnly = terminalActor(
      {
        stallPubkey: STALL,
        role: TERMINAL_ROLES.REDEEM_ONLY,
        lockedTo: DEVICE,
        permissions: grantFor(TERMINAL_ROLES.REDEEM_ONLY, STALL),
      },
      DEVICE,
    )!
    const expired = openSession(redeemOnly, SESSION_KIND.FULL, Date.now() - 13 * 3600 * 1000)

    await expect(
      issueAndDeliver({ ...params, actor: redeemOnly, session: expired }),
    ).rejects.toThrow(/signing in again/)
  })

  it('leaves the stall on its own device completely alone', async () => {
    // The fifth criterion. An owner has no session and never will, so none of
    // the above can reach them.
    await issueAndDeliver({ ...params, actor: ownerActor(STALL)! })
    expect(calls.length).toBeGreaterThan(0)
  })
})
