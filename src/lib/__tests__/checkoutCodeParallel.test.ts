/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools'

/**
 * #477: making a checkout code took 26 s on staging, 68 round trips one after another. The steps
 * of each proof (and each part) now run side by side. These tests pin that the speed costs none
 * of the money-path rules, against `cashlinkWorld` (a mint that really signs and enforces NUT-11,
 * and the gateway's lock and relay rules), with a mint and gateway that answer LATE and out of
 * order, so proofs genuinely overlap:
 *
 * - the result does not depend on which proof finished first (same locked token, same deposit);
 * - every proof is locked once, burnt once, its refund deposited once;
 * - a page that dies with several proofs in flight resumes to the same code, nothing burnt twice;
 * - a first proof or part that cannot move stops everything before anything else moves;
 * - the refused part of a code ends it only once no other part is part way;
 * - concurrency is bounded;
 * - fewer calls: one NUT-07 for a gift's proofs, keys cached per keyset.
 */

vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))

const cashlink = await import('../cashlinkFlow')
const flow = await import('../checkoutCodeFlow')
const records = await import('../checkoutCodeRecords')
const { parseVoucherToken, tokenProofs, creditableFaceValue } = await import('../voucherToken')
const W = await import('./cashlinkWorld')
await W.loadTokenReader()

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
const ID = hexToBytes('33'.repeat(32))
const ME = getPublicKey(ID)
const S = 'd4'.repeat(32)
const SHOP = { url: 'https://shop.example', redeemKey: S, platform: 'woocommerce' as const, since: 1 }

let w: ReturnType<typeof W.world>
let store: InstanceType<typeof W.FakeCodeStore>
let ports: import('../checkoutCodeFlow').CheckoutPorts
let inFlight = 0
let peak = 0

/** Every mint and gateway call answers after a random delay, so concurrent steps interleave. */
function jitter(seed: number) {
  let s = seed
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) % 7) + 1
  const slow = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        await new Promise((r) => setTimeout(r, rand()))
        return await fn(...a)
      } finally {
        inFlight -= 1
      }
    }
  const m = w.mint
  ports.mint = {
    activeKeysetId: slow(m.activeKeysetId.bind(m)),
    keys: slow(m.keys.bind(m)),
    swap: slow(m.swap.bind(m)),
    restore: slow(m.restore.bind(m)),
    states: slow(m.states.bind(m)),
  }
  const g = w.gateway
  ports.gateway = { call: slow(g.call.bind(g)) }
}

function coupon(amounts: number[], nonce: string) {
  const proofs = amounts.map((a, n) => w.mint.issue(W.bearerSecret({ nonce: nonce.padEnd(8, 'n') }, `${nonce}${n}`), a))
  const token = W.tokenOf(proofs)
  const faceValue = creditableFaceValue(parseVoucherToken(token)).faceValue
  return { tokenId: `row-${nonce}`, token, amount: faceValue, faceValue }
}

const start = (parts: ReturnType<typeof coupon>[]) =>
  flow.startCheckoutCode({ ports, pubkey: ME, stall: W.STALL, shop: SHOP, unit: 'GBP', decimals: 2, amount: parts.reduce((n, p) => n + p.amount, 0), x: X, parts })

const only = () => records.loadCheckoutCodes(ME)[0]
const locksSigned = () => w.gateway.locks.size
const swapsOf = (secret: string) => w.mint.log.swaps.filter((s) => s.inputs.some((i) => i.secret === secret) && s.answer === 'signed').length
const lockedSats = (r = only()) => r.parts.reduce((n, p) => n + (p.lockedToken ? tokenProofs(p.lockedToken).reduce((m, q) => m + q.amount, 0) : 0), 0)
const depositBody = () => store.calls.find((c) => c.path === '/v1/checkout-codes' && c.method === 'POST')?.body as { parts: Array<{ token: string }> } | undefined

/** The lock calls per predecessor: the first is its dry run (before the burn), later ones are real. */
function realLock() {
  const seen = new Map<string, number>()
  return (path: string, body: unknown): string | undefined => {
    if (!path.endsWith('/cashlink/lock')) return undefined
    const pred = (body as { predecessor_secret?: string } | undefined)?.predecessor_secret ?? ''
    const n = (seen.get(pred) ?? 0) + 1
    seen.set(pred, n)
    return n > 1 ? pred : undefined
  }
}

