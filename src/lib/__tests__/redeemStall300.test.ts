import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

/**
 * #300: the owner-device till stayed "Waiting for payment" after the buyer
 * paid. `_doRedeem` fetched the token metadata, then hung on an un-timed
 * await (inspectVoucher, or the receive pacer) and never reached api.receive.
 * `redeem()` keeps the hung promise in `_inFlightRedemptions`, so every later
 * poll of the same token JOINED it and hung too: the token was dropped for the
 * whole session. Pinned against the real classic script.
 */

const REDEMPTION_SOURCE = readFileSync('shared/tokenRedemption.js', 'utf8')
const TOKEN = 'cashuAeyJ0b2tlbiI6W119'
const FP = createHash('sha256').update(TOKEN).digest('hex')
const never = () => new Promise<never>(() => {})

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function load(api: Record<string, unknown>): any {
  const r = new Function(
    'api', 'walletStorageIntegration', 'localStorage', 'resolveDecimals', 'TokenSecurity',
    `${REDEMPTION_SOURCE}; return TokenRedemption;`,
  )(
    { acknowledgeReceive: async () => {}, _nostrPublicKey: 'c'.repeat(64), ...api },
    { atomicallyWrite: async () => {} },
    memoryStorage(),
    () => 2,
    { getFingerprint: async () => FP },
  )
  r._stepTimeoutMs = 50
  r._receiveGateTimeoutMs = 50
  return r
}

const ok = (id: string) => ({ receive_id: id, amount: 650, token: 'cashuAfresh', imported_count: 1, unit: 'sat' })
const settle = <T,>(p: Promise<T>, ms = 1000) =>
  Promise.race([p.then((v) => ({ v }), (e) => ({ e })), new Promise((r) => setTimeout(() => r('HUNG'), ms))])

describe('#300 a stalled redemption step never drops the token', () => {
  // The race that dropped it: inspectVoucher (opportunistic for dm-poll) never
  // answers. The redemption must give up on it and still reach api.receive.
  it('a hung inspectVoucher does not stop api.receive', async () => {
    const receive = vi.fn(async () => ok('r-1'))
    const r = load({ getTokenMetadata: async () => ({}), inspectVoucher: never, receive })
    const out = await settle(r.redeem(TOKEN, { skipDuplicateCheck: true, source: 'dm-poll' }))
    expect(out).not.toBe('HUNG')
    expect(receive).toHaveBeenCalledTimes(1)
  })

  // Same for a metadata response that never arrives (the request did go out).
  it('a hung getTokenMetadata does not stop api.receive', async () => {
    const receive = vi.fn(async () => ok('r-1'))
    const r = load({ getTokenMetadata: never, inspectVoucher: async () => ({}), receive })
    const out = await settle(r.redeem(TOKEN, { skipDuplicateCheck: true, source: 'dm-poll' }))
    expect(out).not.toBe('HUNG')
    expect(receive).toHaveBeenCalledTimes(1)
  })

  // The retry path: a receive pacer that never frees a slot. The attempt must
  // fail as a quiet, retryable RECEIVE_DEFERRED (dm-poll keeps the event and
  // retries next poll), log it, and leave no in-flight entry for the next
  // attempt to join, which then receives the token.
  it('a stuck receive gate defers, and the next attempt receives', async () => {
    const receive = vi.fn(async () => ok('r-1'))
    const r = load({ getTokenMetadata: async () => ({ face_unit: 'GBP', expires_at: 1 }), receive })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    r._receiveGate = never
    const first = await settle(r.redeem(TOKEN, { skipDuplicateCheck: true, source: 'dm-poll' }))
    expect(first).not.toBe('HUNG')
    expect((first as { e?: { code?: string } }).e?.code).toBe('RECEIVE_DEFERRED')
    expect(warn.mock.calls.some((c) => String(c[0]).includes('#300'))).toBe(true)
    expect(receive).not.toHaveBeenCalled()

    r._receiveGate = async () => {}
    const second = await settle(r.redeem(TOKEN, { skipDuplicateCheck: true, source: 'dm-poll' }))
    expect((second as { v?: unknown }).v).toBeTruthy()
    expect(receive).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  // No double-receive: once the retry saved the coupon, another delivery of the
  // same token is the idempotent "already redeemed" and never calls the gateway.
  it('a redelivery after the retry saved it does not receive again', async () => {
    const receive = vi.fn(async () => ok('r-1'))
    const r = load({ getTokenMetadata: async () => ({ face_unit: 'GBP', expires_at: 1 }), receive })
    r._receiveGate = never
    await settle(r.redeem(TOKEN, { skipDuplicateCheck: true, source: 'dm-poll' }))
    r._receiveGate = async () => {}
    await r.redeem(TOKEN, { skipDuplicateCheck: true, source: 'dm-poll' })
    r._localClaim.clear?.(FP)
    await settle(r._doRedeem(TOKEN, { fingerprint: FP, skipDuplicateCheck: true, source: 'dm-poll' }))
    expect(receive).toHaveBeenCalledTimes(1)
  })
})
