import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, nip17 } from 'nostr-tools'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'

import { discharge, GIFT_MAX_ATTEMPTS, type Obligation, type Ports } from '../discharge'
import type { GiftPorts, WrapEvent } from '../giftDelivery'
import { balanceUrl, codeLockFor, depositBody, depositCode, displayCode, verifyCodePart, type DepositBody, type StoreAnswer } from '../codeGift'
import { readConfig } from '../config'
import type { GiftDelivery } from '../purchasesApi'
import { encodePlainTokenV4 } from '../../../src/lib/plainToken'
import { lockedCanonicalBytes } from '../../../src/lib/voucherToken'
import { STALL, STALL_SK, delegatedCredential, ninetyDayTerm } from './stallFixture'
import { BUILTIN_TEMPLATES } from '../../imani-mailer/builtins'
import { compile, render, resolveFields } from '../../imani-mailer/templates'

/** #410 code gifts (plan option 1(a)): minted locked to S, deposited as a code, mailed, no relay arm. */

const NOW = Date.UTC(2026, 10, 5, 12)
const DAY_S = 86_400
const ISSUER_SK = generateSecretKey()
const ISSUER_HEX = bytesToHex(ISSUER_SK)
const ISSUER = getPublicKey(ISSUER_SK)
const R_SK = generateSecretKey()
const R = getPublicKey(R_SK)
const S = getPublicKey(generateSecretKey())
/** x, pinned by payment-adapter: 20 days out, inside the 90-day coupon's window. */
const X = Math.floor(NOW / 1000) + 20 * DAY_S
const DRAFT = '11111111-2222-3333-4444-555555555555'
const CODE = 'IMANIABCD2345EFGH'

/**
 * A minted part in contract §2's shape, signed by the stall as gateway-customer signs it, so the
 * wallet's reader credits it (an unsigned locked proof credits 0).
 */
function partSecret(lock: string, refund: string, x: number, over: { drop?: string[]; extra?: string[][] } = {}): string {
  const rows: string[][] = [
    ['voucher_id', 'v1'], ['issuer', STALL], ['unit', 'EUR'], ['face_value', '2000'], ['face_decimals', '2'], ['issuance_ratio', '1'],
    ['locktime', String(x)], ['refund', `02${refund}`], ['sigflag', 'SIG_ALL'], ['n_sigs', '1'], ['max_sats', '1000'],
    ...(over.extra ?? []),
  ].filter((t) => !(over.drop ?? []).includes(t[0]))
  const nonce = bytesToHex(generateSecretKey())
  const data = `02${lock}`
  const sig = bytesToHex(schnorr.sign(sha256(lockedCanonicalBytes(data, nonce, rows)), hexToBytes(STALL_SK)))
  return JSON.stringify(['P2PK_VOUCHER', { nonce, data, tags: [...rows, ['issuer_sig', sig], ['issuer_pubkey', STALL]] }])
}
const tokenOf = (...secrets: string[]) =>
  encodePlainTokenV4('https://mint.example', 'sat', secrets.map((secret) => ({ amount: 1000, id: '00ab', secret, C: `02${'c'.repeat(64)}` })))
const honestMint = (body: Record<string, unknown>) => {
  const ll = body.link_lock as { refund_pubkey: string; locktime: number }
  return tokenOf(partSecret(String(body.recipient_pubkey), ll.refund_pubkey, ll.locktime), partSecret(String(body.recipient_pubkey), ll.refund_pubkey, ll.locktime))
}

const codeDelivery = (over: Partial<GiftDelivery> = {}): GiftDelivery => ({
  kind: 'email',
  refundPubkey: R,
  recipientEmail: 'dan@example.com',
  sealed: 'v1.sealed.never-opened',
  message: 'Enjoy',
  from: 'Ann',
  buyerEmail: 'ann@example.com',
  claimWindowDays: 30,
  buyerPubkey: null,
  draftCreatedAt: NOW,
  gift: 'code',
  shopKey: S,
  shopUrl: 'https://olive.example/shop',
  codeExpiresAt: X,
  ...over,
})

const obligation = (d: GiftDelivery = codeDelivery(), over: Partial<Obligation> = {}): Obligation => ({
  id: 'evt_1',
  paymentRequestId: '0123456789abcdef0123456789abcdef',
  stallPubkey: STALL,
  faceValue: 2000,
  faceUnit: 'EUR',
  faceDecimals: 2,
  memo: '',
  recipient: { kind: 'claim' },
  attempts: 0,
  processorReference: 'pi_3Code',
  gift: { kind: 'email', delivery: d, draftId: DRAFT },
  ...over,
})

