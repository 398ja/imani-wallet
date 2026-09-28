/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

import { receiveByOwnSwap, recoverInterruptedSwaps, settleReceive } from '../receiveSwap'
import { loadSwapIntents, pendingSwapIntents, rememberSwapIntent } from '../swapIntent'
import { blindOutputs, splitIntoDenominations } from '../walletSwap'
import { tokenProofs } from '../voucherToken'

/**
 * Receiving a coupon by swapping it ourselves.
 *
 * The orchestration, which is where the ordering guarantees live. The pieces it
 * assembles are tested separately: `walletSwap` for the crypto and `swapIntent`
 * for the record. What this covers is the sequence, because the sequence is what
 * decides whether a lost response costs somebody their money.
 *
 * Every test here drives a FAKE mint through the injected transport. The live
 * mint is covered by `swapRecoveryProbe`; fakes are used here so the failure
 * modes that matter, a response that never arrives and a page that dies
 * mid-request, can be produced on demand rather than waited for.
 */

const KEYSET = '01ef5b830da1f32acd88bdf30c246627833672eb53112b7e2962a608ba96773aa9'
const MINT = 'https://mint.example.test'
const PUBKEY = 'a'.repeat(64)

/**
 * A fake mint that performs real BDHKE, so the proofs this produces are the ones
 * the arithmetic actually yields rather than placeholders. Counts calls, so a
 * test can assert a swap was NOT repeated.
 */
async function fakeMint() {
  const { secp256k1 } = await import('@noble/curves/secp256k1.js')
  const { bytesToHex } = await import('@noble/hashes/utils')

  const secretKey = secp256k1.utils.randomSecretKey()
  const scalar = BigInt('0x' + bytesToHex(secretKey))
  const publicKey = secp256k1.Point.BASE.multiply(scalar).toHex(true)

  const calls = { swap: 0, restore: 0, keys: 0 }
  const signed = new Map<string, { id: string; amount: number; C_: string }>()

  const sign = (outputs: { amount: number; id: string; B_: string }[]) =>
    outputs.map((output) => {
      const signature = {
        id: output.id,
        amount: output.amount,
        C_: secp256k1.Point.fromHex(output.B_).multiply(scalar).toHex(true),
      }
      signed.set(output.B_, signature)
      return signature
    })

  return {
    calls,
    publicKey,
    keys: () => ({ '1': publicKey, '2': publicKey, '4': publicKey, '8': publicKey }),
    transport: {
      async keysetKeys() {
        calls.keys++
        return { '1': publicKey, '2': publicKey, '4': publicKey, '8': publicKey }
      },
      async activeKeysetId() {
        return KEYSET
      },
      async swap(_mintUrl: string, request: { outputs: { amount: number; id: string; B_: string }[] }) {
        calls.swap++
        return { signatures: sign(request.outputs) }
      },
      async restore(_mintUrl: string, outputs: { amount: number; id: string; B_: string }[]) {
        calls.restore++
        // Mirrors the real mint: only the messages it HAS a signature for come
        // back, paired with those signatures, so a partial answer is normal.
        // Verified against the live mint, which returns `{outputs: [], signatures: []}`
        // for an unknown B_ and matched pairs otherwise.
        const matchedOutputs: { B_: string }[] = []
        const signatures: { id: string; amount: number; C_: string }[] = []
        for (const output of outputs) {
          const signature = signed.get(output.B_)
          if (!signature) continue
          matchedOutputs.push({ B_: output.B_ })
          signatures.push(signature)
        }
        return { outputs: matchedOutputs, signatures }
      },
    },
  }
}

/** A token's worth of proofs, in the shape the receive takes as input. */
const sourceProofs = (amount: number) => [
  { amount, id: KEYSET, secret: 'aa'.repeat(32), C: '02' + 'bb'.repeat(32) },
]

beforeEach(() => {
  localStorage.clear()
})

