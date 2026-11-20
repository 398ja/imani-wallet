/**
 * @vitest-environment node
 */
/**
 * A card sale's customer receipt reaches the stall (card receipts).
 *
 * Staging, 2026-11-20, voucher ee84bf74: a card sale was delivered by the purchase issuer, whose
 * NIP-98 key is the stall's delegate. gateway-customer stamped that key as `sender_pubkey`, so the
 * customer's receipt (and its attestation) was posted to the delegate, whose queue nobody drains.
 * The stall drained nothing. A cash sale is sent by the stall itself and was never affected.
 */
import { describe, expect, it, vi } from 'vitest'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'

import { issuerDelegationTemplate } from '../issuerDelegation'

const STALL_SK = '7'.repeat(63) + '1'
const STALL = getPublicKey(hexToBytes(STALL_SK))
const OTHER_SK = '5'.repeat(63) + '3'
const OTHER = getPublicKey(hexToBytes(OTHER_SK))
const DELEGATE = getPublicKey(hexToBytes('11'.repeat(32)))
const FRIEND = 'f'.repeat(64)
const NOW = 1_800_000_000_000

function delegationBy(sk: string): unknown {
  return finalizeEvent(
    issuerDelegationTemplate({
      delegatePubkey: DELEGATE,
      expiresAt: Math.floor(NOW / 1000) + 400 * 86_400,
      createdAt: Math.floor(NOW / 1000) - 60,
    }),
    hexToBytes(sk),
  )
}

function delegatedWarrant(delegation: unknown): string {
  return JSON.stringify({
    form: 'delegated',
    sale_total: 500,
    face_decimals: 2,
    unit: 'GBP',
    nonce: 'n1',
    sig: 'ab'.repeat(32),
    ref: 'pi_x',
    delegation,
  })
}

const voucher = { current: {} as Record<string, unknown> }
vi.mock('../voucherToken', () => ({
  parseVoucherToken: (token: string) => {
    if (token === 'bad') throw new Error('unreadable')
    return { voucher: voucher.current }
  },
}))

const { receiptAddressee } = await import('../receiptAddressee')

describe('receiptAddressee', () => {
  it('sends a card sale receipt to the stall, not the delegate that delivered it', () => {
    voucher.current = { issuerId: STALL, issuanceWarrant: delegatedWarrant(delegationBy(STALL_SK)) }
    expect(receiptAddressee(DELEGATE, 'tok', NOW)).toBe(STALL)
  })

  it('leaves a cash sale (stall-signed warrant, stall sender) unchanged', () => {
    voucher.current = {
      issuerId: STALL,
      issuanceWarrant: JSON.stringify({
        form: 'merchant', sale_total: 500, face_decimals: 2, unit: 'GBP', nonce: 'n', sig: 'ab',
      }),
    }
    expect(receiptAddressee(STALL, 'tok', NOW)).toBe(STALL)
  })

  it('leaves a friend who passed on a card-bought coupon as the addressee', () => {
    voucher.current = { issuerId: STALL, issuanceWarrant: delegatedWarrant(delegationBy(STALL_SK)) }
    expect(receiptAddressee(FRIEND, 'tok', NOW)).toBe(FRIEND)
  })

  it('does not redirect on a delegation the issuer did not sign', () => {
    voucher.current = { issuerId: STALL, issuanceWarrant: delegatedWarrant(delegationBy(OTHER_SK)) }
    expect(OTHER).not.toBe(STALL)
    expect(receiptAddressee(DELEGATE, 'tok', NOW)).toBe(DELEGATE)
  })

  it('keeps the sender when the token cannot be read', () => {
    expect(receiptAddressee(DELEGATE, 'bad', NOW)).toBe(DELEGATE)
  })
})
