import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  canonicaliseTypedClaimCode,
  normaliseTypedClaimCode,
  toCanonicalClaimCode,
  redeemCashbackCode,
  replayPendingCashback,
} from '../cashback'
import { clearConfigCache } from '../config'

/**
 * The legacy redemption coordinator, which is where the money actually moves.
 * Recording every call is how the tests below prove the destructive claim and
 * the mint swap happen in the right order — and only once.
 */
const redeemed: string[] = []
let redeemFails = false

vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({}),
}))
vi.mock('../wallet', () => ({
  notifyWalletChanged: () => {},
}))
vi.mock('../nip98', () => ({
  signedFetch: async () => new Response('{}', { status: 200 }),
}))

const ORIGIN = 'cashback.example.test'
const CLAIM_REF = 'abcd1234efgh5678'
/** 43 base64url characters — the 32-byte AES-256 key the claim URL carries. */
const KEY = 'A'.repeat(43)

/**
 * The suite runs on the node environment — no jsdom is installed, and pulling
 * one in for two globals is a dependency this does not need. `Response`,
 * `fetch`, `crypto.subtle` and `atob` are all native in Node 18+; only these
 * two browser objects have to be stood up.
 */
const store = new Map<string, string>()
const fakeLocalStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
}

beforeEach(() => {
  redeemed.length = 0
  redeemFails = false
  clearConfigCache()
  store.clear()
  vi.stubGlobal('localStorage', fakeLocalStorage)
  vi.stubGlobal('window', {
    TokenRedemption: {
      async redeem(token: string) {
        if (redeemFails) throw new Error('mint unreachable')
        redeemed.push(token)
        return {}
      },
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * A real AES-256-GCM envelope, encrypted with the same key the URL fragment
 * names. Encrypting for real rather than stubbing `crypto.subtle` is the point:
 * a wrong key length or a botched base64url decode has to fail here.
 */
async function sealed(token: string): Promise<{ ciphertext: string; iv: string; key: string }> {
  const keyBytes = new Uint8Array(32).fill(0)
  const iv = new Uint8Array(12).fill(7)
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
    'encrypt',
  ])
  const buf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(token),
  )
  return {
    ciphertext: b64url(new Uint8Array(buf)),
    iv: b64url(iv),
    key: b64url(keyBytes),
  }
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Wire up the three endpoints a redemption touches, each independently. */
function stubFetch(routes: {
  config?: unknown
  byCode?: { status: number; body?: unknown }
  ciphertext?: { status: number; body?: unknown }
  meta?: unknown
}) {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: string) => {
    const url = String(input)
    calls.push(url)

    if (url.startsWith('/api/v1/config')) {
      return json(200, routes.config ?? { default_domain: 'x.test', cashback_origins: [ORIGIN] })
    }
    if (url.includes('/cashback/by-code/')) {
      const r = routes.byCode ?? { status: 404 }
      return json(r.status, r.body ?? {})
    }
    if (url.includes('/cashback/public/')) {
      return json(200, routes.meta ?? { amountMinor: 500, unit: 'EUR', memo: 'thanks' })
    }
    if (url.includes('/ciphertext')) {
      const r = routes.ciphertext ?? { status: 404 }
      return json(r.status, r.body ?? {})
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  return calls
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('typed claim codes', () => {
  it('accepts every shape a code gets written down in', () => {
    // All of these came off the same receipt. The customer is typing from paper
    // on a phone keyboard minutes after installing, so none of them may fail.
    for (const typed of ['CB-A1B2-C3', 'cb-a1b2-c3', 'CBA1B2C3', 'a1b2c3', ' CB A1B2 C3 ']) {
      expect(canonicaliseTypedClaimCode(typed)).toBe('CB-A1B2-C3')
    }
  })

  it('refuses what is not a code rather than guessing', () => {
    // Five characters is not "nearly right" — sending it would spend one of a
    // rate limit the customer shares with everyone behind their IP.
    expect(normaliseTypedClaimCode('A1B2C')).toBeNull()
    expect(normaliseTypedClaimCode('A1B2C3D4E5')).toBeNull()
    expect(normaliseTypedClaimCode('')).toBeNull()
  })

  it('only strips CB when it is the prefix of a full-length entry', () => {
    // `CB` is also two legitimate characters of a six-character code. Stripping
    // it from a bare six would silently redeem someone else's coupon.
    expect(normaliseTypedClaimCode('CB12ZZ')).toBe('CB12ZZ')
    expect(toCanonicalClaimCode('CB12ZZ')).toBe('CB-CB12-ZZ')
  })
})

describe('redeeming a code', () => {
  it('claims, decrypts, and banks the token', async () => {
    const seal = await sealed('cashuBrealtoken')
    const calls = stubFetch({
      byCode: {
        status: 200,
        body: { claimUrl: `https://${ORIGIN}/c/${CLAIM_REF}#k=${seal.key}` },
      },
      ciphertext: { status: 200, body: { ciphertext: seal.ciphertext, iv: seal.iv } },
    })

    const result = await redeemCashbackCode('CB-A1B2-C3')

    expect(result).toEqual({ kind: 'ok', amountMinor: 500, unit: 'EUR', memo: 'thanks' })
    expect(redeemed).toEqual(['cashuBrealtoken'])
    // The read-only metadata must be fetched BEFORE the destructive claim, or a
    // success screen for a coupon that committed offline has no amount to show.
    expect(calls.findIndex((c) => c.includes('/public/'))).toBeLessThan(
      calls.findIndex((c) => c.includes('/ciphertext')),
    )
    // Banked, so nothing is left queued for replay.
    expect(store.get('imani:cashback:pending') ?? null).toBeNull()
  })

  it('never fetches a claim URL on a host the gateway did not vouch for', async () => {
    // The lookup is public and unauthenticated, so its answer is not evidence.
    // A URL pointing anywhere else is where a claim key would be exfiltrated.
    const calls = stubFetch({
      byCode: {
        status: 200,
        body: { claimUrl: `https://evil.example.test/c/${CLAIM_REF}#k=${KEY}` },
      },
    })

    expect(await redeemCashbackCode('CB-A1B2-C3')).toEqual({
      kind: 'invalid',
      reason: 'untrusted_claim_url',
    })
    expect(calls.some((c) => c.includes('evil.example.test'))).toBe(false)
  })

  it('refuses a claim URL that carries no key', async () => {
    // Without the fragment there is nothing to decrypt with, so following it
    // would burn the single-use claim for a token we could never open.
    const calls = stubFetch({
      byCode: { status: 200, body: { claimUrl: `https://${ORIGIN}/c/${CLAIM_REF}` } },
    })

    expect(await redeemCashbackCode('CB-A1B2-C3')).toMatchObject({ kind: 'invalid' })
    expect(calls.some((c) => c.includes('/ciphertext'))).toBe(false)
  })

  it('keeps the token for replay when the mint swap fails', async () => {
    // This is the money case. The claim is already spent by the time the swap
    // runs, so dropping the token here loses the coupon permanently — the
    // holding store answers 410 for the rest of time.
    const seal = await sealed('cashuBstranded')
    stubFetch({
      byCode: {
        status: 200,
        body: { claimUrl: `https://${ORIGIN}/c/${CLAIM_REF}#k=${seal.key}` },
      },
      ciphertext: { status: 200, body: { ciphertext: seal.ciphertext, iv: seal.iv } },
    })
    redeemFails = true

    expect(await redeemCashbackCode('CB-A1B2-C3')).toMatchObject({ kind: 'unreachable' })
    expect(store.get('imani:cashback:pending') ?? null).toBe('cashuBstranded')

    // ...and the next visit to the screen recovers it.
    redeemFails = false
    expect(await replayPendingCashback()).toBe(true)
    expect(redeemed).toEqual(['cashuBstranded'])
    expect(store.get('imani:cashback:pending') ?? null).toBeNull()
  })

  it('tells the three terminal reasons apart', async () => {
    for (const code of ['claimed', 'expired', 'revoked'] as const) {
      clearConfigCache()
      stubFetch({ byCode: { status: 410, body: { code } } })
      expect(await redeemCashbackCode('CB-A1B2-C3')).toEqual({ kind: 'terminal', code })
    }
  })

  it('surfaces the wait when the gateway names one', async () => {
    stubFetch({ byCode: { status: 429, body: { retryAfterSeconds: 30 } } })

    expect(await redeemCashbackCode('CB-A1B2-C3')).toEqual({
      kind: 'throttled',
      retryAfterSeconds: 30,
    })
  })

  it('reports a 404 plainly, since throttling hides behind it', async () => {
    stubFetch({ byCode: { status: 404 } })
    expect(await redeemCashbackCode('CB-A1B2-C3')).toEqual({ kind: 'not_found' })
  })

  it('stays off entirely when the deployment lists no trusted origin', async () => {
    // Empty is the gateway's default and means "cashback is not configured
    // here". Proceeding would mean trusting whatever host the lookup named.
    const calls = stubFetch({ config: { default_domain: 'x.test', cashback_origins: [] } })

    expect(await redeemCashbackCode('CB-A1B2-C3')).toEqual({ kind: 'disabled' })
    expect(calls.some((c) => c.includes('by-code'))).toBe(false)
  })

  it('does not spend a lookup on a code that was never valid', async () => {
    const calls = stubFetch({})
    expect(await redeemCashbackCode('nonsense')).toEqual({ kind: 'not_found' })
    expect(calls.some((c) => c.includes('by-code'))).toBe(false)
  })
})
