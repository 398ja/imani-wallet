/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * gateway-customer#287: a gift's locks go to the gateway in ONE call (`/cashlink/lock-batch`), its
 * dry runs in one more, instead of one call per proof each. On staging the per-proof locks of one
 * coupon queued behind each other in the gateway (about 1 s each, side by side) and each paid its
 * own round trip.
 *
 * Pinned here, against `cashlinkWorld` (a mint that really signs, and the gateway's lock rules):
 *
 * - an 8-proof gift is armed with one dry-run batch and one lock batch, nothing per proof;
 * - the answer is exactly what the per-proof calls gave: same locks, same order, same refusals;
 * - a gateway without the batch route (404) is asked one by one, as before, and remembered;
 * - a lock still "not spent yet" (409) or rate limited (429) inside a batch is asked again;
 * - a malformed or failed batch answer is never read as a signature; a batch that cannot be sent
 *   leaves the arm for the next run (nothing lost, nothing locked twice).
 */

vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))

const { armGift, lockAll, LOCK_PATH, LOCK_BATCH_PATH } = await import('../cashlinkFlow')
const { parseVoucherToken, tokenProofs } = await import('../voucherToken')
const { bearerSecret, tokenOf, world } = await import('./cashlinkWorld')

type World = ReturnType<typeof world>

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
const LINK = hexToBytes('11'.repeat(32))
const REFUND = hexToBytes('22'.repeat(32))

let w: World
let locks: Map<string, string>
let armState: string[]

function giftOn(amounts = [64], tag = 'w') {
  const proofs = amounts.map((a, n) => w.mint.issue(bearerSecret({}, `${tag}${n}`), a))
  return { token: tokenOf(proofs), sentAt: NOW }
}

function armCtx(gift: { token: string; sentAt: number }, extra: Partial<Parameters<typeof armGift>[0]> = {}) {
  return {
    ports: w.ports,
    linkSecret: LINK,
    refundSecret: REFUND,
    x: X,
    gifts: [gift],
    merchant: false,
    onArming: async (ks: string) => void armState.push(`arming:${ks}`),
    onLocked: async (g: string, s: string) => void locks.set(g, s),
    knownLocks: locks,
    ...extra,
  }
}

const EIGHT = [128, 64, 32, 16, 8, 4, 2, 1]
const callsTo = (path: string) => w.gateway.calls.filter((c) => c.path === path)
const lockedToken = () => w.wraps[w.wraps.length - 1]
const keptSats = () => w.kept.reduce((n, k) => n + (k.satsToken ? (k.sats ?? 0) : parseVoucherToken(k.token).tokenAmount), 0)

beforeEach(() => {
  w = world(NOW)
  locks = new Map()
  armState = []
  localStorage.clear()
})

