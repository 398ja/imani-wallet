/**
 * A stall's own ledger judges a card sale by when it was made (#176 review).
 *
 * A card coupon carries a `delegated` warrant whose delegation expires. The
 * stall's issuance ledger recorded when each sale happened, so it asks whether
 * the delegation was in force THEN. Judging it against today's clock would
 * turn every past card sale "failed" the day the delegation runs out, and the
 * stall's books would show sales it really did authorise as forged.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { finalizeEvent } from 'nostr-tools/pure'

import { delegatedSaleDigest } from '../issuanceWarrant'
import { issuerDelegationTemplate } from '../issuerDelegation'
import { issuedVoucher } from '../issuedVoucher'
import { reconcileIssuances } from '../reconcileIssuance'
import type { WalletTransaction } from '../transactions'

const STALL_SK = '9'.repeat(63) + '1'
const STALL = bytesToHex(schnorr.getPublicKey(hexToBytes(STALL_SK)))
const DELEGATE_SK = 'd'.repeat(63) + '4'
const DELEGATE = bytesToHex(schnorr.getPublicKey(hexToBytes(DELEGATE_SK)))

const DAY = 86_400_000
const SIGNED_AT = 1_800_000_000_000
const EXPIRES_AT = SIGNED_AT + 30 * DAY
/** Long after the delegation lapsed: the day the stall reviews its books. */
const REVIEWED_AT = EXPIRES_AT + 90 * DAY

function cardWarrant(): string {
  const nonce = 'card-nonce'
  const ref = 'pi_3PzCard'
  const delegation = finalizeEvent(
    issuerDelegationTemplate({
      delegatePubkey: DELEGATE,
      expiresAt: Math.floor(EXPIRES_AT / 1000),
      createdAt: Math.floor(SIGNED_AT / 1000),
    }),
    hexToBytes(STALL_SK),
  )
  return JSON.stringify({
    form: 'delegated',
    sale_total: 2500,
    face_decimals: 2,
    unit: 'GBP',
    nonce,
    sig: bytesToHex(
      schnorr.sign(
        delegatedSaleDigest(STALL, 2500, 2, 'GBP', nonce, ref),
        hexToBytes(DELEGATE_SK),
      ),
    ),
    delegation,
    ref,
  })
}

function cardSale(at: number): WalletTransaction {
  return {
    id: 'issued:card-1',
    type: 'issued',
    direction: 'out',
    at,
    amount: 2500,
    unit: 'GBP',
    decimals: 2,
    voucherId: 'card-1',
    issuanceWarrant: cardWarrant(),
  } as unknown as WalletTransaction
}

describe('a card sale in the stall ledger after its delegation lapsed', () => {
  // The real clock stands at the review date, months after the delegation
  // lapsed, because that is the clock a ledger that ignored the sale date
  // would judge by.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(REVIEWED_AT)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Sold ten days into a 30-day delegation, reviewed months later: still the
  // stall's authorised sale on the coupon page.
  it('still reads verified on the coupon page', () => {
    const record = issuedVoucher([cardSale(SIGNED_AT + 10 * DAY)], 'card-1', {
      now: REVIEWED_AT,
      stallPubkey: STALL,
    })
    expect(record?.warrantVerdict).toEqual({ verdict: 'verified' })
  })

  // The same sale in the reconciliation report counts as authorised takings.
  it('still counts as authorised in reconciliation', () => {
    const [row] = reconcileIssuances([cardSale(SIGNED_AT + 10 * DAY)], STALL)
    expect(row.verdict).toBe('authorised')
  })

  // A row claiming to be sold after the delegation ended was not authorised
  // by it, and the ledger says so.
  it('reads failed when the recorded sale is after the delegation expired', () => {
    const record = issuedVoucher([cardSale(EXPIRES_AT + DAY)], 'card-1', {
      now: REVIEWED_AT,
      stallPubkey: STALL,
    })
    expect(record?.warrantVerdict.verdict).toBe('failed')
  })
})
