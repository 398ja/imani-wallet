import { describe, expect, it } from 'vitest'

import { buildReceivedTransaction, buildSentTransaction, toTransaction } from '../transactions'
import { groupHistory } from '../historyGroups'
import { cashlinkBundleId } from '../cashlinkFlow'

/**
 * Rows as the builders write them, read back the way History reads them, must fold into one entry
 * when they are one payment: a multi-voucher send, or several coupons claimed off one Cashlink.
 */

const ISSUER = 'ab'.repeat(32)
const FRIEND = 'cd'.repeat(32)
const BUNDLE = 'ef'.repeat(16)
const SECRET = 's'.repeat(43)

const sent = (i: number, over: Partial<Parameters<typeof buildSentTransaction>[0]> = {}) =>
  toTransaction(
    buildSentTransaction({
      tokenId: `t${i}`,
      amount: 300,
      unit: 'EUR',
      decimals: 2,
      merchantId: ISSUER,
      recipientPubkey: FRIEND,
      bundleId: BUNDLE,
      at: 1_000 + i,
      ...over,
    }),
  )

const received = (i: number, bundleId?: string) =>
  toTransaction(
    buildReceivedTransaction({ tokenId: `r${i}`, amount: 250, unit: 'eur', decimals: 2, merchantId: ISSUER, bundleId, at: 2_000 + i }),
  )

describe('rows built on send group as one History entry', () => {
  it('three sent parts with one bundle id are one entry of the total', () => {
    const entries = groupHistory([sent(2), sent(1), sent(0)])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'bundle', amount: 900, direction: 'out' })
  })

  it('a single sent row without a bundle stays single', () => {
    expect(groupHistory([sent(0, { bundleId: undefined })])).toMatchObject([{ kind: 'single' }])
  })
})

describe('rows built on a Cashlink claim group as one History entry', () => {
  it('buildReceivedTransaction keeps the bundle id it is given', () => {
    expect(received(0, BUNDLE).bundleId).toBe(BUNDLE)
  })

  it('never writes bundleId: null', () => {
    const row = buildReceivedTransaction({ tokenId: 'r', amount: 1, unit: 'EUR', decimals: 2, at: 1 }) as unknown as Record<string, unknown>
    expect('bundleId' in row).toBe(false)
  })

  it('two coupons claimed off one link fold into one incoming entry', () => {
    const id = cashlinkBundleId(FRIEND)
    const entries = groupHistory([received(1, id), received(0, id)])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'bundle', amount: 500, direction: 'in' })
  })

  it('the claim bundle id is stable per link and differs between links', () => {
    expect(cashlinkBundleId(FRIEND)).toBe(cashlinkBundleId(FRIEND.toUpperCase()))
    expect(cashlinkBundleId(FRIEND)).not.toBe(cashlinkBundleId(ISSUER))
    expect(cashlinkBundleId(FRIEND)).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('rows already stored without a bundle id', () => {
  it('sent rows of one Cashlink fold on the link, without exposing the link key', () => {
    const link = { k: SECRET, x: 9, status: 'outstanding' as const }
    const entries = groupHistory([sent(1, { bundleId: undefined, link }), sent(0, { bundleId: undefined, link })])
    expect(entries).toHaveLength(1)
    expect(entries[0]!.kind).toBe('bundle')
    expect(JSON.stringify(entries[0]!.kind === 'bundle' ? entries[0]!.id : '')).not.toContain(SECRET)
  })

  it('sent rows of two different links stay apart', () => {
    const a = { k: 'A'.repeat(43), x: 9, status: 'outstanding' as const }
    const b = { k: 'B'.repeat(43), x: 9, status: 'outstanding' as const }
    expect(groupHistory([sent(1, { bundleId: undefined, link: a }), sent(0, { bundleId: undefined, link: b })])).toHaveLength(2)
  })
})
