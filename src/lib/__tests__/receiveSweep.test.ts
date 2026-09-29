/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'

import { sweepInterruptedReceives } from '../receiveSweep'
import { pendingSwapIntents, rememberSwapIntent } from '../swapIntent'

/**
 * Finishing receives that were interrupted after the mint had already signed.
 *
 * The recovery itself is tested in `receiveSwap.test.ts` against a fake mint. What
 * this covers is the part start-up depends on: that a failure here cannot stop a
 * wallet opening, and that recovered proofs are handed to the caller rather than
 * counted and dropped.
 *
 * That second one is not hypothetical. The first version of this module counted
 * the result and returned, which destroyed the intent (recovery forgets it) and
 * then discarded the only copy of the proofs. It looked like a success and logged
 * one.
 */

const PUBKEY = 'a'.repeat(64)
const MINT = 'https://mint.example.test'
const KEYSET = '01ef5b830da1f32acd88bdf30c246627833672eb53112b7e2962a608ba96773aa9'

/** An intent on disk, as a receive that never came back would leave. */
function pendingIntent(swapId: string) {
  rememberSwapIntent(PUBKEY, {
    swapId,
    mintUrl: MINT,
    keysetId: KEYSET,
    inputs: [{ amount: 2, id: KEYSET, secret: 'spent-secret', C: '02' + 'ab'.repeat(32) }],
    outputs: [
      { amount: 2, id: KEYSET, secret: 'fresh-secret', B_: '02' + 'cd'.repeat(32), r: 'ef'.repeat(32) },
    ],
    at: Date.now(),
  })
}

