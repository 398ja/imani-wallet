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

type Scope = Record<string, unknown>

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

function loadApiHelpers(): {
  generateReceiveIdempotencyKey: (fp: string | null) => string | null
  parseRetryAfterMs: (v: string | null) => number | null
} {
  const scope: Scope = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const window: any = scope
  new Function('window', 'localStorage', 'GatewayConfig', `${API_SOURCE}`)(
    window,
    memoryStorage(),
    { relayUrl: 'wss://r', apiUrl: 'http://gw', gatewayUrl: 'http://gw' },
  )
  return window
}

interface Redemption {
  _doRedeem(token: string, opts: Record<string, unknown>): Promise<Record<string, unknown>>
  _acknowledgeEscrow(id: string | null): Promise<boolean>
  _scheduleAckRetry(id: string, retryAfterMs: number | null): Promise<boolean>
  flushUnacknowledgedEscrows(): Promise<number>
  _ackSleep: (ms: number) => Promise<void>
  _ackBackoffsMs: number[]
  _ackRetries: Map<string, Promise<boolean>>
  ReceiveLedger: {
    list(): Array<{ receiveId: string; fp: string | null; acked: boolean }>
    unacknowledged(): string[]
    receiveIdFor(fp: string): string | null
    recordSettled(id: string, fp: string | null): void
    LIMIT: number
  }
  ReceiveAlreadySettledError: new (...a: unknown[]) => Error
  RedemptionSaveError: new (...a: unknown[]) => Error
}

function loadRedemption(g: {
  api: Record<string, unknown>
  walletStorageIntegration?: Record<string, unknown>
  localStorage: ReturnType<typeof memoryStorage>
  ImaniDmPoll?: unknown
}): Redemption {
  return new Function(
    'api',
    'walletStorageIntegration',
    'localStorage',
    'ImaniDmPoll',
    'generateReceiveIdempotencyKey',
    'resolveDecimals',
    `${REDEMPTION_SOURCE}; return TokenRedemption;`,
  )(
    g.api,
    g.walletStorageIntegration,
    g.localStorage,
    g.ImaniDmPoll,
    (fp: string) => `rcv_${fp}`,
    () => 2,
  ) as Redemption
}

const FP_A = 'a'.repeat(64)
const FP_B = 'b'.repeat(64)
const TOKEN = 'cashuAeyJ0b2tlbiI6W119'
const PUBKEY = 'c'.repeat(64)

const okReceive = (receiveId: string) => ({
  receive_id: receiveId,
  amount: 1356,
  token: 'cashuAfresh',
  imported_count: 1,
  unit: 'sat',
})

const httpError = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { status, ...extra })

