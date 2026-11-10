/**
 * @vitest-environment jsdom
 *
 * #591 criteria 1, 2 (client side) and 12, and C6 opt-out: the fleet controller that ties the
 * opt-in record, the client, the scheduler and uploads together.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools'

import { FleetController, fleetHistoryLines, CONSENT_VERSION, type ControllerDeps } from '../controller'
import { readFleet, writeFleet, fleetKeyName } from '../state'
import { parseFleetConfig } from '../../config'
import { displaySnapshotCode, snapshotCheckSymbol } from '../../snapshot/code'

const walletKey = generateSecretKey()
const WALLET = getPublicKey(walletKey)
const lender = { withPrivkey: <T,>(f: (k: Uint8Array) => T): T => f(walletKey.slice()) }
const SUPPORT = getPublicKey(generateSecretKey())
const CODE = displaySnapshotCode('7KQ4M2XD' + snapshotCheckSymbol('7KQ4M2XD'))
const NOW = Date.parse('2026-11-10T23:00:00Z')

type Captured = { url: string; method: string; body: unknown; auth: Event; init: RequestInit }
function harness(routes: Partial<Record<string, (c: Captured) => Response>> = {}, over: Partial<ControllerDeps> = {}) {
  const calls: Captured[] = []
  const fetch = vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const h = (init.headers ?? {}) as Record<string, string>
    const c: Captured = { url: String(url), method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined, auth: h.Authorization ? JSON.parse(atob(h.Authorization.slice(6))) : (undefined as never), init }
    calls.push(c)
    const key = `${c.method} ${c.url}`
    const r = routes[key]
    if (r) return r(c)
    if (key === 'POST /api/v1/support/fleet/clients') return new Response(JSON.stringify({ heartbeat_seconds: 900, jitter_seconds: 120 }), { status: 201 })
    if (key === 'POST /api/v1/support/fleet/heartbeat') return new Response(JSON.stringify({ heartbeat_seconds: 900, jitter_seconds: 120, snapshot_request: null, last_upload: null }), { status: 200 })
    if (key === 'DELETE /api/v1/support/fleet/clients/self') return new Response(null, { status: 204 })
    return new Response('{}', { status: 404 })
  }) as unknown as typeof globalThis.fetch
  const upload = vi.fn(async () => 'held' as const)
  const deps: ControllerDeps = {
    walletPubkey: WALLET,
    lender,
    config: async () => ({ enabled: true, support: { blossomUrl: 'http://localhost:28090', supportPubkey: SUPPORT, ttlSeconds: 604800 } }),
    fetch,
    storage: localStorage,
    appVersion: '0.41.0',
    platform: 'pwa',
    now: () => Date.now(),
    random: () => 0.5,
    visible: () => true,
    onVisibility: () => () => undefined,
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    upload,
    ...over,
  }
  return { deps, calls, upload, fetch, c: new FleetController(deps) }
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('criterion 1: with fleet off, no fleet request of any kind', () => {
  it('config off: unlock, visibility and time produce zero requests', async () => {
    const h = harness({}, { config: async () => ({ enabled: false, support: null }) })
    writeFleet(WALLET, { ...readFleet(WALLET), optIn: { consent_version: 1, install_nonce: '11'.repeat(32), opted_in_at: NOW } })
    await h.c.unlock()
    await vi.advanceTimersByTimeAsync(48 * 3_600_000)
    expect(h.fetch).not.toHaveBeenCalled()
    expect(await h.c.available()).toBe(false)
  })

  it('config on but not opted in: zero requests', async () => {
    const h = harness()
    await h.c.unlock()
    await vi.advanceTimersByTimeAsync(48 * 3_600_000)
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('a signer that cannot lend its key: the feature is not offered and nothing is sent', async () => {
    const h = harness({}, { lender: { withPrivkey: () => { throw new Error('remote') } } })
    expect(await h.c.available()).toBe(false)
    await expect(h.c.optIn()).rejects.toThrow()
    expect(h.fetch).not.toHaveBeenCalled()
    expect(readFleet(WALLET).optIn).toBeNull()
  })

  it('parseFleetConfig: absent or not exactly true is off; needs a valid support npub', () => {
    const npub = 'npub1' + 'q'.repeat(58)
    expect(parseFleetConfig({}).enabled).toBe(false)
    expect(parseFleetConfig({ fleet_enabled: 'true', support_npub: npub, support_blossom_url: 'http://x' }).enabled).toBe(false)
    expect(parseFleetConfig({ fleet_enabled: true }).enabled).toBe(false)
  })
})

describe('criterion 2 (client): opting in registers once and records consent_version', () => {
  it('opt-in writes {consent_version, install_nonce, opted_in_at}, registers once with the fleet key, then heartbeats', async () => {
    const h = harness()
    await h.c.optIn()
    await vi.advanceTimersByTimeAsync(0)
    const st = readFleet(WALLET)
    expect(st.optIn).toEqual({ consent_version: CONSENT_VERSION, install_nonce: expect.stringMatching(/^[0-9a-f]{64}$/), opted_in_at: NOW })
    const reg = h.calls.filter((c) => c.url.endsWith('/fleet/clients'))
    expect(reg.length).toBe(1)
    expect(reg[0].body).toEqual({ consent_version: CONSENT_VERSION, app_version: '0.41.0', platform: 'pwa' })
    expect(reg[0].auth.pubkey).not.toBe(WALLET)
    expect(h.calls.map((c) => c.url)).toContain('/api/v1/support/fleet/heartbeat')
    for (const c of h.calls) {
      expect(c.init.credentials).toBe('omit')
      expect(c.auth.pubkey).toBe(reg[0].auth.pubkey)
    }
    // Unlocking again does not register again.
    h.c.lock()
    await h.c.unlock()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls.filter((c) => c.url.endsWith('/fleet/clients')).length).toBe(1)
  })

  it('opting out sends DELETE by the same fleet key and clears local state at once, nonce included', async () => {
    const h = harness()
    await h.c.optIn()
    await vi.advanceTimersByTimeAsync(0)
    const fleetPk = h.calls[0].auth.pubkey
    await h.c.optOut()
    const del = h.calls.find((c) => c.method === 'DELETE')!
    expect(del.url).toBe('/api/v1/support/fleet/clients/self')
    expect(del.auth.pubkey).toBe(fleetPk)
    expect(localStorage.getItem(fleetKeyName(WALLET))).toBeNull()
    expect(readFleet(WALLET).optIn).toBeNull()
    // No more heartbeats.
    const n = h.calls.length
    await vi.advanceTimersByTimeAsync(48 * 3_600_000)
    expect(h.calls.length).toBe(n)
  })

  it('re-joining after opt-out makes a new, unrelated fleet key', async () => {
    const h = harness()
    await h.c.optIn()
    const first = h.calls[0].auth.pubkey
    await h.c.optOut()
    await h.c.optIn()
    const second = h.calls.filter((c) => c.url.endsWith('/fleet/clients'))[1].auth.pubkey
    expect(second).not.toBe(first)
  })

  it('a failed DELETE keeps only the old nonce, and retries it on next unlock', async () => {
    let down = true
    const h = harness({ 'DELETE /api/v1/support/fleet/clients/self': () => (down ? new Response('', { status: 503 }) : new Response(null, { status: 204 })) })
    await h.c.optIn()
    const fleetPk = h.calls[0].auth.pubkey
    const nonce = readFleet(WALLET).optIn!.install_nonce
    await h.c.optOut()
    const st = readFleet(WALLET)
    expect(st.optIn).toBeNull()
    expect(st.held).toBeNull()
    expect(st.deregisterNonce).toBe(nonce)
    down = false
    h.c.lock()
    await h.c.unlock()
    await vi.advanceTimersByTimeAsync(0)
    const dels = h.calls.filter((c) => c.method === 'DELETE')
    expect(dels.length).toBe(2)
    expect(dels[1].auth.pubkey).toBe(fleetPk)
    expect(readFleet(WALLET).deregisterNonce).toBeNull()
    // and nothing else was sent after opt-out
    expect(h.calls.filter((c) => c.url.endsWith('/heartbeat')).every((c) => h.calls.indexOf(c) < h.calls.indexOf(dels[0]))).toBe(true)
  })

  it('a heartbeat 410 triggers exactly one re-register, then heartbeats again', async () => {
    let gone = 1
    const h = harness({
      'POST /api/v1/support/fleet/heartbeat': () => (gone-- > 0
        ? new Response(JSON.stringify({ error: 'unknown_client' }), { status: 410 })
        : new Response(JSON.stringify({ heartbeat_seconds: 900, jitter_seconds: 120, snapshot_request: null, last_upload: null }), { status: 200 })),
    })
    await h.c.optIn()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls.map((c) => c.url.split('/').pop())).toEqual(['clients', 'heartbeat', 'clients', 'heartbeat'])
  })

  it('a second 410 straight after a re-register does not loop', async () => {
    const h = harness({ 'POST /api/v1/support/fleet/heartbeat': () => new Response(JSON.stringify({ error: 'unknown_client' }), { status: 410 }) })
    await h.c.optIn()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls.filter((c) => c.url.endsWith('/clients')).length).toBe(2)
    expect(h.calls.length).toBe(4)
  })

  it('a consent version change re-asks: an old opt-in is not used', async () => {
    const h = harness()
    writeFleet(WALLET, { ...readFleet(WALLET), optIn: { consent_version: CONSENT_VERSION - 1, install_nonce: '11'.repeat(32), opted_in_at: NOW } })
    await h.c.unlock()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(h.calls.filter((c) => c.method === 'POST').length).toBe(0)
    expect(h.c.status().optedIn).toBe(false)
  })

  it('lock stops heartbeats', async () => {
    const h = harness()
    await h.c.optIn()
    await vi.advanceTimersByTimeAsync(0)
    h.c.lock()
    const n = h.calls.length
    await vi.advanceTimersByTimeAsync(48 * 3_600_000)
    expect(h.calls.length).toBe(n)
  })
})

describe('requests and history (criteria 6, 12)', () => {
  const req = (over = {}) => ({ code: CODE, round: 'F202611102300', expires_at: NOW / 1000 + 3600, max_bytes: 5242880, history_days: 7, ...over })

  it('a request on the heartbeat is held (clamped) and the upload is tried', async () => {
    const h = harness({ 'POST /api/v1/support/fleet/heartbeat': () => new Response(JSON.stringify({ heartbeat_seconds: 900, jitter_seconds: 120, snapshot_request: req({ max_bytes: 1e12, history_days: 400 }), last_upload: null }), { status: 200 }) })
    await h.c.optIn()
    await vi.advanceTimersByTimeAsync(0)
    expect(readFleet(WALLET).held).toEqual({ code: CODE, round: 'F202611102300', expiresAt: NOW / 1000 + 3600, maxBytes: 5 * 1024 * 1024, historyDays: 7 })
    expect(h.upload).toHaveBeenCalled()
  })

  it('a request for a round already handled is not held again', async () => {
    const h = harness({ 'POST /api/v1/support/fleet/heartbeat': () => new Response(JSON.stringify({ heartbeat_seconds: 900, jitter_seconds: 120, snapshot_request: req(), last_upload: null }), { status: 200 }) })
    writeFleet(WALLET, { ...readFleet(WALLET), uploads: [{ round: 'F202611102300', at: NOW - 1000, state: 'not_sent', counted: false }] })
    await h.c.optIn()
    await vi.advanceTimersByTimeAsync(0)
    expect(readFleet(WALLET).held).toBeNull()
  })

  it('last_upload moves the history line to received / deleted from server', async () => {
    const h = harness({ 'POST /api/v1/support/fleet/heartbeat': () => new Response(JSON.stringify({ heartbeat_seconds: 900, jitter_seconds: 120, snapshot_request: null, last_upload: { round: 'F202611092300', state: 'deleted' } }), { status: 200 }) })
    writeFleet(WALLET, { ...readFleet(WALLET), uploads: [{ round: 'F202611092300', at: Date.parse('2026-11-09T23:10:00Z'), state: 'sent', counted: true }] })
    await h.c.optIn()
    await vi.advanceTimersByTimeAsync(0)
    expect(readFleet(WALLET).uploads[0].state).toBe('deleted')
  })

  it('criterion 12: each fleet upload is a history line, "Health check on <date>: ..."', () => {
    writeFleet(WALLET, { ...readFleet(WALLET), uploads: [
      { round: 'F202611092300', at: Date.parse('2026-11-09T23:10:00Z'), state: 'deleted', counted: true },
      { round: 'F202611082300', at: Date.parse('2026-11-08T23:10:00Z'), state: 'received', counted: true },
      { round: 'F202611072300', at: Date.parse('2026-11-07T23:10:00Z'), state: 'sent', counted: true },
      { round: 'F202611062300', at: Date.parse('2026-11-06T23:10:00Z'), state: 'not_sent', counted: false },
    ] })
    expect(fleetHistoryLines(readFleet(WALLET), 'en-GB')).toEqual([
      'Health check on 9 Nov 2026: deleted from server',
      'Health check on 8 Nov 2026: received',
      'Health check on 7 Nov 2026: sent',
      'Health check on 6 Nov 2026: not sent',
    ])
  })
})