describe('a receive that completes', () => {
  it('returns proofs carrying secrets the wallet chose', async () => {
    const mint = await fakeMint()
    const result = await receiveByOwnSwap(
      { pubkey: PUBKEY, mintUrl: MINT, proofs: sourceProofs(2) },
      mint.transport,
    )

    expect(result.proofs.reduce((sum, p) => sum + p.amount, 0)).toBe(2)
    expect(result.proofs.every((p) => /^[0-9a-f]{64}$/.test(p.secret))).toBe(true)
    expect(result.proofs.every((p) => /^0[23][0-9a-f]{64}$/i.test(p.C))).toBe(true)
  })

  /**
   * The record OUTLIVES the receive, deliberately, and this is the one piece of
   * the design most likely to look like a bug.
   *
   * `receiveByOwnSwap` returns proofs that exist only in memory. Clearing the
   * record there would open exactly the window this mechanism closes: the swap is
   * done, the money has moved, and a page that dies before the caller's save
   * lands would have nothing to recover from. So the caller saves first and calls
   * `settleReceive` second.
   */
  it('keeps the intent until the caller says the proofs are saved', async () => {
    const mint = await fakeMint()
    const result = await receiveByOwnSwap(
      { pubkey: PUBKEY, mintUrl: MINT, proofs: sourceProofs(2) },
      mint.transport,
    )

    expect(
      loadSwapIntents(PUBKEY),
      'the proofs are still only in memory, so the record must remain',
    ).toHaveLength(1)

    settleReceive(PUBKEY, result.swapId)
    expect(loadSwapIntents(PUBKEY)).toEqual([])
  })

  /**
   * The ordering that the whole design rests on, asserted directly rather than
   * inferred. The transport observes the stored intent AT THE MOMENT the request
   * arrives, so this fails if the write happens after the call or not at all.
   */
  it('has already persisted the intent by the time the mint is called', async () => {
    const mint = await fakeMint()
    let intentsWhenCalled = -1

    const observing = {
      ...mint.transport,
      async swap(mintUrl: string, request: Parameters<typeof mint.transport.swap>[1]) {
        intentsWhenCalled = loadSwapIntents(PUBKEY).length
        return mint.transport.swap(mintUrl, request)
      },
    }

    await receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: sourceProofs(2) }, observing)
    expect(intentsWhenCalled, 'the intent must be on disk BEFORE the swap request').toBe(1)
  })

  /** Amounts are conserved. A receive that changes the total is a bug, not a fee. */
  it('conserves the amount across denominations', async () => {
    const mint = await fakeMint()
    const result = await receiveByOwnSwap(
      { pubkey: PUBKEY, mintUrl: MINT, proofs: sourceProofs(7) },
      mint.transport,
    )
    expect(result.proofs.map((p) => p.amount)).toEqual([4, 2, 1])
  })
})

describe('a receive whose response never arrives', () => {
  /**
   * The #123 failure. The swap may well have succeeded at the mint, so the
   * intent MUST survive: it is the only way back to money that has already moved.
   */
  it('keeps the intent when the request throws', async () => {
    const mint = await fakeMint()
    const failing = {
      ...mint.transport,
      async swap() {
        throw new Error('network died mid-request')
      },
    }

    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: sourceProofs(2) }, failing),
    ).rejects.toThrow(/network died/)

    const held = pendingSwapIntents(PUBKEY)
    expect(held, 'the intent is the only route back to money that may have moved').toHaveLength(1)
    expect(held[0].inputs).toEqual(sourceProofs(2))
    expect(held[0].outputs.every((o) => o.r && o.B_)).toBe(true)
  })

  /**
   * A mint that answers with a mismatched signature set is also an unfinished
   * receive, not a finished failure: the swap may have gone through.
   */
  it('keeps the intent when the answer cannot be unblinded', async () => {
    const mint = await fakeMint()
    const wrong = {
      ...mint.transport,
      async swap() {
        return { signatures: [] }
      },
    }

    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: sourceProofs(2) }, wrong),
    ).rejects.toThrow(/signature/)
    expect(pendingSwapIntents(PUBKEY)).toHaveLength(1)
  })
})

