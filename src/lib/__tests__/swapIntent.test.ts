/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'

import {
  rememberSwapIntent,
  loadSwapIntents,
  forgetSwapIntent,
  pendingSwapIntents,
  SWAP_INTENT_LIFETIME_MS,
  type SwapIntent,
} from '../swapIntent'
import { blindOutputs, splitIntoDenominations } from '../walletSwap'

/**
 * What the wallet must write down before it asks the mint to swap.
 *
 * ## Why this has to exist before the request, not after
 *
 * The mint's answer is blind signatures. They are worthless without the
 * blinding factors, and those exist only in the page that generated them. So the
 * ordering is forced: persist, then request. A page that navigates mid-request
 * after persisting can rebuild the proofs; one that navigates before has asked
 * the mint to burn an input in exchange for something nobody can reconstruct.
 *
 * That is imani-wallet#123 exactly, and it is the reason this module is not an
 * optimisation. The wallet-side swap is only safe because of it.
 *
 * ## Why localStorage and not IndexedDB
 *
 * IndexedDB is async, and the write has to have LANDED before the request goes
 * out. An async write racing a navigation is the failure this prevents, so using
 * one here would reintroduce it in a subtler form. `localStorage` is synchronous:
 * when `rememberSwapIntent` returns, the record is on disk. `pay.ts` stores
 * pending sends the same way, for the same reason.
 */

const PUBKEY = 'b1787b2b98c0a4f9e1d3c5a7b9e1d3c5a7b9e1d3c5a7b9e1d3c5a7b9e1d3c5a7'
const KEYSET = '01ef5b830da1f32acd88bdf30c246627833672eb53112b7e2962a608ba96773aa9'

const intent = (overrides: Partial<SwapIntent> = {}): SwapIntent => ({
  swapId: 'swap-1',
  mintUrl: 'https://mint.example.test',
  keysetId: KEYSET,
  inputs: [{ amount: 2, id: KEYSET, secret: 'aa'.repeat(32), C: '02' + 'bb'.repeat(32) }],
  outputs: blindOutputs(splitIntoDenominations(2), KEYSET),
  at: Date.now(),
  ...overrides,
})

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('remembering an intent', () => {
  it('reads back exactly what was written', () => {
    const written = intent()
    rememberSwapIntent(PUBKEY, written)
    expect(loadSwapIntents(PUBKEY)).toEqual([written])
  })

  /**
   * The blinding factor is the whole point of the record. Without it the mint's
   * answer cannot become a proof, so a store that dropped it would look like it
   * was working and recover nothing.
   */
  it('keeps the blinding factor and the secret of every output', () => {
    const written = intent()
    rememberSwapIntent(PUBKEY, written)

    const [read] = loadSwapIntents(PUBKEY)
    expect(read.outputs.map((o) => o.r)).toEqual(written.outputs.map((o) => o.r))
    expect(read.outputs.map((o) => o.secret)).toEqual(written.outputs.map((o) => o.secret))
    expect(read.outputs.every((o) => /^[0-9a-f]{64}$/.test(o.r))).toBe(true)
  })

  /**
   * `B_` is what NUT-09 restore is keyed on, so a record without it can be
   * replayed but not restored, which is the recovery that still works after the
   * mint's replay cache has expired.
   */
  it('keeps the blinded message, which restore is keyed on', () => {
    const written = intent()
    rememberSwapIntent(PUBKEY, written)
    expect(loadSwapIntents(PUBKEY)[0].outputs.map((o) => o.B_)).toEqual(
      written.outputs.map((o) => o.B_),
    )
  })

  /**
   * The inputs are needed to REPLAY the swap, which is the cheaper recovery of
   * the two: NUT-19 returns the original response for an identical request.
   * Without them only restore is available.
   */
  it('keeps the inputs, so the swap can be replayed verbatim', () => {
    const written = intent()
    rememberSwapIntent(PUBKEY, written)
    expect(loadSwapIntents(PUBKEY)[0].inputs).toEqual(written.inputs)
  })

  /** A retry of the same swap must not accumulate records. */
  it('overwrites a record with the same swap id', () => {
    rememberSwapIntent(PUBKEY, intent({ swapId: 'swap-1' }))
    rememberSwapIntent(PUBKEY, intent({ swapId: 'swap-1', mintUrl: 'https://other.test' }))

    const all = loadSwapIntents(PUBKEY)
    expect(all).toHaveLength(1)
    expect(all[0].mintUrl).toBe('https://other.test')
  })

  it('keeps several distinct swaps', () => {
    rememberSwapIntent(PUBKEY, intent({ swapId: 'a' }))
    rememberSwapIntent(PUBKEY, intent({ swapId: 'b' }))
    expect(loadSwapIntents(PUBKEY).map((i) => i.swapId).sort()).toEqual(['a', 'b'])
  })

  /**
   * Scoped per pubkey, like every other record in this wallet. Two accounts on
   * one device must not read each other's swaps, and an intent carries the
   * secrets of live money.
   */
  it('does not leak between accounts on one device', () => {
    rememberSwapIntent(PUBKEY, intent())
    expect(loadSwapIntents('c'.repeat(64))).toEqual([])
  })
})

