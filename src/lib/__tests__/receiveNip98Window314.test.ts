import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #314: a receive delayed more than about 60 s failed gateway-customer's NIP-98 time window and
 * was not retried in the same session.
 *
 * Found in the Stripe S5 till e2e: the receive was held in transit 61 s, gateway-customer answered
 * 401 `Auth event timestamp outside acceptable window`, the till kept Paid and said "will keep
 * trying", and the coupon only arrived in the merchant's NEXT session.
 *
 * Pinned against the REAL classic scripts (`shared/api.js` signs, `shared/tokenRedemption.js`
 * receives), loaded the way the browser does. The gateway double is the part that matters: it
 * enforces the 60 s window on the auth event's `created_at` exactly as imani-security's
 * `Nip98AuthFilter` does (refused before the controller, so nothing received), and it counts
 * receives by Idempotency-Key the way gateway-customer does, so a double receive would show.
 */

const API_SOURCE = readFileSync('shared/api.js', 'utf8')
const REDEMPTION_SOURCE = readFileSync('shared/tokenRedemption.js', 'utf8')

const WINDOW_S = 60
const TOKEN = 'cashuAeyJ0b2tlbiI6W119'
const FP = createHash('sha256').update(TOKEN).digest('hex')
const PUBKEY = 'c'.repeat(64)

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  }
}

/** The page clock. Advanced by the tests: a held request, a slow pacer. */
let nowMs = 0

/** NIP-98 header: the event carries the moment it was SIGNED, nothing else is needed here. */
const NostrUtils = {
  createNip98AuthHeader: async () =>
    `Nostr ${Buffer.from(JSON.stringify({ kind: 27235, created_at: Math.floor(nowMs / 1000) })).toString('base64')}`,
}

interface Gateway {
  /** Every POST /wallet/receive that reached the controller (passed auth), by key. */
  receivedByKey: Map<string, number>
  /** Every attempt, including the ones auth refused. */
  attempts: Array<{ key: string | undefined; signedAt: number; status: number }>
  /** Milliseconds the NEXT receive spends in transit before the gateway reads it. */
  holdNext: number[]
}

function gatewayFetch(gw: Gateway) {
  return async (url: string, init: { method: string; headers: Record<string, string> }) => {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (!url.endsWith('/api/v1/wallet/receive')) return json(200, {})
    nowMs += gw.holdNext.shift() ?? 0
    const auth = init.headers.Authorization ?? ''
    const event = JSON.parse(Buffer.from(auth.replace(/^Nostr /, ''), 'base64').toString('utf8'))
    const key = init.headers['Idempotency-Key']
    if (Math.abs(nowMs / 1000 - event.created_at) > WINDOW_S) {
      gw.attempts.push({ key, signedAt: event.created_at, status: 401 })
      // imani-security Nip98AuthFilter.sendError: ErrorCode.AUTH_INVALID_API_KEY (AUTH_002).
      return json(401, {
        error: { code: 'AUTH_002', message: 'Auth event timestamp outside acceptable window', trace_id: 't' },
      })
    }
    gw.attempts.push({ key, signedAt: event.created_at, status: 200 })
    const seen = gw.receivedByKey.get(key ?? '') ?? 0
    gw.receivedByKey.set(key ?? '', seen + 1)
    // gateway-customer's same-key replay carries no fresh token; the first answer does.
    return json(200, { receive_id: 'r-1', amount: 650, token: seen === 0 ? 'cashuAfresh' : null, unit: 'sat' })
  }
}

interface Loaded {
  api: { setNostrCredentials(pub: string, priv?: string): void } & Record<string, unknown>
  generateReceiveIdempotencyKey: (fp: string | null) => string | null
}

function loadApi(fetchImpl: unknown): Loaded {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const window: any = {}
  new Function('window', 'localStorage', 'GatewayConfig', 'fetch', 'NostrUtils', API_SOURCE)(
    window,
    memoryStorage(),
    { relayUrl: 'wss://r', apiUrl: 'http://gw', gatewayUrl: 'http://gw' },
    fetchImpl,
    NostrUtils,
  )
  window.api.setNostrCredentials(PUBKEY, 'd'.repeat(64))
  return window
}

interface Redemption {
  _doRedeem(token: string, opts: Record<string, unknown>): Promise<Record<string, unknown>>
  _receiveGate: () => Promise<void>
  _receiveSlowWarnMs: number
}

