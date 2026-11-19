/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'

import { receiveByOwnSwap, recoverInterruptedSwaps } from '../receiveSwap'
import { MintRefusal, isKeysetInactive } from '../mintRefusal'
import { createMintTransport } from '../mintTransport'
import { pendingSwapIntents, rememberSwapIntent } from '../swapIntent'
import { blindOutputs, splitIntoDenominations } from '../walletSwap'

/**
 * A receive left pending across a keyset rotation (#248).
 *
 * The resumed attempt replays its stored outputs on the old keyset, and the mint refuses them
 * with 12002 before spending anything. Without handling that, every retry fails the same way.
 */

const OLD = '00' + 'aa'.repeat(7)
const NEW = '00' + 'bb'.repeat(7)
const MINT = 'https://mint.example.test'
const PUBKEY = 'c'.repeat(64)
const proofs = [{ amount: 2, id: OLD, secret: 'dd'.repeat(32), C: '02' + 'ee'.repeat(32) }]

const inactive = () =>
  new MintRefusal('swap refused by the mint: keyset inactive', 400, 12002, 'keyset inactive')

async function rotatedMint() {
  const { secp256k1 } = await import('@noble/curves/secp256k1.js')
  const { bytesToHex } = await import('@noble/hashes/utils')
  const scalar = BigInt('0x' + bytesToHex(secp256k1.utils.randomSecretKey()))
  const pub = secp256k1.Point.BASE.multiply(scalar).toHex(true)
  const swaps: { id: string; B_: string }[][] = []
  return {
    swaps,
    transport: {
      async activeKeysetId() {
        return NEW
      },
      async keysetKeys() {
        return { '1': pub, '2': pub }
      },
      async swap(_m: string, req: { inputs: unknown[]; outputs: { amount: number; id: string; B_: string }[] }) {
        swaps.push(req.outputs.map(({ id, B_ }) => ({ id, B_ })))
        if (req.outputs.some((o) => o.id !== NEW)) throw inactive()
        return {
          signatures: req.outputs.map((o) => ({
            id: o.id,
            amount: o.amount,
            C_: secp256k1.Point.fromHex(o.B_).multiply(scalar).toHex(true),
          })),
        }
      },
      restore: vi.fn(async () => ({ outputs: [], signatures: [] })),
    },
  }
}

/** The first attempt, written before the rotation, on the old keyset. */
async function pendingOnOldKeyset() {
  const { receiveSwapId } = await import('../receiveSwap')
  const swapId = receiveSwapId(proofs)
  const outputs = blindOutputs(splitIntoDenominations(2), OLD)
  rememberSwapIntent(PUBKEY, { swapId, mintUrl: MINT, keysetId: OLD, inputs: proofs, outputs, at: Date.now() })
  return { swapId, outputs }
}

beforeEach(() => localStorage.clear())

describe('a receive resumed across a keyset rotation', () => {
  it('re-blinds against the active keyset and completes', async () => {
    const mint = await rotatedMint()
    const { swapId, outputs } = await pendingOnOldKeyset()

    const result = await receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs }, mint.transport)

    expect(mint.swaps).toHaveLength(2)
    expect(mint.swaps[0].map((o) => o.B_), 'the first try is still the byte-identical replay').toEqual(
      outputs.map((o) => o.B_),
    )
    expect(mint.swaps[1].every((o) => o.id === NEW)).toBe(true)
    expect(result.proofs.every((p) => p.id === NEW)).toBe(true)
    expect(result.proofs.reduce((s, p) => s + p.amount, 0)).toBe(2)
    expect(result.swapId).toBe(swapId)

    const held = pendingSwapIntents(PUBKEY)
    expect(held, 'one record, the old unsigned outputs replaced').toHaveLength(1)
    expect(held[0].keysetId).toBe(NEW)
    expect(held[0].outputs.map((o) => o.B_)).toEqual(mint.swaps[1].map((o) => o.B_))
  })

  it('does not loop when the mint calls the refused keyset active', async () => {
    const mint = await rotatedMint()
    await pendingOnOldKeyset()
    const confused = { ...mint.transport, activeKeysetId: async () => OLD }

    await expect(
      receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs }, confused),
    ).rejects.toThrow(/still lists it as active/)
    expect(mint.swaps).toHaveLength(1)
    expect(pendingSwapIntents(PUBKEY)[0].keysetId).toBe(OLD)
  })
})

describe('when re-blinding must NOT happen', () => {
  it('keeps the outputs when any signature came back', async () => {
    const mint = await rotatedMint()
    const { outputs } = await pendingOnOldKeyset()
    const partial = {
      ...mint.transport,
      async swap() {
        mint.swaps.push([])
        return { signatures: [{ id: OLD, amount: 2, C_: '02' + '11'.repeat(32) }] }
      },
    }

    await expect(receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs }, partial)).rejects.toThrow()
    expect(mint.swaps).toHaveLength(1)
    const held = pendingSwapIntents(PUBKEY)[0]
    expect(held.outputs.map((o) => `${o.B_}:${o.r}`)).toEqual(outputs.map((o) => `${o.B_}:${o.r}`))
  })

  it.each([
    ['already spent', new MintRefusal('swap refused by the mint: Token already spent.', 400, 11001)],
    ['a network failure', new Error('network died mid-request')],
    ['12002 in the message only', new Error('keyset inactive 12002')],
  ])('leaves other errors unchanged: %s', async (_name, error) => {
    const mint = await rotatedMint()
    const { outputs } = await pendingOnOldKeyset()
    const failing = {
      ...mint.transport,
      async swap() {
        mint.swaps.push([])
        throw error
      },
    }

    await expect(receiveByOwnSwap({ pubkey: PUBKEY, mintUrl: MINT, proofs }, failing)).rejects.toBe(error)
    expect(mint.swaps).toHaveLength(1)
    expect(pendingSwapIntents(PUBKEY)[0].outputs.map((o) => o.B_)).toEqual(outputs.map((o) => o.B_))
  })
})

describe('the recovery sweep is untouched', () => {
  it('only restores, never swaps or re-blinds, for an intent on a retired keyset', async () => {
    const mint = await rotatedMint()
    await pendingOnOldKeyset()
    await recoverInterruptedSwaps(PUBKEY, mint.transport)
    expect(mint.transport.restore).toHaveBeenCalledTimes(1)
    expect(mint.swaps).toHaveLength(0)
  })
})

describe('the transport reports the mint code', () => {
  it('turns a 12002 body into a keyset-inactive refusal', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ detail: 'keyset inactive', code: 12002 }), { status: 400 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const failure = await createMintTransport()
        .swap(MINT, { inputs: proofs, outputs: [{ amount: 2, id: OLD, B_: '02' + '00'.repeat(32) }] })
        .catch((e: unknown) => e)
      expect(isKeysetInactive(failure)).toBe(true)
      expect((failure as Error).message).toMatch(/keyset inactive/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