describe('forgetting an intent', () => {
  /**
   * Dropped once the proofs are saved, and not before. An intent that outlives
   * its swap is a set of live secrets sitting in localStorage for no reason.
   */
  it('removes only the named swap', () => {
    rememberSwapIntent(PUBKEY, intent({ swapId: 'a' }))
    rememberSwapIntent(PUBKEY, intent({ swapId: 'b' }))

    forgetSwapIntent(PUBKEY, 'a')

    expect(loadSwapIntents(PUBKEY).map((i) => i.swapId)).toEqual(['b'])
  })

  /** The key is removed entirely when the last intent goes, leaving no residue. */
  it('leaves nothing behind when the last one is forgotten', () => {
    rememberSwapIntent(PUBKEY, intent({ swapId: 'only' }))
    forgetSwapIntent(PUBKEY, 'only')

    expect(loadSwapIntents(PUBKEY)).toEqual([])
    expect(
      Object.keys(localStorage).some((k) => k.includes('swap-intent')),
      'the storage key itself must be gone, not left holding an empty array',
    ).toBe(false)
  })

  it('is silent about a swap it does not hold', () => {
    rememberSwapIntent(PUBKEY, intent({ swapId: 'a' }))
    expect(() => forgetSwapIntent(PUBKEY, 'nope')).not.toThrow()
    expect(loadSwapIntents(PUBKEY)).toHaveLength(1)
  })
})

describe('which intents are still worth recovering', () => {
  /**
   * An intent is only recoverable while the mint will still answer for it.
   * Replay depends on a cache with a TTL, and restore depends on the keyset
   * still being loaded. Past that a record is secrets with no use, so it stops
   * being offered rather than being retried forever. `pay.ts` caps pending sends
   * for the same reason (#127: a permanent failure retried for ever).
   */
  it('excludes an intent older than the lifetime', () => {
    const fresh = intent({ swapId: 'fresh', at: Date.now() })
    const stale = intent({ swapId: 'stale', at: Date.now() - SWAP_INTENT_LIFETIME_MS - 1 })
    rememberSwapIntent(PUBKEY, fresh)
    rememberSwapIntent(PUBKEY, stale)

    expect(pendingSwapIntents(PUBKEY).map((i) => i.swapId)).toEqual(['fresh'])
    // Still ON DISK though: expiry decides what is offered for recovery, not
    // what is deleted. Deleting money-bearing records on a clock read would
    // destroy the only copy of a proof nobody has rebuilt yet.
    expect(loadSwapIntents(PUBKEY)).toHaveLength(2)
  })

  it('offers an intent right up to the lifetime boundary', () => {
    vi.useFakeTimers()
    const start = Date.now()
    rememberSwapIntent(PUBKEY, intent({ swapId: 'edge', at: start }))

    vi.setSystemTime(start + SWAP_INTENT_LIFETIME_MS - 1)
    expect(pendingSwapIntents(PUBKEY)).toHaveLength(1)

    vi.setSystemTime(start + SWAP_INTENT_LIFETIME_MS)
    expect(pendingSwapIntents(PUBKEY)).toHaveLength(0)
  })
})

