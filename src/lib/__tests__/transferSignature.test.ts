import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nip17, type Event } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import { ATTESTATION_KIND, TRANSFER_RECEIPT_KIND } from '../attestationKind'
import { commitTo } from '../audit'

/**
 * Both signatures over a customer-to-customer transfer (#91), and what they
 * must never leak. ADR 0014 is the design these pin.
 */

const SENDER_SK = '1'.repeat(64)
const RECEIVER_SK = '2'.repeat(64)
const STRANGER_SK = '3'.repeat(64)
const pub = (sk: string) => bytesToHex(schnorr.getPublicKey(hexToBytes(sk)))
const SENDER = pub(SENDER_SK)
const RECEIVER = pub(RECEIVER_SK)
const STRANGER = pub(STRANGER_SK)

/** Whose wallet is "open". Swapped between sender and receiver per test. */
let currentSk = SENDER_SK
let signerThrows = false
vi.mock('../nap', () => ({
  getSigner: () => {
    if (signerThrows) throw new Error('No signer - the wallet is locked.')
    return {
      pubkey: pub(currentSk),
      withPrivkey: <T,>(borrow: (key: Uint8Array) => T) => borrow(hexToBytes(currentSk)),
    }
  },
}))

const published: Event[] = []
let publishOk = 1
let publishThrows = false
vi.mock('../relay', () => ({
  publish: async (event: Event) => {
    if (publishThrows) throw new Error('relay down')
    if (publishOk > 0) published.push(event)
    return { ok: publishOk, total: 1, errors: publishOk === 0 ? ['refused'] : [] }
  },
}))

const {
  signTransfer,
  parseTransferSignature,
  verifyTransferSignature,
  verifyTransferReceipt,
  transferIdFor,
  transferTag,
  transferBlind,
  sendTransferSignature,
  offerTransferSignature,
  noteTransferReceived,
  resetHeldTransfers,
} = await import('../transferSignature')

const TOKEN = 'cashuB-the-send-token'
const TRANSFER = transferIdFor(TOKEN)

function signed(over: Partial<Parameters<typeof signTransfer>[1]> = {}) {
  return signTransfer(hexToBytes(SENDER_SK), {
    transfer: TRANSFER,
    recipient: RECEIVER,
    amount: 250,
    unit: 'EUR',
    decimals: 2,
    ...over,
  })
}

beforeEach(() => {
  published.length = 0
  publishOk = 1
  publishThrows = false
  signerThrows = false
  currentSk = SENDER_SK
  resetHeldTransfers()
})

describe('the sender signature', () => {
  it('verifies at the receiver', () => {
    const p = signed()
    expect(verifyTransferSignature(p, { recipient: RECEIVER, transfer: TRANSFER, authorPubkey: SENDER }))
      .toEqual({ ok: true })
  })

  it('survives the trip through the gift-wrap payload', () => {
    const p = signed()
    const parsed = parseTransferSignature(JSON.stringify(p))
    expect(parsed).toEqual(p)
    expect(verifyTransferSignature(parsed!, { recipient: RECEIVER })).toEqual({ ok: true })
  })

  it.each([
    ['amount', { amount: 25_000 }],
    ['recipient', { recipient: STRANGER }],
    ['unit', { unit: 'XAF' }],
    ['transfer', { transfer: 'f'.repeat(32) }],
    ['transferKey', { transferKey: STRANGER }],
  ])('does NOT verify once %s is tampered with', (_field, patch) => {
    const tampered = { ...signed(), ...patch }
    const recipient = 'recipient' in patch ? STRANGER : RECEIVER
    expect(verifyTransferSignature(tampered, { recipient }).ok).toBe(false)
  })

  it('does NOT verify when someone else wrapped it', () => {
    // A signature the receiver got from a third party must not count: the
    // payload names its signer and the wrap has to agree.
    expect(verifyTransferSignature(signed(), { recipient: RECEIVER, authorPubkey: STRANGER }).ok)
      .toBe(false)
  })

  it('does NOT verify for the wrong transfer', () => {
    expect(verifyTransferSignature(signed(), { recipient: RECEIVER, transfer: 'e'.repeat(32) }).ok)
      .toBe(false)
  })

  it('refuses a version it does not know, so #94 can extend it safely', () => {
    const p = { ...signed(), v: 2 }
    expect(parseTransferSignature(JSON.stringify(p))).toBeUndefined()
  })

  it('refuses an oversized payload before parsing it', () => {
    const p = { ...signed(), padding: 'x'.repeat(4000) }
    expect(parseTransferSignature(JSON.stringify(p))).toBeUndefined()
  })

  it('uses a fresh nonce, so two sends of one coupon share no public tag', () => {
    const a = signed()
    const b = signed()
    expect(a.nonce).not.toBe(b.nonce)
    expect(transferTag(a.transfer, a.nonce)).not.toBe(transferTag(b.transfer, b.nonce))
    expect(a.transferKey).not.toBe(b.transferKey)
  })

  it('never uses the identity key as the per-transfer key', () => {
    expect(signed().transferKey).not.toBe(SENDER)
  })
})

