/**
 * #648: a stall that enrols for card sales after taking card payments mints the backlog after it
 * signs the delegation. `cardSalePull` then re-dates each row to the Stripe payment time, which is
 * before the delegation, and the warrant was judged at that time: "does not match its signature".
 * The warrant is judged at the mint time (`senderSaleAt`), and `at` stays the payment time.
 * Shape of corda on staging: paid Oct 17, delegation signed Oct 18 13:31:45, minted 4 s later.
 */
import { describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { finalizeEvent } from 'nostr-tools/pure'

import { delegatedSaleDigest } from '../issuanceWarrant'
import { issuerDelegationTemplate } from '../issuerDelegation'
import { issuedVoucher } from '../issuedVoucher'
import { reconcileIssuances } from '../reconcileIssuance'
import type { TransactionRow } from '@imani/wallet-storage'
import { toTransaction, warrantIssuedAt } from '../transactions'

const STALL_SK = 'a'.repeat(63) + '1'
const STALL = bytesToHex(schnorr.getPublicKey(hexToBytes(STALL_SK)))
const DELEGATE_SK = 'd'.repeat(63) + '4'
const DELEGATE = bytesToHex(schnorr.getPublicKey(hexToBytes(DELEGATE_SK)))

const SIGNED_S = Date.UTC(2026, 9, 18, 13, 31, 45) / 1000
const MINTED_MS = Date.UTC(2026, 9, 18, 13, 31, 49)
const PAID_MS = Date.UTC(2026, 9, 17, 6, 24)
const NOW_MS = Date.UTC(2026, 10, 20, 12)
const REF = 'pi_3URR2WQ4card'
const NONCE = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'

function warrant(): string {
  const delegation = finalizeEvent(
    issuerDelegationTemplate({ delegatePubkey: DELEGATE, expiresAt: SIGNED_S + 400 * 86_400, createdAt: SIGNED_S }),
    hexToBytes(STALL_SK),
  )
  const sig = bytesToHex(schnorr.sign(delegatedSaleDigest(STALL, 1000, 2, 'GBP', NONCE, REF), hexToBytes(DELEGATE_SK)))
  return JSON.stringify({ form: 'delegated', sale_total: 1000, face_decimals: 2, unit: 'GBP', nonce: NONCE, sig, delegation, ref: REF })
}

function cardRow(over: Record<string, unknown> = {}) {
  return toTransaction({
    id: 'issued:3f8ba365',
    type: 'issued',
    amount: 1000,
    unit: 'GBP',
    decimals: 2,
    voucherId: '3f8ba365-a55a-408d-a7c2-6079ff58e094',
    timestamp: Math.floor(MINTED_MS / 1000),
    issuanceWarrant: warrant(),
    ...over,
  } as unknown as TransactionRow)
}

/** What `cardSalePull` writes when it re-dates the row to the payment. */
const reDated = { timestamp: Math.floor(PAID_MS / 1000), senderSaleAt: MINTED_MS, saleTimeSource: 'payment-adapter' }

describe('#648 a card backlog minted right after the stall enrolled', () => {
  it('verifies at the mint time before any re-dating', () => {
    const rec = issuedVoucher([cardRow()], '3f8ba365-a55a-408d-a7c2-6079ff58e094', { now: NOW_MS, stallPubkey: STALL })
    expect(rec?.warrantVerdict.verdict).toBe('verified')
  })

  it('still verifies once re-dated to the payment, and keeps the payment time for the books', () => {
    const row = cardRow(reDated)
    expect(row.at).toBe(PAID_MS)
    expect(row.senderSaleAt).toBe(MINTED_MS)
    expect(warrantIssuedAt(row)).toBe(MINTED_MS)
    const rec = issuedVoucher([row], row.voucherId!, { now: NOW_MS, stallPubkey: STALL })
    expect(rec?.warrantVerdict.verdict).toBe('verified')
  })

  it('reconciles as authorised, not a mismatch', () => {
    const [result] = reconcileIssuances([cardRow(reDated)], STALL)
    expect(result?.verdict).toBe('authorised')
  })

  it('still refuses a coupon minted before the delegation was signed', () => {
    const early = cardRow({ timestamp: SIGNED_S - 3600 })
    const rec = issuedVoucher([early], early.voucherId!, { now: NOW_MS, stallPubkey: STALL })
    expect(rec?.warrantVerdict.verdict).toBe('failed')
  })

  it('a row with no time at all is judged now, as before', () => {
    expect(warrantIssuedAt({ at: 0 })).toBeUndefined()
  })
})