/** A 7-proof coupon, the shape of the staging profile (EUR 6.00). */
const sevenProofs = (nonce: string) => coupon([256, 128, 64, 32, 16, 8, 4], nonce)

beforeEach(() => {
  w = W.world(NOW)
  store = new W.FakeCodeStore(w.mint)
  localStorage.clear()
  inFlight = 0
  peak = 0
  ports = {
    ...w.ports,
    store,
    identitySecret: () => Uint8Array.from(ID),
    carve: async () => {
      throw new Error('no split in this test')
    },
    consume: async () => {},
    activity: async () => {},
  }
  // gateway-customer#287: the wallet asks for a gift's locks in one `/lock-batch` call. A test here
  // replaces `ports.gateway` outright (a hook in front of the jittered fake), so each one it puts in
  // place answers a batch through ITS own single-lock behaviour (`expandBatches`): a hook on
  // `/cashlink/lock` (refuse, rate limit, kill one) still sees every lock, as the real batch route
  // judges each one as `/lock` alone.
  let gateway = ports.gateway
  Object.defineProperty(ports, 'gateway', {
    configurable: true,
    enumerable: true,
    get: () => gateway,
    set: (g: typeof gateway) => {
      gateway = { call: W.expandBatches(g.call.bind(g)) }
    },
  })
  ports.gateway = gateway
})

describe('#477: a code made with its proofs side by side', () => {
  it('a 7-proof coupon is issued, every proof locked, burnt and armed exactly once', async () => {
    jitter(1)
    const c = sevenProofs('a')
    const out = await start([c])
    expect(out.kind).toBe('issued')
    const r = only()
    expect(r.status).toBe('reserved')
    expect(r.parts[0]).toMatchObject({ state: 'locked', armed: true })
    expect(lockedSats()).toBe(508)
    expect(locksSigned()).toBe(7)
    for (const p of tokenProofs(c.token)) expect(swapsOf(p.secret)).toBe(1)
    expect(w.gateway.deposits.size).toBe(7)
  })

  it('the result does not depend on which proof finished first: the locked token is in the gift\u2019s order', async () => {
    for (const seed of [3, 11, 29, 41]) {
      w = W.world(NOW)
      store = new W.FakeCodeStore(w.mint)
      localStorage.clear()
      ports = { ...ports, ...w.ports, store }
      jitter(seed)
      const c = sevenProofs('a')
      expect((await start([c])).kind).toBe('issued')
      const locked = tokenProofs(only().parts[0].lockedToken!)
      expect(locked.map((p) => p.amount)).toEqual([256, 128, 64, 32, 16, 8, 4])
      // Each locked proof is the successor of the gift proof in the same place.
      const gift = tokenProofs(c.token)
      locked.forEach((p, n) => expect(w.gateway.locks.get(gift[n].secret)?.signed).toBe(p.secret))
      expect(depositBody()!.parts[0].token).toBe(only().parts[0].lockedToken)
    }
  }, 30_000)

  it('three parts at once: one code, each part its own R, all locked, the deposit names them in order', async () => {
    jitter(5)
    const parts = [coupon([64, 32], 'a'), coupon([128], 'b'), coupon([16, 8, 4], 'c')]
    expect((await start(parts)).kind).toBe('issued')
    const r = only()
    expect(r.parts.map((p) => p.state)).toEqual(['locked', 'locked', 'locked'])
    expect(r.parts.map((p) => p.i)).toEqual([0, 1, 2])
    expect(depositBody()!.parts.map((p) => p.token)).toEqual(r.parts.map((p) => p.lockedToken))
    expect(lockedSats()).toBe(64 + 32 + 128 + 16 + 8 + 4)
  })

  it('concurrency is bounded: never more than parts x proofs in flight that the limits allow', async () => {
    jitter(7)
    const parts = [sevenProofs('a'), sevenProofs('b'), sevenProofs('c'), sevenProofs('d')]
    expect((await start(parts)).kind).toBe('issued')
    // 3 parts at a time, at most 8 proofs each, one call per proof at a time, plus a relay check each.
    expect(peak).toBeLessThanOrEqual(3 * 8 + 3)
    expect(peak).toBeGreaterThan(1)
  }, 30_000)

  it('fewer calls: one NUT-07 for a gift\u2019s proofs before the burns, none per proof after a fresh burn', async () => {
    const c = sevenProofs('a')
    const states = vi.spyOn(w.mint, 'states')
    expect((await start([c])).kind).toBe('issued')
    const giftSecrets = new Set(tokenProofs(c.token).map((p) => p.secret))
    const whole = states.mock.calls.filter((args) => args[1].length === 7 && args[1].every((x) => giftSecrets.has(x)))
    // The preflight's check, and the arm's own, each over all seven proofs at once.
    expect(whole.length).toBe(2)
    const singleGift = states.mock.calls.filter((args) => args[1].length === 1 && tokenProofs(c.token).some((p) => p.secret === args[1][0]))
    expect(singleGift.length).toBe(0)
    // And no per-proof check of a burn the mint has just signed.
    expect(states.mock.calls.filter((args) => args[1].length === 1).length).toBe(0)
  })
})

