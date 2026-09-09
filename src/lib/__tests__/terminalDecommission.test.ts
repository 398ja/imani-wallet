/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Decommissioning a terminal from the device.
 *
 * Ticket 08. The order is the whole point, so most of these assert on what has
 * NOT happened: a failed revocation must leave the credential and the storage
 * exactly as they were, because a wipe that silently leaves a working key in
 * the world is the failure this exists to prevent.
 *
 * `logout` is mocked to record whether it ran. That is the erasing half, and
 * it is already tested where it lives; what matters here is whether it is
 * reached at all, and in what order.
 */

const erased: string[] = []
vi.mock('../logout', () => ({
  logout: async (pubkey: string) => {
    erased.push(pubkey)
    return true
  },
  LOGOUT_WARNING: 'the customer wording',
}))

const { decommissionTerminal, DECOMMISSION_COPY, DECOMMISSION_REFUSAL } = await import(
  '../terminalDecommission'
)
const { parseVoucherToken } = await import('../voucherToken')

const TOKEN = readFileSync(
  join(__dirname, 'fixtures', 'live-terminal-credential.token'),
  'utf8',
).trim()
const METADATA = parseVoucherToken(TOKEN).voucher.merchantMetadata
const PUBKEY = 'c'.repeat(64)
const ENROLMENT_KEY = 'imani-wallet:terminal'

function enrol(over: Record<string, unknown> = {}) {
  localStorage.setItem(
    ENROLMENT_KEY,
    JSON.stringify({
      stallPubkey: 'b1787b2b98a5244a70d934b393e0179e7ebba0c72579b4a0b238eda3911caa02',
      role: 'redeem-only',
      terminalPubkey: PUBKEY,
      permissions: [],
      enrolledAt: 1,
      token: TOKEN,
      merchantMetadata: METADATA,
      issuerId: 'b1787b2b98a5244a70d934b393e0179e7ebba0c72579b4a0b238eda3911caa02',
      ...over,
    }),
  )
}

const api = (over = {}) => ({
  validateToken: vi.fn(async () => ({ state: 'UNSPENT' })),
  receive: vi.fn(async () => ({ receive_id: 'r1' })),
  ...over,
})

beforeEach(() => {
  localStorage.clear()
  erased.length = 0
})

describe('the order', () => {
  it('revokes before erasing anything', async () => {
    /**
     * The ticket's first criterion. Wiping first would leave a live authority
     * on a device nobody controls: the credential would still be unspent, so
     * anyone recovering the storage could trade with it, and the owner's
     * roster would still show the terminal as live.
     */
    enrol()
    const mint = api()

    const out = await decommissionTerminal(mint, PUBKEY, () => {})

    expect(out.done).toBe(true)
    expect(mint.receive).toHaveBeenCalledOnce()
    expect(erased).toEqual([PUBKEY])
  })

  it('does not wipe when the revocation fails', async () => {
    /**
     * The second criterion, and the one worth the most care. A device that
     * wipes without revoking is strictly worse than one that refuses: the key
     * is still live, and now nobody knows where it is.
     */
    enrol()
    const mint = api({
      receive: vi.fn(async () => {
        throw new Error('offline')
      }),
    })

    const out = await decommissionTerminal(mint, PUBKEY, () => {})

    expect(out.done).toBe(false)
    expect(erased).toEqual([])
    // And the credential is still on the device, ready to try again.
    expect(localStorage.getItem(ENROLMENT_KEY)).toContain(TOKEN)
  })

  it('does not report success when it failed', async () => {
    enrol()
    const mint = api({
      receive: vi.fn(async () => {
        throw new Error('offline')
      }),
    })

    const out = await decommissionTerminal(mint, PUBKEY, () => {})
    if (out.done) throw new Error('expected refusal')

    expect(out.reason).toBe(DECOMMISSION_REFUSAL.REVOKE_FAILED)
    // Says what did NOT happen, which is the thing the holder needs to know.
    expect(out.message).toMatch(/nothing has been erased/)
  })

  it('finishes the job when the owner already revoked it remotely', async () => {
    // Already spent means the device is powerless but still holding a key.
    // Refusing here would strand it in exactly that state.
    enrol()
    const mint = api({ validateToken: vi.fn(async () => ({ state: 'SPENT' })) })

    const out = await decommissionTerminal(mint, PUBKEY, () => {})

    expect(out.done).toBe(true)
    expect(erased).toEqual([PUBKEY])
    expect(mint.receive).not.toHaveBeenCalled()
  })
})

describe('it is not a logout', () => {
  it('refuses a device that is not a terminal', async () => {
    // Wiping here would be a logout wearing a terminal's words, and the person
    // holding it would be told the wrong thing about what comes back.
    const out = await decommissionTerminal(api(), PUBKEY, () => {})

    expect(out.done).toBe(false)
    if (!out.done) expect(out.reason).toBe(DECOMMISSION_REFUSAL.NOT_A_TERMINAL)
    expect(erased).toEqual([])
  })

  it('refuses a device enrolled before credentials were stored', async () => {
    enrol({ token: undefined, merchantMetadata: undefined })
    const out = await decommissionTerminal(api(), PUBKEY, () => {})

    expect(out.done).toBe(false)
    expect(erased).toEqual([])
  })

  it('promises no backup key, account, or past sales', async () => {
    /**
     * The fourth criterion. The logout copy promises an account, a business
     * and past sales all return with a backup key. A terminal holds no
     * coupons, has no key its holder should write down, and comes back only by
     * the owner enrolling it — so saying otherwise sends someone hunting for a
     * backup key that was never theirs.
     */
    const words = Object.values(DECOMMISSION_COPY).join(' ')

    expect(words).not.toMatch(/backup key|nsec|password|log in/i)
    expect(words).not.toMatch(/your account|your business|your sales/i)
  })

  it('says the one thing that IS true: the owner can set it up again', async () => {
    expect(DECOMMISSION_COPY.body).toMatch(/stall owner adds it/)
    // And that the stall keeps the record, because "revoking is not erasing".
    expect(DECOMMISSION_COPY.body).toMatch(/keeps every sale/)
  })
})

describe('the confirmation does not repeat the description', () => {
  it('says something the standing copy does not', () => {
    // The same sentence twice makes the second one furniture — and the second
    // is the one being read hardest, at the point of an irreversible tap.
    expect(DECOMMISSION_COPY.confirmBody).not.toBe(DECOMMISSION_COPY.body)
    expect(DECOMMISSION_COPY.confirmBody).toMatch(/cannot be undone/)
  })

  it('still promises no self-service recovery', () => {
    // The criterion holds for every string, not just the ones checked above.
    expect(DECOMMISSION_COPY.confirmBody).not.toMatch(/backup key|nsec|log in/i)
    expect(DECOMMISSION_COPY.confirmBody).toMatch(/stall owner/)
  })
})
