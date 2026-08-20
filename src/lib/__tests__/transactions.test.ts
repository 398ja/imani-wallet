import { describe, it, expect } from 'vitest'
import type { TransactionRow } from '@imani/wallet-storage'

import {
  toTransaction,
  counterpartyOf,
  transactionLabel,
  buildPaymentTransaction,
  buildIssueTransaction,
} from '../transactions'

/**
 * Rows as imani-apps' `_buildReceiveTransactionRow` actually writes them:
 * camelCase, reaching TypeScript only through TransactionRow's index signature.
 */
function writtenRow(over: Record<string, unknown> = {}): TransactionRow {
  return {
    id: 'received:ce4f3df2c561debdf260d4fdc77ed8b8',
    txId: 'received:ce4f3df2c561debdf260d4fdc77ed8b8',
    type: 'received',
    direction: 'in',
    timestamp: 1786525200000, // epoch ms, as Date.now() gives
    amount: 500,
    unit: 'EUR',
    decimals: 2,
    merchantName: 'Rosa Green Farm',
    merchantId: 'f'.repeat(64),
    counterparty: 'a'.repeat(64),
    voucherId: 'v-1',
    tokenId: 'ce4f3df2c561debdf260d4fdc77ed8b8',
    memo: 'Received via DM',
    ...over,
  } as unknown as TransactionRow
}

describe('toTransaction', () => {
  it('reads the camelCase fields the writer actually emits', () => {
    const tx = toTransaction(writtenRow())

    expect(tx.merchantId).toBe('f'.repeat(64))
    expect(tx.merchantName).toBe('Rosa Green Farm')
    expect(tx.tokenId).toBe('ce4f3df2c561debdf260d4fdc77ed8b8')
    expect(tx.voucherId).toBe('v-1')
    expect(tx.unit).toBe('EUR')
    expect(tx.decimals).toBe(2)
  })

  it('derives direction from type, ignoring the row', () => {
    // The writer hardcodes direction:'in' on every row it builds, including
    // payments. Trusting it puts an incoming arrow on money leaving the wallet.
    const payment = toTransaction(writtenRow({ type: 'payment', direction: 'in' }))
    expect(payment.direction).toBe('out')
    expect(transactionLabel(payment)).toBe('Paid')

    const received = toTransaction(writtenRow({ type: 'received', direction: 'in' }))
    expect(received.direction).toBe('in')
    expect(transactionLabel(received)).toBe('Received')
  })

  it('normalises both timestamp units to milliseconds', () => {
    // TransactionRow documents seconds; the writer uses Date.now(). Treating
    // milliseconds as seconds dates every record to 1970.
    const ms = toTransaction(writtenRow({ timestamp: 1786525200000 }))
    const seconds = toTransaction(writtenRow({ timestamp: 1786525200 }))

    expect(ms.at).toBe(1786525200000)
    expect(seconds.at).toBe(1786525200000)
    expect(new Date(ms.at).getUTCFullYear()).toBe(2026)
    expect(new Date(seconds.at).getUTCFullYear()).toBe(2026)
  })

  it('falls back to created_at when there is no timestamp', () => {
    const tx = toTransaction(
      writtenRow({ timestamp: undefined, created_at: '2026-08-12T09:00:00.000Z' }),
    )
    expect(new Date(tx.at).getUTCFullYear()).toBe(2026)
  })

  it('survives a row missing everything optional', () => {
    const tx = toTransaction({ id: 'x', type: 'received' } as unknown as TransactionRow)

    expect(tx.id).toBe('x')
    expect(tx.amount).toBe(0)
    expect(tx.at).toBe(0)
    expect(tx.merchantId).toBeUndefined()
    expect(tx.memo).toBeUndefined()
  })

  it('prefers a name over a pubkey for the counterparty label', () => {
    expect(counterpartyOf(toTransaction(writtenRow()))).toBe('Rosa Green Farm')
    expect(counterpartyOf(toTransaction(writtenRow({ merchantName: undefined })))).toBe(
      'f'.repeat(64),
    )
  })
})

