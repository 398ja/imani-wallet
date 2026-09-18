/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { SimplePool } from 'nostr-tools'

import { allEvents, newestAddressable } from '../relay'

/**
 * Relay READS must not wait three seconds on a relay that is not there.
 *
 * Reads go to the relay and the gateway in parallel and merge the results, so
 * the caller pays for the slower store — and reaching strfry from a browser
 * needs its port published, which a real deployment does not do. A socket to a
 * host that DROPS packets ends on a timer rather than a refusal, so the wallet's
 * ordinary deployed state was its worst latency. Measured against a real strfry
 * and two dead addresses:
 *
 *   healthy relay ..................... 25ms
 *   port not published (refused) ....... 3ms
 *   unroutable host (dropped) ....... 3002ms   <- SimplePool's default
 *   the same, capped at 1200 ........ 1201ms
 *
 * ## Why this is tested through the seam rather than over a socket
 *
 * The measurement above is real but needs an address that black-holes packets,
 * which is not something a unit test should depend on. What CAN be pinned is
 * the thing that would silently undo it: the option being dropped, either by a
 * refactor here or by a nostr-tools release that stops forwarding it. Both show
 * up as the pool being built without a bounded connection wait.
 */

vi.mock('./gatewayNostr', () => ({ gatewayEvents: async () => [], newestByD: () => [] }))

describe('relay reads', () => {
  /**
   * `SimplePool`'s constructor TYPE omits `maxWaitForConnection` while its body
   * forwards it — `super({ ..., maxWaitForConnection: 3e3, ...options })` — so
   * the wallet passes it through a cast. That makes this assertion load-bearing:
   * if upstream ever stops forwarding the option, the app would quietly go back
   * to 3s reads with nothing failing. This fails instead.
   */
  it('still forwards maxWaitForConnection to the pool', () => {
    const pool = new SimplePool({
      maxWaitForConnection: 1200,
    } as ConstructorParameters<typeof SimplePool>[0])

    expect((pool as unknown as { maxWaitForConnection: number }).maxWaitForConnection).toBe(1200)
  })

  /** And the default really is the 3s this change exists to escape. */
  it('would otherwise wait three seconds to connect', () => {
    const pool = new SimplePool()

    expect((pool as unknown as { maxWaitForConnection: number }).maxWaitForConnection).toBe(3000)
  })

  /**
   * The read paths must USE the bounded pool. Asserted by observing the
   * connection budget the query actually runs under, so deleting the option
   * from either call site fails here rather than in production.
   */
  it.each([
    ['allEvents', () => allEvents('ab'.repeat(32), 0, [])],
    ['newestAddressable', () => newestAddressable('ab'.repeat(32), 30078, 'imani:merchant', [])],
  ])('%s reads through a pool with a bounded connection wait', async (_name, read) => {
    const built: number[] = []
    const Original = SimplePool.prototype.constructor

    // An empty relay list means querySync resolves immediately with no socket,
    // so this exercises construction and teardown without touching a network.
    const spy = vi.spyOn(SimplePool.prototype, 'querySync').mockImplementation(async function (
      this: SimplePool,
    ) {
      built.push((this as unknown as { maxWaitForConnection: number }).maxWaitForConnection)
      return []
    })

    await read()

    expect(Original).toBeDefined()
    expect(built.length).toBeGreaterThan(0)
    // Bounded, and well under the 3s default.
    for (const budget of built) {
      expect(budget).toBeLessThanOrEqual(1500)
      expect(budget).toBeGreaterThan(0)
    }
    spy.mockRestore()
  })

  /**
   * PUBLISHING KEEPS ITS FULL BUDGET, deliberately. A read that gives up early
   * costs a slower answer from the other store; a publish that gives up early
   * is an event the user believes they sent and nobody has.
   */
  it('does not cap the publish path', async () => {
    const budgets: number[] = []
    const spy = vi
      .spyOn(SimplePool.prototype, 'publish')
      .mockImplementation(function (this: SimplePool) {
        budgets.push((this as unknown as { maxWaitForConnection: number }).maxWaitForConnection)
        return []
      })

    const { publish } = await import('../relay')
    await publish(
      { id: 'x', kind: 1, pubkey: 'ab'.repeat(32), created_at: 0, tags: [], content: '', sig: '' },
      [],
    )

    expect(budgets).toEqual([3000])
    spy.mockRestore()
  })
})
