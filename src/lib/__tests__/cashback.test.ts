import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  canonicaliseTypedClaimCode,
  normaliseTypedClaimCode,
  toCanonicalClaimCode,
  redeemCashbackCode,
  replayPendingCashback,
  pendingCashbackCount,
} from '../cashback'
import { clearConfigCache } from '../config'
import { resetGate } from './trustedMintKit'
import { buildPlainToken } from './voucherFixtures'

/**
 * The legacy redemption coordinator, which is where the money actually moves.
 * Recording every call is how the tests below prove the destructive claim and
 * the mint swap happen in the right order — and only once.
 */
const redeemed: string[] = []
let redeemFails = false

vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({}),
  withCorrelation: async (_ids: unknown, run: (id: string) => unknown) => run('corr-test'),
}))
vi.mock('../wallet', () => ({
  notifyWalletChanged: () => {},
  recordCashbackStatus: async () => {},
}))
vi.mock('../nip98', () => ({
  signedFetch: async () => new Response('{}', { status: 200 }),
}))

const ORIGIN = 'cashback.example.test'
/**
 * The mint the portal stamps into cashback tokens, served as `token_mint_urls`.
 * The commit is gated on it (#133 review), so every token below is a real plain
 * token at this mint rather than an opaque string the gate could not read.
 */
const CASHBACK_MINT = 'https://mint.staging.398ja.xyz'
const REAL_TOKEN = buildPlainToken(CASHBACK_MINT, 'sat', [8, 2])
const CURRENT_TOKEN = buildPlainToken(CASHBACK_MINT, 'sat', [16])
const STRANDED_TOKEN = buildPlainToken(CASHBACK_MINT, 'sat', [32])
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
  resetGate()
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
  resetGate()
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
      return json(
        200,
        routes.config ?? { default_domain: 'x.test', cashback_origins: [ORIGIN], token_mint_urls: [CASHBACK_MINT] },
      )
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
    expect(normaliseTypedClaimCode('A1B2C3D4E5F')).toBeNull()
    expect(normaliseTypedClaimCode('')).toBeNull()
  })

  it('only strips CB when it is the prefix of a full-length entry', () => {
    // `CB` can also be the first two characters of a code of either length.
    // Stripping it from a bare code would silently redeem someone else's coupon.
    expect(normaliseTypedClaimCode('CB12ZZ')).toBe('CB12ZZ')
    expect(toCanonicalClaimCode('CB12ZZ')).toBe('CB-CB12-ZZ')
  })

  it('accepts the ten-character codes the portal issues today, in every shape', () => {
    // Since gateway-portal 0.4.0 (GP-02) a code is ten random characters, CB-XXXXX-XXXXX.
    // The wallet only knew the old six, so the Redeem button stayed disabled for every
    // code a shop could hand out.
    for (const typed of ['CB-AEQTJ-MYJHY', 'cb-aeqtj-myjhy', 'CBAEQTJMYJHY', 'aeqtjmyjhy', ' CB AEQTJ MYJHY ']) {
      expect(canonicaliseTypedClaimCode(typed)).toBe('CB-AEQTJ-MYJHY')
    }
  })

  it('keeps CB as code characters in a bare ten-character entry', () => {
    // A current code can itself start with C and B. Only a twelve-character entry
    // carries the prefix.
    expect(canonicaliseTypedClaimCode('CBQTJMYJHY')).toBe('CB-CBQTJ-MYJHY')
  })

  it('refuses lengths between and beyond the two code shapes', () => {
    // Seven to nine characters is a half-typed current code, not a legacy one.
    for (const typed of ['A1B2C3D', 'A1B2C3D4', 'A1B2C3D4E', 'A1B2C3D4E5F']) {
      expect(canonicaliseTypedClaimCode(typed)).toBeNull()
    }
  })
})

