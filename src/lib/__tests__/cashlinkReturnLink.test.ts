/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * A Cashlink take-back row names the `sent` row that made the Cashlink (`returnOf`), so the return
 * opens the send it undoes and the send lists what came back. Covered here: the locked path writes
 * it, the creation row is chosen the same way on every run, the send finds its returns, and the
 * link survives the encrypted history backup. The unlocked path is `cashlinkUnarmedTakenBackRow`.
 */

vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))
vi.mock('../cashbackValidation', () => ({ cashbackValidation: () => undefined }))

const { armGift, settleLockedGift } = await import('../cashlinkFlow')
const { creationRowId } = await import('../giftLinks')
const { cashlinkReturnsOf, toTransaction } = await import('../transactions')
const { takenBackRow } = await import('../cashlinkPorts')
const { toContent, toRow } = await import('../txRecords')
const { bearerSecret, tokenOf, world, at } = await import('./cashlinkWorld')

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
const LINK = hexToBytes('11'.repeat(32))
const REFUND = hexToBytes('22'.repeat(32))
const K = 'k'.repeat(43)

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

describe('a locked Cashlink taken back names the send that made it', () => {
  it('at its expiry, refunded by the relay', async () => {
    // Arrange
    const { w, lockedToken } = await armedWorld()
    at(w, X + 3600)
    await w.gateway.runRelay(X + 3600)

    // Act
    const out = await settleLockedGift({ ports: w.ports, linkSecret: LINK, refundSecret: REFUND, lockedToken, returnOf: 'sent:t0', onReturning: async () => {} })

    // Assert
    expect(out.kind).toBe('returned')
    expect(w.kept.length).toBeGreaterThan(0)
    expect(w.kept.every((k) => k.takenBack === true && k.returnOf === 'sent:t0')).toBe(true)
  })

  it('by hand, before its expiry', async () => {
    // Arrange
    const { w, lockedToken } = await armedWorld()

    // Act
    const out = await settleLockedGift({ ports: w.ports, linkSecret: LINK, refundSecret: REFUND, lockedToken, takeBackNow: true, returnOf: 'sent:t0', onReturning: async () => {} })

    // Assert
    expect(out.kind).toBe('returned')
    expect(w.kept.every((k) => k.returnOf === 'sent:t0')).toBe(true)
  })

  it('the History row carries it, beside its own id', () => {
    // Arrange
    const row = { token_id: 't1', face_value: 300, face_unit: 'EUR', face_decimals: 2, issuer_id: 'a'.repeat(64), voucher_id: 'v' } as never

    // Act
    const back = takenBackRow(row, 'cashuB', 1, 'bundle1', 'sent:t0') as unknown as Record<string, unknown>
    const bare = takenBackRow(row, 'cashuB', 1, 'bundle1') as unknown as Record<string, unknown>

    // Assert
    expect(back).toMatchObject({ id: 'returned:t1', returnOf: 'sent:t0' })
    expect('returnOf' in bare).toBe(false)
  })
})

describe('creationRowId', () => {
  const row = (id: string) => ({ id, row: { id } as never, link: { k: K, x: X, status: 'outstanding' as const } })

  it('prefers the send’s own row over one a restore scan adopted', () => {
    // Act
    const id = creationRowId([row('sent:gift-aaa'), row('sent:zzz')])

    // Assert
    expect(id).toBe('sent:zzz')
  })

  it('names the same row whatever order the rows are read in', () => {
    // Act
    const a = creationRowId([row('sent:b'), row('sent:a')])
    const b = creationRowId([row('sent:a'), row('sent:b')])

    // Assert
    expect(a).toBe('sent:a')
    expect(b).toBe('sent:a')
  })
})

describe('cashlinkReturnsOf', () => {
  const sent = (id: string, k = K) => toTransaction({ id, type: 'sent', timestamp: 1, amount: 300, unit: 'EUR', link: { k, x: X, status: 'reclaimed' } } as never)
  const back = (id: string, returnOf: string, at = 2) => toTransaction({ id, type: 'received', timestamp: at, amount: 150, unit: 'EUR', returnOf } as never)

  it('lists the returns that name any row of the same link, newest first', () => {
    // Arrange
    const all = [sent('sent:a'), sent('sent:b'), back('returned:1', 'sent:a', 5), back('returned:2', 'sent:b', 9), sent('sent:other', 'o'.repeat(43)), back('returned:3', 'sent:other')]

    // Act
    const found = cashlinkReturnsOf(all, all[1])

    // Assert
    expect(found.map((t) => t.id)).toEqual(['returned:2', 'returned:1'])
  })

  it('is empty for a row that made no Cashlink', () => {
    // Arrange
    const plain = toTransaction({ id: 'sent:x', type: 'sent', timestamp: 1, amount: 1, unit: 'EUR' } as never)

    // Act
    const found = cashlinkReturnsOf([plain, back('returned:1', 'sent:x')], plain)

    // Assert
    expect(found).toEqual([])
  })
})

describe('the encrypted history backup', () => {
  it('keeps the link from a take-back to its send', () => {
    // Arrange
    const tx = toTransaction({ id: 'returned:t1', type: 'received', timestamp: 1_000, amount: 300, unit: 'EUR', decimals: 2, returnOf: 'sent:t0' } as never)

    // Act
    const restored = toTransaction(toRow(tx.id, toContent(tx)))

    // Assert
    expect(restored.returnOf).toBe('sent:t0')
  })

  it('adds nothing to a row that is not a take-back', () => {
    // Arrange
    const tx = toTransaction({ id: 'received:t2', type: 'received', timestamp: 1_000, amount: 300, unit: 'EUR', decimals: 2 } as never)

    // Act
    const content = toContent(tx)

    // Assert
    expect('return_of' in content).toBe(false)
    expect(toTransaction(toRow(tx.id, content)).returnOf).toBeUndefined()
  })
})