describe('recovering interrupted swaps', () => {
  /**
   * What runs when the wallet comes back. The intent is on disk, the mint has
   * already signed, and the proofs are rebuilt with no gateway involved. This is
   * the case that used to lose a coupon.
   */
  it('rebuilds the proofs from a persisted intent', async () => {
    const mint = await fakeMint()
    const outputs = blindOutputs(splitIntoDenominations(2), KEYSET)

    // The mint signed these, and then the response was lost.
    await mint.transport.swap(MINT, { inputs: [], outputs })

    rememberSwapIntent(PUBKEY, {
      swapId: 'interrupted',
      mintUrl: MINT,
      keysetId: KEYSET,
      inputs: sourceProofs(2),
      outputs,
      at: Date.now(),
    })

    const recovered = await recoverInterruptedSwaps(PUBKEY, mint.transport)

    expect(recovered).toHaveLength(1)
    expect(recovered[0].swapId).toBe('interrupted')
    expect(recovered[0].proofs.map((p) => p.secret)).toEqual(outputs.map((o) => o.secret))
    expect(recovered[0].proofs.reduce((sum, p) => sum + p.amount, 0)).toBe(2)
  })

  /** A recovered swap is settled, so its record goes the same as a completed one. */
  it('forgets an intent it has recovered', async () => {
    const mint = await fakeMint()
    const outputs = blindOutputs(splitIntoDenominations(2), KEYSET)
    await mint.transport.swap(MINT, { inputs: [], outputs })
    rememberSwapIntent(PUBKEY, {
      swapId: 'interrupted',
      mintUrl: MINT,
      keysetId: KEYSET,
      inputs: sourceProofs(2),
      outputs,
      at: Date.now(),
    })

    await recoverInterruptedSwaps(PUBKEY, mint.transport)
    expect(loadSwapIntents(PUBKEY)).toEqual([])
  })

  /**
   * Restore is the LOOKUP, not a second swap. Re-swapping would present already
   * burnt inputs and be refused, and if it were not refused it would be a second
   * spend. So recovery must not call swap at all.
   */
  it('recovers by asking the mint what it signed, not by swapping again', async () => {
    const mint = await fakeMint()
    const outputs = blindOutputs(splitIntoDenominations(2), KEYSET)
    await mint.transport.swap(MINT, { inputs: [], outputs })
    const swapsBefore = mint.calls.swap

    rememberSwapIntent(PUBKEY, {
      swapId: 'interrupted',
      mintUrl: MINT,
      keysetId: KEYSET,
      inputs: sourceProofs(2),
      outputs,
      at: Date.now(),
    })

    await recoverInterruptedSwaps(PUBKEY, mint.transport)

    expect(mint.calls.swap, 'recovery must not re-swap').toBe(swapsBefore)
    expect(mint.calls.restore).toBe(1)
  })

  /**
   * An intent the mint never signed is a swap that never happened. The inputs are
   * unspent, so there is nothing to recover and the coupon can simply be received
   * again. Dropping the record is right; reporting recovered proofs would be a lie.
   */
  it('reports nothing for an intent the mint never signed', async () => {
    const mint = await fakeMint()
    rememberSwapIntent(PUBKEY, {
      swapId: 'never-happened',
      mintUrl: MINT,
      keysetId: KEYSET,
      inputs: sourceProofs(2),
      outputs: blindOutputs(splitIntoDenominations(2), KEYSET),
      at: Date.now(),
    })

    expect(await recoverInterruptedSwaps(PUBKEY, mint.transport)).toEqual([])
    // And the record is DROPPED, not retried for ever. Found in review: asserting
    // only the empty return passed whether or not the drop happened, so the #127
    // claim in the module comment was unpinned. A record that can never succeed
    // would otherwise be swept on every login until it expired.
    expect(loadSwapIntents(PUBKEY)).toEqual([])
  })

  /**
   * A record past its window is not offered, because the mint may no longer
   * answer for it. It stays on disk, per `swapIntent`: a clock read must not
   * delete money.
   */
  it('ignores an intent too old to recover', async () => {
    const mint = await fakeMint()
    const outputs = blindOutputs(splitIntoDenominations(2), KEYSET)
    await mint.transport.swap(MINT, { inputs: [], outputs })
    rememberSwapIntent(PUBKEY, {
      swapId: 'ancient',
      mintUrl: MINT,
      keysetId: KEYSET,
      inputs: sourceProofs(2),
      outputs,
      at: Date.now() - 48 * 60 * 60 * 1000,
    })

    expect(await recoverInterruptedSwaps(PUBKEY, mint.transport)).toEqual([])
    expect(loadSwapIntents(PUBKEY), 'and it is still on disk').toHaveLength(1)
  })

  /**
   * One failing recovery must not abandon the others. Each intent is a separate
   * piece of somebody's money.
   */
  it('recovers the others when one intent fails', async () => {
    const mint = await fakeMint()
    const good = blindOutputs(splitIntoDenominations(2), KEYSET)
    await mint.transport.swap(MINT, { inputs: [], outputs: good })

    rememberSwapIntent(PUBKEY, {
      swapId: 'good',
      mintUrl: MINT,
      keysetId: KEYSET,
      inputs: sourceProofs(2),
      outputs: good,
      at: Date.now(),
    })
    rememberSwapIntent(PUBKEY, {
      swapId: 'broken',
      mintUrl: 'https://unreachable.example.test',
      keysetId: KEYSET,
      inputs: sourceProofs(2),
      outputs: blindOutputs(splitIntoDenominations(2), KEYSET),
      at: Date.now(),
    })

    const failing = {
      ...mint.transport,
      async restore(mintUrl: string, outputs: Parameters<typeof mint.transport.restore>[1]) {
        if (mintUrl !== MINT) throw new Error('unreachable')
        return mint.transport.restore(mintUrl, outputs)
      },
    }

    const recovered = await recoverInterruptedSwaps(PUBKEY, failing)

    expect(recovered.map((r) => r.swapId)).toEqual(['good'])
    // The one that failed is KEPT, so a later sweep can try again.
    expect(loadSwapIntents(PUBKEY).map((i) => i.swapId)).toEqual(['broken'])
  })

  it('does nothing when there is nothing to recover', async () => {
    const mint = await fakeMint()
    expect(await recoverInterruptedSwaps(PUBKEY, mint.transport)).toEqual([])
    expect(mint.calls.restore).toBe(0)
  })

  /**
   * The review finding that loses money, exercised through the sweep.
   *
   * The mint deliberately creates this state: a swap that fails partway still
   * SPENDS its inputs and leaves the outputs it did sign recoverable only through
   * restore. Insisting on a complete answer abandoned those signatures, which the
   * wallet owns and can reach no other way. Here the mint signed two of three.
   */
  it('recovers the part the mint signed when a swap was cut short', async () => {
    const mint = await fakeMint()
    const outputs = blindOutputs(splitIntoDenominations(7), KEYSET)
    expect(outputs.map((o) => o.amount)).toEqual([4, 2, 1])

    // Only the 4 and the 1 were signed before the swap was interrupted.
    await mint.transport.swap(MINT, { inputs: [], outputs: [outputs[0], outputs[2]] })

    rememberSwapIntent(PUBKEY, {
      swapId: 'cut-short',
      mintUrl: MINT,
      keysetId: KEYSET,
      inputs: sourceProofs(7),
      outputs,
      at: Date.now(),
    })

    const recovered = await recoverInterruptedSwaps(PUBKEY, mint.transport)

    expect(recovered).toHaveLength(1)
    expect(recovered[0].proofs.map((p) => p.amount)).toEqual([4, 1])
    expect(recovered[0].proofs.reduce((sum, p) => sum + p.amount, 0)).toBe(5)
    // Settled, because what could be recovered has been. The unsigned output is
    // value the mint never created, so there is nothing left to come back for.
    expect(loadSwapIntents(PUBKEY)).toEqual([])
  })

  /** And it says so, because a short recovery is worth an operator's attention. */
  it('warns when only part of a swap could be recovered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mint = await fakeMint()
    const outputs = blindOutputs(splitIntoDenominations(7), KEYSET)
    await mint.transport.swap(MINT, { inputs: [], outputs: [outputs[0]] })
    rememberSwapIntent(PUBKEY, {
      swapId: 'cut-short',
      mintUrl: MINT,
      keysetId: KEYSET,
      inputs: sourceProofs(7),
      outputs,
      at: Date.now(),
    })

    await recoverInterruptedSwaps(PUBKEY, mint.transport)

    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('a locked coupon', () => {
  /**
   * The witness must be PERSISTED, not just sent.
   *
   * A NUT-19 replay has to be byte-identical, because the mint fingerprints the
   * whole request. A locked input without its witness is both a different request
   * and one the mint would refuse anyway. Dropping it made replay silently
   * unavailable for exactly the customer-to-customer transfer case the design
   * cares most about, while the comment claimed replay was always the cheaper
   * route. Found in review.
   */
  it('keeps the witness in the record, so a replay can be byte-identical', async () => {
    const mint = await fakeMint()
    const witnessed = [{ ...sourceProofs(2)[0], witness: '{"signatures":["abc123"]}' }]

    const failing = {
      ...mint.transport,
      async swap() {
        throw new Error('response lost')
      },
    }

    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: witnessed }, failing),
    ).rejects.toThrow()

    const [held] = pendingSwapIntents(PUBKEY)
    expect(held.inputs[0].witness).toBe('{"signatures":["abc123"]}')
  })

  /** An unlocked input carries no witness field at all, keeping the wire unchanged. */
  it('records no witness field for a bearer input', async () => {
    const mint = await fakeMint()
    const failing = {
      ...mint.transport,
      async swap() {
        throw new Error('response lost')
      },
    }

    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: sourceProofs(2) }, failing),
    ).rejects.toThrow()

    expect(pendingSwapIntents(PUBKEY)[0].inputs[0]).not.toHaveProperty('witness')
  })
})

