/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * gateway-customer#288 part 2: a part's refund deposits go to the gateway in ONE call
 * (`/cashlink/refunds/batch`) instead of one call per proof. On staging the 8 to 10 deposits of a
 * checkout code ran side by side at about 1 s each, and the slowest set the end of the code.
 *
 * Pinned here, against `cashlinkWorld` (whose gateway judges each deposit of a batch through its own
 * `/refunds` rules):
 *
 * - one deposit call per part; the same outcome and the same stored deposits as one by one;
 * - a gateway without the route (404) is asked one by one, and that is remembered;
 * - the deposits answered KEYSET_INACTIVE are rebuilt in the fresh keyset and sent again, in one batch;
 * - a batch not judged as a whole (5xx, 400, a short answer) is "not armed", never worse, and a
 *   later `retryDeposit` stores them;
 * - one refused deposit makes the part "not armed".
 */

vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))

const { armGift, retryDeposit, REFUNDS_PATH } = await import('../cashlinkFlow')
const { bearerSecret, tokenOf, world } = await import('./cashlinkWorld')

type World = ReturnType<typeof world>

const REFUNDS_BATCH = REFUNDS_PATH + '/batch'
const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
const LINK = hexToBytes('11'.repeat(32))
const REFUND = hexToBytes('22'.repeat(32))
const EIGHT = [128, 64, 32, 16, 8, 4, 2, 1]

let w: World
let locks: Map<string, string>

function giftOn(amounts = [64], tag = 'w') {
  const proofs = amounts.map((a, n) => w.mint.issue(bearerSecret({}, `${tag}${n}`), a))
  return { token: tokenOf(proofs), sentAt: NOW }
}

function armCtx(gift: { token: string; sentAt: number }) {
  return {
    ports: w.ports,
    linkSecret: LINK,
    refundSecret: REFUND,
    x: X,
    gifts: [gift],
    merchant: false,
    onArming: async () => undefined,
    onLocked: async (g: string, s: string) => void locks.set(g, s),
    knownLocks: locks,
  }
}

/** What the WALLET sends (the fake gateway also logs each deposit it judges inside a batch). */
function recordSent(): Array<{ path: string; body: unknown }> {
  const sent: Array<{ path: string; body: unknown }> = []
  const call = w.gateway.call.bind(w.gateway)
  w.ports.gateway = { call: (m, p, b, s) => (sent.push({ path: p, body: b }), call(m, p, b, s)) }
  return sent
}

/** The deposit calls the wallet sent, past the arm's one relay probe (an empty body, refused 422). */
const deposited = <T extends { path: string; body: unknown }>(sent: T[]): T[] =>
  sent.filter((c) => c.path === REFUNDS_PATH && (c.body as { proof?: { secret?: string } })?.proof?.secret)
/** The probe's own answer, first in `depositAnswers`. */
const PROBE = { status: 422, body: { refusal: 'MALFORMED' } }

const lockedToken = () => w.wraps[w.wraps.length - 1]
const storedSwaps = () => [...w.gateway.deposits.values()].map((d) => [d.secret, JSON.stringify(d.swap)]).sort()

beforeEach(() => {
  w = world(NOW)
  locks = new Map()
  localStorage.clear()
})