/** The code store: replays one code per idempotency key, records every body. */
function fakeStore(answer?: (body: DepositBody, n: number) => StoreAnswer) {
  const deposits: Array<{ signer: string; body: DepositBody }> = []
  const byKey = new Map<string, string>()
  return {
    deposits,
    ports: {
      publicBaseUrl: 'https://codes.example/',
      deposit: async (signer: Uint8Array, body: DepositBody) => {
        deposits.push({ signer: getPublicKey(signer), body })
        if (answer) return answer(body, deposits.length)
        if (!byKey.has(body.idempotency_key)) byKey.set(body.idempotency_key, CODE)
        return { status: 201, body: { code: displayCode(byKey.get(body.idempotency_key)!), status: 'reserved', expires_at: body.expires_at } }
      },
    },
  }
}

function fakeGifts(over: Partial<GiftPorts> = {}, store = fakeStore()) {
  const relay: WrapEvent[] = []
  const mails: Array<Record<string, unknown>> = []
  const scrubbed: string[] = []
  const tracked: Array<Record<string, unknown>> = []
  const ports: GiftPorts = {
    sealSecretHex: ISSUER_HEX,
    walletOrigin: 'https://imani.casa',
    publishEvent: async (_s, e) => (relay.push(e), true),
    queryWraps: async () => relay,
    sendMail: async (req) => (mails.push(req as never), { ok: true, status: 202, messageId: 'm', duplicate: false, sandboxed: true }),
    scrubSeal: async (id) => (scrubbed.push(id), true),
    anchor: async () => {
      throw new Error('a code gift never needs an anchor: x is pinned')
    },
    stallName: async () => 'Olive Grove',
    track: async (input) => void tracked.push(input as never),
    codes: store.ports,
    ...over,
  }
  return { ports, relay, mails, scrubbed, tracked, store }
}

const portsWith = (gifts: GiftPorts): Ports => ({
  validityFor: ninetyDayTerm,
  credentialFor: async () => delegatedCredential(),
  tokenFor: async () => '',
  now: () => NOW,
  sleep: async () => {},
  gifts,
})

function fakeGateway(token: (body: Record<string, unknown>) => string) {
  const bodies: Array<{ url: string; body: Record<string, unknown>; key?: string }> = []
  const byKey = new Map<string, string>()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const key = (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key']
    bodies.push({ url, body, key })
    if (url.endsWith('/api/v1/wallet/vouchers')) {
      if (!byKey.has(String(key))) byKey.set(String(key), token(body))
      return new Response(JSON.stringify({ voucher_id: 'v1', issuer_id: STALL, token: byKey.get(String(key)) }), { status: 201 })
    }
    return new Response('{}', { status: 404 })
  })
  return bodies
}

afterEach(() => vi.restoreAllMocks())

describe('the code lock (plan step 1)', () => {
  const base = { shopKey: S, refundPubkey: R, depositorPubkey: ISSUER, locktime: X, nowMs: NOW, couponExpiresAtMs: NOW + 90 * DAY_S * 1000 }
  it('locks to S, refunds to R, at the pinned x', () => {
    expect(codeLockFor(base)).toEqual({ lockPubkey: S, refundPubkey: R, locktime: X })
  })
  it('refuses R = S, R = the depositor, a missing or malformed key', () => {
    expect(codeLockFor({ ...base, refundPubkey: S })).toEqual({ problem: 'refund_is_lock_key' })
    expect(codeLockFor({ ...base, refundPubkey: ISSUER })).toEqual({ problem: 'refund_is_depositor' })
    expect(codeLockFor({ ...base, refundPubkey: null })).toEqual({ problem: 'no_refund_key' })
    expect(codeLockFor({ ...base, shopKey: 'zz' })).toEqual({ problem: 'malformed_key' })
  })
  it('applies lockWindowProblem against NOW and the coupon expiry', () => {
    expect(codeLockFor({ ...base, locktime: Math.floor(NOW / 1000) + 60 })).toEqual({ problem: 'too_near' })
    expect(codeLockFor({ ...base, locktime: Math.floor(NOW / 1000) + 31 * DAY_S })).toEqual({ problem: 'too_far' })
    expect(codeLockFor({ ...base, couponExpiresAtMs: (X + 3600) * 1000 })).toEqual({ problem: 'too_close_to_expiry' })
  })
})

