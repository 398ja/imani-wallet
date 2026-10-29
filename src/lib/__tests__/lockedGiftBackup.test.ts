import { beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, getPublicKey, nip44, type Event } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'
import type { TransactionRow } from '@imani/wallet-storage'

/**
 * A minted-locked gift's history row on the relay backup (#410 G14). Found on the local stack: the
 * buyer's wallet took an unclaimed gift back, the row's record said `returned`, and the Activity
 * line still said "Sent to your recipient, claim by ...". The backup carried the memo but not the
 * record, and the settled row was never re-published, so the next login's restore wrote the old
 * memo back over the new one. Real NIP-44, as `txRecordsPadding.test.ts`.
 */

const SK = hexToBytes('3'.repeat(64))
const ME = getPublicKey(SK)
const conversation = nip44.getConversationKey(SK, ME)

vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: ME,
    nip44Encrypt: (_peer: string, text: string) => nip44.encrypt(text, conversation),
    nip44Decrypt: (_peer: string, text: string) => nip44.decrypt(text, conversation),
    signEvent: async (t: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(t, SK),
  }),
}))

let relayEvents: Event[] = []
vi.mock('../relay', () => ({
  publish: async () => ({ ok: 1, total: 1, errors: [] }),
  allAddressable: async () => relayEvents,
}))

const local = new Map<string, Record<string, unknown>>()
vi.mock('../wallet', () => ({
  // The real restore writer merges into the stored row (`upsertRow`); so does this.
  addRestoredTransaction: async (row: Record<string, unknown>) => {
    const next = { ...(local.get(String(row.id)) ?? {}) }
    for (const [k, v] of Object.entries(row)) if (v !== undefined) next[k] = v
    local.set(String(row.id), next)
    return next
  },
  notifyWalletChanged: () => {},
  getWallet: () => ({
    getAllTransactions: async () => [...local.values()],
    getTransaction: async (id: string) => local.get(id) ?? null,
  }),
}))

const { buildTxEvent, restoreTx } = await import('../txRecords')
const { toTransaction } = await import('../transactions')
const { lockedGiftMemo, laterLockedGift } = await import('../lockedGiftRecord')
type Rec = import('../lockedGiftRecord').LockedGiftRecord

const X = 1_800_000_000
const ID = 'locked-gift:out:0123456789abcdef0123456789abcdef'
// A stand-in: the backup never parses the token, only carries it.
const TOKEN = 'cashuB' + 'o'.repeat(1400)

function row(rec: Rec): TransactionRow {
  return {
    id: ID,
    txId: ID,
    type: 'gift_sent',
    direction: 'out',
    timestamp: 1_799_000_000_000,
    amount: 500,
    unit: 'GBP',
    decimals: 2,
    merchantId: 'bb'.repeat(32),
    merchantName: 'Card Test Bakery',
    lockedGift: rec,
    memo: lockedGiftMemo(rec),
  } as unknown as TransactionRow
}

const waiting: Rec = { dir: 'out', token: TOKEN, x: X, status: 'waiting', stall: 'Card Test Bakery', to: null }
const returned: Rec = { ...waiting, status: 'returned', closedAt: X * 1000 + 5_000 }

const event = (r: TransactionRow) => finalizeEvent(buildTxEvent(toTransaction(r))!, SK)

beforeEach(() => {
  relayEvents = []
  local.clear()
})

describe('a minted-locked gift on the relay backup', () => {
  it('carries the gift record there and back, so a restored device can still sweep it', async () => {
    relayEvents = [event(row(waiting))]
    expect(await restoreTx(ME)).toBe(1)
    const tx = toTransaction(local.get(ID) as unknown as TransactionRow)
    expect(tx.lockedGift).toEqual(waiting)
    expect(tx.memo).toMatch(/^Sent to your recipient, claim by /)
  })

  it('an older copy (still waiting) never reopens a gift taken back on this device', async () => {
    local.set(ID, row(returned) as unknown as Record<string, unknown>)
    relayEvents = [event(row(waiting))]
    await restoreTx(ME)
    const tx = toTransaction(local.get(ID) as unknown as TransactionRow)
    expect(tx.lockedGift?.status).toBe('returned')
    expect(tx.memo).toBe('Not claimed, taken back into your wallet')
  })

  it('a copy from a build that kept no record cannot put the old line back either', async () => {
    // The exact state seen on the local stack: the backup had the memo and nothing else.
    local.set(ID, row(returned) as unknown as Record<string, unknown>)
    const old = toTransaction(row(waiting))
    delete (old as { lockedGift?: unknown }).lockedGift
    relayEvents = [finalizeEvent(buildTxEvent(old)!, SK)]
    await restoreTx(ME)
    expect(toTransaction(local.get(ID) as unknown as TransactionRow).memo).toBe('Not claimed, taken back into your wallet')
  })

  it('a settled copy from another device does close the local one', async () => {
    local.set(ID, row(waiting) as unknown as Record<string, unknown>)
    relayEvents = [event(row(returned))]
    await restoreTx(ME)
    expect(toTransaction(local.get(ID) as unknown as TransactionRow).lockedGift?.status).toBe('returned')
  })
})

describe('laterLockedGift', () => {
  it.each([
    ['waiting', 'returning', 'returning'],
    ['returning', 'waiting', 'returning'],
    ['claimed', 'waiting', 'claimed'],
    ['waiting', 'gone', 'gone'],
    ['returned', 'claimed', 'returned'],
  ] as const)('local %s, incoming %s: keeps %s', (a, b, kept) => {
    expect(laterLockedGift({ ...waiting, status: a }, { ...waiting, status: b })?.status).toBe(kept)
  })
})
