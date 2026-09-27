import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #110: a coupon swapped at the mint, then resubmitted and refused as already
 * spent, with the first swap's proofs lost. Staging lost €100 this way.
 *
 * Pinned here against the REAL classic scripts (`shared/api.js`,
 * `shared/tokenRedemption.js`), loaded the way the browser does, with their
 * free globals supplied as doubles.
 */

const API_SOURCE = readFileSync('shared/api.js', 'utf8')
const REDEMPTION_SOURCE = readFileSync('shared/tokenRedemption.js', 'utf8')

/** A Map-backed localStorage, so the per-account ledger is observable. */
function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    keys: () => [...m.keys()],
  }
}

interface ApiScope {
  api: {
    receive(token: string, o?: { idempotencyKey?: string }): Promise<unknown>
    setNostrCredentials(pub: string, priv: string): void
  }
  generateReceiveIdempotencyKey: (fp: string | null) => string | null
  parseRetryAfterMs: (v: string | null) => number | null
}

function loadApi(fetchImpl?: (url: string, init: unknown) => Promise<unknown>): ApiScope {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const window: any = {}
  new Function('window', 'localStorage', 'GatewayConfig', 'fetch', 'NostrUtils', `${API_SOURCE}`)(
    window,
    memoryStorage(),
    { relayUrl: 'wss://r', apiUrl: 'http://gw', gatewayUrl: 'http://gw' },
    fetchImpl ?? (async () => { throw new Error('no fetch') }),
    { createNip98AuthHeader: async () => 'Nostr stub' },
  )
  return window
}

const { generateReceiveIdempotencyKey } = loadApi()

type LedgerEntry = { receiveId: string; fp: string | null; state: string }
interface Redemption {
  redeem(token: string, opts: Record<string, unknown>): Promise<Record<string, unknown>>
  _doRedeem(token: string, opts: Record<string, unknown>): Promise<Record<string, unknown>>
  _persistRedeemed(v: Record<string, unknown>, ctx: Record<string, unknown>): Promise<unknown>
  _acknowledgeEscrow(id: string | null): Promise<boolean>
  flushUnacknowledgedEscrows(): Promise<number>
  resetAckState(): void
  _ackSleep: (ms: number) => Promise<void>
  _ackGate: () => Promise<void>
  _receiveGate: () => Promise<void>
  _inFlightSleep: (ms: number) => Promise<void>
  buildVoucher(...a: unknown[]): { token: unknown }
  _ackBackoffsMs: number[]
  _ackRetries: Map<string, Promise<boolean>>
  ReceiveLedger: {
    list(): LedgerEntry[]
    unacknowledged(): string[]
    settledUnsaved(): string[]
    receiveIdFor(fp: string): string | null
    recordSettled(id: string, fp: string | null): void
    recordSaved(id: string, fp: string | null): void
    LIMIT: number
  }
  ReceiveSettledNotSavedError: new (...a: unknown[]) => Error
  RedemptionSaveError: new (...a: unknown[]) => Error
}

function loadRedemption(g: {
  api: Record<string, unknown> | undefined
  walletStorageIntegration?: Record<string, unknown>
  localStorage: ReturnType<typeof memoryStorage>
  ImaniDmPoll?: unknown
  TokenSecurity?: unknown
}): Redemption {
  return new Function(
    'api',
    'walletStorageIntegration',
    'localStorage',
    'ImaniDmPoll',
    'generateReceiveIdempotencyKey',
    'resolveDecimals',
    'TokenSecurity',
    `${REDEMPTION_SOURCE}; return TokenRedemption;`,
  )(
    g.api,
    g.walletStorageIntegration,
    g.localStorage,
    g.ImaniDmPoll,
    generateReceiveIdempotencyKey,
    () => 2,
    g.TokenSecurity,
  ) as Redemption
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const TOKEN = 'cashuAeyJ0b2tlbiI6W119'
const FP_A = sha(TOKEN)
const FP_B = sha('cashuAother')
const PUBKEY = 'c'.repeat(64)

/** A first receive: fresh proofs in the response. */
const okReceive = (receiveId: string) => ({
  receive_id: receiveId,
  amount: 1356,
  token: 'cashuAfresh',
  imported_count: 1,
  unit: 'sat',
})
/**
 * The gateway's REAL same-key replay (imani-gateway-customer#119, docs/api.md
 * "Receive: repeats"): 200 with the settled receive_id and `token: null`,
 * because the fresh proofs are not stored.
 */
const replayReceive = (receiveId: string) => ({
  receive_id: receiveId,
  amount: 1356,
  token: null,
  imported_count: 1,
  unit: 'sat',
})

const httpError = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { status, ...extra })

