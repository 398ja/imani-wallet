/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  BUNDLE_WAIT_WINDOW_MS,
  _resetBundleArrivalsForTests,
  bundleView,
  describeBundle,
  reconcileBundles,
  stopBundleTracking,
  trackArrival,
  type ArrivedPart,
  type BundleView,
} from '../bundleArrival'
import { RATE_LIMIT_BACKOFFS_MS } from '../dmPoll'
import { PACED_BUNDLE_PARTS, worstCasePacingDelayMs } from '../receivePacer'

/**
 * One multi-coupon payment, counted as one (#94).
 *
 * The aggregation itself is BundleReceiptStore's and is tested there. These
 * pin what the wallet adds on top: the per-account storage, the currency
 * guard, telling a re-read wrap from a second delivery, and — the rule the
 * whole feature rests on — that the DECLARED figures are only ever shown as
 * expected, while the RECEIVED ones are what arrived.
 */

const ME = 'a'.repeat(64)
const ALICE = 'b'.repeat(64)
const MALLORY = 'c'.repeat(64)
const BUNDLE = '0123456789abcdef0123456789abcdef'

function part(index: number, overrides: Partial<ArrivedPart> = {}): ArrivedPart {
  return {
    bundleId: BUNDLE,
    declaredTotal: 600,
    declaredCount: 2,
    partIndex: index,
    amount: 300,
    unit: 'EUR',
    decimals: 2,
    senderPubkey: ALICE,
    eventId: `wrap-${index}`,
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
  _resetBundleArrivalsForTests(ME)
})

describe('tracking the parts of one payment', () => {
  it('counts €6 from €3 + €3 as one payment, in flight then complete', async () => {
    const first = await trackArrival(ME, part(0))
    expect(first).toMatchObject({ kind: 'bundle', view: { receivedTotal: 300, receivedCount: 1, state: 'in_flight' } })

    const second = await trackArrival(ME, part(1))
    expect(second).toMatchObject({
      kind: 'bundle',
      previous: 'in_flight',
      view: { receivedTotal: 600, receivedCount: 2, declaredTotal: 600, state: 'complete', mismatch: false },
    })
  })

  it('does not lose a part when two arrive back to back', async () => {
    // Not awaited in between: the store reads then writes, and without the
    // queue the second read would miss the first write.
    await Promise.all([trackArrival(ME, part(0)), trackArrival(ME, part(1))])
    expect(await bundleView(ME, BUNDLE)).toMatchObject({ receivedCount: 2, receivedTotal: 600 })
  })

  it('treats the same wrap twice as one part, and says nothing the second time', async () => {
    await trackArrival(ME, part(0))
    const again = await trackArrival(ME, part(0))
    expect(again.kind).toBe('repeat')
    expect(await bundleView(ME, BUNDLE)).toMatchObject({ receivedCount: 1, receivedTotal: 300 })
  })

  it('announces a different delivery under a filled index on its own, and flags the bundle', async () => {
    await trackArrival(ME, part(0))
    const other = await trackArrival(ME, part(0, { eventId: 'another-wrap' }))
    expect(other).toMatchObject({ kind: 'standalone', reason: 'duplicate_index' })
    expect(await bundleView(ME, BUNDLE)).toMatchObject({ receivedCount: 1, mismatch: true })
  })

  it('never hides a part as a repeat when there is no wrap id to prove it', async () => {
    // Review finding: a missing event id used to count as "the same wrap",
    // silently swallowing a different coupon under an already-filled index.
    await trackArrival(ME, part(0, { eventId: undefined }))
    const other = await trackArrival(ME, part(0, { eventId: undefined }))
    expect(other.kind).toBe('standalone')
  })

  it('drops work queued before logout instead of writing it back', async () => {
    const pending = trackArrival(ME, part(0))
    stopBundleTracking()
    expect(await pending).toMatchObject({ kind: 'standalone', reason: 'stopped' })
    expect(localStorage.getItem(`imani-wallet:bundle-arrivals:${ME}`)).toBeNull()
  })

  it('keeps the first declaration and flags a later one that disagrees', async () => {
    await trackArrival(ME, part(0))
    const liar = await trackArrival(ME, part(1, { declaredTotal: 60_000, declaredCount: 9 }))
    expect(liar).toMatchObject({
      kind: 'bundle',
      view: { declaredTotal: 600, declaredCount: 2, mismatch: true },
    })
  })

  it('refuses a part from another sender, which is announced on its own', async () => {
    await trackArrival(ME, part(0))
    const forged = await trackArrival(ME, part(1, { senderPubkey: MALLORY }))
    expect(forged).toMatchObject({ kind: 'standalone', reason: 'author_mismatch' })
    expect(await bundleView(ME, BUNDLE)).toMatchObject({ receivedCount: 1, mismatch: true })
  })

  it('never adds a part in another currency to the total', async () => {
    await trackArrival(ME, part(0))
    const odd = await trackArrival(ME, part(1, { unit: 'GBP' }))
    expect(odd).toMatchObject({ kind: 'standalone', reason: 'unit_mismatch' })
    expect(await bundleView(ME, BUNDLE)).toMatchObject({ receivedTotal: 300, mismatch: true })
  })

  it('falls back to standalone for a malformed bundle id', async () => {
    expect(await trackArrival(ME, part(0, { bundleId: 'not-a-bundle' }))).toMatchObject({ kind: 'standalone' })
  })

  it('keeps accounts apart', async () => {
    await trackArrival(ME, part(0))
    expect(await bundleView('d'.repeat(64), BUNDLE)).toBeUndefined()
  })

  it('calls a bundle incomplete once its window closes short', async () => {
    await trackArrival(ME, part(0))
    const early = await reconcileBundles(ME, new Date(Date.now() + 60_000))
    expect(early).toEqual([])

    const closed = await reconcileBundles(ME, new Date(Date.now() + BUNDLE_WAIT_WINDOW_MS + 1_000))
    expect(closed).toEqual([expect.objectContaining({ bundleId: BUNDLE, state: 'incomplete', receivedTotal: 300 })])
  })

  it('waits longer than a rate-limited part can take to retry', () => {
    // A queued part must not be called missing while the wallet is still
    // retrying it. If the backoffs grow, this window has to grow with them.
    const retryBudget = RATE_LIMIT_BACKOFFS_MS.reduce((a, b) => a + b, 0)
    expect(BUNDLE_WAIT_WINDOW_MS).toBeGreaterThan(retryBudget)
  })

  it('waits longer than a paced part can take to start AND retry (#110)', () => {
    // Pacing delays a late part's first attempt; the 429 retry budget then
    // starts from there. The window must outlast the sum.
    const retryBudget = RATE_LIMIT_BACKOFFS_MS.reduce((a, b) => a + b, 0)
    expect(BUNDLE_WAIT_WINDOW_MS).toBeGreaterThan(worstCasePacingDelayMs(PACED_BUNDLE_PARTS) + retryBudget)
  })
})

