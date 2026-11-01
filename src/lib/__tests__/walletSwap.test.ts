import { describe, expect, it } from 'vitest'

import {
  splitIntoDenominations,
  blindOutputs,
  unblindOutputs,
  unblindRestored,
} from '../walletSwap'

/**
 * The wallet's own half of a swap: choose the outputs, blind them, unblind the
 * mint's answer.
 *
 * ## Why this exists
 *
 * Until now the gateway did this, which is why it ended up holding a spendable
 * copy of every coupon anyone received (imani-gateway-customer#133) and was the
 * only party holding the money when a response was lost (imani-wallet#123). The
 * secrets and the blinding factors are what make a proof spendable, so whoever
 * generates them owns the money. This module moves that to the wallet.
 *
 * See `imani-docs/wallet/explanation/the-wallet-swaps-its-own-receives.md`.
 *
 * ## The blinding factor is the whole security argument
 *
 * A proof needs `C`, and `C = C_ - rK`. The mint returns `C_`, the mint's public
 * key gives `K`, and `r` is the blinding factor. So anyone without `r` can watch
 * the swap go by and still not spend the result. `r` is generated here and never
 * leaves. That single fact is what makes a gateway-assisted voucher receive a
 * signing step rather than custody.
 */

describe('splitting an amount into denominations', () => {
  /**
   * The mint signs one blinded message per proof, each at a power-of-two
   * denomination it holds a key for. So an amount has to become a set of
   * powers of two, and the binary expansion is the fewest proofs that sum to it.
   */
  it('expands an amount into powers of two, largest first', () => {
    expect(splitIntoDenominations(1)).toEqual([1])
    expect(splitIntoDenominations(2)).toEqual([2])
    expect(splitIntoDenominations(3)).toEqual([2, 1])
    expect(splitIntoDenominations(5)).toEqual([4, 1])
    expect(splitIntoDenominations(7)).toEqual([4, 2, 1])
    expect(splitIntoDenominations(8)).toEqual([8])
    expect(splitIntoDenominations(100)).toEqual([64, 32, 4])
  })

  /** Every split must sum to what went in, or the swap is refused on amounts. */
  it('always sums back to the original amount', () => {
    for (let amount = 1; amount <= 600; amount++) {
      const parts = splitIntoDenominations(amount)
      expect(parts.reduce((a, b) => a + b, 0)).toBe(amount)
      expect(parts.every((p) => Number.isInteger(Math.log2(p)))).toBe(true)
    }
  })

  /**
   * Zero and below are not amounts. The mint refuses a non-positive output, so
   * producing one here would turn a caller's arithmetic slip into a failed swap
   * with a confusing message from the far end.
   */
  it('refuses an amount that is not a positive integer', () => {
    expect(() => splitIntoDenominations(0)).toThrow(/positive/)
    expect(() => splitIntoDenominations(-1)).toThrow(/positive/)
    expect(() => splitIntoDenominations(1.5)).toThrow(/positive/)
    expect(() => splitIntoDenominations(Number.NaN)).toThrow(/positive/)
  })

  /**
   * Found in review, and it was silent, which is what made it serious.
   *
   * Bitwise operators coerce to int32, so the original `amount & bit` dropped the
   * high bits of anything at or above 2^32. Measured on the old code: 2^32 + 7
   * split as parts summing to SEVEN. Every guard downstream would have been
   * satisfied, because the mint signs exactly what it is asked for, so the wallet
   * would have burnt about 4.3 billion sats of input and minted 7 sats of output
   * with nothing reporting a fault.
   *
   * Not a realistic coupon. But a money function whose failure mode is silent and
   * undetectable downstream should not have one.
   */
  it('stays exact above the 32-bit boundary', () => {
    for (const amount of [2 ** 31 - 1, 2 ** 31, 2 ** 32, 2 ** 32 + 7, 2 ** 40 + 12345]) {
      const parts = splitIntoDenominations(amount)
      expect(parts.reduce((a, b) => a + b, 0), `split of ${amount}`).toBe(amount)
    }
  })

  /**
   * Past the safe-integer range the arithmetic stops being exact at all, so there
   * is no split to return. Refusing is the only honest answer.
   */
  it('refuses an amount too large to represent exactly', () => {
    expect(() => splitIntoDenominations(Number.MAX_SAFE_INTEGER + 2)).toThrow(/too large/)
  })
})