describe('#477: a page that dies with proofs in flight resumes to the same code', () => {
  it('the gateway dies after some locks: the next run finishes, nothing is burnt or locked twice', async () => {
    jitter(13)
    const c = sevenProofs('a')
    const call = ports.gateway.call
    let locks = 0
    ports.gateway = {
      call: async (m, p, b, s) => {
        // The 4th REAL lock (after the 7 dry runs) dies, with other proofs mid-step.
        if (p.endsWith('/cashlink/lock') && ++locks === 7 + 4) throw new Error('page died')
        return call(m, p, b, s)
      },
    }
    expect((await start([c])).kind).toBe('pending')
    expect(only().parts[0].state).toBe('arming')
    ports.gateway = { call }
    const out = await flow.runCheckoutCode(ports, ME, only().id)
    expect(out.kind).toBe('issued')
    expect(lockedSats()).toBe(508)
    for (const p of tokenProofs(c.token)) expect(swapsOf(p.secret)).toBe(1)
    expect(locksSigned()).toBe(7)
  })

  it('the mint loses a swap reply mid-way: found by NUT-09 on the next run', async () => {
    jitter(17)
    const c = sevenProofs('a')
    w.mint.loseNextReply = true
    expect((await start([c])).kind).toBe('pending')
    expect((await flow.runCheckoutCode(ports, ME, only().id)).kind).toBe('issued')
    expect(lockedSats()).toBe(508)
    for (const p of tokenProofs(c.token)) expect(swapsOf(p.secret)).toBe(1)
  })

  it('one part dies part way while another is refused after its burn: pending, then the code ends with nothing lost', async () => {
    jitter(19)
    const a = coupon([64, 32], 'a')
    const b = coupon([16], 'b')
    const c = coupon([8], 'c')
    const call = ports.gateway.call
    const bSecret = tokenProofs(b.token)[0].secret
    const cSecret = tokenProofs(c.token)[0].secret
    let bDied = false
    const isReal = realLock()
    ports.gateway = {
      call: async (m, p, body, s) => {
        const real = isReal(p, body)
        const pred = real
        if (real && pred === bSecret && !bDied) {
          bDied = true
          throw new Error('page died')
        }
        if (real && pred === cSecret) return { status: 422, body: { refusal: 'SAT_BOUND_EXCEEDED' } }
        return call(m, p, body, s)
      },
    }
    const out = await start([a, b, c])
    // b is part way (its burn happened): never abandoned while it is, or nothing would resume it.
    expect(out.kind).toBe('pending')
    expect(only().parts[1].state).toBe('arming')
    expect(only().parts[2].state).toBe('kept')
    // The next run finishes b, then the code ends: c's value came back as sats, a and b are
    // locked and come back at x. No code.
    const again = await flow.runCheckoutCode(ports, ME, only().id)
    expect(again.kind).toBe('abandoned')
    expect(only().parts.map((p) => p.state)).toEqual(['locked', 'locked', 'kept'])
    expect(only().refusal).toBe('kept_as_sats')
    expect(w.kept.some((k) => k.why === 'returned')).toBe(true)
    expect(store.codes.size).toBe(0)
  })
})