describe('when the store is full', () => {
  /**
   * The cap must sacrifice records that can no longer be acted on, not whichever
   * happens to be oldest.
   *
   * Found in review. The original sliced the newest 20 regardless, so a wallet
   * holding 20 dead records and one live one could drop the live one, which may be
   * the only copy of the blinding factors for money the mint has already moved.
   * `pendingSwapIntents` refuses exactly this hazard on a clock read two functions
   * away, and the same argument applies to a count.
   */
  it('drops expired records before any live one', () => {
    const stale = Date.now() - SWAP_INTENT_LIFETIME_MS - 1
    for (let index = 0; index < 20; index++) {
      rememberSwapIntent(PUBKEY, intent({ swapId: `dead-${index}`, at: stale }))
    }
    expect(loadSwapIntents(PUBKEY)).toHaveLength(20)

    rememberSwapIntent(PUBKEY, intent({ swapId: 'live', at: Date.now() }))

    const held = loadSwapIntents(PUBKEY)
    expect(
      held.map((i) => i.swapId),
      'the live record must survive and the dead ones make way',
    ).toEqual(['live'])
  })

  /**
   * Only when there are genuinely more LIVE records than the cap is one that might
   * still be recoverable dropped, and then it is said out loud, because that is
   * money going out of reach.
   */
  it('warns when it has to drop a record that may still be recoverable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let index = 0; index < 21; index++) {
      rememberSwapIntent(PUBKEY, intent({ swapId: `live-${index}`, at: Date.now() }))
    }

    expect(loadSwapIntents(PUBKEY)).toHaveLength(20)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  /** Under the cap nothing is touched, expired or not. */
  it('keeps everything while there is room', () => {
    rememberSwapIntent(PUBKEY, intent({ swapId: 'a', at: Date.now() - SWAP_INTENT_LIFETIME_MS - 1 }))
    rememberSwapIntent(PUBKEY, intent({ swapId: 'b', at: Date.now() }))
    expect(loadSwapIntents(PUBKEY)).toHaveLength(2)
  })
})

describe('a store that has been corrupted', () => {
  /**
   * Reading must never throw. This is called on the receive path, and an
   * exception here would break receiving money over a damaged record that has
   * nothing to do with the coupon in hand.
   */
  it('reads as empty rather than throwing on malformed JSON', () => {
    localStorage.setItem(`imani-wallet:swap-intents:${PUBKEY}`, '{not json')
    expect(loadSwapIntents(PUBKEY)).toEqual([])
  })

  it('reads as empty when the stored value is not an array', () => {
    localStorage.setItem(`imani-wallet:swap-intents:${PUBKEY}`, '{"swapId":"a"}')
    expect(loadSwapIntents(PUBKEY)).toEqual([])
  })

  /**
   * One unusable entry must not discard the others. Each record is a separate
   * piece of money, so they are filtered individually rather than as a batch.
   */
  it('drops only the entries that are unusable', () => {
    const good = intent({ swapId: 'good' })
    localStorage.setItem(
      `imani-wallet:swap-intents:${PUBKEY}`,
      JSON.stringify([{ nonsense: true }, good, null, { swapId: 'no outputs' }]),
    )
    expect(loadSwapIntents(PUBKEY).map((i) => i.swapId)).toEqual(['good'])
  })
})
