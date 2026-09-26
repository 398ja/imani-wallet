import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEventHash, getPublicKey, nip17, nip59, type Event } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

import { TRANSFER_RECEIPT_KIND } from '../attestationKind'

/**
 * The dmCrypto hand-off of a sender's transfer signature (#91 review, L1).
 *
 * `transferSignature.test.ts` calls `offerTransferSignature` directly and
 * `dmPollTransferReceipt.test.ts` mocks dmCrypto away, so neither notices if
 * the unwrap path stops handing the payload over. This drives a REAL NIP-17
 * gift wrap through the real adapter and watches for the receipt it makes
 * possible. Removing the hand-off in dmCrypto turns the first test red.
 */

const SENDER_SK = '1'.repeat(64)
const RECEIVER_SK = '2'.repeat(64)
const STRANGER_SK = '3'.repeat(64)
const SENDER = getPublicKey(hexToBytes(SENDER_SK))
const RECEIVER = getPublicKey(hexToBytes(RECEIVER_SK))

vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: getPublicKey(hexToBytes('2'.repeat(64))),
    withPrivkey: <T,>(borrow: (key: Uint8Array) => T): T => borrow(hexToBytes('2'.repeat(64))),
  }),
}))

const published: Event[] = []
vi.mock('../relay', () => ({
  publish: async (event: Event) => {
    published.push(event)
    return { ok: 1, total: 1, errors: [] }
  },
}))
vi.mock('../merchant', () => ({ loadMerchant: () => null }))
vi.mock('../wallet', () => ({
  recordTransferSignature: async () => {},
  backUpTransferSignature: async () => {},
  listTransactions: async () => [],
}))

const { createDmCryptoAdapter } = await import('../dmCrypto')
const { GiftWrapProcessor } = await import('@imani/dm-poll')
const {
  signTransfer,
  noteTransferReceived,
  resetHeldTransfers,
  transferIdFor,
  RECEIPT_DELAY_MAX_MS,
} = await import('../transferSignature')

const TOKEN = 'cashuB-the-gift-token'

function payload() {
  return JSON.stringify(
    signTransfer(hexToBytes(SENDER_SK), {
      transfer: transferIdFor(TOKEN),
      recipient: RECEIVER,
      amount: 250,
      unit: 'EUR',
      decimals: 2,
    }),
  )
}

/** Unwrap, let the un-awaited hand-off land, redeem, and let the receipt come due. */
async function deliverThenRedeem(wrap: Event) {
  const adapter = createDmCryptoAdapter()
  const dm = await adapter.unwrapNip17Dm(wrap as never, '')
  await vi.advanceTimersByTimeAsync(0)
  await noteTransferReceived({ token: TOKEN, sender: SENDER, credited: 250, unit: 'EUR', decimals: 2 })
  await vi.advanceTimersByTimeAsync(RECEIPT_DELAY_MAX_MS + 1)
  return { adapter, dm }
}

beforeEach(() => {
  vi.useFakeTimers()
  published.length = 0
  resetHeldTransfers()
})

afterEach(() => {
  resetHeldTransfers()
  vi.useRealTimers()
})

describe('a gift-wrapped transfer signature', () => {
  it('reaches the held store through the real unwrap path', async () => {
    const wrap = nip17.wrapEvent(hexToBytes(SENDER_SK), { publicKey: RECEIVER }, payload())
    await deliverThenRedeem(wrap as Event)
    expect(published.map((e) => e.kind)).toEqual([TRANSFER_RECEIPT_KIND])
  })

  it('yields no token, parses without throwing, and is dropped as a non-token DM', async () => {
    const wrap = nip17.wrapEvent(hexToBytes(SENDER_SK), { publicKey: RECEIVER }, payload())
    const { adapter, dm } = await deliverThenRedeem(wrap as Event)

    expect(dm?.content).toContain('imani_transfer_signature')
    expect(adapter.extractToken(dm!.content)).toBeNull()
    expect(() => adapter.parseTokenTransferMessage(dm!.content)).not.toThrow()
    // The processor's "no token" answer is what DmPollService files as
    // `non_token_dm`: marked processed, never retried, never redeemed.
    const processor = new GiftWrapProcessor({ cryptoAdapter: adapter, recipientPrivkey: '' })
    await expect(processor.process(wrap as never)).resolves.toBeNull()
  })

  it('is NOT handed over when the seal author differs from the rumor author (D2)', async () => {
    // nostr-tools' unwrap does not check this, so a stranger can seal a rumor
    // that claims to be from the sender. The payload's own sig would still
    // verify, which is exactly why the seal has to be checked.
    const rumor = {
      kind: 14,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', RECEIVER]],
      content: payload(),
      pubkey: SENDER,
    } as Event
    rumor.id = getEventHash(rumor)
    const seal = nip59.createSeal(rumor as never, hexToBytes(STRANGER_SK), RECEIVER)
    const wrap = nip59.createWrap(seal, RECEIVER)

    await deliverThenRedeem(wrap as Event)
    expect(published).toHaveLength(0)
  })
})