describe('sweepInterruptedReceives', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  /**
   * The ordinary case, and the one that runs on every single wallet open. It must
   * cost nothing: no mint call, no network, no delay before a balance appears.
   */
  it('does no work at all when nothing was interrupted', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const saved = await sweepInterruptedReceives(PUBKEY, () => {
      throw new Error('save must not be called when there is nothing to recover')
    })

    expect(saved).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  /**
   * A mint that is down must not stop a wallet opening.
   *
   * Start-up chains this after several other recoveries, so a rejection here would
   * surface as a wallet that will not load because a coupon somebody received last
   * week is still pending. The intent stays on disk and the next open tries again.
   */
  it('resolves rather than rejecting when the mint cannot be reached', async () => {
    pendingIntent('interrupted-swap')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('mint unreachable'))

    await expect(sweepInterruptedReceives(PUBKEY, () => {})).resolves.toBe(0)

    // And the intent SURVIVES, which is the half that matters. Resolving while
    // silently dropping the record would look identical from the return value and
    // would mean an unreachable mint permanently lost somebody's coupon.
    expect(pendingSwapIntents(PUBKEY)).toHaveLength(1)
  })

  /**
   * A mint that signed nothing means nothing was spent.
   *
   * The benign shape of an interrupted swap: the inputs are still live, so the
   * intent is dropped and the coupon can simply be received again. No save runs,
   * because there is nothing to save, and that is a success rather than a loss.
   */
  it('recovers nothing, and calls no save, when the mint never signed', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    pendingIntent('interrupted-swap')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ outputs: [], signatures: [] }), { status: 200 }),
    )

    const saved = await sweepInterruptedReceives(PUBKEY, () => {
      throw new Error('save must not run when the mint signed nothing')
    })

    expect(saved).toBe(0)
    expect(errors).not.toHaveBeenCalled()
  })

  /**
   * The property the whole module exists for: recovered proofs REACH the caller.
   *
   * This is the test the first version of this module would have failed. It
   * counted the recovery and returned, which destroyed the intent and dropped the
   * proofs, and every other test here still passed because none of them ever got
   * as far as a signature.
   *
   * Driven through a fake mint that really signs, so the proofs handed over are
   * the ones the arithmetic yields rather than a stand-in.
   */
  it('hands recovered proofs to the caller rather than counting and dropping them', async () => {
    const { secp256k1 } = await import('@noble/curves/secp256k1.js')
    const { bytesToHex } = await import('@noble/hashes/utils')

    const secretKey = secp256k1.utils.randomSecretKey()
    const scalar = BigInt('0x' + bytesToHex(secretKey))
    const mintPublicKey = secp256k1.Point.BASE.multiply(scalar).toHex(true)

    const { blindOutputs } = await import('../walletSwap')
    const outputs = blindOutputs([2], KEYSET)
    const blinded = outputs[0]

    rememberSwapIntent(PUBKEY, {
      swapId: 'signed-swap',
      mintUrl: MINT,
      keysetId: KEYSET,
      inputs: [{ amount: 2, id: KEYSET, secret: 'spent-secret', C: '02' + 'ab'.repeat(32) }],
      outputs,
      at: Date.now(),
    })

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/restore')) {
        return new Response(
          JSON.stringify({
            outputs: [{ B_: blinded.B_ }],
            signatures: [
              {
                id: KEYSET,
                amount: 2,
                C_: secp256k1.Point.fromHex(blinded.B_).multiply(scalar).toHex(true),
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (url.includes('/keys')) {
        return new Response(
          JSON.stringify({ keysets: [{ id: KEYSET, unit: 'sat', keys: { '2': mintPublicKey } }] }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected request to ${url}`)
    })

    const handedOver: { swapId: string; amount: number }[] = []
    const saved = await sweepInterruptedReceives(PUBKEY, (swap) => {
      handedOver.push({
        swapId: swap.swapId,
        amount: swap.proofs.reduce((sum, proof) => sum + proof.amount, 0),
      })
    })

    expect(saved).toBe(1)
    expect(handedOver).toEqual([{ swapId: 'signed-swap', amount: 2 }])
  })

  /**
   * A save that fails is not a save, and must be reported as loudly as possible.
   *
   * By the time `save` runs, the intent has already been forgotten: the mint's
   * answer is what made it redundant. So proofs that cannot be written have no
   * second route. They are spendable, owned by this wallet, and recorded nowhere,
   * and the log line is the only remaining trace of what was lost.
   *
   * Counting it as saved would hide exactly that, which is why the count and the
   * error are both asserted here.
   */
  it('does not count a save that failed, and says so at ERROR', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { secp256k1 } = await import('@noble/curves/secp256k1.js')
    const { bytesToHex } = await import('@noble/hashes/utils')
    const { blindOutputs } = await import('../walletSwap')

    const secretKey = secp256k1.utils.randomSecretKey()
    const scalar = BigInt('0x' + bytesToHex(secretKey))
    const mintPublicKey = secp256k1.Point.BASE.multiply(scalar).toHex(true)
    const outputs = blindOutputs([2], KEYSET)
    const blinded = outputs[0]

    rememberSwapIntent(PUBKEY, {
      swapId: 'unsaveable-swap',
      mintUrl: MINT,
      keysetId: KEYSET,
      inputs: [{ amount: 2, id: KEYSET, secret: 'spent-secret', C: '02' + 'ab'.repeat(32) }],
      outputs,
      at: Date.now(),
    })

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/restore')) {
        return new Response(
          JSON.stringify({
            outputs: [{ B_: blinded.B_ }],
            signatures: [
              {
                id: KEYSET,
                amount: 2,
                C_: secp256k1.Point.fromHex(blinded.B_).multiply(scalar).toHex(true),
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({ keysets: [{ id: KEYSET, unit: 'sat', keys: { '2': mintPublicKey } }] }),
        { status: 200 },
      )
    })

    const saved = await sweepInterruptedReceives(PUBKEY, () => {
      throw new Error('storage is full')
    })

    expect(saved).toBe(0)
    expect(errors).toHaveBeenCalledOnce()
    // The amount is in the log, because it is what somebody has to reconcile.
    expect(errors.mock.calls[0][1]).toMatchObject({ swapId: 'unsaveable-swap', amount: 2 })
  })
})
