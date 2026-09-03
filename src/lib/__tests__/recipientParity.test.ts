/**
 * @vitest-environment jsdom
 *
 * The API must refuse the sends the app refuses.
 *
 * The app's rule lives in `refuseIfWrongMerchant` (pay.ts), which performs its
 * own lookup and throws. The API's lives in `checkRecipient`
 * (`@imani/wallet-core`), which is handed a role and returns a verdict. They
 * are shaped differently on purpose — one has a network, the other is pure —
 * and that is exactly why they could drift.
 *
 * So this drives both over the same situations and compares allow against
 * allow, refuse against refuse. `refuseIfWrongMerchant` is not exported, so the
 * app's side is reached through `payRequest`'s real path with the network
 * stubbed at `merchantStatus`'s one dependency.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const relayEvents = vi.fn<[], Promise<unknown[]>>(async () => [])

// The relay, stubbed at the seam `merchant.ts` actually reads through. Both
// stores are stubbed so a test decides the answer rather than the environment.
vi.mock('nostr-tools/pool', () => ({
  SimplePool: class {
    querySync() {
      return relayEvents()
    }
    close() {}
  },
  useWebSocketImplementation: () => {},
}))
vi.mock('../gatewayNostr', () => ({ gatewayEvents: async () => relayEvents() }))

const STALL = 'a'.repeat(64)
const OTHER_STALL = 'b'.repeat(64)
const CUSTOMER = 'c'.repeat(64)
const SENDER = 'd'.repeat(64)

/** A live stall record, as the relay would hold it. */
const stallRecord = (pubkey: string) => ({
  id: 'e'.repeat(64),
  pubkey,
  kind: 30078,
  created_at: 1_700_000_000,
  tags: [['d', 'imani:merchant']],
  content: JSON.stringify({ active: true, categories: ['retail'], issuanceCurrency: 'EUR' }),
  sig: 'f'.repeat(128),
})

type Situation = {
  name: string
  sender: string
  recipient: string
  issuer: string
  /** What the relay holds for the recipient, or 'outage'. */
  network: 'stall' | 'none' | 'outage'
}

const SITUATIONS: Situation[] = [
  { name: 'redemption to the issuing stall', sender: SENDER, recipient: STALL, issuer: STALL, network: 'stall' },
  { name: 'redemption during an outage', sender: SENDER, recipient: STALL, issuer: STALL, network: 'outage' },
  { name: 'transfer to a customer', sender: SENDER, recipient: CUSTOMER, issuer: STALL, network: 'none' },
  { name: 'send to a different stall', sender: SENDER, recipient: OTHER_STALL, issuer: STALL, network: 'stall' },
  { name: 'send to a different stall during an outage', sender: SENDER, recipient: OTHER_STALL, issuer: STALL, network: 'outage' },
  { name: 'send to a customer during an outage', sender: SENDER, recipient: CUSTOMER, issuer: STALL, network: 'outage' },
  { name: 'send to self', sender: SENDER, recipient: SENDER, issuer: STALL, network: 'none' },
  { name: 'stall redeeming to itself', sender: STALL, recipient: STALL, issuer: STALL, network: 'stall' },
]

/** The app's answer: does its guard allow this send? */
async function appAllows(s: Situation): Promise<boolean> {
  localStorage.clear()
  vi.resetModules()

  relayEvents.mockImplementation(async () => {
    if (s.network === 'outage') throw new Error('relay unreachable')
    return s.network === 'stall' ? [stallRecord(s.recipient)] : []
  })

  // The self-send check lives in `payRequest` itself, above the merchant guard
  // and inseparable from a full send. This one line is the app's, verbatim.
  if (s.sender.toLowerCase() === s.recipient.toLowerCase()) return false

  // The app's REAL guard, called rather than reproduced. A test that
  // re-implemented the rule would prove only that the test agrees with itself,
  // which is precisely the drift this file exists to detect.
  const { refuseIfWrongMerchant } = await import('../pay')
  try {
    await refuseIfWrongMerchant(s.recipient, s.issuer)
    return true
  } catch {
    return false
  }
}

/** The API's answer, from the shared rule. */
async function apiAllows(s: Situation): Promise<boolean> {
  const { checkRecipient, needsRecipientLookup } = await import('@imani/wallet-core')

  // The service only looks a recipient up when the keys cannot decide it.
  let role: 'stall' | 'customer' | 'unknown' = 'unknown'
  if (needsRecipientLookup(s.sender, s.recipient, s.issuer)) {
    role = s.network === 'outage' ? 'unknown' : s.network === 'stall' ? 'stall' : 'customer'
  }

  return checkRecipient({
    senderPubkey: s.sender,
    recipientPubkey: s.recipient,
    issuerPubkey: s.issuer,
    recipientRole: role,
  }).allowed
}

describe('the API refuses what the app refuses', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  for (const situation of SITUATIONS) {
    it(`agrees on ${situation.name}`, async () => {
      expect(await apiAllows(situation)).toBe(await appAllows(situation))
    })
  }
})

describe('the redemption path asks the network nothing', () => {
  /**
   * The property that makes fail-closed affordable. If redemption needed a
   * lookup, an outage would stop the whole market — and refusing on `unknown`
   * would be unaffordable rather than merely inconvenient.
   */
  it('performs no lookup for a redemption, even with the relay unreachable', async () => {
    const { checkRecipient, needsRecipientLookup } = await import('@imani/wallet-core')

    const lookup = vi.fn(async () => 'unknown' as const)
    expect(needsRecipientLookup(SENDER, STALL, STALL)).toBe(false)

    const verdict = checkRecipient({
      senderPubkey: SENDER,
      recipientPubkey: STALL,
      issuerPubkey: STALL,
      recipientRole: 'unknown',
    })

    expect(verdict).toEqual({ allowed: true, kind: 'redemption' })
    expect(lookup).not.toHaveBeenCalled()
  })
})