describe('sending the signature', () => {
  it('gift-wraps it to the recipient, who can open and verify it', async () => {
    const ok = await sendTransferSignature({
      transfer: TRANSFER, recipient: RECEIVER, amount: 250, unit: 'EUR', decimals: 2,
    })
    expect(ok).toBe(true)
    expect(published).toHaveLength(1)
    expect(published[0]!.kind).toBe(1059)
    // The outer wrap names neither the sender nor the amount.
    expect(published[0]!.pubkey).not.toBe(SENDER)
    expect(published[0]!.content).not.toContain('250')

    const rumor = nip17.unwrapEvent(published[0]! as never, hexToBytes(RECEIVER_SK))
    const p = parseTransferSignature(rumor.content)!
    expect(verifyTransferSignature(p, { recipient: RECEIVER, transfer: TRANSFER, authorPubkey: rumor.pubkey }))
      .toEqual({ ok: true })
  })

  it('never throws, and reports false, when the relay refuses', async () => {
    publishThrows = true
    await expect(
      sendTransferSignature({ transfer: TRANSFER, recipient: RECEIVER, amount: 1, unit: 'EUR', decimals: 2 }),
    ).resolves.toBe(false)
  })

  it('never throws on a locked wallet', async () => {
    signerThrows = true
    await expect(
      sendTransferSignature({ transfer: TRANSFER, recipient: RECEIVER, amount: 1, unit: 'EUR', decimals: 2 }),
    ).resolves.toBe(false)
  })

  it('sends nothing when an older gateway returned no transfer id', async () => {
    await expect(
      sendTransferSignature({ transfer: undefined, recipient: RECEIVER, amount: 1, unit: 'EUR', decimals: 2 }),
    ).resolves.toBe(false)
    expect(published).toHaveLength(0)
  })
})