describe('#477: nothing moves past a first proof or part that cannot', () => {
  it('a mint that refuses every burn outright: nothing moved, the coupon is as it was (rev-wallet377 M2)', async () => {
    jitter(23)
    const c = sevenProofs('a')
    ports.mint = { ...ports.mint, swap: async () => ({ kind: 'refused', code: 11005 }) }
    const out = await start([c])
    expect(out.kind).toBe('abandoned')
    expect(only().parts[0].state).toBe('unarmed')
    expect(only().refusal).toBe('burn_refused')
    expect(w.kept).toHaveLength(0)
    for (const p of tokenProofs(c.token)) expect(swapsOf(p.secret)).toBe(0)
  })

  it('a mint that refuses SOME burns: pending, and the next run finishes those, nothing burnt twice', async () => {
    jitter(37)
    const c = sevenProofs('a')
    const swap = ports.mint.swap
    const refuse = new Set(tokenProofs(c.token).slice(2, 4).map((p) => p.secret))
    ports.mint = { ...ports.mint, swap: async (u, i, o) => (i.some((x) => refuse.has(x.secret)) ? { kind: 'refused', code: 11004 } : swap(u, i, o)) }
    expect((await start([c])).kind).toBe('pending')
    expect(only().parts[0].state).toBe('arming')
    ports.mint = { ...ports.mint, swap }
    expect((await flow.runCheckoutCode(ports, ME, only().id)).kind).toBe('issued')
    expect(lockedSats()).toBe(508)
    for (const p of tokenProofs(c.token)) expect(swapsOf(p.secret)).toBe(1)
  })

  it('the first part failing stops the code before any other part is burnt', async () => {
    jitter(29)
    const a = coupon([64], 'a')
    const b = coupon([32], 'b')
    const aSecret = tokenProofs(a.token)[0].secret
    const call = ports.gateway.call
    const isReal = realLock()
    ports.gateway = {
      call: async (m, p, body, s) => {
        if (isReal(p, body) === aSecret) throw new Error('page died')
        return call(m, p, body, s)
      },
    }
    expect((await start([a, b])).kind).toBe('pending')
    expect(swapsOf(tokenProofs(b.token)[0].secret)).toBe(0)
    expect(only().parts[1].state).toBe('new')
  })

  it('a refused dry run on ANY part still stops the whole code before the first burn', async () => {
    jitter(31)
    const a = coupon([64], 'a')
    const b = coupon([32], 'b')
    const bSecret = tokenProofs(b.token)[0].secret
    const call = ports.gateway.call
    ports.gateway = {
      call: async (m, p, body, s) => {
        if (p.endsWith('/cashlink/lock') && (body as { predecessor_secret?: string }).predecessor_secret === bSecret) return { status: 422, body: { refusal: 'SAT_BOUND_EXCEEDED' } }
        return call(m, p, body, s)
      },
    }
    const out = await start([a, b])
    expect(out.kind).toBe('refused')
    expect(w.mint.log.swaps.filter((s) => s.answer === 'signed').length).toBe(0)
  })

  it('a dry run the gateway rate limits (429) is asked again, never read as a refusal', async () => {
    const c = coupon([64, 32, 16], 'a')
    const call = ports.gateway.call.bind(ports.gateway)
    let limited = 2
    ports.gateway = {
      call: async (m, p, body, s) => (p.endsWith('/cashlink/lock') && limited-- > 0 ? { status: 429, body: { refusal: 'RATE_LIMITED' } } : call(m, p, body, s)),
    }
    const out = await start([c])
    expect(out.kind).toBe('issued')
  })

  it('a dry run still rate limited after its retries leaves the code refused with nothing burnt', async () => {
    const c = coupon([64], 'a')
    const call = ports.gateway.call.bind(ports.gateway)
    ports.gateway = { call: async (m, p, body, s) => (p.endsWith('/cashlink/lock') ? { status: 429, body: { refusal: 'RATE_LIMITED' } } : call(m, p, body, s)) }
    const out = await start([c])
    expect(out.kind).toBe('refused')
    expect(only().refusal).toBe('rate_limited')
    expect(w.mint.log.swaps).toHaveLength(0)
  })
})