describe('gateway-customer#288: a part\u2019s refunds are deposited in one gateway call', () => {
  it('an 8-proof gift: one refund batch of 8, no per-proof deposit call', async () => {
    const sent = recordSent()

    const out = await armGift(armCtx(giftOn(EIGHT)))

    expect(out.kind).toBe('armed')
    expect(deposited(sent)).toHaveLength(0)
    expect(sent.filter((c) => c.path === REFUNDS_BATCH)).toHaveLength(1)
    expect(w.gateway.refundBatches).toEqual([8])
    expect(w.gateway.deposits.size).toBe(8)
    // Signed by the link key, as each single deposit is.
    const batchCall = w.gateway.calls.find((c) => c.path === REFUNDS_BATCH)!
    const singleSigners = new Set(deposited(w.gateway.calls).map((c) => c.signedBy))
    expect(singleSigners).toEqual(new Set([batchCall.signedBy]))
  })

  it('the batched deposits end exactly where the one-by-one deposits end', async () => {
    const batched = await armGift(armCtx(giftOn(EIGHT)))
    const batchedSwaps = storedSwaps()

    w = world(NOW)
    locks = new Map()
    w.gateway.refundBatchRoute = false
    const single = await armGift(armCtx(giftOn(EIGHT)))

    expect(single).toEqual(batched)
    expect(storedSwaps()).toEqual(batchedSwaps)
    expect(w.gateway.refundBatches).toEqual([])
  })

  it('a gateway without the route (404) is asked one by one, and only asked for a batch once', async () => {
    w.gateway.refundBatchRoute = false
    const sent = recordSent()

    const first = await armGift(armCtx(giftOn([64, 32])))
    const second = await armGift(armCtx(giftOn([16, 8], 'v')))

    expect(first.kind).toBe('armed')
    expect(second.kind).toBe('armed')
    expect(sent.filter((c) => c.path === REFUNDS_BATCH)).toHaveLength(1)
    expect(deposited(sent)).toHaveLength(4)
    expect(w.gateway.deposits.size).toBe(4)
  })

  it('a 405 is a missing route too', async () => {
    const call = w.gateway.call.bind(w.gateway)
    w.gateway.call = async (m, p, b, s) => (p === REFUNDS_BATCH ? { status: 405, body: null } : call(m, p, b, s))

    const out = await armGift(armCtx(giftOn([64, 32])))

    expect(out.kind).toBe('armed')
    expect(w.gateway.deposits.size).toBe(2)
  })

  it('KEYSET_INACTIVE: only those deposits are rebuilt in the fresh keyset and sent again, in one batch', async () => {
    const gift = giftOn([64, 32, 16])
    const realActive = w.mint.activeKeysetId.bind(w.mint)
    let reads = 0
    w.mint.activeKeysetId = async () => {
      reads += 1
      // The deposit's first read sees the old keyset; it is archived just before the deposit.
      if (reads === 2) {
        const old = await realActive()
        w.mint.rotate()
        return old
      }
      return realActive()
    }
    // All three were built in the archived keyset, so all three come back inactive: one re-batch.
    const sent = recordSent()

    const out = await armGift(armCtx(gift))

    expect(out.kind).toBe('armed')
    expect(sent.filter((c) => c.path === REFUNDS_BATCH)).toHaveLength(2)
    expect(deposited(sent)).toHaveLength(0)
    expect(w.gateway.refundBatches).toEqual([3, 3])
    expect([...w.gateway.deposits.values()].every((d) => d.swap.outputs.every((o) => o.id === w.mint.active().id))).toBe(true)
  })

  it('KEYSET_INACTIVE for one deposit: the re-batch carries that one only', async () => {
    const gift = giftOn([64, 32, 16])
    w.gateway.depositAnswers = [PROBE, { status: 201, body: {} }, { status: 422, body: { refusal: 'KEYSET_INACTIVE' } }]
    const realActive = w.mint.activeKeysetId.bind(w.mint)
    w.mint.activeKeysetId = async (_url?: string, opts?: { fresh?: boolean }) => {
      if (opts?.fresh) w.mint.rotate()
      return realActive()
    }

    const out = await armGift(armCtx(gift))

    expect(out.kind).toBe('armed')
    expect(w.gateway.refundBatches).toEqual([3, 1])
  })

  for (const [name, answer] of [
    ['a 503', { status: 503, body: null }],
    ['a 500', { status: 500, body: { error: 'boom' } }],
    ['a 400', { status: 400, body: { refusal: 'VALIDATION' } }],
    ['a 429', { status: 429, body: null }],
    ['a short answer', { status: 200, body: { results: [{ status: 201 }] } }],
    ['results without a numeric status', { status: 200, body: { results: [{ status: '201' }, {}] } }],
    ['no results at all', { status: 200, body: { ok: true } }],
  ] as const) {
    it(`a batch not judged as a whole (${name}) is "not armed", never worse, and a later retryDeposit stores them`, async () => {
      const gift = giftOn([64, 32])
      w.gateway.override.set(REFUNDS_BATCH, answer)

      const out = await armGift(armCtx(gift))

      expect(out.kind).toBe('not_armed')
      expect(w.gateway.deposits.size).toBe(0)
      // The lock stands: the gift is on the link and recoverable.
      expect(lockedToken()).toBeDefined()
      expect((await retryDeposit(w.ports, LINK, REFUND, lockedToken())).kind).toBe('armed')
      expect(w.gateway.deposits.size).toBe(2)
    })
  }

  it('a batch whose call throws (gateway unreachable) is "not armed", relay unreachable', async () => {
    const gift = giftOn([64, 32])
    const call = w.gateway.call.bind(w.gateway)
    w.gateway.call = async (m, p, b, s) => {
      if (p === REFUNDS_BATCH) throw new Error('network down')
      return call(m, p, b, s)
    }

    const out = await armGift(armCtx(gift))

    expect(out).toMatchObject({ kind: 'not_armed', why: 'relay unreachable' })
  })

  it('one refused deposit (409 CONFLICT) makes the part "not armed"; the others are stored', async () => {
    const gift = giftOn([64, 32, 16])
    w.gateway.depositAnswers = [PROBE, { status: 201, body: {} }, { status: 409, body: { refusal: 'CONFLICT' } }]

    const out = await armGift(armCtx(gift))

    expect(out).toMatchObject({ kind: 'not_armed', why: 'CONFLICT' })
    expect(w.gateway.refundBatches).toEqual([3])
  })

  it('a resent part replays (200): armed again, nothing stored twice', async () => {
    await armGift(armCtx(giftOn([64, 32, 16])))
    const before = storedSwaps()

    const again = await retryDeposit(w.ports, LINK, REFUND, lockedToken())

    expect(again.kind).toBe('armed')
    expect(storedSwaps()).toEqual(before)
    expect(w.gateway.refundBatches).toEqual([3, 3])
  })
})