describe('the part shape (contract §2)', () => {
  const lock = { lockPubkey: S, refundPubkey: R, locktime: X }
  it('accepts P2PK_VOUCHER(02||S), SIG_ALL, n_sigs 1, refund R, locktime x', () => {
    expect(verifyCodePart(tokenOf(partSecret(S, R, X)), lock)).toBeNull()
  })
  it('refuses n_sigs absent, pubkeys present, another S, R or x, or no SIG_ALL', () => {
    expect(verifyCodePart(tokenOf(partSecret(S, R, X, { drop: ['n_sigs'] })), lock)).toMatch(/n_sigs 1/)
    expect(verifyCodePart(tokenOf(partSecret(S, R, X, { extra: [['pubkeys', `02${R}`]] })), lock)).not.toBeNull()
    expect(verifyCodePart(tokenOf(partSecret(R, S, X)), lock)).not.toBeNull()
    expect(verifyCodePart(tokenOf(partSecret(S, ISSUER, X)), lock)).toMatch(/refunds to another key/)
    expect(verifyCodePart(tokenOf(partSecret(S, R, X + 1)), lock)).toMatch(/another locktime/)
    expect(verifyCodePart(tokenOf(partSecret(S, R, X, { drop: ['sigflag'] })), lock)).not.toBeNull()
  })
  it('the deposit body: one part per token, amount = creditable face value, expires_at = x', () => {
    const t = tokenOf(partSecret(S, R, X), partSecret(S, R, X))
    expect(depositBody({ draftId: DRAFT, stallPubkey: STALL, lock, unit: 'EUR', tokens: [t] })).toEqual({
      idempotency_key: `${DRAFT}:code`,
      stall_pubkey: STALL,
      shop_key: S,
      unit: 'eur',
      amount: 2000,
      expires_at: X,
      parts: [{ token: t, amount: 2000 }],
    })
  })
})

describe('deposit answers', () => {
  const body = { idempotency_key: 'k' } as DepositBody
  const run = (a: StoreAnswer) => depositCode({ publicBaseUrl: '', deposit: async () => a }, ISSUER_SK, body)
  it('201 or a 200 replay is the code', async () => {
    expect(await run({ status: 201, body: { code: 'IMANI-ABCD-2345-EFGH' } })).toMatchObject({ ok: true, code: CODE })
    expect(await run({ status: 200, body: { code: CODE } })).toMatchObject({ ok: true, code: CODE })
  })
  it('409 MINT_UNAVAILABLE, 429, 5xx, unreachable and DUPLICATE_PART stay pending', async () => {
    for (const a of [{ status: 409, body: { refusal: 'MINT_UNAVAILABLE' } }, { status: 429, body: null }, { status: 503, body: null }, { status: 0, body: null }, { status: 422, body: { refusal: 'DUPLICATE_PART' } }]) {
      expect(await run(a)).toMatchObject({ ok: false, permanent: false })
    }
  })
  it('a 422 refusal is permanent', async () => {
    expect(await run({ status: 422, body: { refusal: 'WRONG_LOCK_KEY', part: 0 } })).toMatchObject({ ok: false, permanent: true })
  })
})