describe('#477: the code is deposited at the store beside the refund deposits', () => {
  it('the store is asked before the refunds have finished, and the code is issued once both are done', async () => {
    const c = sevenProofs('a')
    const call = ports.gateway.call.bind(ports.gateway)
    let refundsDone = 0
    let refundsDoneWhenStoreAsked = -1
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    ports.gateway = {
      call: async (m, p, body, s) => {
        const isRefund = p.endsWith('/cashlink/refunds') && (body as { proof?: { secret?: string } })?.proof?.secret
        if (!isRefund) return call(m, p, body, s)
        // Refunds wait until the store has been asked: a sequential flow would never get there.
        await held
        try {
          return await call(m, p, body, s)
        } finally {
          refundsDone += 1
        }
      },
    }
    const storeCall = store.call.bind(store)
    store.call = async (m, p, b) => {
      if (p === '/v1/checkout-codes' && m === 'POST') {
        refundsDoneWhenStoreAsked = refundsDone
        release()
      }
      return storeCall(m, p, b)
    }
    const out = await start([c])
    expect(out.kind).toBe('issued')
    expect(refundsDoneWhenStoreAsked).toBe(0)
    expect(only()).toMatchObject({ status: 'reserved' })
    expect(only().parts[0]).toMatchObject({ state: 'locked', armed: true })
    expect(w.gateway.deposits.size).toBe(7)
    expect(store.codes.size).toBe(1)
  })

  it('the relay refusing the refunds still issues the code (taken back by this wallet at x)', async () => {
    const c = coupon([64, 32], 'a')
    w.gateway.relayOn = true
    const call = ports.gateway.call.bind(ports.gateway)
    ports.gateway = {
      call: async (m, p, body, s) =>
        p.endsWith('/cashlink/refunds') && (body as { proof?: { secret?: string } })?.proof?.secret ? { status: 503, body: { refusal: 'RELAY_DISABLED' } } : call(m, p, body, s),
    }
    const out = await start([c])
    expect(out.kind).toBe('issued')
    expect(only().parts[0]).toMatchObject({ state: 'locked', armed: false })
  })

  it('the store unreachable at the early deposit: pending, the record ready to deposit, and the next pass issues it', async () => {
    const c = coupon([64, 32], 'a')
    store.down = true
    expect((await start([c])).kind).toBe('pending')
    expect(only().status).toBe('depositing')
    expect(only().parts[0].state).toBe('locked')
    store.down = false
    await flow.reconcileCheckoutCodes(ports, ME)
    expect(only()).toMatchObject({ status: 'reserved', code: expect.stringMatching(/^IMANI/) })
    expect(store.codes.size).toBe(1)
  })

  it('the store refusing the early deposit outright: no code, every part comes back at x', async () => {
    const c = coupon([64], 'a')
    store.nextDeposit = { status: 422, body: { refusal: 'WRONG_ISSUER', part: 0 } }
    const out = await start([c])
    expect(out.kind).toBe('abandoned')
    expect(only()).toMatchObject({ status: 'abandoned', refusal: 'WRONG_ISSUER' })
    expect(only().parts[0].state).toBe('locked')
  })

  it('no early deposit while a part is not yet locked: a part still part way leaves the code pending, no store call', async () => {
    const a = coupon([64], 'a')
    const b = coupon([32], 'b')
    const bSecret = tokenProofs(b.token)[0].secret
    const call = ports.gateway.call.bind(ports.gateway)
    const isReal = realLock()
    ports.gateway = { call: async (m, p, body, s) => (isReal(p, body) === bSecret ? Promise.reject(new Error('page died')) : call(m, p, body, s)) }
    expect((await start([a, b])).kind).toBe('pending')
    expect(store.calls.filter((c) => c.path === '/v1/checkout-codes' && c.method === 'POST')).toHaveLength(0)
    ports.gateway = { call }
    expect((await flow.runCheckoutCode(ports, ME, only().id)).kind).toBe('issued')
    expect(store.codes.size).toBe(1)
  })
})