const retryOnce = {
  retryOnTransientMintError: async <T,>(fn: () => Promise<T>, o: { isTransient: (e: unknown) => boolean }) => {
    try {
      return await fn()
    } catch (e) {
      if (!o.isTransient(e)) throw e
      return fn()
    }
  },
}

describe('generateReceiveIdempotencyKey (#110 item 1)', () => {
  it('gives the same token the same key on every call', () => {
    expect(generateReceiveIdempotencyKey(FP_A)).toBe(generateReceiveIdempotencyKey(FP_A))
    expect(generateReceiveIdempotencyKey(FP_A)).toBe(`rcv_${FP_A}`)
  })

  it('gives different tokens different keys, even sharing a 16-char prefix', () => {
    const a = `${'1'.repeat(16)}${'2'.repeat(48)}`
    const b = `${'1'.repeat(16)}${'3'.repeat(48)}`
    expect(generateReceiveIdempotencyKey(FP_A)).not.toBe(generateReceiveIdempotencyKey(FP_B))
    expect(generateReceiveIdempotencyKey(a)).not.toBe(generateReceiveIdempotencyKey(b))
  })

  it('sends no key rather than a guessed one without a fingerprint', () => {
    expect(generateReceiveIdempotencyKey(null)).toBeNull()
    expect(generateReceiveIdempotencyKey('')).toBeNull()
  })
})

describe('weak fingerprints never key a receive (review 1)', () => {
  /**
   * TokenSecurity's fallback is `fallback_<first 50 chars>_<length>`. Two
   * tokens sharing a 50-char prefix and a length share it, and the gateway
   * would replay one's settled result for the other.
   */
  it('two tokens colliding on the fallback fingerprint get different, SHA-256 keys', async () => {
    const t1 = `cashuA${'x'.repeat(50)}AAAA`
    const t2 = `cashuA${'x'.repeat(50)}BBBB`
    const fallback = (t: string) => `fallback_${t.substring(0, 50)}_${t.length}`
    expect(fallback(t1)).toBe(fallback(t2))

    const keys: Array<string | undefined> = []
    const r = loadRedemption({
      api: {
        receive: async (_t: string, o: { idempotencyKey?: string }) => {
          keys.push(o.idempotencyKey)
          return okReceive(`r-${keys.length}`)
        },
        acknowledgeReceive: async () => {},
        _nostrPublicKey: PUBKEY,
      },
      walletStorageIntegration: { atomicallyWrite: async () => {} },
      localStorage: memoryStorage(),
      TokenSecurity: { getFingerprint: async (t: string) => fallback(t) },
    })
    await r.redeem(t1, { skipDuplicateCheck: true, source: 'dm-poll' })
    await r.redeem(t2, { skipDuplicateCheck: true, source: 'dm-poll' })

    expect(keys).toEqual([`rcv_${sha(t1)}`, `rcv_${sha(t2)}`])
    expect(keys.some((k) => k?.includes('fallback_'))).toBe(false)
  })

  it('a non-SHA fingerprint passed straight to _doRedeem sends no key at all', async () => {
    const keys: Array<string | undefined> = []
    const r = loadRedemption({
      api: {
        receive: async (_t: string, o: { idempotencyKey?: string }) => {
          keys.push(o.idempotencyKey)
          return okReceive('r-1')
        },
        acknowledgeReceive: async () => {},
        _nostrPublicKey: PUBKEY,
      },
      walletStorageIntegration: { atomicallyWrite: async () => {} },
      localStorage: memoryStorage(),
    })
    await r._doRedeem(TOKEN, { fingerprint: 'fallback_cashuA_22', skipDuplicateCheck: true })
    expect(keys).toEqual([null])
  })
})

