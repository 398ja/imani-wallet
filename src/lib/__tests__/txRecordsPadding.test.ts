import { beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, getPublicKey, nip44, type Event } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'
import type { TransactionRow } from '@imani/wallet-storage'

/**
 * Kind-7376 records are padded to size buckets (#99, the #91 re-review's R6
 * residual), so a row carrying a sender's transfer signature is not told
 * apart by its length. Uses real NIP-44 v2, since its own padding is part of
 * what is being measured.
 */

const SK = hexToBytes('2'.repeat(64))
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

const restored: TransactionRow[] = []
vi.mock('../wallet', () => ({
  addRestoredTransaction: async (row: TransactionRow) => void restored.push(row),
  notifyWalletChanged: () => {},
  getWallet: () => ({ getAllTransactions: async () => [] }),
  recordTransferSignature: async () => {},
  backUpTransferSignature: async () => {},
  listTransactions: async () => [],
}))

const { buildTxEvent, restoreTx, TX_PAD_BUCKETS } = await import('../txRecords')
const { toTransaction, buildPaymentTransaction, buildIssueTransaction, buildCashbackTransaction } = await import(
  '../transactions'
)
const { signTransfer, transferIdFor } = await import('../transferSignature')

const TRANSFER = transferIdFor('cashuB-the-gift-token')
const PAYLOAD = JSON.stringify(
  signTransfer(hexToBytes('1'.repeat(64)), { transfer: TRANSFER, recipient: ME, amount: 250, unit: 'EUR', decimals: 2 }),
)

/** A customer's received row, as the redemption writes it. */
const received = {
  id: `received:${TRANSFER}`,
  txId: `received:${TRANSFER}`,
  type: 'received',
  direction: 'in',
  timestamp: 1786891362000,
  amount: 250,
  unit: 'EUR',
  decimals: 2,
  merchantId: 'bb'.repeat(32),
  counterparty: 'aa'.repeat(32),
  voucherId: '71fa3948-0f65-4b54-b1eb-09d19a01e210',
  tokenId: TRANSFER,
  memo: 'Birthday',
  transferId: TRANSFER,
} as unknown as TransactionRow
const withSignature = { ...received, transferSignature: PAYLOAD } as unknown as TransactionRow

const lengthOf = (row: TransactionRow) => buildTxEvent(toTransaction(row))!.content.length

beforeEach(() => {
  relayEvents = []
  restored.length = 0
})

describe('7376 size buckets', () => {
  it('a row with the transfer signature and the same row without it produce equal ciphertext length', () => {
    expect(lengthOf(withSignature)).toBe(lengthOf(received))
  })

  it('every ordinary row type lands in the same bucket', () => {
    const payment = buildPaymentTransaction({
      tokenId: '95867a5a515d3fc9fd8fa203b4c25225',
      amount: 50,
      unit: 'GBP',
      decimals: 2,
      merchantId: '99'.repeat(32),
      merchantName: 'Kofi',
      voucherId: 'df8f2cbe-1111-2222-3333-444455556666',
      memo: 'Tomatoes',
      at: 1786891362412,
    })
    const issued = buildIssueTransaction({
      voucherId: 'df8f2cbe-1111-2222-3333-444455556666',
      amount: 2500,
      unit: 'XOF',
      decimals: 0,
      recipientPubkey: 'cc'.repeat(32),
      at: 1786891362412,
    })
    const cashback = buildCashbackTransaction({
      cashbackId: 'cb-77',
      claimCode: 'A1B2C3',
      amount: 500,
      unit: 'XAF',
      decimals: 0,
      at: 1786891362412,
    })
    const lengths = new Set([received, withSignature, payment, issued, cashback].map(lengthOf))
    expect(lengths.size).toBe(1)
    // 2048 bytes of plaintext, as NIP-44 v2 seals it.
    expect([...lengths]).toEqual([2820])
  })

  it('stays far inside the relay event limit (64 KB), even for the largest bucket', () => {
    const huge = { ...withSignature, memo: 'x'.repeat(TX_PAD_BUCKETS.at(-1)! - 3000) } as unknown as TransactionRow
    expect(lengthOf(huge)).toBeLessThan(32 * 1024)
  })
})

describe('restore', () => {
  async function publishedEvent(row: TransactionRow): Promise<Event> {
    return finalizeEvent(buildTxEvent(toTransaction(row))!, SK)
  }

  it('round-trips a padded record, and the pad never reaches the row', async () => {
    relayEvents = [await publishedEvent(withSignature)]
    // Written padded...
    const sealed = JSON.parse(nip44.decrypt(relayEvents[0]!.content, conversation)) as { pad?: string }
    expect(sealed.pad?.length).toBeGreaterThan(0)
    // ...and read back without it.
    expect(await restoreTx(ME)).toBe(1)
    const row = restored[0] as unknown as Record<string, unknown>
    expect(row.transferSignature).toBe(PAYLOAD)
    expect(row.transferId).toBe(TRANSFER)
    expect(row.memo).toBe('Birthday')
    expect(Object.values(row)).not.toContain(expect.stringMatching(/^0{20,}$/))
    expect('pad' in row).toBe(false)
    expect(toTransaction(restored[0]!)).toEqual(toTransaction({ ...withSignature, timestamp: 1786891362000 } as never))
  })

  it('still reads an old, unpadded record', async () => {
    // Written by a build before #99: plain JSON, no `pad`.
    const tx = toTransaction(withSignature)
    const old = { ...buildTxEvent(tx)! }
    const { toContent } = await import('../txRecords')
    old.content = nip44.encrypt(JSON.stringify(toContent(tx)), conversation)
    relayEvents = [finalizeEvent(old, SK)]
    expect(await restoreTx(ME)).toBe(1)
    expect((restored[0] as unknown as Record<string, unknown>).transferSignature).toBe(PAYLOAD)
  })
})
