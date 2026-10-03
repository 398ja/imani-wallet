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

/**
 * An unlocked wallet holding the STALL's key, so an owner's sale signs a
 * `merchant` warrant. Without one the warrant is absent, and since #159 Sell
 * refuses a sale every recipient would refuse (`assertSaleWarranted`).
 * Only `signer.pubkey === stall` is checked before signing, and nothing here
 * verifies the signature. `null` stands for a locked wallet.
 */
const signerState = vi.hoisted(() => ({ pubkey: 'a'.repeat(64) as string | null }))

vi.mock('../nap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nap')>()),
  getSigner: () => {
    if (signerState.pubkey === null) throw new Error('No signer — the wallet has not been unlocked.')
    return {
      pubkey: signerState.pubkey,
      withPrivkey: <T,>(borrow: (key: Uint8Array) => T): T => borrow(new Uint8Array(32).fill(7)),
    }
  },
}))

const { issueAndDeliver } = await import('../issue')
const { ownerActor, terminalActor } = await import('../actor')
const { NEVER_EXPIRES } = await import('../merchant')
const { TERMINAL_ROLES, grantFor } = await import('../terminalRole')
const { openSession, SESSION_KIND } = await import('../terminalSession')
const { UnwarrantedSaleError } = await import('../warrantSigner')

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
  signerState.pubkey = STALL
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
   *
   * The terminal case of that criterion is not reachable while terminal sales
   * are refused (#159); see the last describe in this file. It returns with
   * the `delegated` warrant form.
   */
  it('carries the stall when the owner issued it', async () => {
    await issueAndDeliver({ ...params, actor: ownerActor(STALL)! })

    const dm = bodies.find((b) => 'issuer_id' in b)
    expect(dm!.issuer_id).toBe(STALL)
  })

  /**
   * A never-expiring coupon sends NO `expiry_days`, rather than sending zero.
   *
   * The portal reads an absent expiry as "never" and still bounds the field at
   * `@Min(1)`, so a literal 0 would be a 400 on every sale — the one way this
   * branch can be wrong that a type checker cannot see.
   */
  it('omits the expiry entirely when the stall issues coupons that never expire', async () => {
    await issueAndDeliver({
      ...params,
      expiryDays: NEVER_EXPIRES,
      actor: ownerActor(STALL)!,
    })

    const mint = bodies.find((b) => 'face_value_minor' in b)
    expect(mint).toBeDefined()
    expect(mint).not.toHaveProperty('expiry_days')
  })

  it('still stamps a term the stall did choose', async () => {
    await issueAndDeliver({ ...params, expiryDays: 90, actor: ownerActor(STALL)! })

    const mint = bodies.find((b) => 'face_value_minor' in b)
    expect(mint!.expiry_days).toBe(90)
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

/**
 * Issue #159: a terminal's coupon could only carry a signed `none` warrant,
 * and every wallet receiving a coupon by DM refuses that before the mint swap
 * (`refuseIfUnwarranted`) — the customer's included. The terminal still
 * reported "It is in their wallet now" while the customer's wallet showed
 * "Coupon not authorised".
 *
 * So a terminal sale is refused before anything leaves the device, and so is
 * any sale whose warrant would not be a signed `merchant` one. The stamping
 * and privacy properties a terminal sale used to be tested for here (issuer is
 * the stall, the terminal key appears nowhere on the coupon) come back with
 * the `delegated` warrant form; until then there is no terminal coupon to
 * inspect, and `calls` being empty is the stronger statement.
 */
describe('a sale the customer’s wallet would refuse is never made (#159)', () => {
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

  it('refuses a full till with a live session, before anything is minted', async () => {
    const actor = till()

    const run = issueAndDeliver({ ...params, actor, session: live(actor) })

    await expect(run).rejects.toBeInstanceOf(UnwarrantedSaleError)
    await expect(run).rejects.toThrow(/delegated/)
    expect(calls).toEqual([])
    expect(bodies).toEqual([])
  })

  it('never reports a stage, so the screen never shows progress or success', async () => {
    const actor = till()
    const stages: string[] = []

    await issueAndDeliver({ ...params, actor, session: live(actor) }, (s) => stages.push(s)).catch(
      () => {},
    )

    expect(stages).toEqual([])
  })

  it('refuses an owner session whose key is not the stall, which could only sign `none`', async () => {
    signerState.pubkey = 'f'.repeat(64)

    const run = issueAndDeliver({ ...params, actor: ownerActor(STALL)! })

    await expect(run).rejects.toBeInstanceOf(UnwarrantedSaleError)
    expect(calls).toEqual([])
  })

  it('refuses an owner whose wallet is locked, which could sign no warrant at all', async () => {
    signerState.pubkey = null

    const run = issueAndDeliver({ ...params, actor: ownerActor(STALL)! })

    await expect(run).rejects.toThrow(/locked/)
    expect(calls).toEqual([])
  })

  it('sends the owner’s sale with a signed merchant warrant', async () => {
    await issueAndDeliver({ ...params, actor: ownerActor(STALL)! })

    const mint = bodies.find((b) => 'face_value_minor' in b)
    expect(JSON.parse(String(mint!.issuance_warrant)).form).toBe('merchant')
  })
})