describe('api.receive is keyed on the token, across retries (#110 item 2)', () => {
  let storage: ReturnType<typeof memoryStorage>
  beforeEach(() => {
    storage = memoryStorage()
  })

  /**
   * The retry wrapper really does resubmit the token after a transient error
   * (that is its job). What must hold is that it resubmits under the SAME key.
   */
  it('a transient retry of a receive reuses the first key', async () => {
    const keys: Array<string | undefined> = []
    const receive = vi.fn(async (_t: string, o: { idempotencyKey?: string }) => {
      keys.push(o.idempotencyKey)
      if (keys.length === 1) throw httpError(502, 'HTTP 502 Bad Gateway')
      return okReceive('0c707915')
    })
    const r = loadRedemption({
      api: { receive, acknowledgeReceive: vi.fn(async () => {}), _nostrPublicKey: PUBKEY },
      walletStorageIntegration: { atomicallyWrite: vi.fn(async () => {}) },
      localStorage: storage,
      ImaniDmPoll: retryOnce,
    })

    await r._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true, source: 'dm-poll' })

    expect(receive).toHaveBeenCalledTimes(2)
    expect(keys[0]).toBe(`rcv_${FP_A}`)
    expect(keys[1]).toBe(keys[0])
  })

  /**
   * The demonstrated path: swap succeeds, save fails (RedemptionSaveError),
   * dm-poll resubmits the same token (packages/dm-poll/tests). The resubmit
   * carries the same key and the gateway answers with its REAL replay shape:
   * receive_id, `token: null`.
   */
  it('a save failure is resubmitted under the same key, and the null-token replay is NOT saved (review 4)', async () => {
    const keys: Array<string | undefined> = []
    let calls = 0
    const receive = vi.fn(async (_t: string, o: { idempotencyKey?: string }) => {
      keys.push(o.idempotencyKey)
      calls += 1
      return calls === 1 ? okReceive('0c707915') : replayReceive('0c707915')
    })
    let failSave = true
    const written: unknown[] = []
    const atomicallyWrite = vi.fn(async (w: { vouchers: unknown[] }) => {
      if (failSave) throw new Error('QuotaExceededError')
      written.push(...w.vouchers)
    })
    const acknowledgeReceive = vi.fn(async () => {})
    const r = loadRedemption({
      api: { receive, acknowledgeReceive, _nostrPublicKey: PUBKEY },
      walletStorageIntegration: { atomicallyWrite },
      localStorage: storage,
    })

    await expect(
      r._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true, source: 'dm-poll' }),
    ).rejects.toBeInstanceOf(r.RedemptionSaveError)

    failSave = false
    const err = await r
      ._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true, source: 'dm-poll' })
      .catch((e: unknown) => e)

    expect(keys).toEqual([`rcv_${FP_A}`, `rcv_${FP_A}`])
    // The phantom balance: the input token, already spent, must never be saved.
    expect(err).toBeInstanceOf(r.ReceiveSettledNotSavedError)
    expect((err as { reason?: string }).reason).toBe('replay-without-token')
    expect(written).toEqual([])
    expect(acknowledgeReceive).not.toHaveBeenCalled()
    expect(r.ReceiveLedger.settledUnsaved()).toEqual(['0c707915'])
  })
})