describe('code gift discharge', () => {
  it('mints locked to S with refund R at x, deposits as the issuer, mails the code, hands R the parts, scrubs, tracks', async () => {
    const g = fakeGifts()
    const bodies = fakeGateway(honestMint)
    const out = await discharge('http://gw', obligation(), portsWith(g.ports))
    expect(out.kind).toBe('discharged')
    const mint = bodies.find((b) => b.url.endsWith('/wallet/vouchers'))!
    expect(mint.body.recipient_pubkey).toBe(S)
    expect(mint.body.link_lock).toEqual({ refund_pubkey: R, locktime: X })
    expect(mint.key).toBe('purchase:pi:pi_3Code')
    // The deposit: as the issuer (the seal key), keyed on the draft, one part, S, x.
    expect(g.store.deposits).toHaveLength(1)
    const dep = g.store.deposits[0]
    expect(dep.signer).toBe(ISSUER)
    expect(dep.body).toMatchObject({ idempotency_key: `${DRAFT}:code`, stall_pubkey: STALL, shop_key: S, unit: 'eur', amount: 2000, expires_at: X })
    expect(dep.body.parts).toHaveLength(1)
    // The recipient's email: the code, the shop, x and the public balance link.
    expect(g.mails).toHaveLength(1)
    const mail = g.mails[0] as { template: string; to: string; idempotencyKey: string; fields: Record<string, string> }
    expect(mail.template).toBe('gift-code')
    expect(mail.to).toBe('dan@example.com')
    expect(mail.idempotencyKey).toBe(`${DRAFT}:code-mail`)
    expect(mail.fields).toMatchObject({
      from: 'Ann', stall: 'Olive Grove', shop: 'olive.example', amount: '€20.00', code: 'IMANI-ABCD-2345-EFGH',
      shopUrl: 'https://olive.example/shop', balanceUrl: `https://codes.example/v1/code-check/${CODE}`, message: 'Enjoy',
    })
    expect(mail.fields.expiresOn).toBe(new Date(X * 1000).toUTCString().slice(0, 16))
    // The fields satisfy the real template.
    const t = compile('gift-code', BUILTIN_TEMPLATES['gift-code'])
    const rendered = render(t, resolveFields(t, mail.fields, { hosts: ['olive.example', 'codes.example'], allowHttp: false }))
    expect(rendered.text).toContain('IMANI-ABCD-2345-EFGH')
    // The buyer's copy: a wrap to R only, no relay refund anywhere.
    expect(g.relay).toHaveLength(1)
    const rumor = JSON.parse(nip17.unwrapEvent(g.relay[0] as never, R_SK).content) as Record<string, unknown>
    expect(rumor).toMatchObject({ type: 'imani_gift_sent', gift: 'code', claimBy: X, stall: 'Olive Grove' })
    expect(rumor.token).toBe(dep.body.parts[0].token)
    expect(g.scrubbed).toEqual(['evt_1'])
    expect(g.tracked[0]).toMatchObject({ kind: 'code', draftId: DRAFT, claimBy: X * 1000, code: { code: CODE, amountMinor: 2000 } })
  })

  it('a crash after the deposit replays: the same mint key, the same deposit key, the same code', async () => {
    const store = fakeStore()
    let mailUp = false
    const g = fakeGifts({ sendMail: async (req) => (mailUp ? (g.mails.push(req as never), { ok: true, status: 202, messageId: 'm', duplicate: false, sandboxed: true }) : (() => { throw new Error('crash') })()) }, store)
    const bodies = fakeGateway(honestMint)
    const first = await discharge('http://gw', obligation(), portsWith(g.ports))
    expect(first).toMatchObject({ kind: 'gift_undelivered', park: false })
    mailUp = true
    const second = await discharge('http://gw', obligation(undefined, { attempts: 1 }), portsWith(g.ports))
    expect(second.kind).toBe('discharged')
    const mints = bodies.filter((b) => b.url.endsWith('/wallet/vouchers'))
    expect(mints).toHaveLength(2)
    expect(mints[0].key).toBe(mints[1].key)
    expect(JSON.stringify(mints[0].body)).toBe(JSON.stringify(mints[1].body))
    expect(store.deposits).toHaveLength(2)
    expect(store.deposits[0].body).toEqual(store.deposits[1].body)
    expect((g.mails[0] as { fields: Record<string, string> }).fields.code).toBe('IMANI-ABCD-2345-EFGH')
  })

  it('a store that is down or answers 409 MINT_UNAVAILABLE keeps it pending, no email', async () => {
    for (const a of [{ status: 503, body: null }, { status: 409, body: { refusal: 'MINT_UNAVAILABLE' } }]) {
      const g = fakeGifts({}, fakeStore(() => a))
      fakeGateway(honestMint)
      const out = await discharge('http://gw', obligation(), portsWith(g.ports))
      expect(out).toMatchObject({ kind: 'gift_undelivered', park: false })
      expect(g.mails).toHaveLength(0)
      vi.restoreAllMocks()
    }
  })

  it('a 422 refusal parks it, no email; so does the last attempt of a pending one', async () => {
    const g = fakeGifts({}, fakeStore(() => ({ status: 422, body: { refusal: 'EXPIRY_OUT_OF_WINDOW', part: 0 } })))
    fakeGateway(honestMint)
    expect(await discharge('http://gw', obligation(), portsWith(g.ports))).toMatchObject({ kind: 'gift_undelivered', park: true })
    expect(g.mails).toHaveLength(0)
    vi.restoreAllMocks()
    const h = fakeGifts({}, fakeStore(() => ({ status: 503, body: null })))
    fakeGateway(honestMint)
    expect(await discharge('http://gw', obligation(undefined, { attempts: GIFT_MAX_ATTEMPTS }), portsWith(h.ports))).toMatchObject({ kind: 'gift_undelivered', park: true })
  })

  it('a mis-locked mint is never deposited', async () => {
    const g = fakeGifts()
    fakeGateway(() => tokenOf(partSecret(S, R, X, { drop: ['n_sigs'] })))
    expect(await discharge('http://gw', obligation(), portsWith(g.ports))).toMatchObject({ kind: 'gift_undelivered', park: true })
    expect(g.store.deposits).toHaveLength(0)
  })

  it('an x outside the window, or R = S, is refused before minting', async () => {
    for (const d of [codeDelivery({ codeExpiresAt: Math.floor(NOW / 1000) + 60 }), codeDelivery({ refundPubkey: S }), codeDelivery({ refundPubkey: ISSUER })]) {
      const g = fakeGifts()
      const bodies = fakeGateway(honestMint)
      expect((await discharge('http://gw', obligation(d), portsWith(g.ports))).kind).toBe('attention')
      expect(bodies.some((b) => b.url.endsWith('/wallet/vouchers'))).toBe(false)
      vi.restoreAllMocks()
    }
  })

  it('PURCHASE_CODE_GIFTS off: parked before minting, as before', async () => {
    const g = fakeGifts({ codes: undefined })
    const bodies = fakeGateway(honestMint)
    const out = await discharge('http://gw', obligation(), portsWith(g.ports))
    expect(out).toMatchObject({ kind: 'attention' })
    expect(bodies.some((b) => b.url.endsWith('/wallet/vouchers'))).toBe(false)
  })

  it('a shop url that is not a clean https url is refused before minting', async () => {
    for (const shopUrl of ['http://olive.example', 'https://user:pw@olive.example', 'https://olive.example/a b', 'javascript:alert(1)', 'https://localhost/x', `https://olive.example/${'a'.repeat(300)}`]) {
      const g = fakeGifts()
      const bodies = fakeGateway(honestMint)
      expect((await discharge('http://gw', obligation(codeDelivery({ shopUrl })), portsWith(g.ports))).kind).toBe('attention')
      expect(bodies.some((b) => b.url.endsWith('/wallet/vouchers'))).toBe(false)
      vi.restoreAllMocks()
    }
  })

  it('the mail renders with a shop host the mailer does NOT allow-list (shopUrl is plain text)', () => {
    const t = compile('gift-code', BUILTIN_TEMPLATES['gift-code'])
    const fields = {
      stall: 'Olive', shop: 'olive.example', amount: '€15.00', code: 'IMANI-AB12-CD34-EF56', shopUrl: 'https://olive.example/shop',
      expiresOn: '4 December 2026', balanceUrl: `https://codes.example/v1/code-check/${CODE}`,
    }
    const out = render(t, resolveFields(t, fields, { hosts: ['codes.example'], allowHttp: false }))
    expect(out.text).toContain('Enter it at checkout on https://olive.example/shop')
    // The balance link is still checked against the allowlist.
    expect(() => resolveFields(t, { ...fields, balanceUrl: 'https://evil.example/x' }, { hosts: ['codes.example'], allowHttp: false }))
      .toThrow(/allowed host/)
  })

  it('the balance link', () => {
    expect(balanceUrl('https://codes.example/', CODE)).toBe(`https://codes.example/v1/code-check/${CODE}`)
  })
})

