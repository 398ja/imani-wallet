/**
 * @vitest-environment jsdom
 *
 * #591 contract C4 (client side) and C6 clamping: register / heartbeat / deregister.
 */
import { describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

import { CLIENTS_PATH, HEARTBEAT_PATH, SELF_PATH, clampRequest, deregister, heartbeat, register, FleetHttpError, MAX_FLEET_BYTES } from '../client'
import { fleetSigner } from '../key'
import { displaySnapshotCode, snapshotCheckSymbol } from '../../snapshot/code'

const walletKey = generateSecretKey()
const WALLET = getPublicKey(walletKey)
const lender = { withPrivkey: <T,>(f: (k: Uint8Array) => T): T => f(walletKey.slice()) }
const signer = fleetSigner(lender, new Uint8Array(32).fill(5))
const GOOD = displaySnapshotCode('7KQ4M2XD' + snapshotCheckSymbol('7KQ4M2XD'))
const NOW = Date.parse('2026-11-10T23:00:00Z')

type Captured = { url: string; init: RequestInit }
function mock(answer: (c: Captured) => Response) {
  const calls: Captured[] = []
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} }
    calls.push(c)
    return answer(c)
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}
const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status })
const authEvent = (c: Captured): Event => JSON.parse(atob(String((c.init.headers as Record<string, string>).Authorization).slice(6)))

describe('register (C4)', () => {
  it('POSTs the C4 body, NIP-98 signed by the fleet key, with credentials omit', async () => {
    const m = mock(() => json(201, { heartbeat_seconds: 900, jitter_seconds: 120 }))
    const r = await register({ fetch: m.fetch, signer }, { consent_version: 1, app_version: '0.41.0', platform: 'pwa' })
    expect(r).toEqual({ heartbeatSeconds: 900, jitterSeconds: 120 })
    const [c] = m.calls
    expect(c.url).toBe(CLIENTS_PATH)
    expect(c.init.method).toBe('POST')
    expect(c.init.credentials).toBe('omit')
    expect(JSON.parse(String(c.init.body))).toEqual({ consent_version: 1, app_version: '0.41.0', platform: 'pwa' })
    const e = authEvent(c)
    expect(verifyEvent(e)).toBe(true)
    expect(e.kind).toBe(27235)
    expect(e.pubkey).toBe(signer.pubkey)
    expect(e.pubkey).not.toBe(WALLET)
    expect(e.tags.find((t) => t[0] === 'u')?.[1]).toBe(new URL(CLIENTS_PATH, window.location.origin).toString())
    expect(e.tags.find((t) => t[0] === 'payload')?.[1]).toBe(bytesToHex(sha256(new TextEncoder().encode(String(c.init.body)))))
  })

  it('200 (already registered) is fine; 403 and 429 are errors', async () => {
    expect(await register({ fetch: mock(() => json(200, { heartbeat_seconds: 900, jitter_seconds: 0 })).fetch, signer }, { consent_version: 1, app_version: '0.41.0', platform: 'web' })).toEqual({ heartbeatSeconds: 900, jitterSeconds: 0 })
    await expect(register({ fetch: mock(() => json(403, { error: 'invalid' })).fetch, signer }, { consent_version: 1, app_version: '0.41.0', platform: 'web' })).rejects.toBeInstanceOf(FleetHttpError)
    await expect(register({ fetch: mock(() => json(429, { error: 'rate_limited' })).fetch, signer }, { consent_version: 1, app_version: '0.41.0', platform: 'web' })).rejects.toMatchObject({ status: 429 })
  })

  it('clamps hostile heartbeat and jitter values', async () => {
    const tiny = await register({ fetch: mock(() => json(201, { heartbeat_seconds: 1, jitter_seconds: -5 })).fetch, signer }, { consent_version: 1, app_version: '0.41.0', platform: 'web' })
    expect(tiny.heartbeatSeconds).toBeGreaterThanOrEqual(300)
    expect(tiny.jitterSeconds).toBe(0)
    const huge = await register({ fetch: mock(() => json(201, { heartbeat_seconds: 1e12, jitter_seconds: 1e12 })).fetch, signer }, { consent_version: 1, app_version: '0.41.0', platform: 'web' })
    expect(huge.heartbeatSeconds).toBeLessThanOrEqual(86400)
    expect(huge.jitterSeconds).toBeLessThanOrEqual(huge.heartbeatSeconds / 2)
    const junk = await register({ fetch: mock(() => json(201, { heartbeat_seconds: 'x' })).fetch, signer }, { consent_version: 1, app_version: '0.41.0', platform: 'web' })
    expect(junk).toEqual({ heartbeatSeconds: 900, jitterSeconds: 120 })
  })
})