describe('never ack an escrow whose value was not saved (review 2)', () => {
  it('a save failure leaves the escrow settled-unsaved: not acked now, not acked by the flush', async () => {
    const acknowledgeReceive = vi.fn(async () => {})
    const r = loadRedemption({
      api: { receive: async () => okReceive('0c707915'), acknowledgeReceive, _nostrPublicKey: PUBKEY },
      walletStorageIntegration: { atomicallyWrite: async () => { throw new Error('QuotaExceededError') } },
      localStorage: memoryStorage(),
    })
    await expect(
      r._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true, source: 'dm-poll' }),
    ).rejects.toBeInstanceOf(r.RedemptionSaveError)

    expect(r.ReceiveLedger.unacknowledged()).toEqual([])
    expect(r.ReceiveLedger.settledUnsaved()).toEqual(['0c707915'])
    await expect(r.flushUnacknowledgedEscrows()).resolves.toBe(0)
    expect(acknowledgeReceive).not.toHaveBeenCalled()
    // And a direct call is refused too, so no future call site can do it.
    await r._acknowledgeEscrow('0c707915')
    expect(acknowledgeReceive).not.toHaveBeenCalled()
  })

  it('a successful save moves it to saved and acks it', async () => {
    const acknowledgeReceive = vi.fn(async () => {})
    const r = loadRedemption({
      api: { receive: async () => okReceive('0c707915'), acknowledgeReceive, _nostrPublicKey: PUBKEY },
      walletStorageIntegration: { atomicallyWrite: async () => {} },
      localStorage: memoryStorage(),
    })
    await r._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true, source: 'dm-poll' })
    expect(acknowledgeReceive).toHaveBeenCalledWith('0c707915')
    expect(r.ReceiveLedger.list()[0].state).toBe('acked')
  })
})

describe('settled receives are terminal but never a success (review 3, 5)', () => {
  it("409 RECEIVE_ALREADY_SETTLED: id from X-Receive-Id, surfaced as settled-not-saved, not retried", async () => {
    const headers = new Map([['x-receive-id', '7a211696']])
    const receive = vi.fn(async () => {
      throw httpError(409, 'Receive already settled', {
        code: 'RECEIVE_ALREADY_SETTLED',
        headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
        data: { details: 'receive_id=ignored status=HELD' },
      })
    })
    const isTransient = vi.fn()
    const r = loadRedemption({
      api: { receive, _nostrPublicKey: PUBKEY },
      localStorage: memoryStorage(),
      ImaniDmPoll: {
        retryOnTransientMintError: async <T,>(fn: () => Promise<T>, o: { isTransient: (e: unknown) => boolean }) => {
          try {
            return await fn()
          } catch (e) {
            isTransient(o.isTransient(e))
            throw e
          }
        },
      },
    })

    const err = await r
      ._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true, source: 'dm-poll' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(r.ReceiveSettledNotSavedError)
    expect((err as { receiveId?: string }).receiveId).toBe('7a211696')
    expect((err as { code?: string }).code).toBe('RECEIVE_SETTLED_NOT_SAVED')
    // Not dm-poll's "already redeemed" wording: that path marks it received.
    expect((err as Error).message).not.toMatch(/already (been )?redeemed|already spent|proof already used/i)
    expect(isTransient).toHaveBeenCalledWith(false)
    expect(receive).toHaveBeenCalledTimes(1)
  })

  it("409 with no header: the id is parsed from details", async () => {
    const r = loadRedemption({
      api: {
        receive: async () => {
          throw httpError(409, 'Conflict', {
            code: 'RECEIVE_ALREADY_SETTLED',
            data: { details: 'receive_id=0c707915 status=HELD' },
          })
        },
        _nostrPublicKey: PUBKEY,
      },
      localStorage: memoryStorage(),
    })
    const err = await r
      ._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true })
      .catch((e: unknown) => e)
    expect((err as { receiveId?: string }).receiveId).toBe('0c707915')
  })

  it('api.js exposes the response headers on a thrown error', async () => {
    const { api } = loadApi(async () => ({
      ok: false,
      status: 409,
      headers: {
        get: (k: string) =>
          ({ 'content-type': 'application/json', 'x-receive-id': '7a211696' } as Record<string, string>)[k.toLowerCase()] ?? null,
      },
      json: async () => ({ error: { code: 'RECEIVE_ALREADY_SETTLED', message: 'settled' } }),
    }))
    api.setNostrCredentials('a'.repeat(64), '1'.repeat(64))
    const err = (await api.receive('cashuAx').catch((e: unknown) => e)) as {
      code?: string
      headers?: { get(k: string): string | null }
    }
    expect(err.code).toBe('RECEIVE_ALREADY_SETTLED')
    expect(err.headers?.get('X-Receive-Id')).toBe('7a211696')
  })

  it('11001 on a token this wallet already has a receive_id for is settled-not-saved', async () => {
    const r = loadRedemption({
      api: {
        receive: async () => {
          throw httpError(400, 'Failed to swap tokens (mint_error_code=11001, reason=Proof already used)')
        },
        _nostrPublicKey: PUBKEY,
      },
      localStorage: memoryStorage(),
    })
    r.ReceiveLedger.recordSettled('0c707915', FP_A)

    const err = await r
      ._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true, source: 'dm-poll' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(r.ReceiveSettledNotSavedError)
    expect((err as { receiveId?: string }).receiveId).toBe('0c707915')
  })

  it('leaves 11001 on a token it never received alone', async () => {
    const r = loadRedemption({
      api: {
        receive: async () => {
          throw httpError(400, 'mint_error_code=11001 Proof already used')
        },
        _nostrPublicKey: PUBKEY,
      },
      localStorage: memoryStorage(),
    })
    const err = await r
      ._doRedeem(TOKEN, { fingerprint: FP_B, skipDuplicateCheck: true, source: 'dm-poll' })
      .catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(r.ReceiveSettledNotSavedError)
  })
})

