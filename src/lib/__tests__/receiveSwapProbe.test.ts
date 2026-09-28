import { describe, expect, it, beforeEach } from 'vitest'

import { createMintTransport } from '../mintTransport'
import { receiveByOwnSwap, recoverInterruptedSwaps, settleReceive } from '../receiveSwap'
import { loadSwapIntents } from '../swapIntent'
import { splitIntoDenominations, blindOutputs, unblindOutputs } from '../walletSwap'

/**
 * A whole receive, through the real transport, against the real mint.
 *
 * The other probes exercise the primitives. This one runs the actual production
 * path end to end: `createMintTransport` talking HTTP to staging, driven by
 * `receiveByOwnSwap`, with nothing faked. It is the closest thing to the finished
 * feature that exists before the call site is wired.
 *
 * Two claims, and neither can be established with a stub:
 *
 *  1. the transport and the orchestration agree on every wire shape, including
 *     the keyset lookup, the swap and the restore. A mismatch in any one of them
 *     is invisible to a fake mint built from the same assumptions.
 *  2. a receive whose response is lost is recovered by the real sweep, using the
 *     real restore, and the recovered proofs are live money at the mint.
 *
 * Costs 2 sat of mock-Lightning value, so gated like the other spend probes:
 *
 *   PROBE_MINT_SWAP=1 npx vitest run src/lib/__tests__/receiveSwapProbe.test.ts
 *
 * Recorded result, 2026-09-28 against mint.staging.398ja.xyz: receive completed,
 * proofs UNSPENT, source SPENT, and an abandoned receive recovered by the sweep.
 */
const MINT = process.env.STAGING_MINT_URL ?? 'https://mint.staging.398ja.xyz'
const swapLive = process.env.PROBE_MINT_SWAP ? describe : describe.skip
const PUBKEY = 'b'.repeat(64)

/**
 * Node's environment, not jsdom, and deliberately.
 *
 * jsdom ships its own `AbortController` whose signal Node's `fetch` refuses, so
 * the timeout in `mintTransport` makes every real request fail there. That is a
 * test-harness artefact rather than a defect, and the other probes avoid it only
 * because they call `fetch` without a signal.
 *
 * This probe needs a REAL network stack, so it runs under node and brings the one
 * browser API the swap record depends on. Small enough to be obviously correct,
 * and it keeps the production modules unchanged.
 */
const memoryStorage = () => {
  const entries = new Map<string, string>()
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, String(value)),
    removeItem: (key: string) => void entries.delete(key),
    clear: () => entries.clear(),
    key: (index: number) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size
    },
  } as Storage
}

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), writable: true })
}

beforeEach(() => {
  localStorage.clear()
})

/** 2 sat of real proofs from the staging mint, minted into wallet-chosen outputs. */
async function fundedProofs(keysetId: string, keys: Record<string, string>) {
  const post = async (path: string, body: unknown) => {
    const response = await fetch(MINT + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json().catch(() => null)) as never }
  }
  const get = async (path: string) => (await fetch(MINT + path)).json() as never

  const quote = (await post('/v1/mint/quote/bolt11', { amount: 2, unit: 'sat' }))
    .body as unknown as { quote: string }
  let state = 'UNPAID'
  for (let attempt = 0; attempt < 20 && state === 'UNPAID'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    state = ((await get(`/v1/mint/quote/bolt11/${quote.quote}`)) as { state: string }).state
  }
  expect(state, 'the mock must settle the invoice').not.toBe('UNPAID')

  const outputs = blindOutputs(splitIntoDenominations(2), keysetId)
  const minted = await post('/v1/mint/bolt11', {
    quote: quote.quote,
    outputs: outputs.map((o) => ({ amount: o.amount, id: o.id, B_: o.B_ })),
  })
  expect(minted.status).toBe(200)
  return unblindOutputs(
    outputs,
    (minted.body as unknown as { signatures: never[] }).signatures,
    keys,
  )
}

/** The mint's view of whether these secrets are still spendable. */
async function statesOf(secrets: string[]) {
  const { hashToCurve } = await import('@cashu/crypto/modules/common')
  const { bytesToHex } = await import('@noble/hashes/utils')
  const Ys = secrets.map((secret) =>
    bytesToHex(hashToCurve(new TextEncoder().encode(secret)).toRawBytes(true)),
  )
  const response = await fetch(MINT + '/v1/checkstate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Ys }),
  })
  const body = (await response.json()) as { states: { state: string }[] }
  return body.states.map((s) => s.state)
}

swapLive('a receive through the real transport', () => {
  it('completes, and the money is the wallet own', async () => {
    const transport = createMintTransport()

    const keysetId = await transport.activeKeysetId(MINT)
    const keys = await transport.keysetKeys(MINT, keysetId)
    const source = await fundedProofs(keysetId, keys)

    const result = await receiveByOwnSwap(
      { pubkey: PUBKEY, mintUrl: MINT, proofs: source },
      transport,
    )

    expect(result.proofs.reduce((sum, p) => sum + p.amount, 0)).toBe(2)
    expect(await statesOf(result.proofs.map((p) => p.secret))).toEqual(['UNSPENT'])
    expect(
      await statesOf(source.map((p) => p.secret)),
      'the source must be burnt, or this was a copy rather than a receive',
    ).toEqual(['SPENT'])

    // The record outlives the receive until the caller settles it.
    expect(loadSwapIntents(PUBKEY)).toHaveLength(1)
    settleReceive(PUBKEY, result.swapId)
    expect(loadSwapIntents(PUBKEY)).toEqual([])
  }, 90_000)

  /**
   * The #123 case, through production code from end to end. The swap is performed
   * by the real transport and the result is thrown away, which is what a page
   * navigating mid-request does. The sweep then rebuilds the money from the record
   * alone, using the real restore against the real mint.
   */
  it('is recovered by the sweep when its response is abandoned', async () => {
    const transport = createMintTransport()
    const keysetId = await transport.activeKeysetId(MINT)
    const keys = await transport.keysetKeys(MINT, keysetId)
    const source = await fundedProofs(keysetId, keys)

    // A transport whose swap really happens and then refuses to report it.
    const losesTheResponse = {
      ...transport,
      async swap(mintUrl: string, request: Parameters<typeof transport.swap>[1]) {
        await transport.swap(mintUrl, request)
        throw new Error('the page navigated before the response arrived')
      },
    }

    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs: source }, losesTheResponse),
    ).rejects.toThrow(/navigated/)

    // The money has moved and the wallet does not know where.
    expect(await statesOf(source.map((p) => p.secret))).toEqual(['SPENT'])
    expect(loadSwapIntents(PUBKEY), 'the record is the only route back').toHaveLength(1)

    const recovered = await recoverInterruptedSwaps(PUBKEY, transport)

    expect(recovered).toHaveLength(1)
    expect(recovered[0].proofs.reduce((sum, p) => sum + p.amount, 0)).toBe(2)
    expect(
      await statesOf(recovered[0].proofs.map((p) => p.secret)),
      'the recovered proofs must be live money',
    ).toEqual(['UNSPENT'])
    expect(loadSwapIntents(PUBKEY), 'and the record is settled').toEqual([])
  }, 90_000)
})