describe('gateway-customer#287: a gift is locked in one gateway call', () => {
  it('an 8-proof gift: one dry-run batch and one lock batch, no per-proof lock call', async () => {
    const gift = giftOn(EIGHT)
    // What the WALLET sends (the fake gateway also logs each lock it judges inside a batch).
    const sent: string[] = []
    const call = w.gateway.call.bind(w.gateway)
    w.ports.gateway = { call: (m, p, b, s) => (sent.push(p), call(m, p, b, s)) }

    const out = await armGift(armCtx(gift))

    expect(out.kind).toBe('armed')
    expect(sent.filter((p) => p === LOCK_PATH)).toHaveLength(0)
    expect(sent.filter((p) => p === LOCK_BATCH_PATH)).toHaveLength(2)
    expect(w.gateway.batches).toEqual([8, 8])
    // Every proof locked exactly once, in the gift's own order.
    const locked = tokenProofs(lockedToken())
    expect(locked.map((p) => p.amount)).toEqual(EIGHT)
    const gift8 = tokenProofs(gift.token)
    locked.forEach((p, n) => expect(w.gateway.locks.get(gift8[n].secret)?.signed).toBe(p.secret))
    expect(w.gateway.locks.size).toBe(8)
  })

  it('the batched arm ends exactly where the per-proof arm ends', async () => {
    // Arrange: the same gift, armed once with the batch route and once on a gateway without it.
    const gift = giftOn(EIGHT)
    const batched = await armGift(armCtx(gift))
    const batchedLocks = [...w.gateway.locks.entries()].map(([k, v]) => [k, v.signed])
    const batchedToken = tokenProofs(lockedToken()).map((p) => [p.amount, p.secret, p.id])

    w = world(NOW)
    locks = new Map()
    w.gateway.batchRoute = false
    const again = giftOn(EIGHT)

    // Act
    const single = await armGift(armCtx(again))

    // Assert: same outcome, same locks (deterministic from R and the gift), the same locked
    // proofs (the mint's DLEQ nonces differ per signature, so the proofs, not the token bytes).
    expect(single).toEqual(batched)
    expect([...w.gateway.locks.entries()].map(([k, v]) => [k, v.signed])).toEqual(batchedLocks)
    expect(tokenProofs(lockedToken()).map((p) => [p.amount, p.secret, p.id])).toEqual(batchedToken)
    expect(w.gateway.batches).toEqual([])
  })

  it('a gateway without the batch route (404) is asked one by one, and only asked for a batch once', async () => {
    w.gateway.batchRoute = false

    const first = await armGift(armCtx(giftOn([64, 32])))
    const second = await armGift(armCtx(giftOn([16, 8], 'v')))

    expect(first.kind).toBe('armed')
    expect(second.kind).toBe('armed')
    // One 404 from the batch route, then the single route for every dry run and lock after it.
    expect(callsTo(LOCK_BATCH_PATH)).toHaveLength(1)
    expect(callsTo(LOCK_PATH)).toHaveLength(2 * 2 + 2 * 2)
  })

  it('a refusal for ONE proof in the dry-run batch stops the arm before anything is burnt', async () => {
    const gift = giftOn([64, 32, 16])
    const third = tokenProofs(gift.token)[2].secret
    const call = w.gateway.call.bind(w.gateway)
    w.gateway.call = async (m, p, b, s) =>
      p === LOCK_PATH && (b as { predecessor_secret?: string }).predecessor_secret === third
        ? { status: 422, body: { refusal: 'ISSUER_SELF_SWAP' } }
        : call(m, p, b, s)

    const out = await armGift(armCtx(gift))

    expect(out).toEqual({ kind: 'unarmed', why: 'lock_refused' })
    expect(w.mint.log.swaps).toHaveLength(0)
    expect(armState).toEqual([])
  })

  it('a lock the mint has not caught up with (409) inside the batch is asked again, alone, and locked', async () => {
    const gift = giftOn([64, 32, 16])
    const second = tokenProofs(gift.token)[1].secret
    const call = w.gateway.call.bind(w.gateway)
    let behind = 2
    let seen = 0
    w.gateway.call = async (m, p, b, s) => {
      const pred = (b as { predecessor_secret?: string } | undefined)?.predecessor_secret
      // The dry run is the first /lock for each proof; the mint lags for the second proof's real lock.
      if (p === LOCK_PATH && pred === second && ++seen > 1 && behind-- > 0) return { status: 409, body: { refusal: 'PREDECESSOR_NOT_SPENT' } }
      return call(m, p, b, s)
    }

    const out = await armGift(armCtx(gift))

    expect(out.kind).toBe('armed')
    // Dry runs (3), the locks (3), then the lagging one twice more, alone.
    expect(w.gateway.batches).toEqual([3, 3, 1, 1])
    expect(w.gateway.locks.size).toBe(3)
  })

  it('a lock rate limited (429) inside the batch is waited for and asked again, never read as a refusal', async () => {
    const gift = giftOn([64, 32])
    const first = tokenProofs(gift.token)[0].secret
    const call = w.gateway.call.bind(w.gateway)
    let limited = 1
    let seen = 0
    w.gateway.call = async (m, p, b, s) => {
      const pred = (b as { predecessor_secret?: string } | undefined)?.predecessor_secret
      if (p === LOCK_PATH && pred === first && ++seen === 2 && limited-- > 0) return { status: 429, body: { refusal: 'RATE_LIMITED' } }
      return call(m, p, b, s)
    }
    const sleeps: number[] = []
    w.ports.sleep = async (ms) => void sleeps.push(ms)

    const out = await armGift(armCtx(gift))

    expect(out.kind).toBe('armed')
    expect(keptSats()).toBe(0)
    expect(sleeps).toContain(5_000)
    expect(w.gateway.locks.size).toBe(2)
  })

  it('a batch answer with the wrong number of results is never read as a signature: left for the next run', async () => {
    const gift = giftOn([64, 32])
    const call = w.gateway.call.bind(w.gateway)
    let batches = 0
    w.gateway.call = async (m, p, b, s) => {
      // The dry-run batch is answered honestly; the lock batch comes back short (a broken gateway).
      if (p === LOCK_BATCH_PATH && ++batches === 2) return { status: 200, body: { results: [{ status: 200, signed_secret: 'x' }] } }
      return call(m, p, b, s)
    }

    const out = await armGift(armCtx(gift))

    // Burnt, not locked: "not now" (5xx-like), so the next run finds the burns and finishes.
    expect(out.kind).toBe('arming')
    expect(w.wraps).toHaveLength(0)
    expect(keptSats()).toBe(0)
    w.gateway.call = call
    const ks = armState[0].split(':')[1]
    const resumed = await armGift(armCtx(gift, { burnKeyset: ks }))
    expect(resumed.kind).toBe('armed')
    expect(tokenProofs(lockedToken()).map((p) => p.amount)).toEqual([64, 32])
  })

  it('a lock batch that cannot be sent (the page dies) leaves every proof for the next run, none locked twice', async () => {
    const gift = giftOn([64, 32, 16])
    const call = w.gateway.call.bind(w.gateway)
    let batches = 0
    w.gateway.call = async (m, p, b, s) => {
      if (p === LOCK_BATCH_PATH && ++batches === 2) throw new Error('page died')
      return call(m, p, b, s)
    }

    expect((await armGift(armCtx(gift))).kind).toBe('arming')
    expect(w.gateway.locks.size).toBe(0)

    w.gateway.call = call
    const ks = armState[0].split(':')[1]
    expect((await armGift(armCtx(gift, { burnKeyset: ks }))).kind).toBe('armed')
    expect(w.gateway.locks.size).toBe(3)
    for (const p of tokenProofs(gift.token)) {
      expect(w.mint.log.swaps.filter((s) => s.answer === 'signed' && s.inputs.some((i) => i.secret === p.secret))).toHaveLength(1)
    }
  })

  it('a batch refused AS A WHOLE (400, 413) after the burn is "not now", never a refusal: no sats kept, resumes', async () => {
    for (const status of [400, 413]) {
      w = world(NOW)
      locks = new Map()
      armState = []
      const gift = giftOn([64, 32])
      const call = w.gateway.call.bind(w.gateway)
      let batches = 0
      w.gateway.call = async (m, p, b, s) => {
        if (p === LOCK_BATCH_PATH && ++batches === 2) return { status, body: { refusal: 'VALIDATION' } }
        return call(m, p, b, s)
      }

      const out = await armGift(armCtx(gift))

      expect(out.kind, `HTTP ${status}`).toBe('arming')
      expect(keptSats()).toBe(0)
      w.gateway.call = call
      const ks = armState[0].split(':')[1]
      expect((await armGift(armCtx(gift, { burnKeyset: ks }))).kind).toBe('armed')
    }
  })

  it('a refused lock after the burn keeps that proof\u2019s sats; the others are still locked', async () => {
    const gift = giftOn([64, 32])
    const second = tokenProofs(gift.token)[1].secret
    const call = w.gateway.call.bind(w.gateway)
    let seen = 0
    w.gateway.call = async (m, p, b, s) => {
      const pred = (b as { predecessor_secret?: string } | undefined)?.predecessor_secret
      if (p === LOCK_PATH && pred === second && ++seen === 2) return { status: 422, body: { refusal: 'SAT_BOUND_EXCEEDED' } }
      return call(m, p, b, s)
    }

    const out = await armGift(armCtx(gift))

    expect(out.kind).toBe('armed')
    expect(tokenProofs(lockedToken()).map((p) => p.amount)).toEqual([64])
    expect(keptSats()).toBe(32)
  })
})

