import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Claim links phase 2 (spec 4.1, 2.3, 7): the merchant's link.
 *
 *  - `formatCashbackLink` builds `https://<wallet-origin>/c/<ref>#k=<key>`, key in the fragment only;
 *  - generate keeps `claimKey` (it used to be dropped) as `claim: { ref, key }`, in memory;
 *  - `resolveClaimLinkByCode` rebuilds the same parts from the stored code, spending nothing;
 *  - `revokeCashback` maps the portal's answers;
 *  - the key never reaches a request URL or a log line.
 */

let signed: { path: string; method: string; body: unknown }[] = []
let signedAnswer: () => Promise<Response> = async () => new Response('{}', { status: 200 })

vi.mock('../nip98', () => ({
  signedFetch: async (path: string, method: string, body: unknown) => {
    signed.push({ path, method, body })
    return signedAnswer()
  },
}))
vi.mock('../wallet', () => ({ notifyWalletChanged: () => {}, recordCashbackStatus: async () => {} }))
vi.mock('../legacyBridge', () => ({ legacyApi: async () => ({}), withCorrelation: async () => ({}) }))

const { formatCashbackLink, claimRefFromUrl, isClaimKey } = await import('../claimLink')
const { generateCashback, resolveClaimLinkByCode, revokeCashback } = await import('../cashback')
const { clearConfigCache } = await import('../config')

const ORIGIN = 'cashback.example.test'
const REF = 'abcd1234efgh5678'
const KEY = 'Ab-_' + 'x'.repeat(39)
const WALLET = 'https://wallet.example.test'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const requested: string[] = []
function stubFetch(byCode: { status: number; body?: unknown }, origins = [ORIGIN]) {
  vi.stubGlobal('fetch', async (input: string) => {
    const url = String(input)
    requested.push(url)
    if (url.startsWith('/api/v1/config')) return json(200, { default_domain: 'x.test', cashback_origins: origins })
    if (url.includes('/cashback/by-code/')) return json(byCode.status, byCode.body ?? {})
    throw new Error(`unexpected fetch: ${url}`)
  })
}

beforeEach(() => {
  signed = []
  requested.length = 0
  signedAnswer = async () => new Response('{}', { status: 200 })
  clearConfigCache()
})
afterEach(() => vi.unstubAllGlobals())

