import { describe, expect, it } from 'vitest'

import { splitIntoDenominations, blindOutputs, unblindOutputs } from '../walletSwap'

/**
 * The wallet's own swap, against a real mint.
 *
 * `walletSwap.test.ts` proves the arithmetic with a stand-in mint. This proves
 * the same code against the deployed one, which is the only place three claims
 * the whole design rests on can actually be checked:
 *
 *  1. a mint accepts a swap whose outputs were chosen by the wallet rather than
 *     by whoever holds the inputs. Nothing in NUT-03 forbids it and nothing in
 *     the mint appeared to check, but "appeared to" is not evidence.
 *  2. re-posting an identical swap returns identical signatures (NUT-19), which
 *     is what makes a lost response recoverable inside the cache window.
 *  3. `/v1/restore` returns signatures for our blinded outputs (NUT-09), which
 *     is what makes it recoverable after the window closes.
 *
 * Costs 2 sat of mock-Lightning value on a shared staging stack, so it is gated
 * behind its own flag, the same way `burnProbe.test.ts` gates its spend:
 *
 *   PROBE_MINT_SWAP=1 npx vitest run src/lib/__tests__/walletSwapProbe.test.ts
 *
 * Recorded result, 2026-09-28 against mint.staging.398ja.xyz: swap accepted,
 * fresh proofs UNSPENT, inputs SPENT, replay signatures identical, restore
 * recovered byte-identical proofs.
 */
const MINT = process.env.STAGING_MINT_URL ?? 'https://mint.staging.398ja.xyz'
const swapLive = process.env.PROBE_MINT_SWAP ? describe : describe.skip

interface MintResponse {
  status: number
  body: Record<string, never>
}

swapLive('a swap the wallet performs itself', () => {
  it('is accepted, burns its inputs, and is recoverable two ways', async () => {
    const { hashToCurve } = await import('@cashu/crypto/modules/common')
    const { bytesToHex } = await import('@noble/hashes/utils')

    const post = async (path: string, body: unknown): Promise<MintResponse> => {
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
    const keyset = keysets.keysets.find((k) => k.active && k.unit === 'sat')
    expect(keyset, 'staging must have an active sat keyset').toBeDefined()
    const keys = (
      (await get(`/v1/keys/${keyset!.id}`)) as { keysets: { keys: Record<string, string> }[] }
    ).keysets[0].keys

    // Fund 2 sat. phoenixd-mock settles within a few seconds rather than
    // immediately, so this polls rather than reading the creation response —
    // which is a `paid: false` every time and is not the settled state.
    const quote = (await post('/v1/mint/quote/bolt11', { amount: 2, unit: 'sat' })).body as unknown as {
      quote: string
    }
    let state = 'UNPAID'
    for (let attempt = 0; attempt < 20 && state === 'UNPAID'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      state = ((await get(`/v1/mint/quote/bolt11/${quote.quote}`)) as { state: string }).state
    }
    expect(state, 'the mock must settle the invoice, or nothing below can run').not.toBe('UNPAID')

    // Mint into outputs THIS WALLET chose, which is already the property under
    // test: the mint is being handed blinded messages by their owner.
    const mintOutputs = blindOutputs(splitIntoDenominations(2), keyset!.id)
    const minted = await post('/v1/mint/bolt11', {
      quote: quote.quote,
      outputs: mintOutputs.map((o) => ({ amount: o.amount, id: o.id, B_: o.B_ })),
    })
    expect(minted.status, 'the mint must sign a funded quote').toBe(200)
    const mintedProofs = unblindOutputs(
      mintOutputs,
      (minted.body as unknown as { signatures: never[] }).signatures,
      keys,
    )

    // Claim 1: a swap whose outputs the wallet chose.
    const swapOutputs = blindOutputs(splitIntoDenominations(2), keyset!.id)
    const asInputs = mintedProofs.map((p) => ({
      amount: p.amount,
      id: p.id,
      secret: p.secret,
      C: p.C,
    }))
    const asOutputs = swapOutputs.map((o) => ({ amount: o.amount, id: o.id, B_: o.B_ }))
    const swap = await post('/v1/swap', { inputs: asInputs, outputs: asOutputs })
    expect(swap.status, 'the mint must accept wallet-chosen outputs').toBe(200)

    const swapSignatures = (swap.body as unknown as { signatures: never[] }).signatures
    const fresh = unblindOutputs(swapOutputs, swapSignatures, keys)
    expect(fresh.map((p) => p.amount)).toEqual([2])

    // The swap must have moved the value: new proofs live, old ones burnt. This
    // is what makes a receive a receive rather than a copy.
    const Y = (secret: string) =>
      bytesToHex(hashToCurve(new TextEncoder().encode(secret)).toRawBytes(true))
    const states = (
      (
        await post('/v1/checkstate', {
          Ys: [...fresh.map((p) => Y(p.secret)), ...mintedProofs.map((p) => Y(p.secret))],
        })
      ).body as unknown as { states: { state: string }[] }
    ).states
    expect(states.slice(0, fresh.length).map((s) => s.state)).toEqual(['UNSPENT'])
    expect(states.slice(fresh.length).map((s) => s.state)).toEqual(['SPENT'])

    // Claim 2: NUT-19 replay. The lost-response fix inside the cache window.
    const replay = await post('/v1/swap', { inputs: asInputs, outputs: asOutputs })
    expect(replay.status).toBe(200)
    expect(
      (replay.body as unknown as { signatures: never[] }).signatures,
      'an identical swap must replay rather than fail as double-spent',
    ).toEqual(swapSignatures)

    // Claim 3: NUT-09 restore. The lost-response fix after the window closes.
    // Keyed on B_, which the wallet can reproduce because it kept the secrets
    // and blinding factors.
    const restore = await post('/v1/restore', { outputs: asOutputs })
    expect(restore.status).toBe(200)
    const restored = unblindOutputs(
      swapOutputs,
      (restore.body as unknown as { signatures: never[] }).signatures,
      keys,
    )
    expect(restored, 'restore must rebuild the identical proofs').toEqual(fresh)
  }, 90_000)
})
