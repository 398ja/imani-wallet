/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))

const { carveProofs } = await import('../checkoutCodePorts')
const { tokenProofs, creditableFaceValue, parseVoucherToken } = await import('../voucherToken')
const W = await import('./cashlinkWorld')

/** #402: a split part is carved from a coupon's own proofs, its face shares adding up exactly. */
describe('carving a part off a coupon', () => {
  const w = W.world()
  const token = W.tokenOf([64, 32, 16].map((a, n) => w.mint.issue(W.bearerSecret({}, `c${n}`), a)))
  const face = (t: string) => creditableFaceValue(parseVoucherToken(t)).faceValue

  it('takes whole proofs worth the amount and leaves the rest a coupon', () => {
    const out = carveProofs(token, 6)!
    expect(face(out.part)).toBe(6)
    expect(face(out.rest!)).toBe(face(token) - 6)
    expect(tokenProofs(out.part).length + tokenProofs(out.rest!).length).toBe(3)
  })

  it('refuses an amount no subset makes', () => {
    expect(carveProofs(token, 1)).toBeNull()
  })
})