describe('what the mint is told', () => {
  /**
   * The security claim, asserted on the wire rather than trusted. The request
   * must carry blinded messages and nothing else: no secret and no blinding
   * factor. Anyone reading this request, gateway or attacker, cannot spend the
   * result.
   */
  it('never sends a secret or a blinding factor', async () => {
    const mint = await fakeMint()
    let body = ''

    const capturing = {
      ...mint.transport,
      async swap(mintUrl: string, request: Parameters<typeof mint.transport.swap>[1]) {
        body = JSON.stringify(request)
        return mint.transport.swap(mintUrl, request)
      },
    }

    const result = await receiveByOwnSwap(
      { pubkey: PUBKEY, mintUrl: MINT, proofs: sourceProofs(2) },
      capturing,
    )

    for (const proof of result.proofs) {
      expect(body, 'an output secret must never reach the mint').not.toContain(proof.secret)
    }
    for (const intent of [...loadSwapIntents(PUBKEY)]) {
      for (const output of intent.outputs) {
        expect(body).not.toContain(output.r)
      }
    }
    // The blinded messages ARE sent: that is the request.
    expect(body).toContain('B_')
  })

  /** The witness travels with the inputs, so a locked coupon can be received. */
  it('sends the witness for a locked input when one is supplied', async () => {
    const mint = await fakeMint()
    let sent: unknown = null
    const capturing = {
      ...mint.transport,
      async swap(mintUrl: string, request: Parameters<typeof mint.transport.swap>[1]) {
        sent = request
        return mint.transport.swap(mintUrl, request)
      },
    }

    const witnessed = [{ ...sourceProofs(2)[0], witness: '{"signatures":["ab"]}' }]
    await receiveByOwnSwap(
      { pubkey: PUBKEY, mintUrl: MINT, proofs: witnessed },
      capturing,
    )

    expect((sent as { inputs: { witness?: string }[] }).inputs[0].witness).toBe(
      '{"signatures":["ab"]}',
    )
  })
})

