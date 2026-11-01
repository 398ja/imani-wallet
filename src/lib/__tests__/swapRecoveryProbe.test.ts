/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach } from 'vitest'

import { rememberSwapIntent, pendingSwapIntents, forgetSwapIntent } from '../swapIntent'
import {
  splitIntoDenominations,
  blindOutputs,
  unblindOutputs,
  unblindRestored,
} from '../walletSwap'

/**
 * Recovering a swap whose response was lost, against a real mint.
 *
 * This is the end-to-end claim of imani-wallet#123, exercised rather than
 * argued. The sequence deliberately mimics the failure from the post-deploy
 * runs: persist the intent, perform the swap, and then THROW THE RESPONSE AWAY
 * without reading it, which is what a page navigating mid-request does.
 *
 * At that point the input proofs are burnt and the wallet holds nothing but the
 * record it wrote beforehand. Both recoveries are then run from that record
 * alone:
 *
 *  - NUT-19 replay: re-post the identical swap, get the original signatures.
 *  - NUT-09 restore: ask for signatures on our blinded outputs, keyed on `B_`.
 *
 * Under the old design this was the unrecoverable case, because the gateway
 * chose the secrets and the escrow kept no copy. The test passes only if the
 * wallet can rebuild spendable proofs with no help from anybody but the mint.
 *
 * Costs 2 sat on a shared staging stack, so gated like the other spend probes:
 *
 *   PROBE_MINT_SWAP=1 npx vitest run src/lib/__tests__/swapRecoveryProbe.test.ts
 *
 * Recorded result, 2026-09-28 against mint.staging.398ja.xyz: inputs SPENT after
 * the discarded swap, replay returned the original signatures, restore returned
 * them too, and both rebuilt proofs the mint reports UNSPENT.
 */
const MINT = process.env.STAGING_MINT_URL ?? 'https://mint.staging.398ja.xyz'
const swapLive = process.env.PROBE_MINT_SWAP ? describe : describe.skip
const PUBKEY = 'a'.repeat(64)

beforeEach(() => {
  localStorage.clear()
})

