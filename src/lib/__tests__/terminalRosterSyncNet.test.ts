/**
 * @vitest-environment jsdom
 */
/**
 * The roster event on the wire (#160 phase 6, plan 2.2, F9): kind 30078, `d=imani:terminals`,
 * sealed to the stall, and chunked when a roster of live tokens outgrows one relay event.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, getPublicKey, nip44, type Event } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

const SK = '7'.repeat(64)
const PK = getPublicKey(hexToBytes(SK))
const relayStore: Event[] = []
const gatewayStore: Event[] = []

vi.mock('../nap', () => ({
  getSigner: () => {
    const key = hexToBytes(SK)
    const conv = () => nip44.getConversationKey(key, PK)
    return {
      pubkey: PK,
      nip44Encrypt: (_p: string, plain: string) => nip44.encrypt(plain, conv()),
      nip44Decrypt: (_p: string, cipher: string) => nip44.decrypt(cipher, conv()),
      signEvent: async (t: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(t, key),
    }
  },
}))
vi.mock('../relay', () => ({
  // #428: `allEvents` IS the gateway read now; both stores land in one answer.
  allEvents: async () => [...relayStore, ...gatewayStore],
  publish: async (e: Event) => (relayStore.push(e), { ok: 1, total: 1, errors: [] }),
}))
vi.mock('../gatewayNostr', () => ({ gatewayEvents: async () => [...gatewayStore] }))
vi.mock('../transferSignature', () => ({ mirrorToGateway: async (e: Event) => (gatewayStore.push(e), true) }))
vi.mock('../legacyBridge', () => ({ legacyApi: async () => ({}) }))
const collectEnrolled = vi.hoisted(() => vi.fn(async () => 0))
vi.mock('../terminalDeliveryNet', () => ({ collectEnrolled }))
vi.mock('../terminalRevoke', () => ({ markSpentElsewhere: async () => 0 }))

const { fetchRosterPlaintext, publishRosterPlaintext, syncRosterNow, ROSTER_KIND, ROSTER_D_TAG } = await import('../terminalRosterSyncNet')
const { rosterPayload } = await import('../terminalRosterSync')
const { RELAY_MAX_EVENT_BYTES } = await import('../chunkedRecord')

beforeEach(() => {
  relayStore.length = 0
  gatewayStore.length = 0
})

function bigRoster(n: number): string {
  return rosterPayload({
    rows: Array.from({ length: n }, (_, i) => {
      const token = 'cashuB' + 'x'.repeat(2400) + i
      return {
        terminalPubkey: i.toString(16).padStart(64, '0'), name: `Till ${i}`, role: 'issue-and-redeem' as const,
        enrolledAt: i, status: 'in-service' as const, voucherId: `v${i}`, token,
        credentials: [{ voucherId: `v${i}`, issuedAt: i, token }],
      }
    }),
    forgotten: [],
  })
}

describe('the roster event', () => {
  it('is one sealed kind-30078 event with d=imani:terminals when small, and reads back', async () => {
    const plain = bigRoster(2)
    expect(await publishRosterPlaintext(plain)).toBe(true)
    expect(relayStore).toHaveLength(1)
    expect(relayStore[0].kind).toBe(ROSTER_KIND)
    expect(relayStore[0].tags).toContainEqual(['d', ROSTER_D_TAG])
    expect(relayStore[0].content).not.toContain('Till 0')
    expect(await fetchRosterPlaintext(PK)).toBe(plain)
  })

  it('is chunked under the relay limit when 40 live tokens would not fit one event (F9)', async () => {
    const plain = bigRoster(40)
    expect(plain.length).toBeGreaterThan(65_535)
    expect(await publishRosterPlaintext(plain)).toBe(true)
    expect(relayStore.length).toBeGreaterThan(0)
    for (const e of relayStore) expect(JSON.stringify(e).length).toBeLessThan(RELAY_MAX_EVENT_BYTES)
    expect(await fetchRosterPlaintext(PK)).toBe(plain)
  })

  it('reads the newest copy, from whichever store has it', async () => {
    await publishRosterPlaintext(bigRoster(1))
    relayStore.length = 0
    expect(await fetchRosterPlaintext(PK)).toBe(bigRoster(1))
  })

  it('answers null for a stall that never published one', async () => {
    relayStore.push(finalizeEvent({ kind: 1, created_at: 1, tags: [], content: 'x' }, hexToBytes(SK)))
    expect(await fetchRosterPlaintext(PK)).toBeNull()
  })
})

/**
 * Found by the local gate (#160 phase 6, E4). A restored phone merged a roster whose till was
 * still Waiting when it was published. The till's "enrolled" DM had come and gone, and only the
 * Terminals screen's poll ever read it, so the till read Waiting there for good. The login sync
 * collects the enrolled notices once the merge is in.
 */
describe('the login sync', () => {
  it('collects the enrolled notices after merging, so a merged Waiting till can read In service', async () => {
    collectEnrolled.mockClear()
    await syncRosterNow(PK)
    expect(collectEnrolled).toHaveBeenCalledWith(PK)
  })
})