describe('a voucher is refused, not mangled', () => {
  /**
   * The bug this guard exists to prevent, and it is a money-losing one.
   *
   * This path generates RANDOM output secrets, which is right for plain ecash. A
   * voucher's secret is a NUT-10 structure carrying its id, face value, lock key,
   * issuer signature and warrant. Swapping one into a random secret would return
   * proofs worth the right number of SATS with no coupon attached: a EUR 5.00
   * coupon becomes a handful of sats, and the warrant and issuer attestation are
   * gone with it.
   *
   * Handling it properly needs the issuer to sign each fresh secret, which is the
   * one place the design keeps the gateway. Until that exists, refusing is the
   * only honest behaviour.
   *
   * Uses a REAL captured voucher token, so the guard is matched against the
   * secret shape the product actually issues rather than one written to suit it.
   */
  it('refuses a real captured voucher proof', async () => {
    const mint = await fakeMint()
    const voucherProofs = tokenProofs(
      readFileSync('src/lib/__tests__/fixtures/witness-positive.token', 'utf8').trim(),
    )
    expect(voucherProofs[0].secret.startsWith('["P2PK_VOUCHER"')).toBe(true)

    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: voucherProofs }, mint.transport),
    ).rejects.toThrow(/voucher/i)
  })

  /** Refused before anything is written down or spent. */
  it('writes no intent and makes no swap for a voucher', async () => {
    const mint = await fakeMint()
    const voucherProofs = tokenProofs(
      readFileSync('src/lib/__tests__/fixtures/witness-positive.token', 'utf8').trim(),
    )

    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: voucherProofs }, mint.transport),
    ).rejects.toThrow()

    expect(loadSwapIntents(PUBKEY)).toEqual([])
    expect(mint.calls.swap).toBe(0)
  })

  /** The unlocked voucher kind is refused too, for the same reason. */
  it('refuses the unlocked VOUCHER kind as well', async () => {
    const mint = await fakeMint()
    const unlocked = [
      {
        amount: 2,
        id: KEYSET,
        secret: '["VOUCHER","abcd",{"nonce":"00"}]',
        C: '02' + 'bb'.repeat(32),
      },
    ]

    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: unlocked }, mint.transport),
    ).rejects.toThrow(/voucher/i)
  })

  /**
   * A mixed token must be refused whole. Receiving the plain part and dropping
   * the voucher part would be the same loss, just partial.
   */
  it('refuses a mixed set containing one voucher proof', async () => {
    const mint = await fakeMint()
    const mixed = [
      ...sourceProofs(2),
      {
        amount: 2,
        id: KEYSET,
        secret: '["VOUCHER","abcd",{"nonce":"00"}]',
        C: '02' + 'cc'.repeat(32),
      },
    ]

    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: mixed }, mint.transport),
    ).rejects.toThrow(/voucher/i)
    expect(mint.calls.swap).toBe(0)
  })
})