describe('_acknowledgeEscrow (#110 item 3)', () => {
  let storage: ReturnType<typeof memoryStorage>
  beforeEach(() => {
    storage = memoryStorage()
  })

  it('retries a rate-limited ack, honouring Retry-After, through the ack gate', async () => {
    let calls = 0
    const acknowledgeReceive = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw httpError(429, 'Rate limit exceeded', { retryAfterMs: 45_000 })
    })
    const r = loadRedemption({ api: { acknowledgeReceive, _nostrPublicKey: PUBKEY }, localStorage: storage })
    const waits: number[] = []
    r._ackSleep = async (ms: number) => void waits.push(ms)
    const gate = vi.fn(async () => {})
    r._ackGate = gate
    r.ReceiveLedger.recordSaved('f6af3356', FP_A)

    await expect(r._acknowledgeEscrow('f6af3356')).resolves.toBe(false)
    await r._ackRetries.get('f6af3356')

    expect(acknowledgeReceive).toHaveBeenCalledTimes(2)
    expect(waits[0]).toBe(45_000)
    // The first ack and its retry are both paced (review C).
    expect(gate).toHaveBeenCalledTimes(2)
    expect(r.ReceiveLedger.unacknowledged()).toEqual([])
  })

  it('is bounded: gives up after its backoffs and leaves the id for the next poll', async () => {
    const acknowledgeReceive = vi.fn(async (): Promise<void> => {
      throw httpError(429, 'Rate limit exceeded', { retryAfterMs: 10 * 60_000 })
    })
    const r = loadRedemption({ api: { acknowledgeReceive, _nostrPublicKey: PUBKEY }, localStorage: storage })
    const waits: number[] = []
    r._ackSleep = async (ms: number) => void waits.push(ms)
    r.ReceiveLedger.recordSaved('a40ed0a6', FP_A)

    await r._acknowledgeEscrow('a40ed0a6')
    await r._ackRetries.get('a40ed0a6')

    expect(acknowledgeReceive).toHaveBeenCalledTimes(1 + r._ackBackoffsMs.length)
    expect(Math.max(...waits)).toBeLessThanOrEqual(65_000)
    expect(r.ReceiveLedger.unacknowledged()).toEqual(['a40ed0a6'])

    acknowledgeReceive.mockImplementation(async () => {})
    await expect(r.flushUnacknowledgedEscrows()).resolves.toBe(1)
    expect(r.ReceiveLedger.unacknowledged()).toEqual([])
  })

  it('stops a background retry on logout / account switch', async () => {
    const acknowledgeReceive = vi.fn(async (): Promise<void> => {
      throw httpError(503, 'unavailable')
    })
    const r = loadRedemption({ api: { acknowledgeReceive, _nostrPublicKey: PUBKEY }, localStorage: storage })
    r._ackSleep = async () => {
      r.resetAckState()
    }
    r.ReceiveLedger.recordSaved('x1', null)
    await r._acknowledgeEscrow('x1')
    await r._ackRetries.get('x1')
    expect(acknowledgeReceive).toHaveBeenCalledTimes(1)
  })

  it('retries a 403 a bounded number of times, then drops it', async () => {
    const acknowledgeReceive = vi.fn(async (): Promise<void> => {
      throw httpError(403, 'Forbidden')
    })
    const r = loadRedemption({ api: { acknowledgeReceive, _nostrPublicKey: PUBKEY }, localStorage: storage })
    r._ackSleep = async () => {}
    r.ReceiveLedger.recordSaved('forbidden', null)
    await r._acknowledgeEscrow('forbidden')
    await r._ackRetries.get('forbidden')
    expect(acknowledgeReceive).toHaveBeenCalledTimes(3)
    expect(r.ReceiveLedger.unacknowledged()).toEqual([])
  })

  it('persists per account, survives a reload, and does nothing with no account', async () => {
    const r1 = loadRedemption({ api: { _nostrPublicKey: PUBKEY }, localStorage: storage })
    r1.ReceiveLedger.recordSaved('b756c79c', FP_A)
    expect(storage.keys()).toEqual([`imani-wallet:receive-ledger:${PUBKEY}`])

    const r2 = loadRedemption({ api: { _nostrPublicKey: PUBKEY }, localStorage: storage })
    expect(r2.ReceiveLedger.unacknowledged()).toEqual(['b756c79c'])
    const other = loadRedemption({ api: { _nostrPublicKey: 'd'.repeat(64) }, localStorage: storage })
    expect(other.ReceiveLedger.unacknowledged()).toEqual([])

    const anon = loadRedemption({ api: {}, localStorage: storage })
    anon.ReceiveLedger.recordSaved('nobody', null)
    expect(storage.keys()).toEqual([`imani-wallet:receive-ledger:${PUBKEY}`])
  })

  it('is bounded in storage', () => {
    const r = loadRedemption({ api: { _nostrPublicKey: PUBKEY }, localStorage: storage })
    for (let i = 0; i < r.ReceiveLedger.LIMIT + 25; i++) r.ReceiveLedger.recordSaved(`r-${i}`, null)
    expect(r.ReceiveLedger.list()).toHaveLength(r.ReceiveLedger.LIMIT)
  })

  it('drops an escrow the gateway no longer has instead of retrying forever', async () => {
    const acknowledgeReceive = vi.fn(async (): Promise<void> => {
      throw httpError(404, 'Not found')
    })
    const r = loadRedemption({ api: { acknowledgeReceive, _nostrPublicKey: PUBKEY }, localStorage: storage })
    r.ReceiveLedger.recordSaved('gone', null)
    await r._acknowledgeEscrow('gone')
    expect(r._ackRetries.size).toBe(0)
    expect(r.ReceiveLedger.unacknowledged()).toEqual([])
  })

  it('never throws, even with no api', async () => {
    const r = loadRedemption({ api: undefined, localStorage: storage })
    await expect(r._acknowledgeEscrow('x')).resolves.toBe(false)
    await expect(r.flushUnacknowledgedEscrows()).resolves.toBe(0)
  })
})

