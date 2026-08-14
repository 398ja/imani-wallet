import { describe, it, expect } from 'vitest'

import { toRecord, ISSUED_D_PREFIX } from '../issuedRecords'
import { buildIssueTransaction, toTransaction, type WalletTransaction } from '../transactions'

const BASE = {
  voucherId: 'v-1',
  amount: 2500,
  unit: 'XAF',
  decimals: 0,
  recipientPubkey: 'f'.repeat(64),
  memo: 'Sack of yams',
  /** Epoch SECONDS, as the gateway reports it. */
  expiresAt: 1_789_246_394,
  at: 1_786_654_307_000,
}

describe('toRecord', () => {
  it('survives the full round trip through a transaction row', () => {
    // row -> record is the path a sale takes to the relay; record -> row is the
    // path it takes coming back on a new device. Anything lost here is lost
    // from the merchant's books permanently.
    const row = toTransaction(buildIssueTransaction(BASE))
    const record = toRecord(row)

    expect(record).toEqual({
      voucherId: 'v-1',
      amount: 2500,
      unit: 'XAF',
      decimals: 0,
      recipientPubkey: 'f'.repeat(64),
      memo: 'Sack of yams',
      expiresAt: 1_789_246_394,
      at: 1_786_654_307_000,
    })
  })

  it('converts the expiry back to SECONDS', () => {
    // toTransaction normalises it to ms for display; the wire format is seconds.
    // Publishing ms would restore a coupon expiring in the year 58000.
    const row = toTransaction(buildIssueTransaction(BASE))
    expect(row.expiresAt).toBe(1_789_246_394_000)
    expect(toRecord(row)?.expiresAt).toBe(1_789_246_394)
  })

  it('restores to a row identical to the original', () => {
    const original = toTransaction(buildIssueTransaction(BASE))
    const record = toRecord(original)!
    const restored = toTransaction(
      buildIssueTransaction({
        voucherId: record.voucherId,
        amount: record.amount,
        unit: record.unit,
        decimals: record.decimals,
        recipientPubkey: record.recipientPubkey,
        memo: record.memo,
        expiresAt: record.expiresAt,
        at: record.at,
      }),
    )
    expect(restored).toEqual(original)
    // Same id means a restore overwrites rather than duplicating.
    expect(restored.id).toBe(original.id)
  })

  it('keeps an absent expiry absent rather than inventing 1970', () => {
    const row = toTransaction(buildIssueTransaction({ ...BASE, expiresAt: undefined }))
    expect(toRecord(row)?.expiresAt).toBeUndefined()
  })

  it('refuses a row with no voucher id — it would have no address on the relay', () => {
    expect(toRecord({ id: 'x', type: 'issued', direction: 'out', at: 1, amount: 1, unit: 'EUR', decimals: 2 } as WalletTransaction)).toBeNull()
  })
})

describe('ISSUED_D_PREFIX', () => {
  it('namespaces issuance records apart from the stall record', () => {
    // Both are kind-30078 under the same key. A prefix collision would make
    // `newestAddressable(…, 'imani:merchant')` and the issuance query fight over
    // the same events.
    expect(ISSUED_D_PREFIX).toBe('imani:issued:')
    expect('imani:merchant'.startsWith(ISSUED_D_PREFIX)).toBe(false)
  })
})