describe('refusals', () => {
  it('refuses a receive with no proofs', async () => {
    const mint = await fakeMint()
    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: [] }, mint.transport),
    ).rejects.toThrow(/no proofs/)
  })

  it('refuses a receive with no mint URL', async () => {
    const mint = await fakeMint()
    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: '', proofs: sourceProofs(2) }, mint.transport),
    ).rejects.toThrow(/mint/)
  })

  /** Nothing is written down for a request that was never going to be made. */
  it('writes no intent for a refused receive', async () => {
    const mint = await fakeMint()
    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: [] }, mint.transport),
    ).rejects.toThrow()
    expect(loadSwapIntents(PUBKEY)).toEqual([])
    expect(mint.calls.swap).toBe(0)
  })

  it('refuses proofs whose amounts do not sum to something positive', async () => {
    const mint = await fakeMint()
    await expect(
      receiveByOwnSwap(
        { pubkey: PUBKEY, mintUrl: MINT, proofs: [{ ...sourceProofs(0)[0], amount: 0 }] },
        mint.transport,
      ),
    ).rejects.toThrow(/positive/)
  })
})

describe('the swap id', () => {
  /**
   * Derived from the inputs, not random. Two receives of the SAME coupon must
   * reuse one record, or a double-tap leaves two intents for one piece of money
   * and the second recovery reports proofs that are already saved.
   */
  it('is the same for the same inputs and different for different ones', async () => {
    const mint = await fakeMint()
    const seen: string[] = []
    const capturing = {
      ...mint.transport,
      async swap(mintUrl: string, request: Parameters<typeof mint.transport.swap>[1]) {
        seen.push(loadSwapIntents(PUBKEY)[0].swapId)
        return mint.transport.swap(mintUrl, request)
      },
    }

    await receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: sourceProofs(2) }, capturing)
    await receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: sourceProofs(2) }, capturing)
    await receiveByOwnSwap(
      {
        pubkey: PUBKEY,
        mintUrl: MINT,
        proofs: [{ amount: 2, id: KEYSET, secret: 'cc'.repeat(32), C: '02' + 'dd'.repeat(32) }],
      },
      capturing,
    )

    expect(seen[0]).toBe(seen[1])
    expect(seen[2]).not.toBe(seen[0])
  })
})

describe('an interrupted receive retried from the start', () => {
  /**
   * The double-tap case. A receive that failed, then the user tries again with
   * the same coupon. The record is keyed on the inputs, so the retry OVERWRITES
   * rather than adding a second one, and the outputs it stores are the ones the
   * retry will actually use.
   */
  it('replaces the earlier intent rather than adding a second', async () => {
    const mint = await fakeMint()
    const failing = {
      ...mint.transport,
      async swap() {
        throw new Error('first attempt died')
      },
    }

    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: sourceProofs(2) }, failing),
    ).rejects.toThrow()
    expect(loadSwapIntents(PUBKEY)).toHaveLength(1)

    const result = await receiveByOwnSwap(
      { pubkey: PUBKEY, mintUrl: MINT, proofs: sourceProofs(2) },
      mint.transport,
    )

    // ONE record, not two: the retry overwrote the first attempt's. A random
    // swap id would have left the earlier one orphaned, to be recovered later
    // into proofs the wallet has already saved.
    expect(loadSwapIntents(PUBKEY)).toHaveLength(1)

    settleReceive(PUBKEY, result.swapId)
    expect(loadSwapIntents(PUBKEY)).toEqual([])
  })
})