function loadRedemption(loaded: Loaded, written: unknown[]): Redemption {
  const r = new Function(
    'api',
    'walletStorageIntegration',
    'localStorage',
    'ImaniDmPoll',
    'generateReceiveIdempotencyKey',
    'resolveDecimals',
    'TokenSecurity',
    `${REDEMPTION_SOURCE}; return TokenRedemption;`,
  )(
    loaded.api,
    { atomicallyWrite: async (w: { vouchers: unknown[] }) => void written.push(...w.vouchers) },
    memoryStorage(),
    undefined,
    loaded.generateReceiveIdempotencyKey,
    () => 2,
    undefined,
  ) as Redemption
  r._receiveSlowWarnMs = 0
  return r
}

let gw: Gateway
let written: unknown[]

beforeEach(() => {
  nowMs = Date.parse('2026-10-18T13:55:29.000Z')
  vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  gw = { receivedByKey: new Map(), attempts: [], holdNext: [] }
  written = []
})

afterEach(() => vi.restoreAllMocks())

describe('a receive delayed past the NIP-98 window (#314)', () => {
  // Red on main: the held receive came back 401 and the redemption failed, leaving the coupon for
  // the next session. Now the same receive is signed again and goes through, in this session.
  it('succeeds after one re-sign, in the same redemption', async () => {
    const r = loadRedemption(loadApi(gatewayFetch(gw)), written)
    gw.holdNext.push(61_000) // the S5 run: held 61 s in transit

    await r._doRedeem(TOKEN, { fingerprint: FP, skipDuplicateCheck: true, source: 'dm-poll' })

    expect(gw.attempts.map((a) => a.status)).toEqual([401, 200])
    // A NEW signature, not the stale one resent.
    expect(gw.attempts[1].signedAt).toBeGreaterThan(gw.attempts[0].signedAt)
    expect(written).toHaveLength(1)
  })

  // The money property: both tries carry the token's one key, and the gateway receives it once.
  it('reuses the idempotency key, so the gateway sees one receive', async () => {
    const r = loadRedemption(loadApi(gatewayFetch(gw)), written)
    gw.holdNext.push(61_000)

    await r._doRedeem(TOKEN, { fingerprint: FP, skipDuplicateCheck: true, source: 'dm-poll' })

    expect(gw.attempts.map((a) => a.key)).toEqual([`rcv_${FP}`, `rcv_${FP}`])
    expect([...gw.receivedByKey.entries()]).toEqual([[`rcv_${FP}`, 1]])
  })

  // Once, not a loop: a link that holds every request past the window still fails, and is left
  // to the in-session retry (dmPoll) and the next session, never hammered here.
  it('signs again only once per attempt', async () => {
    const r = loadRedemption(loadApi(gatewayFetch(gw)), written)
    gw.holdNext.push(61_000, 61_000, 61_000)

    await expect(
      r._doRedeem(TOKEN, { fingerprint: FP, skipDuplicateCheck: true, source: 'dm-poll' }),
    ).rejects.toMatchObject({ status: 401 })
    expect(gw.attempts.map((a) => a.status)).toEqual([401, 401])
    expect(gw.receivedByKey.size).toBe(0)
  })

  // Other auth refusals are not cured by a fresh signature and are not retried.
  it('does not retry any other 401', async () => {
    const receives: string[] = []
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/api/v1/wallet/receive')) receives.push(url)
      return new Response(JSON.stringify({ error: { code: 'AUTH_002', message: 'Invalid signature' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }
    const r = loadRedemption(loadApi(fetchImpl), written)
    await expect(
      r._doRedeem(TOKEN, { fingerprint: FP, skipDuplicateCheck: true, source: 'dm-poll' }),
    ).rejects.toMatchObject({ status: 401 })
    expect(receives).toHaveLength(1)
  })

  // The signature is made at SEND time, after the receive gate (the pacer), not when the attempt
  // starts: a long wait for a pacer slot must not age it.
  it('signs after the receive gate, so a slow pacer cannot stale the signature', async () => {
    const r = loadRedemption(loadApi(gatewayFetch(gw)), written)
    r._receiveGate = async () => {
      nowMs += 90_000 // a full pacer window and more
    }

    await r._doRedeem(TOKEN, { fingerprint: FP, skipDuplicateCheck: true, source: 'dm-poll' })

    expect(gw.attempts.map((a) => a.status)).toEqual([200])
    expect(gw.attempts[0].signedAt).toBe(Math.floor(nowMs / 1000))
  })
})