describe('blinding the outputs', () => {
  const keysetId = '01ef5b830da1f32acd88bdf30c246627833672eb53112b7e2962a608ba96773aa9'

  /** One blinded message per denomination, each carrying its own amount. */
  it('produces one blinded output per denomination', () => {
    const outputs = blindOutputs([4, 2, 1], keysetId)
    expect(outputs.map((o) => o.amount)).toEqual([4, 2, 1])
    expect(outputs.every((o) => o.id === keysetId)).toBe(true)
    expect(outputs.every((o) => /^0[23][0-9a-f]{64}$/i.test(o.B_))).toBe(true)
  })

  /**
   * The secret is what the mint will hash to `Y`, and a repeat would be a proof
   * that collides with one that already exists. Nothing recovers from that, so
   * it is worth asserting rather than trusting the random source by inspection.
   */
  it('gives every output a distinct secret and blinding factor', () => {
    const outputs = blindOutputs([1, 1, 1, 1, 1, 1, 1, 1], keysetId)
    expect(new Set(outputs.map((o) => o.secret)).size).toBe(8)
    expect(new Set(outputs.map((o) => o.r)).size).toBe(8)
    expect(new Set(outputs.map((o) => o.B_)).size).toBe(8)
  })

  /**
   * The mint hashes the secret STRING, so the secret has to be text the mint and
   * the wallet agree on byte for byte. Raw random bytes produce a `Y` the two
   * sides disagree about, which `burnProbe.test.ts` records as having cost an
   * hour to find. Hex keeps it printable and unambiguous.
   */
  it('uses a printable hex secret, as the mint expects', () => {
    for (const output of blindOutputs([1, 2], keysetId)) {
      expect(output.secret).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('refuses to blind against a blank keyset id', () => {
    expect(() => blindOutputs([1], '')).toThrow(/keyset/)
  })

  it('refuses an empty output set', () => {
    expect(() => blindOutputs([], keysetId)).toThrow(/at least one/)
  })
})

describe('unblinding what the mint returned', () => {
  const keysetId = '01ef5b830da1f32acd88bdf30c246627833672eb53112b7e2962a608ba96773aa9'

  /**
   * The round trip, checked without a mint: blind a set, have the "mint" sign
   * with a known key, unblind, and confirm the proof carries the secret we chose.
   *
   * Uses the real BDHKE primitives on both sides, so this is the arithmetic the
   * live mint performs rather than a stub of it. `burnProbe.test.ts` covers the
   * same path against the real staging mint, gated behind a flag because it
   * spends money.
   */
  it('recovers proofs carrying the secrets the wallet chose', async () => {
    const { secp256k1 } = await import('@noble/curves/secp256k1.js')
    const { bytesToHex } = await import('@noble/hashes/utils')

    const mintPrivateKey = secp256k1.utils.randomSecretKey()
    const mintPublicKey = secp256k1.Point.BASE.multiply(
      BigInt('0x' + bytesToHex(mintPrivateKey)),
    )

    const outputs = blindOutputs([2, 1], keysetId)

    // What the mint does: C_ = k * B_.
    const signatures = outputs.map((output) => ({
      id: output.id,
      amount: output.amount,
      C_: secp256k1.Point.fromHex(output.B_)
        .multiply(BigInt('0x' + bytesToHex(mintPrivateKey)))
        .toHex(true),
    }))

    const keys = Object.fromEntries(
      outputs.map((o) => [String(o.amount), mintPublicKey.toHex(true)]),
    )

    const proofs = unblindOutputs(outputs, signatures, keys)

    expect(proofs.map((p) => p.amount)).toEqual([2, 1])
    expect(proofs.map((p) => p.secret)).toEqual(outputs.map((o) => o.secret))
    expect(proofs.every((p) => p.id === keysetId)).toBe(true)
    expect(proofs.every((p) => /^0[23][0-9a-f]{64}$/i.test(p.C))).toBe(true)
    // Sanity: the unblinded C must not be the blinded C_ the mint returned.
    expect(proofs.map((p) => p.C)).not.toEqual(signatures.map((s) => s.C_))
  })

  /**
   * A mint that answers with a different number of signatures than we asked for
   * has not answered our request. Pairing them positionally past that point
   * would silently build proofs against the wrong amounts.
   */
  it('refuses a signature count that does not match the outputs', () => {
    const outputs = blindOutputs([2, 1], keysetId)
    expect(() =>
      unblindOutputs(outputs, [{ id: keysetId, amount: 2, C_: '02'.padEnd(66, 'a') }], {}),
    ).toThrow(/signature/)
  })

  /**
   * The amounts must line up too. A mint returning a 1 where we asked for a 2
   * would otherwise produce a proof claiming an amount its signature does not
   * cover, which the mint would then refuse at the next spend with nothing to
   * explain why.
   *
   * The keyset here holds a key for BOTH amounts deliberately. An earlier
   * version supplied only the signed amount's key, so the key lookup threw
   * first and the test passed without the amount guard existing at all. Caught
   * by deleting the guard and watching this stay green.
   */
  it('refuses a signature whose amount does not match its output', () => {
    const outputs = blindOutputs([2], keysetId)
    expect(() =>
      unblindOutputs(outputs, [{ id: keysetId, amount: 1, C_: '02'.padEnd(66, 'a') }], {
        '1': '02'.padEnd(66, 'b'),
        '2': '02'.padEnd(66, 'c'),
      }),
    ).toThrow(/amount/)
  })

  /** Without the mint's key for that denomination the proof cannot be built. */
  it('refuses when the keyset has no key for an amount', () => {
    const outputs = blindOutputs([2], keysetId)
    expect(() =>
      unblindOutputs(outputs, [{ id: keysetId, amount: 2, C_: '02'.padEnd(66, 'a') }], {}),
    ).toThrow(/key/)
  })

  /**
   * The keyset must match too, and it was the one field left unchecked. The proof
   * takes the OUTPUT's id, so a signature made under keyset B would be recorded
   * against keyset A and fail at the next spend with nothing to explain why. Found
   * in review: swapping `id: output.id` for `id: signature.id` left every test
   * green, which is the definition of an unpinned field.
   */
  it('refuses a signature made under a different keyset', () => {
    const outputs = blindOutputs([2], keysetId)
    expect(() =>
      unblindOutputs(outputs, [{ id: '00e3372e61d05605', amount: 2, C_: '02'.padEnd(66, 'a') }], {
        '2': '02'.padEnd(66, 'b'),
      }),
    ).toThrow(/keyset/)
  })
})

describe('unblinding a NUT-09 restore', () => {
  const keysetId = '01ef5b830da1f32acd88bdf30c246627833672eb53112b7e2962a608ba96773aa9'

  /**
   * Builds a fake mint's answer for a chosen SUBSET of outputs, in the shape the
   * real mint returns: matched messages paired with their signatures.
   */
  async function restoreAnswer(outputs: ReturnType<typeof blindOutputs>, indices: number[]) {
    const { secp256k1 } = await import('@noble/curves/secp256k1.js')
    const { bytesToHex } = await import('@noble/hashes/utils')
    const secretKey = secp256k1.utils.randomSecretKey()
    const scalar = BigInt('0x' + bytesToHex(secretKey))
    const publicKey = secp256k1.Point.BASE.multiply(scalar).toHex(true)

    const matched = indices.map((index) => outputs[index])
    return {
      answer: {
        outputs: matched.map((o) => ({ B_: o.B_ })),
        signatures: matched.map((o) => ({
          id: o.id,
          amount: o.amount,
          C_: secp256k1.Point.fromHex(o.B_).multiply(scalar).toHex(true),
        })),
      },
      keys: { '1': publicKey, '2': publicKey, '4': publicKey },
    }
  }

  /**
   * The finding that mattered most in review, and it loses money.
   *
   * A swap that fails partway still SPENDS its inputs, and the mint deliberately
   * leaves the outputs it did sign durably recoverable through restore. So a
   * partial answer is a designed state, not a fault. Reusing the swap's positional
   * count check threw on any partial answer, which abandoned every signature the
   * mint really had issued: money the wallet owns and has no other route to.
   */
  it('recovers the subset the mint signed and reports the rest', async () => {
    const outputs = blindOutputs([4, 2, 1], keysetId)
    const { answer, keys } = await restoreAnswer(outputs, [0, 2])

    const { proofs, unmatched } = unblindRestored(outputs, answer, keys)

    expect(proofs.map((p) => p.amount)).toEqual([4, 1])
    expect(proofs.map((p) => p.secret)).toEqual([outputs[0].secret, outputs[2].secret])
    expect(unmatched.map((o) => o.amount)).toEqual([2])
  })

  /** A complete answer is just the case where nothing is unmatched. */
  it('recovers everything when the mint signed everything', async () => {
    const outputs = blindOutputs([2, 1], keysetId)
    const { answer, keys } = await restoreAnswer(outputs, [0, 1])

    const { proofs, unmatched } = unblindRestored(outputs, answer, keys)

    expect(proofs.map((p) => p.amount)).toEqual([2, 1])
    expect(unmatched).toEqual([])
  })

  /** Nothing signed means nothing recovered, and nothing thrown. */
  it('reports every output as unmatched when the mint signed none', async () => {
    const outputs = blindOutputs([2, 1], keysetId)
    const { answer, keys } = await restoreAnswer(outputs, [])

    const { proofs, unmatched } = unblindRestored(outputs, answer, keys)

    expect(proofs).toEqual([])
    expect(unmatched).toHaveLength(2)
  })

  /**
   * Paired by `B_`, not by position, which is the whole difference from a swap.
   * The mint returns matches in its own order, and pairing positionally would
   * attach a signature to the wrong output.
   */
  it('pairs by blinded message rather than by position', async () => {
    const outputs = blindOutputs([4, 2, 1], keysetId)
    const { answer, keys } = await restoreAnswer(outputs, [2, 0])

    const { proofs } = unblindRestored(outputs, answer, keys)

    // Returned in OUR order, regardless of the order the mint answered in.
    expect(proofs.map((p) => p.amount)).toEqual([4, 1])
    expect(proofs.map((p) => p.secret)).toEqual([outputs[0].secret, outputs[2].secret])
  })

  /** An answer whose own two arrays disagree is not an answer we can read. */
  it('refuses an answer whose outputs and signatures do not pair up', () => {
    const outputs = blindOutputs([2], keysetId)
    expect(() =>
      unblindRestored(outputs, { outputs: [{ B_: outputs[0].B_ }], signatures: [] }, {}),
    ).toThrow(/paired/)
  })

  /** The same amount and keyset guards apply as on a swap. */
  it('refuses a restored signature whose amount does not match', async () => {
    const outputs = blindOutputs([2], keysetId)
    const { answer, keys } = await restoreAnswer(outputs, [0])
    answer.signatures[0].amount = 1

    expect(() => unblindRestored(outputs, answer, { ...keys, '1': keys['2'] })).toThrow(/amount/)
  })

  it('refuses a restored signature made under a different keyset', async () => {
    const outputs = blindOutputs([2], keysetId)
    const { answer, keys } = await restoreAnswer(outputs, [0])
    answer.signatures[0].id = '00e3372e61d05605'

    expect(() => unblindRestored(outputs, answer, keys)).toThrow(/keyset/)
  })
})