describe('#477: the HTTP mint keeps its active keyset for a minute', () => {
  const keysets = (id: string) => new Response(JSON.stringify({ keysets: [{ id, unit: 'sat', active: true }] }), { status: 200 })

  it('one read serves callers within a minute; `fresh` reads again; a failed read is not kept', async () => {
    cashlink.clearMintKeysCache()
    let n = 0
    let id = 'ks1'
    let fail = true
    vi.stubGlobal('fetch', async () => {
      n += 1
      if (fail) {
        fail = false
        return new Response('', { status: 503 })
      }
      return keysets(id)
    })
    const mint = cashlink.httpCashlinkMint()
    await expect(mint.activeKeysetId('https://m')).rejects.toThrow()
    expect(await Promise.all([mint.activeKeysetId('https://m'), mint.activeKeysetId('https://m')])).toEqual(['ks1', 'ks1'])
    expect(n).toBe(2)
    id = 'ks2'
    expect(await mint.activeKeysetId('https://m')).toBe('ks1')
    expect(await mint.activeKeysetId('https://m', { fresh: true })).toBe('ks2')
    expect(await mint.activeKeysetId('https://m')).toBe('ks2')
    expect(n).toBe(3)
    vi.unstubAllGlobals()
  })

  it('expires after a minute', async () => {
    cashlink.clearMintKeysCache()
    let n = 0
    vi.stubGlobal('fetch', async () => {
      n += 1
      return keysets(`ks${n}`)
    })
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const mint = cashlink.httpCashlinkMint()
    expect(await mint.activeKeysetId('https://m')).toBe('ks1')
    now.mockReturnValue(1_000_000 + 59_000)
    expect(await mint.activeKeysetId('https://m')).toBe('ks1')
    now.mockReturnValue(1_000_000 + 61_000)
    expect(await mint.activeKeysetId('https://m')).toBe('ks2')
    now.mockRestore()
    vi.unstubAllGlobals()
  })

  it('a keyset archived after it was cached: the burn is re-made with a FRESH read, never the cached id, and it arms', async () => {
    // A mint port that caches the active keyset as the HTTP one does, unless asked `fresh`.
    const c = coupon([64, 32], 'a')
    const real = w.mint
    let cached: string | undefined
    const reads: Array<'cached' | 'fresh'> = []
    ports.mint = {
      activeKeysetId: async (_u, o) => {
        if (!o?.fresh && cached) {
          reads.push('cached')
          return cached
        }
        reads.push('fresh')
        cached = real.active().id
        return cached
      },
      keys: real.keys.bind(real),
      swap: real.swap.bind(real),
      restore: real.restore.bind(real),
      states: real.states.bind(real),
    }
    await ports.mint.activeKeysetId('m')
    real.rotate()
    const out = await start([c])
    expect(out.kind).toBe('issued')
    expect(reads).toContain('fresh')
    // Every locked proof is in the NEW keyset, and every refund deposit too.
    expect(tokenProofs(only().parts[0].lockedToken!).every((p) => p.id === real.active().id)).toBe(true)
    expect(only().parts[0].armed).toBe(true)
  })
})

describe('#477: the parallel helper', () => {
  it('waits for every task, keeps their order, and never rejects', async () => {
    const order: number[] = []
    const out = await cashlink.inParallel(
      [30, 1, 20, 5].map((ms, n) => async () => {
        await new Promise((r) => setTimeout(r, ms))
        order.push(n)
        if (n === 2) throw new Error('two')
        return n
      }),
      2,
    )
    expect(out.map((o) => (o.ok ? o.value : 'x'))).toEqual([0, 1, 'x', 3])
    expect(order).toHaveLength(4)
  })

  it('never runs more than the limit at once', async () => {
    let now = 0
    let max = 0
    await cashlink.inParallel(
      Array.from({ length: 10 }, () => async () => {
        now += 1
        max = Math.max(max, now)
        await new Promise((r) => setTimeout(r, 2))
        now -= 1
      }),
      3,
    )
    expect(max).toBe(3)
  })
})

describe('#477: mint keys are fetched once per keyset', () => {
  it('the HTTP mint caches keys by mint and keyset id, and forgets a failed fetch', async () => {
    cashlink.clearMintKeysCache()
    const calls: string[] = []
    let fail = true
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url)
      if (fail) {
        fail = false
        return new Response('', { status: 503 })
      }
      const id = url.split('/').pop()!
      return new Response(JSON.stringify({ keysets: [{ id, keys: { '1': '02' + 'ab'.repeat(32) } }] }), { status: 200 })
    })
    const mint = cashlink.httpCashlinkMint()
    await expect(mint.keys('https://m', 'k1')).rejects.toThrow()
    const [a, b] = await Promise.all([mint.keys('https://m', 'k1'), mint.keys('https://m', 'k1')])
    expect(a).toBe(b)
    await mint.keys('https://m', 'k1')
    await mint.keys('https://m', 'k2')
    await mint.keys('https://other', 'k1')
    // 1 failed + 1 for k1 (shared by three callers) + k2 + another mint's k1.
    expect(calls).toHaveLength(4)
    vi.unstubAllGlobals()
  })

  it('a keyset answer for another id is refused, not cached', async () => {
    cashlink.clearMintKeysCache()
    let n = 0
    vi.stubGlobal('fetch', async () => {
      n += 1
      return new Response(JSON.stringify({ keysets: [{ id: 'other', keys: { '1': '02' } }] }), { status: 200 })
    })
    const mint = cashlink.httpCashlinkMint()
    await expect(mint.keys('https://m', 'k1')).rejects.toThrow('keys for another keyset')
    await expect(mint.keys('https://m', 'k1')).rejects.toThrow('keys for another keyset')
    expect(n).toBe(2)
    vi.unstubAllGlobals()
  })
})