describe('the receiver attestation', () => {
  it('publishes a kind-7378, never a 7377, once both halves are here', async () => {
    currentSk = RECEIVER_SK
    await offerTransferSignature(signed(), SENDER)
    expect(published).toHaveLength(0) // Not yet redeemed.

    await expect(noteTransferReceived({ token: TOKEN, credited: 250, unit: 'EUR' })).resolves.toBe(true)
    expect(published).toHaveLength(1)
    expect(published[0]!.kind).toBe(TRANSFER_RECEIPT_KIND)
    expect(published.some((e) => e.kind === ATTESTATION_KIND)).toBe(false)
    expect(verifyTransferReceipt(published[0]!)).toBe(true)
  })

  it('pairs in either order', async () => {
    currentSk = RECEIVER_SK
    await noteTransferReceived({ token: TOKEN, credited: 250, unit: 'EUR' })
    expect(published).toHaveLength(0)
    await offerTransferSignature(signed(), SENDER)
    expect(published).toHaveLength(1)
  })

  it('names neither party, the amount, the voucher, or the transfer id', async () => {
    currentSk = RECEIVER_SK
    const p = signed()
    await offerTransferSignature(p, SENDER)
    await noteTransferReceived({ token: TOKEN, credited: 250, unit: 'EUR' })
    const event = published[0]!
    const wire = JSON.stringify(event)
    expect(event.pubkey).not.toBe(RECEIVER)
    for (const secret of [SENDER, RECEIVER, TRANSFER, p.nonce, p.sig, TOKEN]) {
      expect(wire).not.toContain(secret)
    }
    expect(JSON.parse(event.content)).not.toHaveProperty('amount')
  })

  it('links to the sender only through the per-transfer key', async () => {
    currentSk = RECEIVER_SK
    const p = signed()
    await offerTransferSignature(p, SENDER)
    await noteTransferReceived({ token: TOKEN, credited: 250, unit: 'EUR' })
    const content = JSON.parse(published[0]!.content)
    expect(content.senderKey).toBe(p.transferKey)
    expect(content.tag).toBe(transferTag(TRANSFER, p.nonce))
  })

  it('commits to the amount so either party can open it, and nobody else', async () => {
    currentSk = RECEIVER_SK
    const p = signed()
    await offerTransferSignature(p, SENDER)
    await noteTransferReceived({ token: TOKEN, credited: 250, unit: 'EUR' })
    const content = JSON.parse(published[0]!.content)
    expect(content.commitment).toBe(commitTo(250, transferBlind(p.nonce)))
    expect(content.commitment).not.toBe(commitTo(250, transferBlind('0'.repeat(64))))
  })

  it('publishes no commitment when the parties disagree on the amount', async () => {
    currentSk = RECEIVER_SK
    await offerTransferSignature(signed(), SENDER)
    await noteTransferReceived({ token: TOKEN, credited: 200, unit: 'EUR' })
    expect(JSON.parse(published[0]!.content)).not.toHaveProperty('commitment')
  })

  it('publishes no commitment for an unverified voucher', async () => {
    currentSk = RECEIVER_SK
    await offerTransferSignature(signed(), SENDER)
    await noteTransferReceived({ token: TOKEN })
    expect(JSON.parse(published[0]!.content)).not.toHaveProperty('commitment')
  })

  it('publishes NOTHING without a sender signature', async () => {
    // A unilateral "I received something" links to nothing, and would record
    // a gift the sender never asked to have recorded.
    currentSk = RECEIVER_SK
    await expect(noteTransferReceived({ token: TOKEN, credited: 250, unit: 'EUR' })).resolves.toBe(false)
    expect(published).toHaveLength(0)
  })

  it('ignores a tampered signature instead of publishing it', async () => {
    currentSk = RECEIVER_SK
    await offerTransferSignature({ ...signed(), amount: 99_999 }, SENDER)
    await noteTransferReceived({ token: TOKEN, credited: 250, unit: 'EUR' })
    expect(published).toHaveLength(0)
  })

  it('ignores a signature addressed to someone else', async () => {
    currentSk = RECEIVER_SK
    await offerTransferSignature(signed({ recipient: STRANGER }), SENDER)
    await noteTransferReceived({ token: TOKEN, credited: 250, unit: 'EUR' })
    expect(published).toHaveLength(0)
  })

  it('never throws when the publish fails', async () => {
    currentSk = RECEIVER_SK
    publishThrows = true
    await offerTransferSignature(signed(), SENDER)
    await expect(noteTransferReceived({ token: TOKEN, credited: 250, unit: 'EUR' })).resolves.toBe(false)
  })

  it('never throws on a locked wallet', async () => {
    signerThrows = true
    await expect(noteTransferReceived({ token: TOKEN })).resolves.toBe(false)
    await expect(offerTransferSignature(signed(), SENDER)).resolves.toBe(false)
  })

  it('a per-transfer receiver key: two receipts share no author', async () => {
    currentSk = RECEIVER_SK
    const tokenB = 'cashuB-another'
    await offerTransferSignature(signed(), SENDER)
    await offerTransferSignature(signed({ transfer: transferIdFor(tokenB) }), SENDER)
    await noteTransferReceived({ token: TOKEN })
    await noteTransferReceived({ token: tokenB })
    expect(published).toHaveLength(2)
    expect(published[0]!.pubkey).not.toBe(published[1]!.pubkey)
  })

  it('a receipt with a forged sender half does not verify', async () => {
    currentSk = RECEIVER_SK
    await offerTransferSignature(signed(), SENDER)
    await noteTransferReceived({ token: TOKEN })
    const forged = { ...published[0]!, content: JSON.stringify({ ...JSON.parse(published[0]!.content), senderKey: STRANGER }) }
    expect(verifyTransferReceipt(forged)).toBe(false)
  })
})