describe('wording: declared is expected, received is money', () => {
  const view = (over: Partial<BundleView>): BundleView => ({
    bundleId: BUNDLE,
    senderPubkey: ALICE,
    unit: 'EUR',
    decimals: 2,
    declaredTotal: 600,
    declaredCount: 2,
    receivedTotal: 300,
    receivedCount: 1,
    state: 'in_flight',
    mismatch: false,
    ...over,
  })

  it('shows progress while parts are outstanding', () => {
    const words = describeBundle(view({}))
    expect(words.amount).toMatch(/3\.00.*of.*6\.00/)
    expect(words.progress).toBe('1 of 2 vouchers so far')
    expect(words.settled).toBe(false)
  })

  it('says a queued part is still coming rather than missing', () => {
    expect(describeBundle(view({}), { queued: 1 }).progress).toBe('1 of 2 in — 1 still receiving')
  })

  it('reads as one payment when complete', () => {
    const words = describeBundle(view({ receivedTotal: 600, receivedCount: 2, state: 'complete' }))
    expect(words.amount).toMatch(/6\.00/)
    expect(words.amount).not.toMatch(/of/)
    expect(words.body).toMatch(/6\.00 received \(2 vouchers\)/)
    expect(words.settled).toBe(true)
  })

  it('states the shortfall against the declaration when the window closes', () => {
    const words = describeBundle(view({ state: 'incomplete' }))
    expect(words.body).toMatch(/3\.00 of an expected €6\.00 received\. 1 voucher has not arrived\./)
  })

  it('never caps money that arrived beyond the declaration', () => {
    const words = describeBundle(view({ receivedTotal: 900, receivedCount: 3, state: 'complete' }))
    expect(words.amount).toMatch(/9\.00/)
    expect(words.body).toMatch(/more than the €6\.00/)
  })

  it('carries a caveat when parts disagreed', () => {
    expect(describeBundle(view({ mismatch: true })).body).toMatch(/did not match/)
  })
})