describe('the keyset the outputs are signed under', () => {
  /**
   * The mint's ACTIVE keyset, not the input's. A receive into a retired keyset
   * produces proofs the mint will not sign again later, which is how a coupon
   * becomes unspendable long after it was received.
   */
  it('uses the mint active keyset rather than the input keyset', async () => {
    const mint = await fakeMint()
    const retired = '00e3372e61d05605'
    let signedUnder = ''

    const capturing = {
      ...mint.transport,
      async swap(mintUrl: string, request: Parameters<typeof mint.transport.swap>[1]) {
        signedUnder = request.outputs[0].id
        return mint.transport.swap(mintUrl, request)
      },
    }

    await receiveByOwnSwap(
      { pubkey: PUBKEY, mintUrl: MINT, proofs: [{ ...sourceProofs(2)[0], id: retired }] },
      capturing,
    )

    expect(signedUnder).toBe(KEYSET)
    expect(signedUnder).not.toBe(retired)
  })
})

describe('concurrency', () => {
  /**
   * Two receives of DIFFERENT coupons at once must not clobber each other's
   * records. `localStorage` is read-modify-write, so this is the shape of bug
   * that only appears under load and loses exactly one of the two.
   */
  it('keeps both intents when two receives run together', async () => {
    const mint = await fakeMint()
    const seen = new Set<string>()

    const slow = {
      ...mint.transport,
      async swap(mintUrl: string, request: Parameters<typeof mint.transport.swap>[1]) {
        for (const intent of loadSwapIntents(PUBKEY)) seen.add(intent.swapId)
        await new Promise((resolve) => setTimeout(resolve, 10))
        return mint.transport.swap(mintUrl, request)
      },
    }

    const results = await Promise.all([
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: sourceProofs(2) }, slow),
      receiveByOwnSwap(
        {
          pubkey: PUBKEY,
          mintUrl: MINT,
          proofs: [{ amount: 4, id: KEYSET, secret: 'ee'.repeat(32), C: '02' + 'ff'.repeat(32) }],
        },
        slow,
      ),
    ])

    expect(seen.size, 'both intents must have been on disk at once').toBe(2)
    // And neither receive lost the other's record: two swaps, two settlements.
    expect(loadSwapIntents(PUBKEY)).toHaveLength(2)
    for (const result of results) settleReceive(PUBKEY, result.swapId)
    expect(loadSwapIntents(PUBKEY)).toEqual([])
  })
})

describe('transport failures that are not the mint', () => {
  /** A keyset lookup that fails happens BEFORE anything is written or spent. */
  it('writes no intent when the keyset cannot be read', async () => {
    const mint = await fakeMint()
    const noKeyset = {
      ...mint.transport,
      async activeKeysetId() {
        throw new Error('mint unreachable')
      },
    }

    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: sourceProofs(2) }, noKeyset),
    ).rejects.toThrow(/unreachable/)
    expect(loadSwapIntents(PUBKEY)).toEqual([])
    expect(mint.calls.swap).toBe(0)
  })

  /**
   * Keys that cannot be read AFTER a successful swap is the dangerous one: the
   * money has moved. The intent must survive so a sweep can finish the job.
   */
  it('keeps the intent when the keys cannot be read after the swap', async () => {
    const mint = await fakeMint()
    const noKeys = {
      ...mint.transport,
      async keysetKeys() {
        throw new Error('keys unavailable')
      },
    }

    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: sourceProofs(2) }, noKeys),
    ).rejects.toThrow(/keys unavailable/)
    expect(pendingSwapIntents(PUBKEY)).toHaveLength(1)
  })
})

describe('logging', () => {
  /**
   * A receive that could not be finished must say so loudly. The wallet has money
   * in an unknown state, and a silent failure here is how the €100 in #110 went
   * unnoticed.
   */
  it('warns when a receive is left unfinished', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mint = await fakeMint()

    await expect(
      receiveByOwnSwap(
        { pubkey: PUBKEY, mintUrl: MINT, proofs: sourceProofs(2) },
        { ...mint.transport, async swap() { throw new Error('boom') } },
      ),
    ).rejects.toThrow()

    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
