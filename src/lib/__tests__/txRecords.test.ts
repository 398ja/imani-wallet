import { describe, it, expect } from 'vitest'

import { toContent, toRow } from '../txRecords'
import { buildIssueTransaction, buildPaymentTransaction, toTransaction } from '../transactions'
import type { TransactionRow } from '@imani/wallet-storage'

/**
 * The rows a device would have written itself, one per writer in the app.
 *
 * `received` has no builder — it is written by imani-apps' `tokenRedemption.js`
 * (`_buildReceiveTransactionRow`), and that shape is reproduced here on purpose:
 * it is the row a merchant's redemption actually is, and the one that used to
 * vanish on logout.
 */
const received = {
  id: 'received:9a79fa249ca599ced49ee39957503fd5',
  txId: 'received:9a79fa249ca599ced49ee39957503fd5',
  type: 'received',
  direction: 'in',
  timestamp: 1786891362412,
  amount: 1200,
  unit: 'GBP',
  decimals: 2,
  merchantId: 'bb'.repeat(32),
  counterparty: 'aa'.repeat(32),
  voucherId: '71fa3948-0f65-4b54-b1eb-09d19a01e210',
  tokenId: '9a79fa249ca599ced49ee39957503fd5',
  memo: 'Market stall',
} as unknown as TransactionRow

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
  memo: 'Coupon issued',
  expiresAt: 1789483362,
  at: 1786891362412,
})

describe('toContent / toRow', () => {
  it.each([
    ['received', received],
    ['payment', payment],
    ['issued', issued],
  ])('round-trips a %s row through a record unchanged', (_name, row) => {
    const before = toTransaction(row)
    const after = toTransaction(toRow(before.id, toContent(before)))

    // Timestamps go over the wire in seconds, as everything nostr does, so a row
    // comes back rounded down to its second. Everything else must survive
    // untouched — this is the assertion that a restored history is the same
    // history, not an approximation of it.
    expect(after).toEqual({ ...before, at: Math.floor(before.at / 1000) * 1000 })
  })

  it('carries the face value, not the sats amount', () => {
    // The trap: a NIP-60 record's `amount` is the backing token amount, while a
    // row's `amount` is the face value. Reading `amount` on the way back
    // restores the wrong money and it looks entirely plausible on screen.
    const content = toContent(toTransaction(received))

    expect(content.face_value).toBe(1200)
    expect(content.amount).toBe(0)
    expect(toTransaction(toRow(received.id, content)).amount).toBe(1200)
  })

  it('reads the face value back from `amount` if that is all a record has', () => {
    // Tolerating a record written by something that followed NIP-60 literally.
    const row = toRow('received:abc', { type: 'received', direction: 'in', amount: 750 })

    expect(toTransaction(row).amount).toBe(750)
  })

  it('keeps no token, and nothing else spendable, in the record', () => {
    // The whole safety argument for putting the ledger on a relay: the money
    // never goes with it, by shape rather than by a filter someone can forget.
    const withToken = { ...received, token: 'cashuBpGFteCJodHRwczovL21pbnQ' } as TransactionRow
    const serialised = JSON.stringify(toContent(toTransaction(withToken)))

    expect(serialised).not.toContain('cashu')
    expect(JSON.parse(serialised)).not.toHaveProperty('token')
  })

  it('keeps the coupon expiry, which NIP-60 has no slot for', () => {
    expect(toContent(toTransaction(issued)).expires_at).toBe(1789483362)
  })

  it('preserves the type, because direction is derived from it', () => {
    // `toTransaction` derives direction from type — a payment stored as 'in' is
    // an incoming arrow on money that left. Losing `type` on restore would flip
    // every payment in the history.
    expect(toTransaction(toRow(payment.id, toContent(toTransaction(payment)))).direction).toBe('out')
    expect(toTransaction(toRow(received.id, toContent(toTransaction(received)))).direction).toBe(
      'in',
    )
  })

  it('restores under the id the writer used, so a re-restore overwrites', () => {
    // Rows are keyed on their own id. If a restore invented one, logging in
    // twice would double the history instead of rewriting it.
    expect(toRow(received.id, toContent(toTransaction(received))).id).toBe(received.id)
    expect(toRow(issued.id, toContent(toTransaction(issued))).id).toBe('issued:' + issued.voucherId)
  })
})
