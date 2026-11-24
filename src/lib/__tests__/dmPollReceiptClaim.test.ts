import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { receiptPayerOf, receivedRowIdFor } from '../dmPoll'

describe('spec 049: the payee receipt names its incoming row', () => {
  const T = 'ab'.repeat(16)
  it('finds the incoming row by transfer id, not an outgoing one', () => {
    const rows = [
      { id: 'sent:x', type: 'sent', direction: 'out', transferId: T },
      { id: 'other', type: 'received', transferId: 'cd'.repeat(16) },
      { id: 'voucher:new-token-id', type: 'received', transferId: T },
    ]
    expect(receivedRowIdFor(rows, T)).toBe('voucher:new-token-id')
  })
  it('reads the snake_case field and answers undefined when no row matches', () => {
    expect(receivedRowIdFor([{ id: 'r', transfer_id: T }], T)).toBe('r')
    expect(receivedRowIdFor([{ id: 'r', transferId: 'zz' }], T)).toBeUndefined()
  })
})

describe('spec 049: the acknowledgement goes to the payer, not the relaying gateway', () => {
  const PAYER = '11'.repeat(32)
  const GATEWAY = '22'.repeat(32)
  const STALL = '33'.repeat(32)
  it("a gateway-relayed wrap: the payload's sender_pubkey, not the wrap's signer", () => {
    expect(receiptPayerOf({ senderPubkey: PAYER, issuerId: STALL }, GATEWAY)).toBe(PAYER)
  })
  it('a bare wallet-to-wallet wrap: the envelope signer', () => {
    expect(receiptPayerOf({}, PAYER)).toBe(PAYER)
    expect(receiptPayerOf(undefined, PAYER)).toBe(PAYER)
  })
  it('never the coupon issuer, and nobody when nothing names a payer', () => {
    expect(receiptPayerOf({ issuerId: STALL, senderPubkey: '' }, undefined)).toBeUndefined()
  })
})