describe('buildPaymentTransaction', () => {
  const merchant = 'f'.repeat(64)
  const payment = () =>
    buildPaymentTransaction({
      tokenId: 'ce4f3df2c561debdf260d4fdc77ed8b8',
      amount: 500,
      unit: 'EUR',
      decimals: 2,
      merchantId: merchant,
      merchantName: 'Rosa Green Farm',
      voucherId: 'v-1',
      memo: 'Two boxes of tomatoes',
      at: 1786525200000,
    })

  it('round-trips through toTransaction as outgoing money', () => {
    // The whole point of writing the same shape the receive path writes: one
    // reader, no second spelling to keep in sync.
    const tx = toTransaction(payment())

    expect(tx.direction).toBe('out')
    expect(transactionLabel(tx)).toBe('Paid')
    expect(tx.amount).toBe(500)
    expect(tx.unit).toBe('EUR')
    expect(tx.decimals).toBe(2)
    expect(tx.memo).toBe('Two boxes of tomatoes')
    expect(tx.at).toBe(1786525200000)
  })

  it('carries the merchantId that transactionsWith filters on', () => {
    // transactionsWith matches merchantId against the merchant pubkey. Get this
    // wrong and the payment is stored but never appears on the merchant screen.
    expect(toTransaction(payment()).merchantId).toBe(merchant)
  })

  it('is keyed by the spent voucher, so re-recording overwrites', () => {
    expect(payment().id).toBe('payment:ce4f3df2c561debdf260d4fdc77ed8b8')
    expect(payment().id).toBe(payment().id)
  })

  it('does not store the wrong direction the legacy writer stores', () => {
    expect((payment() as unknown as Record<string, unknown>).direction).toBe('out')
  })

  it('falls back to a memo rather than storing an empty one', () => {
    const noMemo = buildPaymentTransaction({
      tokenId: 't',
      amount: 1,
      unit: 'EUR',
      decimals: 2,
      merchantId: merchant,
      at: 1,
    })
    expect(toTransaction(noMemo).memo).toBe('Payment to merchant')
  })
})

describe('buildIssueTransaction', () => {
  const input = {
    voucherId: 'v-123',
    amount: 750,
    unit: 'EUR',
    decimals: 2,
    recipientPubkey: 'f'.repeat(64),
    memo: 'Two boxes of tomatoes',
    expiresAt: 1789246394,
    at: 1786654307000,
  }

  it('is keyed on the voucher id, so a retry overwrites rather than duplicating', () => {
    expect(buildIssueTransaction(input).id).toBe('issued:v-123')
  })

  it('reads back as money LEAVING this wallet', () => {
    // The merchant handed the coupon away. An incoming arrow here would claim
    // the opposite of what happened.
    const tx = toTransaction(buildIssueTransaction(input))
    expect(tx.direction).toBe('out')
    expect(tx.type).toBe('issued')
  })

  it('round-trips the amount, recipient and memo', () => {
    const tx = toTransaction(buildIssueTransaction(input))
    expect(tx.amount).toBe(750)
    expect(tx.unit).toBe('EUR')
    expect(tx.counterparty).toBe('f'.repeat(64))
    expect(tx.memo).toBe('Two boxes of tomatoes')
  })

  it('converts the expiry from seconds to milliseconds on the way back', () => {
    // Written in the gateway's unit, read for display. Getting this backwards
    // dates every issued coupon to 1970 or to the year 58000.
    const tx = toTransaction(buildIssueTransaction(input))
    expect(tx.expiresAt).toBe(1789246394 * 1000)
  })

  it('leaves the expiry unset when the gateway never settled one', () => {
    const tx = toTransaction(buildIssueTransaction({ ...input, expiresAt: undefined }))
    expect(tx.expiresAt).toBeUndefined()
  })

  it('falls back to a default memo rather than an empty label', () => {
    const tx = toTransaction(buildIssueTransaction({ ...input, memo: undefined }))
    expect(tx.memo).toBe('Voucher issued')
  })
})

describe('transactionLabel', () => {
  it('names all three kinds', () => {
    const at = (type: string) =>
      transactionLabel(toTransaction({ id: 'x', type, timestamp: 1, amount: 1 } as never))
    expect(at('payment')).toBe('Paid')
    expect(at('issued')).toBe('Issued')
    expect(at('received')).toBe('Received')
  })
})
