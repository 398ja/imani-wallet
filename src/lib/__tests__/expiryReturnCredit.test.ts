/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * #643: value coming back with no link key (an expired checkout code, an unclaimed minted-locked
 * gift) gets its own incoming History row, linked to the debit it reverses, keyed on the coupon so
 * a rerun, a restore or another device overwrites rather than duplicates it.
 */

vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))
vi.mock('../cashbackValidation', () => ({ cashbackValidation: () => undefined }))

const { armGift, settleLockedGift } = await import('../cashlinkFlow')
const { takenBackRow } = await import('../cashlinkPorts')
const { returnOfLabel, CASHLINK_TAKEN_BACK_MEMO } = await import('../transactions')
const { CHECKOUT_CODE_RETURNED_MEMO } = await import('../checkoutCodeFlow')
const { bearerSecret, tokenOf, world, at } = await import('./cashlinkWorld')

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
const LINK = hexToBytes('11'.repeat(32))
const REFUND = hexToBytes('22'.repeat(32))

async function armedWorld() {
  const w = world(NOW)
  const gift = { token: tokenOf([w.mint.issue(bearerSecret(), 64)]), sentAt: NOW }
  const locks = new Map<string, string>()
  await armGift({
    ports: w.ports, linkSecret: LINK, refundSecret: REFUND, x: X, gifts: [gift], merchant: false,
    onArming: async () => {}, onLocked: async (g: string, s: string) => void locks.set(g, s), knownLocks: locks,
  })
  return { w, lockedToken: w.wraps[w.wraps.length - 1] }
}

describe('a return with no link key', () => {
  it('is kept with its own credit, linked to the debit, when the caller names one', async () => {
    // Arrange
    const { w, lockedToken } = await armedWorld()
    at(w, X + 3600)
    await w.gateway.runRelay(X + 3600)

    // Act
    const out = await settleLockedGift({ ports: w.ports, refundSecret: REFUND, lockedToken, returnOf: 'checkout:c1', returnMemo: CHECKOUT_CODE_RETURNED_MEMO, onReturning: async () => {} })

    // Assert
    expect(out.kind).toBe('returned')
    expect(w.kept.length).toBeGreaterThan(0)
    expect(w.kept.every((k) => k.takenBack === true && k.returnOf === 'checkout:c1' && k.returnMemo === CHECKOUT_CODE_RETURNED_MEMO)).toBe(true)
    expect(w.kept.every((k) => k.bundleId === undefined)).toBe(true)
  })

  it('writes no row when the caller names no debit (a guest return page)', async () => {
    // Arrange
    const { w, lockedToken } = await armedWorld()
    at(w, X + 3600)
    await w.gateway.runRelay(X + 3600)

    // Act
    await settleLockedGift({ ports: w.ports, refundSecret: REFUND, lockedToken, onReturning: async () => {} })

    // Assert
    expect(w.kept.length).toBeGreaterThan(0)
    expect(w.kept.some((k) => k.takenBack)).toBe(false)
  })
})

describe('the credit row', () => {
  const row = { token_id: 't1', face_value: 300, face_unit: 'EUR', face_decimals: 2, issuer_id: 'a'.repeat(64), voucher_id: 'v' } as never

  it('is incoming, at the kept coupon face, with the reversal memo and link', () => {
    // Act
    const back = takenBackRow(row, 'cashuB', 1, undefined, 'checkout:c1', CHECKOUT_CODE_RETURNED_MEMO) as unknown as Record<string, unknown>

    // Assert
    expect(back).toMatchObject({ id: 'returned:t1', txId: 'returned:t1', amount: 300, memo: CHECKOUT_CODE_RETURNED_MEMO, returnOf: 'checkout:c1' })
  })

  it('has one id per coupon, so a rerun or another device overwrites it', () => {
    // Act
    const a = takenBackRow(row, 'cashuB', 1, undefined, 'checkout:c1', CHECKOUT_CODE_RETURNED_MEMO) as unknown as Record<string, unknown>
    const b = takenBackRow(row, 'cashuB', 999, undefined, 'checkout:c1', CHECKOUT_CODE_RETURNED_MEMO) as unknown as Record<string, unknown>

    // Assert
    expect(a.id).toBe(b.id)
  })

  it('keeps the Cashlink words by default', () => {
    // Act
    const back = takenBackRow(row, 'cashuB', 1, 'b', 'sent:t0') as unknown as Record<string, unknown>

    // Assert
    expect(back.memo).toBe(CASHLINK_TAKEN_BACK_MEMO)
  })
})

describe('returnOfLabel', () => {
  it('opens a checkout code on its own screen', () => {
    expect(returnOfLabel('checkout:c1')).toEqual({ title: 'Checkout code', link: 'See the checkout code', to: '/online/code/c1' })
  })

  it('opens a gift on its row', () => {
    expect(returnOfLabel('locked-gift:out:ab')).toMatchObject({ title: 'Gift', to: '/transaction/locked-gift%3Aout%3Aab' })
  })

  it('keeps a Cashlink as it was', () => {
    expect(returnOfLabel('sent:t0')).toMatchObject({ title: 'Cashlink', link: 'See the Cashlink you sent' })
  })
})