describe('config: PURCHASE_CODE_GIFTS', () => {
  const base = { PURCHASE_API_URL: 'http://pa', PURCHASE_API_TOKEN: 't', PURCHASE_GATEWAY_URL: 'http://gw', PURCHASE_VAULT_KEY: 'a'.repeat(64), PURCHASE_LIVEMODE: 'false' }
  const gifts = { ...base, PURCHASE_GIFT_SEAL_KEY: ISSUER_HEX, PURCHASE_WALLET_ORIGIN: 'https://imani.casa', PURCHASE_MAILER_URL: 'http://mailer', PURCHASE_MAILER_TOKEN: 'm', PURCHASE_GIFT_ANCHORS_PATH: '/tmp/a.json', PURCHASE_GIFT_TRACKER_PATH: '/tmp/t.json' }
  it('off by default, and when false', () => {
    expect(readConfig(gifts).gifts?.checkoutCodesUrl).toBeNull()
    expect(readConfig({ ...gifts, PURCHASE_CODE_GIFTS: 'false', PURCHASE_CHECKOUT_CODES_URL: 'https://codes.example' }).gifts?.checkoutCodesUrl).toBeNull()
  })
  it('true requires the store url; anything else refuses to boot', () => {
    expect(() => readConfig({ ...gifts, PURCHASE_CODE_GIFTS: 'true' })).toThrow(/PURCHASE_CHECKOUT_CODES_URL/)
    expect(() => readConfig({ ...gifts, PURCHASE_CODE_GIFTS: 'yes' })).toThrow(/PURCHASE_CODE_GIFTS/)
    expect(readConfig({ ...gifts, PURCHASE_CODE_GIFTS: 'true', PURCHASE_CHECKOUT_CODES_URL: 'https://codes.example/' }).gifts?.checkoutCodesUrl).toBe('https://codes.example')
  })
})