describe('redeeming a code', () => {
  it('claims, decrypts, and banks the token', async () => {
    const seal = await sealed(REAL_TOKEN)
    const calls = stubFetch({
      byCode: {
        status: 200,
        body: { claimUrl: `https://${ORIGIN}/c/${CLAIM_REF}#k=${seal.key}` },
      },
      ciphertext: { status: 200, body: { ciphertext: seal.ciphertext, iv: seal.iv } },
    })

    const result = await redeemCashbackCode('CB-A1B2-C3')

    expect(result).toEqual({ kind: 'ok', amountMinor: 500, unit: 'EUR', memo: 'thanks' })
    expect(redeemed).toEqual([REAL_TOKEN])
    // The read-only metadata must be fetched BEFORE the destructive claim, or a
    // success screen for a coupon that committed offline has no amount to show.
    expect(calls.findIndex((c) => c.includes('/public/'))).toBeLessThan(
      calls.findIndex((c) => c.includes('/ciphertext')),
    )
    // Banked, so nothing is left queued for replay.
    expect(store.get('imani:cashback:pending') ?? null).toBeNull()
  })

  it('looks up a current ten-character code, not just a legacy one', async () => {
    // Every code the portal has issued since GP-02 has this shape. Refusing it here
    // would answer "not found" without ever asking the gateway.
    const seal = await sealed(CURRENT_TOKEN)
    const calls = stubFetch({
      byCode: {
        status: 200,
        body: { claimUrl: `https://${ORIGIN}/c/${CLAIM_REF}#k=${seal.key}` },
      },
      ciphertext: { status: 200, body: { ciphertext: seal.ciphertext, iv: seal.iv } },
    })

    const result = await redeemCashbackCode('CB-AEQTJ-MYJHY')

    expect(result).toMatchObject({ kind: 'ok' })
    expect(calls.some((c) => c.includes('/by-code/CB-AEQTJ-MYJHY'))).toBe(true)
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
    const seal = await sealed(STRANDED_TOKEN)
    stubFetch({
      byCode: {
        status: 200,
        body: { claimUrl: `https://${ORIGIN}/c/${CLAIM_REF}#k=${seal.key}` },
      },
      ciphertext: { status: 200, body: { ciphertext: seal.ciphertext, iv: seal.iv } },
    })
    redeemFails = true

    expect(await redeemCashbackCode('CB-A1B2-C3')).toMatchObject({ kind: 'unreachable' })
    expect(pendingCashbackCount()).toBe(1)

    // ...and the next visit to the screen recovers it.
    redeemFails = false
    expect(await replayPendingCashback()).toBe(true)
    expect(redeemed).toEqual([STRANDED_TOKEN])
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

/**
 * #133 review, MEDIUM-1: the cashback commit swapped and credited with no
 * backing check. These run the real trusted-mint gate, fed by the same
 * `/api/v1/config` stub the redemption uses.
 */
describe('the cashback commit is gated on where the value is', () => {
  const MINT = 'https://mint.staging.398ja.xyz'
  const trustedConfig = { default_domain: 'x.test', cashback_origins: [ORIGIN], token_mint_urls: [MINT] }

  async function claimable(token: string) {
    const seal = await sealed(token)
    stubFetch({
      config: trustedConfig,
      byCode: { status: 200, body: { claimUrl: `https://${ORIGIN}/c/${CLAIM_REF}#k=${seal.key}` } },
      ciphertext: { status: 200, body: { ciphertext: seal.ciphertext, iv: seal.iv } },
    })
  }


  /** The control: a cashback token at the trusted mint is banked as before. */
  it('banks a cashback token whose proofs are at the trusted mint', async () => {
    const token = buildPlainToken(MINT)
    await claimable(token)

    expect(await redeemCashbackCode('CB-A1B2-C3')).toMatchObject({ kind: 'ok' })
    expect(redeemed).toEqual([token])
  })

  /**
   * A token at a mint the wallet does not trust is NOT swapped. The claim is
   * already spent, so the token is kept in the stash and the customer is told it
   * is waiting to be verified, rather than losing it or banking rogue proofs.
   */
  it('does not swap a cashback token at an untrusted mint, and keeps it', async () => {
    const token = buildPlainToken('https://rogue-mint.example.test')
    await claimable(token)

    expect(await redeemCashbackCode('CB-A1B2-C3')).toEqual({ kind: 'held', reason: 'untrusted-mint' })
    expect(redeemed).toEqual([])
    expect(pendingCashbackCount()).toBe(1)
  })

  /** The replay path is gated too: a stashed rogue token is never swapped on a later visit. */
  it('does not swap a stashed token at an untrusted mint on replay', async () => {
    const token = buildPlainToken('https://rogue-mint.example.test')
    store.set('imani:cashback:pending', token)
    stubFetch({ config: trustedConfig })

    expect(await replayPendingCashback()).toBe(false)
    expect(redeemed).toEqual([])
    expect(pendingCashbackCount()).toBe(1)
  })

  /**
   * When no trusted mint is known at all the token is held as well, and banked
   * by a later visit once the gateway names the mint.
   */
  it('holds while no mint is known, and banks on a later visit once one is', async () => {
    const token = buildPlainToken(MINT)
    stubFetch({ config: { default_domain: 'x.test', cashback_origins: [ORIGIN] }, ...(await claimRoute(token)) })

    expect(await redeemCashbackCode('CB-A1B2-C3')).toEqual({ kind: 'held', reason: 'no-trusted-mint' })
    expect(redeemed).toEqual([])

    resetGate()
    stubFetch({ config: trustedConfig })
    expect(await replayPendingCashback()).toBe(true)
    expect(redeemed).toEqual([token])
    expect(pendingCashbackCount()).toBe(0)
  })

  /**
   * Two claims held one after the other are both kept. The stash used to be one
   * slot, so a second claim would have overwritten, and lost, the first.
   */
  it('keeps every held claim, not just the last', async () => {
    const first = buildPlainToken('https://rogue-mint.example.test', 'sat', [4])
    const second = buildPlainToken('https://rogue-mint.example.test', 'sat', [16])
    await claimable(first)
    await redeemCashbackCode('CB-A1B2-C3')
    resetGate()
    await claimable(second)
    await redeemCashbackCode('CB-A1B2-C3')

    expect(pendingCashbackCount()).toBe(2)
  })

  async function claimRoute(token: string) {
    const seal = await sealed(token)
    return {
      byCode: { status: 200, body: { claimUrl: `https://${ORIGIN}/c/${CLAIM_REF}#k=${seal.key}` } },
      ciphertext: { status: 200, body: { ciphertext: seal.ciphertext, iv: seal.iv } },
    }
  }
})