describe('formatCashbackLink', () => {
  it('puts the ref in the path and the key in the fragment, on the wallet origin', () => {
    const link = formatCashbackLink(WALLET + '/sell/cashback?x=1', REF, KEY)
    expect(link).toBe(`${WALLET}/c/${REF}#k=${KEY}`)
    const url = new URL(link!)
    expect(url.search).toBe('')
    expect(url.pathname).not.toContain(KEY)
  })

  it('round-trips through the shapes /c/:ref reads', () => {
    const url = new URL(formatCashbackLink(WALLET, REF, KEY)!)
    expect(claimRefFromUrl(url.toString())).toBe(REF)
    expect(/[#&]k=([A-Za-z0-9_-]{43})$/.exec(url.hash)?.[1]).toBe(KEY)
  })

  it('refuses a key of the wrong length, a bad ref and a non-http origin', () => {
    expect(formatCashbackLink(WALLET, REF, KEY.slice(1))).toBeNull()
    expect(formatCashbackLink(WALLET, REF, KEY + 'x')).toBeNull()
    expect(formatCashbackLink(WALLET, 'short', KEY)).toBeNull()
    expect(formatCashbackLink(WALLET, 'bad/ref/here', KEY)).toBeNull()
    expect(formatCashbackLink('javascript:alert(1)', REF, KEY)).toBeNull()
    expect(formatCashbackLink('not a url', REF, KEY)).toBeNull()
  })

  it('reads a ref only from a /c/<ref> path', () => {
    expect(claimRefFromUrl(`https://${ORIGIN}/c/${REF}`)).toBe(REF)
    expect(claimRefFromUrl(`https://${ORIGIN}/x/${REF}`)).toBeNull()
    expect(claimRefFromUrl(`https://${ORIGIN}/c/${REF}/ciphertext`)).toBeNull()
    expect(claimRefFromUrl(null)).toBeNull()
    expect(isClaimKey(KEY)).toBe(true)
    expect(isClaimKey(KEY + '=')).toBe(false)
  })
})

describe('generateCashback keeps the claim key (it used to drop it)', () => {
  const params = { amountMinor: 125, unit: 'EUR', expiryDays: 30, voucherValidityDays: 0, idempotencyKey: 'k1' }

  it('returns the ref and key when the portal sends both', async () => {
    signedAnswer = async () =>
      json(200, { cashbackId: 'cb-1', claimCode: 'CB-ABCDE-FGHJK', claimUrl: `https://${ORIGIN}/c/${REF}`, claimKey: KEY })
    const issued = await generateCashback(params)
    expect(issued.claim).toEqual({ ref: REF, key: KEY })
  })

  it('offers no link when either half is missing or malformed', async () => {
    for (const extra of [{}, { claimUrl: `https://${ORIGIN}/c/${REF}` }, { claimKey: KEY }, { claimUrl: `https://${ORIGIN}/c/${REF}`, claimKey: 'short' }]) {
      signedAnswer = async () => json(200, { cashbackId: 'cb-1', claimCode: 'CB-ABCDE-FGHJK', ...extra })
      expect((await generateCashback(params)).claim).toBeUndefined()
    }
  })
})

describe('resolveClaimLinkByCode (Show QR again)', () => {
  it('rebuilds the ref and key from the code through by-code', async () => {
    stubFetch({ status: 200, body: { claimUrl: `https://${ORIGIN}/c/${REF}#k=${KEY}` } })
    expect(await resolveClaimLinkByCode('cb-abcde-fghjk')).toEqual({ kind: 'ok', ref: REF, key: KEY })
    expect(requested.some((u) => u.endsWith('/by-code/CB-ABCDE-FGHJK'))).toBe(true)
    // Non-destructive: no ciphertext call, and the key in no request URL.
    expect(requested.some((u) => u.includes('/ciphertext'))).toBe(false)
    expect(requested.some((u) => u.includes(KEY))).toBe(false)
  })

  it('refuses a claim URL on a host this deployment does not trust', async () => {
    stubFetch({ status: 200, body: { claimUrl: `https://evil.test/c/${REF}#k=${KEY}` } })
    expect(await resolveClaimLinkByCode('CB-ABCDE-FGHJK')).toEqual({ kind: 'invalid', reason: 'untrusted_claim_url' })
  })

  it('passes a closed code through as terminal, and a malformed code never leaves the device', async () => {
    stubFetch({ status: 410, body: { code: 'claimed' } })
    expect(await resolveClaimLinkByCode('CB-ABCDE-FGHJK')).toEqual({ kind: 'terminal', code: 'claimed' })
    requested.length = 0
    expect(await resolveClaimLinkByCode('nope')).toEqual({ kind: 'not_found' })
    expect(requested).toEqual([])
  })

  it('is disabled where the deployment names no claim host', async () => {
    stubFetch({ status: 200 }, [])
    expect(await resolveClaimLinkByCode('CB-ABCDE-FGHJK')).toEqual({ kind: 'disabled' })
  })
})

describe('revokeCashback (Cancel cashback)', () => {
  it('POSTs the portal revoke for that cashback', async () => {
    expect(await revokeCashback('cb 1')).toEqual({ kind: 'revoked' })
    expect(signed).toEqual([{ path: '/api/v1/portal/cashback/cb%201/revoke', method: 'POST', body: {} }])
  })

  it('reads 409 as already closed, anything else as failed', async () => {
    signedAnswer = async () => json(409, { code: 'NOT_REVOCABLE' })
    expect(await revokeCashback('cb-1')).toEqual({ kind: 'not_revocable' })
    signedAnswer = async () => json(500, {})
    expect(await revokeCashback('cb-1')).toEqual({ kind: 'failed' })
    signedAnswer = async () => {
      throw new TypeError('offline')
    }
    expect(await revokeCashback('cb-1')).toEqual({ kind: 'failed' })
  })
})

describe('fragment hygiene on the merchant path', () => {
  it('logs nothing that carries the key', async () => {
    const lines: string[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' '))),
    )
    signedAnswer = async () =>
      json(200, { cashbackId: 'cb-1', claimCode: 'CB-ABCDE-FGHJK', claimUrl: `https://${ORIGIN}/c/${REF}`, claimKey: KEY })
    await generateCashback({ amountMinor: 1, unit: 'EUR', expiryDays: 1, voucherValidityDays: 0, idempotencyKey: 'k' })
    stubFetch({ status: 200, body: { claimUrl: `https://${ORIGIN}/c/${REF}#k=${KEY}` } })
    await resolveClaimLinkByCode('CB-ABCDE-FGHJK')
    formatCashbackLink(WALLET, REF, KEY)
    spies.forEach((s) => s.mockRestore())
    expect(lines.filter((l) => l.includes(KEY))).toEqual([])
  })
})