describe('flushUnacknowledgedEscrows respects the budget (review 6)', () => {
  function withBacklog(n: number, ack: () => Promise<void>) {
    const storage = memoryStorage()
    const acknowledgeReceive = vi.fn(ack)
    const r = loadRedemption({ api: { acknowledgeReceive, _nostrPublicKey: PUBKEY }, localStorage: storage })
    for (let i = 0; i < n; i++) r.ReceiveLedger.recordSaved(`held-${i}`, null)
    return { r, acknowledgeReceive }
  }

  it('stops at the first 429 even without a Retry-After header', async () => {
    const { r, acknowledgeReceive } = withBacklog(5, async () => {
      throw httpError(429, 'Rate limit exceeded') // no retryAfterMs
    })
    await r.flushUnacknowledgedEscrows()
    expect(acknowledgeReceive).toHaveBeenCalledTimes(1)
  })

  it('sends at most a small bounded number per run, each through the gate', async () => {
    const { r, acknowledgeReceive } = withBacklog(10, async () => {})
    const gate = vi.fn(async () => {})
    r._ackGate = gate
    await expect(r.flushUnacknowledgedEscrows()).resolves.toBe(2)
    expect(acknowledgeReceive).toHaveBeenCalledTimes(2)
    expect(gate).toHaveBeenCalledTimes(2)
  })
})