describe('generateReceiveIdempotencyKey (#110 item 1)', () => {
  const { generateReceiveIdempotencyKey } = loadApiHelpers()

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

describe('parseRetryAfterMs', () => {
  const { parseRetryAfterMs } = loadApiHelpers()
  it('reads delta-seconds and ignores junk', () => {
    expect(parseRetryAfterMs('60')).toBe(60_000)
    expect(parseRetryAfterMs(null)).toBeNull()
    expect(parseRetryAfterMs('soon')).toBeNull()
  })
})

describe('api.receive is keyed on the token, across retries (#110 item 2)', () => {
  let storage: ReturnType<typeof memoryStorage>
  beforeEach(() => {
    storage = memoryStorage()
  })

  /**
   * The staging sequence at 19:44:20–24: the first receive settled (swap done)
   * but the client saw a transient failure, `_withReceiveRetry` retried 1s
   * later, and the retry went out under a NEW key. The gateway could not
   * replay the settled result and re-swapped spent proofs: 11001.
   *
   * The retry wrapper really does resubmit the token after a transient error
   * (that is its job). What must hold is that it resubmits under the SAME key,
   * so the gateway answers with the first swap's proofs.
   */
  it('a transient retry of a settled receive reuses the first key', async () => {
    const keys: Array<string | undefined> = []
    let calls = 0
    const receive = vi.fn(async (_t: string, o: { idempotencyKey?: string }) => {
      keys.push(o.idempotencyKey)
      calls += 1
      if (calls === 1) throw httpError(502, 'HTTP 502 Bad Gateway') // settled server-side, response lost
      return okReceive('0c707915')
    })
    const ImaniDmPoll = {
      // The real helper's contract, minus the sleeps.
      retryOnTransientMintError: async <T,>(fn: () => Promise<T>, o: { isTransient: (e: unknown) => boolean }) => {
        try {
          return await fn()
        } catch (e) {
          if (!o.isTransient(e)) throw e
          return fn()
        }
      },
    }
    const r = loadRedemption({
      api: { receive, acknowledgeReceive: vi.fn(async () => {}), _nostrPublicKey: PUBKEY },
      walletStorageIntegration: { atomicallyWrite: vi.fn(async () => {}) },
      localStorage: storage,
      ImaniDmPoll,
    })

    await r._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true, source: 'dm-poll' })

    expect(receive).toHaveBeenCalledTimes(2)
    expect(keys[0]).toBe(`rcv_${FP_A}`)
    expect(keys[1]).toBe(keys[0])
  })

  /**
   * The cause proven end to end: the swap succeeds, the save fails, and the
   * redemption throws RedemptionSaveError. dm-poll files the wrap as failed
   * and replays it later (FailedEventTracker → processGiftWrap → redeem), and
   * nothing on the way marks the token received, so the token IS resubmitted.
   * (DmPollService's half is pinned in packages/dm-poll/tests.) The resubmit
   * must carry the same key, and the settled receive must be on the ledger
   * so its escrow is still acked and an 11001 is recognised as ours.
   */
  it('a save failure leaves the settled receive on the ledger, and the retry reuses the key', async () => {
    const keys: Array<string | undefined> = []
    const receive = vi.fn(async (_t: string, o: { idempotencyKey?: string }) => {
      keys.push(o.idempotencyKey)
      return okReceive('0c707915')
    })
    let failSave = true
    const atomicallyWrite = vi.fn(async () => {
      if (failSave) throw new Error('QuotaExceededError')
    })
    const r = loadRedemption({
      api: { receive, acknowledgeReceive: vi.fn(async () => {}), _nostrPublicKey: PUBKEY },
      walletStorageIntegration: { atomicallyWrite },
      localStorage: storage,
    })

    await expect(
      r._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true, source: 'dm-poll' }),
    ).rejects.toBeInstanceOf(r.RedemptionSaveError)
    expect(r.ReceiveLedger.receiveIdFor(FP_A)).toBe('0c707915')
    expect(r.ReceiveLedger.unacknowledged()).toEqual(['0c707915'])

    // The replay: the gateway answers the same key with the settled result.
    failSave = false
    await r._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true, source: 'dm-poll' })
    expect(keys).toEqual([`rcv_${FP_A}`, `rcv_${FP_A}`])
    expect(r.ReceiveLedger.unacknowledged()).toEqual([])
  })

  it("treats the gateway's 409 RECEIVE_ALREADY_SETTLED as terminal, never a retry", async () => {
    const receive = vi.fn(async () => {
      throw httpError(409, 'Receive already settled', { code: 'RECEIVE_ALREADY_SETTLED', data: { receive_id: 'r-9' } })
    })
    const isTransient = vi.fn()
    const ImaniDmPoll = {
      retryOnTransientMintError: async <T,>(fn: () => Promise<T>, o: { isTransient: (e: unknown) => boolean }) => {
        try {
          return await fn()
        } catch (e) {
          isTransient(o.isTransient(e))
          throw e
        }
      },
    }
    const r = loadRedemption({ api: { receive, _nostrPublicKey: PUBKEY }, localStorage: storage, ImaniDmPoll })

    const err = await r
      ._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true, source: 'dm-poll' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(r.ReceiveAlreadySettledError)
    expect((err as { receiveId?: string }).receiveId).toBe('r-9')
    // dm-poll's isAlreadyRedeemedError keys on this wording to stop retrying.
    expect((err as Error).message).toMatch(/already been redeemed/)
    expect(isTransient).toHaveBeenCalledWith(false)
    expect(receive).toHaveBeenCalledTimes(1)
  })

  it('treats 11001 on a token this wallet already has a receive_id for as terminal', async () => {
    const receive = vi.fn(async () => {
      throw httpError(400, 'Failed to swap tokens (mint_error_code=11001, reason=Proof already used)')
    })
    const r = loadRedemption({ api: { receive, _nostrPublicKey: PUBKEY }, localStorage: storage })
    r.ReceiveLedger.recordSettled('0c707915', FP_A)

    const err = await r
      ._doRedeem(TOKEN, { fingerprint: FP_A, skipDuplicateCheck: true, source: 'dm-poll' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(r.ReceiveAlreadySettledError)
    expect((err as { receiveId?: string }).receiveId).toBe('0c707915')
  })

  it('leaves 11001 on a token it never received alone', async () => {
    const receive = vi.fn(async () => {
      throw httpError(400, 'mint_error_code=11001 Proof already used')
    })
    const r = loadRedemption({ api: { receive, _nostrPublicKey: PUBKEY }, localStorage: storage })
    const err = await r
      ._doRedeem(TOKEN, { fingerprint: FP_B, skipDuplicateCheck: true, source: 'dm-poll' })
      .catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(r.ReceiveAlreadySettledError)
  })
})

