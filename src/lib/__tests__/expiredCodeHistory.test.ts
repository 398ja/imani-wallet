/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools'

/**
 * Regression: the coupons a checkout code is made of come back one row each when it expires
 * (#643). History must show them as ONE entry, the way a Cashlink take-back folds (#530), from the
 * real return path (a mint that signs, the relay refund) to the folded line, and after the rows
 * round-trip through the encrypted history backup.
 */

vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))
vi.mock('../cashbackValidation', () => ({ cashbackValidation: () => undefined }))

const flow = await import('../checkoutCodeFlow')
const records = await import('../checkoutCodeRecords')
const { checkoutCodeRow, checkoutTxId } = await import('../checkoutCodeHistory')
const { takenBackRow } = await import('../cashlinkPorts')
const { toTransaction } = await import('../transactions')
const { toContent, toRow } = await import('../txRecords')
const { groupHistory, entryVoucherCount } = await import('../historyGroups')
const { parseVoucherToken, creditableFaceValue } = await import('../voucherToken')
const W = await import('./cashlinkWorld')
await W.loadTokenReader()

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
const ID = hexToBytes('33'.repeat(32))
const ME = getPublicKey(ID)
const SHOP = { url: 'https://shop.example', redeemKey: 'd4'.repeat(32), platform: 'woocommerce' as const, since: 1 }

type World = ReturnType<typeof W.world>
let w: World
let ports: import('../checkoutCodeFlow').CheckoutPorts

/** A coupon of its own voucher (`nonce` picks the id), so the folded line can count vouchers. */
function coupon(amounts: number[], nonce: string) {
  const voucherId = `${nonce.repeat(8)}-70f5-4c14-8606-519404684ea7`
  const proofs = amounts.map((a, n) => w.mint.issue(W.bearerSecret({ nonce: nonce.padEnd(8, 'n'), voucherId }, `${nonce}${n}`), a))
  const token = W.tokenOf(proofs)
  const faceValue = creditableFaceValue(parseVoucherToken(token)).faceValue
  return { tokenId: `row-${nonce}`, token, amount: faceValue, faceValue }
}

beforeEach(() => {
  w = W.world(NOW)
  localStorage.clear()
  ports = {
    ...w.ports,
    store: new W.FakeCodeStore(w.mint),
    identitySecret: () => Uint8Array.from(ID),
    carve: async () => {
      throw new Error('no split in this test')
    },
    consume: async () => {},
    activity: async () => {},
  }
})

/** Make a code of `parts`, let it expire, and bring every part back by the relay refund. */
async function expiredCode(parts: ReturnType<typeof coupon>[]) {
  const amount = parts.reduce((n, p) => n + p.amount, 0)
  const out = await flow.startCheckoutCode({ ports, pubkey: ME, stall: W.STALL, shop: SHOP, unit: 'GBP', decimals: 2, amount, x: X, parts })
  expect(out.kind).toBe('issued')
  const record = records.loadCheckoutCodes(ME)[0]!
  W.at(w, X + 120)
  await w.gateway.runRelay(X + 120)
  const notice = { type: 'imani-checkout-code/1' as const, event: 'expired' as const, code_hash: record.codeHash! }
  expect(await flow.handleCheckoutNotice(ports, ME, notice, W.STORE_PUB)).toBe('handled')
  return { record: records.loadCheckoutCodes(ME)[0]!, amount }
}

/** The History rows the app port writes for each kept coupon (`cashlinkPorts.keep`). */
function returnRows(): Record<string, unknown>[] {
  return w.kept
    .filter((k) => k.takenBack)
    .map((k, n) => {
      const parsed = parseVoucherToken(k.token)
      const row = {
        token_id: `back-${n}`,
        voucher_id: parsed.voucher.voucherId,
        face_value: k.faceValue ?? creditableFaceValue(parsed).faceValue,
        face_unit: parsed.voucher.unit,
        face_decimals: parsed.voucher.faceDecimals,
        issuer_id: W.STALL,
      }
      return takenBackRow(row as never, k.token, (X + 200 + n) * 1000, k.bundleId, k.returnOf, k.returnMemo) as unknown as Record<string, unknown>
    })
}

describe('an expired checkout code of several coupons, in History', () => {
  it('is one incoming entry, summed to what came back, beside the code row', async () => {
    // Arrange
    const { record } = await expiredCode([coupon([64], 'a'), coupon([32], 'b')])
    const rows = [...returnRows(), checkoutCodeRow(record)]

    // Act
    const entries = groupHistory(rows.map((r) => toTransaction(r as never)).sort((a, b) => b.at - a.at))

    // Assert
    expect(rows.length).toBe(3)
    const bundles = entries.filter((e) => e.kind === 'bundle')
    expect(bundles).toHaveLength(1)
    const bundle = bundles[0]!
    if (bundle.kind !== 'bundle') throw new Error('unreachable')
    expect(bundle.direction).toBe('in')
    expect(bundle.parts.every((p) => p.returnOf === checkoutTxId(record.id))).toBe(true)
    expect(bundle.amount).toBe(w.kept.reduce((n, k) => n + (k.faceValue ?? 0), 0))
    expect(entryVoucherCount(bundle)).toBe(2)
    // The code's own row is never folded into its returns.
    expect(entries.filter((e) => e.kind === 'single').map((e) => e.kind === 'single' && e.tx.id)).toEqual([checkoutTxId(record.id)])
  })

  it('still folds after the rows round-trip through the encrypted history backup', async () => {
    // Arrange
    await expiredCode([coupon([64], 'a'), coupon([32], 'b')])
    const restored = returnRows().map((r) => {
      const tx = toTransaction(r as never)
      return toTransaction(toRow(tx.id, toContent(tx)))
    })

    // Act
    const entries = groupHistory(restored)

    // Assert
    expect(entries).toEqual([expect.objectContaining({ kind: 'bundle', direction: 'in' })])
  })

  it('two codes expiring together stay two entries', async () => {
    // Arrange
    await expiredCode([coupon([64], 'a'), coupon([32], 'b')])
    const first = returnRows()
    w.kept.length = 0
    localStorage.clear()
    W.at(w, NOW)
    await expiredCode([coupon([16], 'c'), coupon([8], 'd')])
    const second = returnRows().map((r) => ({ ...r, id: `${String(r.id)}-2`, txId: `${String(r.id)}-2` }))

    // Act
    const entries = groupHistory([...first, ...second].map((r) => toTransaction(r as never)))

    // Assert
    expect(entries.filter((e) => e.kind === 'bundle')).toHaveLength(2)
  })

  it('one coupon back is a plain row, not a group of one', async () => {
    // Arrange
    await expiredCode([coupon([64], 'a')])

    // Act
    const entries = groupHistory(returnRows().map((r) => toTransaction(r as never)))

    // Assert
    expect(entries.map((e) => e.kind)).toEqual(['single'])
  })
})