describe('logging (#110 item 6)', () => {
  it('logs by receive_id and never logs the token', async () => {
    const logs: string[] = []
    const spies = (['log', 'info', 'warn', 'error'] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(JSON.stringify(a))),
    )
    try {
      const r = loadRedemption({
        api: {
          receive: async () => okReceive('0c707915'),
          acknowledgeReceive: async () => {},
          _nostrPublicKey: PUBKEY,
        },
        walletStorageIntegration: { atomicallyWrite: async () => {} },
        localStorage: memoryStorage(),
      })
      await r._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true, source: 'dm-poll' })
    } finally {
      spies.forEach((s) => s.mockRestore())
    }
    const all = logs.join('\n')
    expect(all).toContain('0c707915')
    expect(all).not.toContain(TOKEN)
    expect(all).not.toContain('cashuAfresh')
    expect(all).not.toContain(FP_A)
  })
})

describe('second review of #111', () => {
  /** A: a coupon this wallet already SAVED must not be reported as a loss. */
  it.each(['saved', 'acked'])('A: a redelivered token already %s here is the idempotent "already redeemed", not unsaved', async (state) => {
    const receive = vi.fn()
    const r = loadRedemption({ api: { receive, _nostrPublicKey: PUBKEY }, localStorage: memoryStorage() })
    r.ReceiveLedger.recordSettled('0c707915', FP_A)
    if (state === 'saved') r.ReceiveLedger.recordSaved('0c707915', FP_A)
    else {
      r.ReceiveLedger.recordSaved('0c707915', FP_A)
      ;(r.ReceiveLedger as unknown as { markAcked(id: string): void }).markAcked('0c707915')
    }
    const err = await r
      ._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true, source: 'dm-poll' })
      .catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(r.ReceiveSettledNotSavedError)
    expect((err as Error).message).toMatch(/already been redeemed/)
    expect(receive).not.toHaveBeenCalled()
  })

  it("A: only a 'settled' entry turns 11001 into settled-not-saved", async () => {
    const r = loadRedemption({
      api: { receive: async () => { throw httpError(400, 'mint_error_code=11001') }, _nostrPublicKey: PUBKEY },
      localStorage: memoryStorage(),
    })
    r.ReceiveLedger.recordSettled('0c707915', FP_A)
    const err = await r._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(r.ReceiveSettledNotSavedError)
  })

  /** B: never save the input token as the fresh voucher, whatever the shape. */
  it.each([
    ['with a receive_id', { receive_id: 'r-1', amount: 5, token: null, imported_count: 1 }, true],
    ['with NO receive_id', { amount: 5, token: null, imported_count: 1 }, false],
  ])('B: a no-fresh-token result %s saves nothing', async (_n, shape, reconcilable) => {
    const atomicallyWrite = vi.fn(async () => {})
    const r = loadRedemption({
      api: { receive: async () => shape, acknowledgeReceive: vi.fn(), _nostrPublicKey: PUBKEY },
      walletStorageIntegration: { atomicallyWrite },
      localStorage: memoryStorage(),
    })
    const err = await r._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err instanceof r.ReceiveSettledNotSavedError).toBe(reconcilable)
    expect(atomicallyWrite).not.toHaveBeenCalled()
  })

  /**
   * #111 delta review: a duplicate response carries no fresh token either. It
   * must keep its "already redeemed" wording (dm-poll's idempotent path), not
   * be swallowed by the no-fresh-token guard into a retried failure.
   */
  it.each([
    ['duplicate_count > 0', { duplicate_count: 2, imported_count: 0, amount: 5, token: null }],
    ['amount 0', { amount: 0, imported_count: 0, token: null }],
  ])('B: a %s response with no token is still "already redeemed"', async (_n, shape) => {
    const atomicallyWrite = vi.fn(async () => {})
    const r = loadRedemption({
      api: { receive: async () => shape, acknowledgeReceive: vi.fn(), _nostrPublicKey: PUBKEY },
      walletStorageIntegration: { atomicallyWrite },
      localStorage: memoryStorage(),
    })
    const err = await r._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true }).catch((e: unknown) => e)
    expect(String((err as Error).message)).toMatch(/already (been )?redeemed/)
    expect(atomicallyWrite).not.toHaveBeenCalled()
  })

  it('B (original): buildVoucher never falls back to the input token', () => {
    const r = loadRedemption({ api: {}, localStorage: memoryStorage() })
    const v = r.buildVoucher(TOKEN, { amount: 5, token: null }, {}, null, 5, null)
    expect(v.token).not.toBe(TOKEN)
    expect(v.token).toBeNull()
  })

  /** C: every api.receive for one token, across all retry layers, is capped and gated. */
  it('C: api.receive for one token is capped across retries, and every call goes through the gate', async () => {
    const receive = vi.fn(async (): Promise<unknown> => { throw httpError(503, 'HTTP 503') })
    const r = loadRedemption({
      api: { receive, _nostrPublicKey: PUBKEY },
      localStorage: memoryStorage(),
      ImaniDmPoll: {
        retryOnTransientMintError: async <T,>(fn: () => Promise<T>) => {
          let last: unknown
          for (let i = 0; i < 4; i++) {
            try { return await fn() } catch (e) { last = e }
          }
          throw last
        },
      },
    })
    const gate = vi.fn(async () => {})
    r._receiveGate = gate
    // The outer (dmPoll 429) layer re-enters redeem up to 5 times.
    for (let outer = 0; outer < 5; outer++) {
      await r._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true }).catch(() => undefined)
    }
    expect(receive).toHaveBeenCalledTimes(5)
    expect(gate).toHaveBeenCalledTimes(5)
  })

  /** D: the in-flight 409 (Retry-After: 2, empty body) waits and retries under the same key. */
  it('D: 409 with Retry-After and no body waits and retries under the same key', async () => {
    const keys: Array<string | undefined> = []
    const receive = vi.fn(async (_t: string, o: { idempotencyKey?: string }) => {
      keys.push(o.idempotencyKey)
      if (keys.length === 1) throw httpError(409, 'API request failed', { code: 'UNKNOWN_ERROR', retryAfterMs: 2000 })
      return okReceive('0c707915')
    })
    const r = loadRedemption({
      api: { receive, acknowledgeReceive: async () => {}, _nostrPublicKey: PUBKEY },
      walletStorageIntegration: { atomicallyWrite: async () => {} },
      localStorage: memoryStorage(),
    })
    const waits: number[] = []
    r._inFlightSleep = async (ms: number) => void waits.push(ms)
    await r._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true })
    expect(waits).toEqual([2000])
    expect(keys).toEqual([`rcv_${FP_A}`, `rcv_${FP_A}`])
  })

  it('D: a persistent in-flight 409 gives up after its bounded retries', async () => {
    const receive = vi.fn(async (): Promise<unknown> => {
      throw httpError(409, 'API request failed', { retryAfterMs: 2000 })
    })
    const r = loadRedemption({ api: { receive, _nostrPublicKey: PUBKEY }, localStorage: memoryStorage() })
    r._inFlightSleep = async () => {}
    await expect(r._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true })).rejects.toThrow()
    expect(receive).toHaveBeenCalledTimes(3)
  })

  /** E: the save-failure log must not claim a retry recovers the value. */
  it('E: the persist-failure log does not promise a replay recovers it', async () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(String(a[0])))
    try {
      const r = loadRedemption({
        api: { receive: async () => okReceive('0c707915'), _nostrPublicKey: PUBKEY },
        walletStorageIntegration: { atomicallyWrite: async () => { throw new Error('quota') } },
        localStorage: memoryStorage(),
      })
      await r._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true }).catch(() => undefined)
    } finally {
      spy.mockRestore()
    }
    const line = logs.find((l) => l.includes('persist failed')) ?? ''
    expect(line).toMatch(/NOT recoverable/)
    expect(line).not.toMatch(/replays it/)
    expect(REDEMPTION_SOURCE).toMatch(/TODO\(imani-gateway-customer#121\/#119\)/)
  })
})