describe('heartbeat (C4)', () => {
  it('POSTs app_version and platform only, and reads a null request', async () => {
    const m = mock(() => json(200, { heartbeat_seconds: 900, jitter_seconds: 120, snapshot_request: null, last_upload: null }))
    const r = await heartbeat({ fetch: m.fetch, signer, now: () => NOW }, { app_version: '0.41.0', platform: 'android' })
    expect(r).toEqual({ kind: 'ok', heartbeatSeconds: 900, jitterSeconds: 120, request: null, lastUpload: null })
    expect(m.calls[0].url).toBe(HEARTBEAT_PATH)
    expect(m.calls[0].init.credentials).toBe('omit')
    expect(JSON.parse(String(m.calls[0].init.body))).toEqual({ app_version: '0.41.0', platform: 'android' })
    expect(authEvent(m.calls[0]).pubkey).toBe(signer.pubkey)
  })

  it('reads a request and last_upload', async () => {
    const req = { code: GOOD, round: 'F202611102300', expires_at: NOW / 1000 + 3600, max_bytes: 5242880, history_days: 7 }
    const r = await heartbeat({ fetch: mock(() => json(200, { heartbeat_seconds: 900, jitter_seconds: 120, snapshot_request: req, last_upload: { round: 'F202611092300', state: 'deleted' } })).fetch, signer, now: () => NOW }, { app_version: '0.41.0', platform: 'web' })
    expect(r).toMatchObject({ kind: 'ok', request: { code: GOOD, round: 'F202611102300', expiresAt: NOW / 1000 + 3600, maxBytes: 5242880, historyDays: 7 }, lastUpload: { round: 'F202611092300', state: 'deleted' } })
  })

  it('410 is "gone", so the caller re-registers; 429 and 5xx are errors', async () => {
    expect(await heartbeat({ fetch: mock(() => json(410, { error: 'unknown_client' })).fetch, signer, now: () => NOW }, { app_version: '0.41.0', platform: 'web' })).toEqual({ kind: 'gone' })
    await expect(heartbeat({ fetch: mock(() => json(429, { error: 'rate_limited' })).fetch, signer, now: () => NOW }, { app_version: '0.41.0', platform: 'web' })).rejects.toMatchObject({ status: 429 })
    await expect(heartbeat({ fetch: mock(() => json(503, {})).fetch, signer, now: () => NOW }, { app_version: '0.41.0', platform: 'web' })).rejects.toBeInstanceOf(FleetHttpError)
  })
})

describe('clamping hostile requests (C6)', () => {
  const base = { code: GOOD, round: 'F202611102300', expires_at: NOW / 1000 + 3600, max_bytes: 5242880, history_days: 7 }
  it('max_bytes at most 5 MB', () => {
    expect(clampRequest({ ...base, max_bytes: 1e15 }, NOW)?.maxBytes).toBe(MAX_FLEET_BYTES)
    expect(clampRequest({ ...base, max_bytes: -1 }, NOW)).toBeNull()
    expect(clampRequest({ ...base, max_bytes: 'big' }, NOW)?.maxBytes).toBe(MAX_FLEET_BYTES)
  })
  it('history_days at most 7', () => {
    expect(clampRequest({ ...base, history_days: 3650 }, NOW)?.historyDays).toBe(7)
    expect(clampRequest({ ...base, history_days: -4 }, NOW)?.historyDays).toBe(0)
    expect(clampRequest({ ...base, history_days: 2.7 }, NOW)?.historyDays).toBe(2)
  })
  it('expires_at at most now + 72 h + 5 min; past or missing drops', () => {
    expect(clampRequest({ ...base, expires_at: 9e12 }, NOW)?.expiresAt).toBe(NOW / 1000 + 72 * 3600 + 300)
    expect(clampRequest({ ...base, expires_at: NOW / 1000 - 1 }, NOW)).toBeNull()
    expect(clampRequest({ ...base, expires_at: undefined }, NOW)).toBeNull()
  })
  it('a code that fails the Luhn check, or a bad round, is refused', () => {
    const bad = GOOD.slice(0, -1) + (GOOD.endsWith('0') ? '1' : '0')
    expect(clampRequest({ ...base, code: bad }, NOW)).toBeNull()
    expect(clampRequest({ ...base, code: 'SNAP-<script>' }, NOW)).toBeNull()
    expect(clampRequest({ ...base, round: 'T1042' }, NOW)).toBeNull()
    expect(clampRequest({ ...base, round: 'F2026111023001' }, NOW)).toBeNull()
  })
  it('a heartbeat carrying a hostile request holds nothing', async () => {
    const r = await heartbeat({ fetch: mock(() => json(200, { heartbeat_seconds: 900, jitter_seconds: 120, snapshot_request: { ...base, code: 'SNAP-AAA-AAA-AAA' }, last_upload: { round: 'x', state: 'evil' } })).fetch, signer, now: () => NOW }, { app_version: '0.41.0', platform: 'web' })
    expect(r).toMatchObject({ kind: 'ok', request: null, lastUpload: null })
  })
})

describe('deregister (C4)', () => {
  it('DELETEs clients/self with an empty-body payload tag and credentials omit', async () => {
    const m = mock(() => new Response(null, { status: 204 }))
    expect(await deregister({ fetch: m.fetch, signer })).toBe(true)
    const [c] = m.calls
    expect(c.url).toBe(SELF_PATH)
    expect(c.init.method).toBe('DELETE')
    expect(c.init.credentials).toBe('omit')
    expect(c.init.body).toBeUndefined()
    const e = authEvent(c)
    expect(e.pubkey).toBe(signer.pubkey)
    expect(e.tags.find((t) => t[0] === 'payload')?.[1]).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
  it('a 410 means the server has forgotten us; a 404 (routes unmounted), 5xx or network error does not', async () => {
    expect(await deregister({ fetch: mock(() => json(410, {})).fetch, signer })).toBe(true)
    expect(await deregister({ fetch: mock(() => json(404, {})).fetch, signer })).toBe(false)
    expect(await deregister({ fetch: mock(() => json(500, {})).fetch, signer })).toBe(false)
    expect(await deregister({ fetch: (async () => { throw new TypeError('offline') }) as never, signer })).toBe(false)
  })
})