swapLive('a swap whose response was never read', () => {
  it('is recovered from the persisted intent alone, two ways', async () => {
    const { hashToCurve } = await import('@cashu/crypto/modules/common')
    const { bytesToHex } = await import('@noble/hashes/utils')

    const post = async (path: string, body: unknown) => {
      const response = await fetch(MINT + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: (await response.json().catch(() => null)) as never }
    }
    const get = async (path: string) => (await fetch(MINT + path)).json() as never

    const keysets = (await get('/v1/keysets')) as {
      keysets: { id: string; unit: string; active: boolean }[]
    }
    const keyset = keysets.keysets.find((k) => k.active && k.unit === 'sat')!
    const keys = (
      (await get(`/v1/keys/${keyset.id}`)) as { keysets: { keys: Record<string, string> }[] }
    ).keysets[0].keys

    // Fund 2 sat and mint it into wallet-chosen outputs.
    const quote = (await post('/v1/mint/quote/bolt11', { amount: 2, unit: 'sat' }))
      .body as unknown as { quote: string }
    let state = 'UNPAID'
    for (let attempt = 0; attempt < 20 && state === 'UNPAID'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      state = ((await get(`/v1/mint/quote/bolt11/${quote.quote}`)) as { state: string }).state
    }
    expect(state).not.toBe('UNPAID')

    const mintOutputs = blindOutputs(splitIntoDenominations(2), keyset.id)
    const minted = await post('/v1/mint/bolt11', {
      quote: quote.quote,
      outputs: mintOutputs.map((o) => ({ amount: o.amount, id: o.id, B_: o.B_ })),
    })
    expect(minted.status).toBe(200)
    const sourceProofs = unblindOutputs(
      mintOutputs,
      (minted.body as unknown as { signatures: never[] }).signatures,
      keys,
    )

    // --- the receive begins ---------------------------------------------------

    const swapOutputs = blindOutputs(splitIntoDenominations(2), keyset.id)
    const inputs = sourceProofs.map((p) => ({
      amount: p.amount,
      id: p.id,
      secret: p.secret,
      C: p.C,
    }))

    // Step 1, and the ordering is the whole point: written down BEFORE the
    // request, so a navigation between here and the response is survivable.
    rememberSwapIntent(PUBKEY, {
      swapId: 'recovery-probe',
      mintUrl: MINT,
      keysetId: keyset.id,
      inputs,
      outputs: swapOutputs,
      at: Date.now(),
    })

    // Step 2: the swap really happens, and the response is DISCARDED unread.
    // This is the page navigating mid-request. The money has moved and the
    // wallet does not know what it moved to.
    const asOutputs = swapOutputs.map((o) => ({ amount: o.amount, id: o.id, B_: o.B_ }))
    const lost = await post('/v1/swap', { inputs, outputs: asOutputs })
    expect(lost.status, 'the swap itself must have succeeded').toBe(200)

    const Y = (secret: string) =>
      bytesToHex(hashToCurve(new TextEncoder().encode(secret)).toRawBytes(true))
    const inputStates = (
      (await post('/v1/checkstate', { Ys: sourceProofs.map((p) => Y(p.secret)) }))
        .body as unknown as { states: { state: string }[] }
    ).states
    expect(
      inputStates.map((s) => s.state),
      'the inputs must be burnt, or there is nothing to recover from',
    ).toEqual(['SPENT'])

    // --- recovery, from the record and nothing else ---------------------------

    // Everything below uses ONLY what a fresh page would read back. The
    // in-memory `swapOutputs` above is deliberately not referenced again.
    const [recovered] = pendingSwapIntents(PUBKEY)
    expect(recovered, 'the intent must survive to be read back').toBeDefined()
    expect(recovered.swapId).toBe('recovery-probe')

    const recoveredOutputs = recovered.outputs.map((o) => ({
      amount: o.amount,
      id: o.id,
      B_: o.B_,
    }))

    // Recovery one: NUT-19 replay of the identical request.
    const replay = await post('/v1/swap', {
      inputs: recovered.inputs,
      outputs: recoveredOutputs,
    })
    expect(replay.status, 'an identical swap must replay, not fail as double-spent').toBe(200)
    const fromReplay = unblindOutputs(
      recovered.outputs,
      (replay.body as unknown as { signatures: never[] }).signatures,
      keys,
    )

    // Recovery two: NUT-09 restore, which still works after the replay cache
    // has expired.
    const restore = await post('/v1/restore', { outputs: recoveredOutputs })
    expect(restore.status).toBe(200)
    const { proofs: fromRestore, unmatched } = unblindRestored(
      recovered.outputs,
      restore.body as unknown as { outputs: { B_: string }[]; signatures: never[] },
      keys,
    )
    expect(unmatched, 'the mint signed the whole swap, so nothing is unmatched').toEqual([])

    // Both routes must produce the SAME proofs, because both are recovering the
    // one set of signatures the mint issued.
    expect(fromRestore).toEqual(fromReplay)

    // And those proofs must be live money. This is the assertion the whole
    // design is for: the coupon that used to be lost is now in the wallet's
    // hands, recovered without the gateway.
    const recoveredStates = (
      (await post('/v1/checkstate', { Ys: fromReplay.map((p) => Y(p.secret)) }))
        .body as unknown as { states: { state: string }[] }
    ).states
    expect(recoveredStates.map((s) => s.state)).toEqual(['UNSPENT'])
    expect(fromReplay.reduce((sum, p) => sum + p.amount, 0)).toBe(2)

    // Only now is the record dropped, and it must actually go: it holds the
    // secrets of money that is now safely stored elsewhere.
    forgetSwapIntent(PUBKEY, 'recovery-probe')
    expect(pendingSwapIntents(PUBKEY)).toEqual([])
  }, 90_000)
})
