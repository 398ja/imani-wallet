/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createMintTransport } from '../mintTransport'
import { receiveByOwnSwap, type MintTransport } from '../receiveSwap'
import { pendingSwapIntents } from '../swapIntent'
import { VoucherDocumentMissing, tokenProofs } from '../voucherToken'
import { toByReference, tokenWithRawV } from './byReference'
import { buildVoucherToken } from './voucherFixtures'

/**
 * cashu-voucher#64 on the receive path: a by-reference voucher input is refused exactly like a v1
 * one (it must never be swapped into random secrets as plain sats), and when the caller releases
 * it (swap back) the stored intent keeps its document so a NUT-19 replay is byte-identical.
 */
const PUBKEY = 'b'.repeat(64)
const MINT = 'https://mint.example.test'
const KEYSET = '00ab'

beforeEach(() => localStorage.clear())

const v2Proofs = () => tokenProofs(toByReference(buildVoucherToken({}, [2, 1]).token)).map((p) => ({ ...p, id: KEYSET }))

describe('receiveByOwnSwap with by-reference voucher inputs', () => {
  it('refuses a v2 voucher by default, as it refuses v1', async () => {
    const swap = vi.fn()
    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: v2Proofs() }, { swap } as unknown as MintTransport),
    ).rejects.toThrow(/cannot receive a voucher/)
    expect(swap).not.toHaveBeenCalled()
  })

  it('refuses an incomplete v2 input before writing any intent', async () => {
    const proofs = tokenProofs(tokenWithRawV(buildVoucherToken().token, [])).map((p) => ({ ...p, id: KEYSET }))
    const swap = vi.fn()
    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs, releaseVoucher: true }, { swap } as unknown as MintTransport),
    ).rejects.toThrow(VoucherDocumentMissing)
    expect(swap).not.toHaveBeenCalled()
    expect(pendingSwapIntents(PUBKEY)).toHaveLength(0)
  })

  it('keeps the documents in the intent, so the replayed request is byte-identical', async () => {
    const bodies: string[] = []
    let fail = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (String(url).endsWith('/v1/keysets')) {
          return new Response(JSON.stringify({ keysets: [{ id: KEYSET, unit: 'sat', active: true }] }), { status: 200 })
        }
        bodies.push(init?.body ?? '')
        if (fail) return new Response(JSON.stringify({ detail: 'boom' }), { status: 503 })
        return new Response(JSON.stringify({ detail: 'stop here' }), { status: 400 })
      }),
    )
    try {
      const transport = createMintTransport()
      const proofs = v2Proofs()
      await expect(receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs, releaseVoucher: true }, transport)).rejects.toThrow()
      const [intent] = pendingSwapIntents(PUBKEY)
      expect(intent.inputs.every((i) => typeof i.document === 'string')).toBe(true)

      // Replay from the stored intent alone: the request must match the first byte for byte.
      fail = false
      await expect(transport.swap(MINT, { inputs: intent.inputs, outputs: intent.outputs })).rejects.toThrow()
      const swaps = bodies.filter((b) => b.includes('"inputs"'))
      expect(swaps).toHaveLength(2)
      expect(swaps[1]).toBe(swaps[0])
      expect(Object.keys(JSON.parse(swaps[0]).vouchers)).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