describe('gateway-customer#287: lockAll', () => {
  it('splits more than 32 locks into batches of at most 32, answers in order', async () => {
    const seen: number[] = []
    const ports = {
      ...w.ports,
      gateway: {
        call: async (_m: 'GET' | 'POST', p: string, b: unknown) => {
          const locks = (b as { locks: Array<{ n: number }> }).locks
          seen.push(locks.length)
          expect(p).toBe(LOCK_BATCH_PATH)
          return { status: 200, body: { results: locks.map((l) => ({ status: 409, refusal: `P${l.n}` })) } }
        },
      },
    }
    const bodies = Array.from({ length: 70 }, (_, n) => ({ n }))

    const out = await lockAll(ports, bodies, false)

    expect(seen).toEqual([32, 32, 6])
    expect(out.map((a) => (a.ok ? a.value.body?.refusal : 'x'))).toEqual(bodies.map((b) => `P${b.n}`))
  })

  it('a 5xx batch is that status for every lock (not now), never a signature', async () => {
    const ports = { ...w.ports, gateway: { call: async () => ({ status: 503, body: null }) } }

    const out = await lockAll(ports, [{ a: 1 }, { a: 2 }], true)

    expect(out).toHaveLength(2)
    for (const a of out) {
      expect(a.ok).toBe(true)
      if (a.ok) {
        expect(a.value.status).toBe(503)
        expect(a.value.body?.signed_secret).toBeUndefined()
      }
    }
  })

  it('a result without a numeric status is read as a failure, and its signed_secret is not trusted', async () => {
    const ports = {
      ...w.ports,
      gateway: { call: async () => ({ status: 200, body: { results: [{ signed_secret: 'forged' }] } }) },
    }

    const [a] = await lockAll(ports, [{ a: 1 }], true)

    expect(a.ok && a.value.status).toBe(502)
  })

  it('nothing to ask: no call at all', async () => {
    let calls = 0
    const ports = { ...w.ports, gateway: { call: async () => (calls++, { status: 200, body: { results: [] } }) } }

    expect(await lockAll(ports, [], true)).toEqual([])
    expect(calls).toBe(0)
  })
})