describe('_acknowledgeEscrow (#110 item 3)', () => {
  let storage: ReturnType<typeof memoryStorage>
  beforeEach(() => {
    storage = memoryStorage()
  })

  it('retries a rate-limited ack, honouring Retry-After, and clears it from the ledger', async () => {
    let calls = 0
    const acknowledgeReceive = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw httpError(429, 'Rate limit exceeded', { retryAfterMs: 45_000 })
    })
    const r = loadRedemption({ api: { acknowledgeReceive, _nostrPublicKey: PUBKEY }, localStorage: storage })
    const waits: number[] = []
    r._ackSleep = async (ms: number) => void waits.push(ms)
    r.ReceiveLedger.recordSettled('f6af3356', FP_A)

    // Never throws, reports the first attempt failed.
    await expect(r._acknowledgeEscrow('f6af3356')).resolves.toBe(false)
    await r._ackRetries.get('f6af3356')

    expect(acknowledgeReceive).toHaveBeenCalledTimes(2)
    expect(waits[0]).toBe(45_000)
    expect(r.ReceiveLedger.unacknowledged()).toEqual([])
  })

  it('is bounded: gives up after its backoffs and leaves the id for the next poll', async () => {
    const acknowledgeReceive = vi.fn(async (): Promise<void> => {
      throw httpError(429, 'Rate limit exceeded', { retryAfterMs: 10 * 60_000 })
    })
    const r = loadRedemption({ api: { acknowledgeReceive, _nostrPublicKey: PUBKEY }, localStorage: storage })
    const waits: number[] = []
    r._ackSleep = async (ms: number) => void waits.push(ms)
    r.ReceiveLedger.recordSettled('a40ed0a6', FP_A)

    await r._acknowledgeEscrow('a40ed0a6')
    await r._ackRetries.get('a40ed0a6')

    expect(acknowledgeReceive).toHaveBeenCalledTimes(1 + r._ackBackoffsMs.length)
    // A hostile Retry-After is capped.
    expect(Math.max(...waits)).toBeLessThanOrEqual(65_000)
    expect(r.ReceiveLedger.unacknowledged()).toEqual(['a40ed0a6'])

    // The next poll's flush retries it.
    acknowledgeReceive.mockImplementation(async () => {})
    await expect(r.flushUnacknowledgedEscrows()).resolves.toBe(1)
    expect(r.ReceiveLedger.unacknowledged()).toEqual([])
  })

  it('persists per account, and survives a reload', async () => {
    const r1 = loadRedemption({ api: { _nostrPublicKey: PUBKEY }, localStorage: storage })
    r1.ReceiveLedger.recordSettled('b756c79c', FP_A)
    expect(storage.keys()).toEqual([`imani-wallet:receive-ledger:${PUBKEY}`])

    const r2 = loadRedemption({ api: { _nostrPublicKey: PUBKEY }, localStorage: storage })
    expect(r2.ReceiveLedger.unacknowledged()).toEqual(['b756c79c'])
    const other = loadRedemption({ api: { _nostrPublicKey: 'd'.repeat(64) }, localStorage: storage })
    expect(other.ReceiveLedger.unacknowledged()).toEqual([])
  })

  it('is bounded in storage', () => {
    const r = loadRedemption({ api: { _nostrPublicKey: PUBKEY }, localStorage: storage })
    for (let i = 0; i < r.ReceiveLedger.LIMIT + 25; i++) r.ReceiveLedger.recordSettled(`r-${i}`, null)
    expect(r.ReceiveLedger.list()).toHaveLength(r.ReceiveLedger.LIMIT)
  })

  it('drops an escrow the gateway no longer has instead of retrying forever', async () => {
    const acknowledgeReceive = vi.fn(async () => {
      throw httpError(404, 'Not found')
    })
    const r = loadRedemption({ api: { acknowledgeReceive, _nostrPublicKey: PUBKEY }, localStorage: storage })
    r.ReceiveLedger.recordSettled('gone', null)
    await r._acknowledgeEscrow('gone')
    expect(r._ackRetries.size).toBe(0)
    expect(r.ReceiveLedger.unacknowledged()).toEqual([])
  })

  it('never throws, even with no api', async () => {
    const r = loadRedemption({ api: undefined as unknown as Record<string, unknown>, localStorage: storage })
    await expect(r._acknowledgeEscrow('x')).resolves.toBe(false)
    await expect(r.flushUnacknowledgedEscrows()).resolves.toBe(0)
  })

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
        localStorage: storage,
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
