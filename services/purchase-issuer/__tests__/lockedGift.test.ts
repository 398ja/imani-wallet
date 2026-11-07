import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, nip17 } from 'nostr-tools'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import { discharge, GIFT_MAX_ATTEMPTS, type Obligation, type Ports } from '../discharge'
import { formatGiftLink, giftLockFor, verifyLockedGift, wrapForLink, DAY_MS } from '../giftLock'
import type { GiftPorts, WrapEvent } from '../giftDelivery'
import { issueBody } from '../issuer'
import { saleRecordJson } from '../saleRecord'
import { readConfig, ConfigError } from '../config'
import type { GiftDelivery } from '../purchasesApi'
import { encodePlainTokenV4 } from '../../../src/lib/plainToken'
import { seal } from '../../../apps/gifting/src/lib/gift'
import { STALL, delegatedCredential, ninetyDayTerm } from './stallFixture'

/** #410 G14: handle and email gifts, minted locked, verified, delivered, handed to the buyer. */

const NOW = Date.UTC(2026, 9, 29, 12)
const ISSUER_SK = generateSecretKey()
const ISSUER_HEX = bytesToHex(ISSUER_SK)
const BUYER_SK = generateSecretKey()
const BUYER = getPublicKey(BUYER_SK)
const BOB_SK = generateSecretKey()
const BOB = getPublicKey(BOB_SK)
const ELL = bytesToHex(generateSecretKey())
const L = getPublicKey(hexToBytes(ELL))
/** `src/lib/giftLink.ts` formatGiftLink's format, written out (that module is browser-only). */
const walletFormatGiftLink = (origin: string, s: Uint8Array, x: number) =>
  `${new URL(origin).origin}/g#v=1&k=${Buffer.from(s).toString('base64url')}&x=${x}`
// G17: 90-day voucher (ninetyDayTerm), so the 14-day cap is what binds.
const X = Math.floor((NOW + 14 * DAY_MS) / 1000)

/** A P2PK_VOUCHER secret in the minted-locked shape (contract §1). */
function lockedSecret(lock: string, refund: string, x: number, extra: string[][] = []): string {
  return JSON.stringify([
    'P2PK_VOUCHER',
    {
      nonce: bytesToHex(generateSecretKey()),
      data: `02${lock}`,
      tags: [['issuer', STALL], ['locktime', String(x)], ['refund', `02${refund}`], ['sigflag', 'SIG_ALL'], ['n_sigs', '1'], ['max_sats', '1000'], ...extra],
    },
  ])
}
const tokenOf = (...secrets: string[]) =>
  encodePlainTokenV4('https://mint.example', 'sat', secrets.map((secret) => ({ amount: 1000, id: '00ab', secret, C: `02${'c'.repeat(64)}` })))

const delivery = (over: Partial<GiftDelivery> = {}): GiftDelivery => ({
  kind: 'handle',
  refundPubkey: BUYER,
  recipientEmail: null,
  sealed: null,
  message: 'Happy birthday',
  from: 'Ann',
  buyerEmail: null,
  claimWindowDays: 30,
  ...over,
})

const emailDelivery = () =>
  delivery({
    kind: 'email',
    recipientEmail: 'bob@example.com',
    sealed: seal(getPublicKey(ISSUER_SK), { stallPubkey: STALL, amountMinor: 2000, recipient: 'bob@example.com' }, { linkSecret: ELL }),
  })

const obligation = (kind: 'handle' | 'email', d: GiftDelivery, over: Partial<Obligation> = {}): Obligation => ({
  id: 'evt_1',
  paymentRequestId: '0123456789abcdef0123456789abcdef',
  stallPubkey: STALL,
  faceValue: 2000,
  faceUnit: 'EUR',
  faceDecimals: 2,
  memo: '',
  recipient: kind === 'handle' ? { kind: 'pubkey', pubkey: BOB } : { kind: 'claim' },
  attempts: 0,
  processorReference: 'pi_3Test',
  gift: { kind, delivery: d, draftId: '11111111-2222-3333-4444-555555555555' },
  ...over,
})

/** A relay that stores what it is given, a mailer that records, a scrub that records. */
function fakeGifts(over: Partial<GiftPorts> = {}) {
  const relay: WrapEvent[] = []
  const mails: Array<Record<string, unknown>> = []
  const scrubbed: string[] = []
  const anchors = new Map<string, number>()
  const ports: GiftPorts = {
    sealSecretHex: ISSUER_HEX,
    walletOrigin: 'https://imani.casa',
    publishEvent: async (_signer, e) => {
      relay.push(e)
      return true
    },
    queryWraps: async (reader) => relay.filter((e) => e.tags.some((t) => t[0] === 'p' && t[1] === getPublicKey(reader))),
    sendMail: async (req) => {
      mails.push(req as never)
      return { ok: true, status: 202, messageId: 'm1', duplicate: mails.length > 1, sandboxed: true }
    },
    scrubSeal: async (id) => {
      scrubbed.push(id)
      return true
    },
    anchor: async (id, now) => {
      if (!anchors.has(id)) anchors.set(id, now)
      return anchors.get(id)!
    },
    stallName: async () => 'Alice Bakery',
    ...over,
  }
  return { ports, relay, mails, scrubbed, anchors }
}

const portsWith = (gifts: GiftPorts | undefined): Ports => ({
  validityFor: ninetyDayTerm,
  credentialFor: async () => delegatedCredential(),
  tokenFor: async () => '',
  now: () => NOW,
  sleep: async () => {},
  ...(gifts ? { gifts } : {}),
})

/** A gateway: mint answers with `token`, the DM route answers recorded. Records every body. */
function fakeGateway(token: (body: Record<string, unknown>) => string) {
  const bodies: Array<{ url: string; body: Record<string, unknown> }> = []
  // gc answers a replayed idempotency key with the ORIGINAL token.
  const byKey = new Map<string, string>()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    bodies.push({ url, body })
    if (url.endsWith('/api/v1/wallet/vouchers')) {
      const key = String((init?.headers as Record<string, string>)['Idempotency-Key'] ?? Math.random())
      if (!byKey.has(key)) byKey.set(key, token(body))
      return new Response(JSON.stringify({ voucher_id: 'v1', issuer_id: STALL, token: byKey.get(key) }), { status: 201 })
    }
    if (url.endsWith('/api/v1/dm/tokens/send')) {
      return new Response(JSON.stringify({ event_id: 'e1', fulfilment_recorded: true }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  })
  return bodies
}

/** The token the gateway would mint for the request's own lock. */
const honestMint = (body: Record<string, unknown>) => {
  const ll = body.link_lock as { refund_pubkey: string; locktime: number }
  return tokenOf(lockedSecret(String(body.recipient_pubkey), ll.refund_pubkey, ll.locktime), lockedSecret(String(body.recipient_pubkey), ll.refund_pubkey, ll.locktime))
}

const rumorsTo = (relay: WrapEvent[], sk: Uint8Array) =>
  relay
    .filter((e) => e.tags.some((t) => t[0] === 'p' && t[1] === getPublicKey(sk)))
    .map((e) => JSON.parse(nip17.unwrapEvent(e as never, sk).content) as Record<string, unknown>)

afterEach(() => vi.restoreAllMocks())

describe('the issuance request carries the link lock (contract §1)', () => {
  it('recipient_pubkey and link_lock, only when asked', () => {
    const plan = { faceValue: 1, faceUnit: 'EUR', faceDecimals: 2, memo: '', expiresInDays: 90 }
    expect(JSON.parse(issueBody(plan))).not.toHaveProperty('link_lock')
    const body = JSON.parse(issueBody({ ...plan, linkLock: { recipientPubkey: BOB, refundPubkey: BUYER, locktime: X } }))
    expect(body.recipient_pubkey).toBe(BOB)
    expect(body.link_lock).toEqual({ refund_pubkey: BUYER, locktime: X })
  })
})

describe('handle gift', () => {
  it('mints locked to the pinned key, verifies, DMs it, hands the buyer their copy, discharges', async () => {
    const g = fakeGifts()
    const bodies = fakeGateway(honestMint)
    const out = await discharge('http://gw', obligation('handle', delivery()), portsWith(g.ports))
    expect(out.kind).toBe('discharged')
    const mint = bodies.find((b) => b.url.endsWith('/wallet/vouchers'))!.body
    expect(mint.recipient_pubkey).toBe(BOB)
    expect(mint.link_lock).toEqual({ refund_pubkey: BUYER, locktime: X })
    expect(bodies.some((b) => b.url.endsWith('/dm/tokens/send') && b.body.recipient_pubkey === BOB)).toBe(true)
    const [rumor] = rumorsTo(g.relay, BUYER_SK)
    expect(rumor).toMatchObject({ type: 'imani_gift_sent', v: 1, stall: 'Alice Bakery', claimBy: X })
    expect(typeof rumor.token).toBe('string')
    expect(g.mails).toHaveLength(0)
  })

  it('the stall’s sale record names no recipient (G9)', async () => {
    fakeGateway(honestMint)
    const sales: Array<Record<string, unknown>> = []
    const fileSale = async (_c: unknown, sale: Record<string, unknown>) => {
      sales.push(sale)
      return true
    }
    const gift = await discharge('http://gw', obligation('handle', delivery()), { ...portsWith(fakeGifts().ports), fileSale: fileSale as never })
    expect(gift.kind).toBe('discharged')
    expect(sales).toHaveLength(1)
    expect(sales[0].recipientPubkey).toBeUndefined()
    expect(saleRecordJson(sales[0] as never, 'cred')).not.toContain(BOB)
  })

  it('a mis-locked token is never delivered and is parked', async () => {
    const g = fakeGifts()
    const bodies = fakeGateway(() => tokenOf(lockedSecret(BOB, BUYER, X), lockedSecret(BOB, getPublicKey(generateSecretKey()), X)))
    const out = await discharge('http://gw', obligation('handle', delivery()), portsWith(g.ports))
    expect(out).toMatchObject({ kind: 'gift_undelivered', park: true })
    expect(bodies.some((b) => b.url.endsWith('/dm/tokens/send'))).toBe(false)
    expect(g.relay).toHaveLength(0)
  })

  it('a plain (unlocked) token is never delivered', async () => {
    const g = fakeGifts()
    fakeGateway(() => tokenOf(JSON.stringify(['P2PK_VOUCHER', { nonce: 'aa', data: `02${BOB}`, tags: [] }])))
    const out = await discharge('http://gw', obligation('handle', delivery()), portsWith(g.ports))
    expect(out).toMatchObject({ kind: 'gift_undelivered', park: true })
    expect(g.relay).toHaveLength(0)
  })

  it('a buyer copy that is not stored keeps the debt open, retried (not parked)', async () => {
    const g = fakeGifts({ publishEvent: async () => false })
    fakeGateway(honestMint)
    const out = await discharge('http://gw', obligation('handle', delivery()), portsWith(g.ports))
    expect(out).toMatchObject({ kind: 'gift_undelivered', park: false })
  })

  it('parks after GIFT_MAX_ATTEMPTS failed passes', async () => {
    const g = fakeGifts({ publishEvent: async () => false })
    fakeGateway(honestMint)
    const out = await discharge('http://gw', obligation('handle', delivery(), { attempts: GIFT_MAX_ATTEMPTS }), portsWith(g.ports))
    expect(out).toMatchObject({ kind: 'gift_undelivered', park: true })
  })
})

describe('email gift', () => {
  it('mints locked to L, publishes and confirms the wrap, mails the claim link, hands the buyer the token, scrubs', async () => {
    const g = fakeGifts()
    const bodies = fakeGateway(honestMint)
    const out = await discharge('http://gw', obligation('email', emailDelivery()), portsWith(g.ports))
    expect(out.kind).toBe('discharged')
    const mint = bodies.find((b) => b.url.endsWith('/wallet/vouchers'))!.body
    expect(mint.recipient_pubkey).toBe(L)
    expect(mint.link_lock).toEqual({ refund_pubkey: BUYER, locktime: X })
    // The wrap /g reads: to L, by L, carrying the token.
    const [toLink] = rumorsTo(g.relay, hexToBytes(ELL))
    expect(toLink.type).toBe('cashu_token_transfer')
    expect(verifyLockedGift(String(toLink.token), { lockPubkey: L, refundPubkey: BUYER, locktime: X })).toBeNull()
    expect(g.mails).toHaveLength(1)
    const mail = g.mails[0] as { template: string; to: string; idempotencyKey: string; fields: Record<string, string> }
    expect(mail.template).toBe('gift-claim')
    expect(mail.to).toBe('bob@example.com')
    expect(mail.idempotencyKey).toBe('11111111-2222-3333-4444-555555555555:claim')
    expect(mail.fields.claimUrl).toBe(walletFormatGiftLink('https://imani.casa', hexToBytes(ELL), X))
    expect(Object.keys(mail.fields).sort()).toEqual(['amount', 'claimBy', 'claimUrl', 'from', 'message', 'stall'])
    expect(rumorsTo(g.relay, BUYER_SK)[0]).toMatchObject({ type: 'imani_gift_sent', to: 'bob@example.com', claimBy: X })
    expect(g.scrubbed).toEqual(['evt_1'])
  })

  it('a retry publishes no second wrap, reuses the mail key, and asks for the same lock', async () => {
    const g = fakeGifts()
    let n = 0
    const bodies = fakeGateway(honestMint)
    const ports = portsWith(g.ports)
    const first = { ...ports, now: () => NOW }
    // First pass fails at the mailer (retryable); second pass, a day later, succeeds.
    const flaky: GiftPorts = {
      ...g.ports,
      sendMail: async (req) => (n++ === 0 ? { ok: false, status: 503, error: 'transport_unavailable' as never, message: 'down', retryable: true } : g.ports.sendMail(req)),
    }
    const a = await discharge('http://gw', obligation('email', emailDelivery()), { ...first, gifts: flaky })
    expect(a).toMatchObject({ kind: 'gift_undelivered', park: false })
    expect(g.scrubbed).toHaveLength(0)
    const b = await discharge('http://gw', obligation('email', emailDelivery(), { attempts: 1 }), { ...first, now: () => NOW + DAY_MS, gifts: flaky })
    expect(b.kind).toBe('discharged')
    const mints = bodies.filter((x) => x.url.endsWith('/wallet/vouchers'))
    expect(mints).toHaveLength(2)
    expect(mints[1].body).toEqual(mints[0].body)
    expect(rumorsTo(g.relay, hexToBytes(ELL))).toHaveLength(1)
  })

  it('a wrap the relay does not give back is not confirmed: no email', async () => {
    const g = fakeGifts({ queryWraps: async () => [] })
    fakeGateway(honestMint)
    const out = await discharge('http://gw', obligation('email', emailDelivery()), portsWith(g.ports))
    expect(out).toMatchObject({ kind: 'gift_undelivered', park: false })
    expect(g.mails).toHaveLength(0)
    expect(g.scrubbed).toHaveLength(0)
  })

  it('a permanent mailer refusal parks it', async () => {
    const g = fakeGifts({ sendMail: async () => ({ ok: false, status: 422, error: 'invalid_field' as never, message: 'x', retryable: false }) })
    fakeGateway(honestMint)
    const out = await discharge('http://gw', obligation('email', emailDelivery()), portsWith(g.ports))
    expect(out).toMatchObject({ kind: 'gift_undelivered', park: true })
  })

  it('never logs ℓ', async () => {
    const logs: string[] = []
    for (const k of ['log', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a) => void logs.push(a.join(' ')))
    const g = fakeGifts({ scrubSeal: async () => false })
    fakeGateway(honestMint)
    const out = await discharge('http://gw', obligation('email', emailDelivery()), portsWith(g.ports))
    expect(JSON.stringify(out)).not.toContain(ELL)
    expect(logs.join('\n')).not.toContain(ELL)
  })
})

describe('refused before minting', () => {
  const cases: Array<[string, Obligation, GiftPorts | undefined, string]> = [
    ['not configured', obligation('handle', delivery()), undefined, 'blocked'],
    ['no refund key', obligation('handle', delivery({ refundPubkey: null })), fakeGifts().ports, 'blocked'],
    ['refund is the lock key', obligation('handle', delivery({ refundPubkey: BOB })), fakeGifts().ports, 'attention'],
    ['a seal for another purchase', obligation('email', emailDelivery(), { faceValue: 1 }), fakeGifts().ports, 'blocked'],
    ['a scrubbed seal', obligation('email', { ...emailDelivery(), sealed: null }), fakeGifts().ports, 'attention'],
    ['window too short', obligation('handle', delivery()), { ...fakeGifts().ports, anchor: async () => NOW - 89.5 * DAY_MS }, 'attention'],
  ]
  for (const [name, o, gifts, kind] of cases) {
    it(name, async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch')
      const out = await discharge('http://gw', o, portsWith(gifts))
      expect(out.kind).toBe(kind)
      expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/wallet/vouchers'))).toBe(false)
    })
  }
})

describe('pure parts', () => {
  it('giftLockFor: x from the anchor, refused when too short from now', () => {
    expect(giftLockFor({ lockPubkey: BOB, refundPubkey: BUYER, mintedAtMs: NOW, nowMs: NOW, claimWindowDays: 30, couponExpiresAtMs: null })).toEqual({ lockPubkey: BOB, refundPubkey: BUYER, locktime: X })
    expect(giftLockFor({ lockPubkey: BOB, refundPubkey: BUYER, mintedAtMs: NOW, nowMs: NOW + 13.5 * DAY_MS, claimWindowDays: 30, couponExpiresAtMs: null })).toEqual({ problem: 'window_too_short' })
  })
  it('test mode: a claim window in seconds from the anchor (so an e2e can watch it end)', () => {
    expect(giftLockFor({ lockPubkey: BOB, refundPubkey: BUYER, mintedAtMs: NOW, nowMs: NOW, claimWindowDays: 30, couponExpiresAtMs: null, testWindowSeconds: 120 })).toEqual({
      lockPubkey: BOB,
      refundPubkey: BUYER,
      locktime: Math.floor(NOW / 1000) + 120,
    })
    // The key checks still apply in test mode.
    expect(giftLockFor({ lockPubkey: BOB, refundPubkey: BOB, mintedAtMs: NOW, nowMs: NOW, claimWindowDays: 30, couponExpiresAtMs: null, testWindowSeconds: 120 })).toEqual({ problem: 'refund_is_lock_key' })
  })
  it('the gift link and the wrap match the wallet byte for byte', () => {
    const s = hexToBytes(ELL)
    expect(formatGiftLink('https://imani.casa/x', s, X)).toBe(walletFormatGiftLink('https://imani.casa/x', s, X))
    const w = wrapForLink(s, 'cashuBx')
    expect(JSON.parse(nip17.unwrapEvent(w, s).content)).toEqual({ type: 'cashu_token_transfer', token: 'cashuBx' })
  })
  it('verifyLockedGift refuses another locktime and a locktime with no refund', () => {
    const lock = { lockPubkey: BOB, refundPubkey: BUYER, locktime: X }
    expect(verifyLockedGift(tokenOf(lockedSecret(BOB, BUYER, X)), lock)).toBeNull()
    expect(verifyLockedGift(tokenOf(lockedSecret(BOB, BUYER, X + 1)), lock)).toMatch(/locktime/)
    expect(verifyLockedGift(tokenOf(lockedSecret(L, BUYER, X)), lock)).toMatch(/another key/)
    const open = JSON.stringify(['P2PK_VOUCHER', { nonce: 'a', data: `02${BOB}`, tags: [['locktime', String(X)]] }])
    expect(verifyLockedGift(tokenOf(open), lock)).toMatch(/open to anyone/)
  })
})

describe('config: email gifts fail closed', () => {
  const base = { PURCHASE_API_URL: 'http://pa', PURCHASE_API_TOKEN: 't', PURCHASE_GATEWAY_URL: 'http://gw', PURCHASE_VAULT_KEY: 'a'.repeat(64), PURCHASE_LIVEMODE: 'false' }
  it('off without a seal key', () => expect(readConfig(base).gifts).toBeNull())
  it('a seal key without origin, mailer or anchors refuses to boot', () => {
    try {
      readConfig({ ...base, PURCHASE_GIFT_SEAL_KEY: ISSUER_HEX })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError)
      expect((e as ConfigError).missing.join(' ')).toMatch(/WALLET_ORIGIN.*MAILER_URL.*MAILER_TOKEN.*ANCHORS/s)
    }
  })
  it('fully configured', () => {
    const c = readConfig({ ...base, PURCHASE_GIFT_SEAL_KEY: ISSUER_HEX, PURCHASE_WALLET_ORIGIN: 'https://imani.casa/', PURCHASE_MAILER_URL: 'http://mailer', PURCHASE_MAILER_TOKEN: 'm', PURCHASE_GIFT_ANCHORS_PATH: '/tmp/a.json', PURCHASE_GIFT_TRACKER_PATH: '/tmp/t.json' })
    expect(c.gifts).toMatchObject({ walletOrigin: 'https://imani.casa', mailerUrl: 'http://mailer', testWindowSeconds: null })
  })
  const full = { ...base, PURCHASE_GIFT_SEAL_KEY: ISSUER_HEX, PURCHASE_WALLET_ORIGIN: 'https://imani.casa/', PURCHASE_MAILER_URL: 'http://mailer', PURCHASE_MAILER_TOKEN: 'm', PURCHASE_GIFT_ANCHORS_PATH: '/tmp/a.json', PURCHASE_GIFT_TRACKER_PATH: '/tmp/t.json' }
  it('a test claim window is test mode only: refused in live mode, bounded', () => {
    expect(readConfig({ ...full, PURCHASE_TEST_CLAIM_WINDOW_SECONDS: '120' }).gifts?.testWindowSeconds).toBe(120)
    for (const env of [
      { ...full, PURCHASE_LIVEMODE: 'true', PURCHASE_API_URL: 'https://pa', PURCHASE_TEST_CLAIM_WINDOW_SECONDS: '120' },
      { ...full, PURCHASE_TEST_CLAIM_WINDOW_SECONDS: '5' },
      { ...full, PURCHASE_TEST_CLAIM_WINDOW_SECONDS: 'soon' },
    ]) {
      expect(() => readConfig(env)).toThrow(/PURCHASE_TEST_CLAIM_WINDOW_SECONDS/)
    }
  })
})

describe('G15 §4.3: a delivered gift is tracked for the buyer\'s notices', () => {
  const tracking = () => {
    const tracked: Array<{ input: Record<string, unknown>; mintUrl: string }> = []
    return { tracked, track: async (input: never, mintUrl: string) => void tracked.push({ input, mintUrl }) }
  }

  it('signed-in handle gift: @handle display, not guest, claimBy = x, Ys of the token, mint URL', async () => {
    const t = tracking()
    const g = fakeGifts({ track: t.track })
    fakeGateway(honestMint)
    const d = delivery({ buyerEmail: 'ann@example.com', recipientHandle: 'bob', buyerPubkey: BUYER })
    const out = await discharge('http://gw', obligation('handle', d), portsWith(g.ports))
    expect(out.kind).toBe('discharged')
    expect(t.tracked).toHaveLength(1)
    expect(t.tracked[0].mintUrl).toBe('https://mint.example')
    expect(t.tracked[0].input).toMatchObject({
      draftId: '11111111-2222-3333-4444-555555555555', kind: 'handle', claimBy: X * 1000, buyerEmail: 'ann@example.com',
      recipientDisplay: '@bob', stall: 'Alice Bakery', amount: '€20.00', guest: false, returnMailDate: null,
      // G17: the voucher's own expiry (90-day stall), which a taken-back gift keeps.
      spendBy: NOW + 90 * DAY_MS,
    })
  })

  it('a NIP-05 handle is shown as typed; never a key', async () => {
    const t = tracking()
    fakeGateway(honestMint)
    await discharge('http://gw', obligation('handle', delivery({ buyerEmail: 'a@b.co', recipientHandle: 'bob@example.com', buyerPubkey: BUYER })), portsWith(fakeGifts({ track: t.track }).ports))
    expect(t.tracked[0].input.recipientDisplay).toBe('bob@example.com')
    const t2 = tracking()
    await discharge('http://gw', obligation('handle', delivery({ buyerEmail: 'a@b.co', buyerPubkey: BUYER })), portsWith(fakeGifts({ track: t2.track }).ports))
    expect(t2.tracked[0].input.recipientDisplay).toBe('the recipient')
  })

  it('guest email gift: recipient address, guest, return-mail date from the draft created time', async () => {
    const t = tracking()
    fakeGateway(honestMint)
    const d = { ...emailDelivery(), buyerEmail: 'guest@example.com', draftCreatedAt: Date.UTC(2026, 9, 28, 9) }
    const out = await discharge('http://gw', obligation('email', d), portsWith(fakeGifts({ track: t.track }).ports))
    expect(out.kind).toBe('discharged')
    expect(t.tracked[0].input).toMatchObject({ kind: 'email', recipientDisplay: 'bob@example.com', guest: true, returnMailDate: '28 Oct 2026' })
  })

  it('a refund key that is not the buyer key is a guest; no created time means no date', async () => {
    const t = tracking()
    fakeGateway(honestMint)
    const other = getPublicKey(generateSecretKey())
    await discharge('http://gw', obligation('handle', delivery({ buyerEmail: 'a@b.co', buyerPubkey: other })), portsWith(fakeGifts({ track: t.track }).ports))
    expect(t.tracked[0].input).toMatchObject({ guest: true, returnMailDate: null })
  })

  it('no buyer email: not tracked, still discharged, and the log names no address or draft', async () => {
    const t = tracking()
    fakeGateway(honestMint)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await discharge('http://gw', obligation('handle', delivery()), portsWith(fakeGifts({ track: t.track }).ports))
    expect(out.kind).toBe('discharged')
    expect(t.tracked).toHaveLength(0)
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/11111111|@/)
  })

  it('a failing tracker never undoes the discharge', async () => {
    fakeGateway(honestMint)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = fakeGifts({ track: async () => { throw new Error('disk full for ann@example.com') } })
    const out = await discharge('http://gw', obligation('handle', delivery({ buyerEmail: 'ann@example.com' })), portsWith(g.ports))
    expect(out.kind).toBe('discharged')
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/ann@example|11111111/)
  })
})

describe('config: G15 tracker', () => {
  const base = { PURCHASE_API_URL: 'http://pa', PURCHASE_API_TOKEN: 't', PURCHASE_GATEWAY_URL: 'http://gw', PURCHASE_VAULT_KEY: 'a'.repeat(64), PURCHASE_LIVEMODE: 'false' }
  const gifts = { ...base, PURCHASE_GIFT_SEAL_KEY: ISSUER_HEX, PURCHASE_WALLET_ORIGIN: 'https://imani.casa', PURCHASE_MAILER_URL: 'http://mailer', PURCHASE_MAILER_TOKEN: 'm', PURCHASE_GIFT_ANCHORS_PATH: '/tmp/a.json' }
  it('PURCHASE_GIFT_TRACKER_PATH is required with gifts', () => {
    expect(() => readConfig(gifts)).toThrow(/PURCHASE_GIFT_TRACKER_PATH/)
  })
  it('PURCHASE_MINT_TRANSPORT_URL is optional', () => {
    expect(readConfig({ ...gifts, PURCHASE_GIFT_TRACKER_PATH: '/tmp/t.json' }).gifts).toMatchObject({ trackerPath: '/tmp/t.json', mintTransportUrl: null })
    expect(readConfig({ ...gifts, PURCHASE_GIFT_TRACKER_PATH: '/tmp/t.json', PURCHASE_MINT_TRANSPORT_URL: 'http://localhost:27777/' }).gifts?.mintTransportUrl).toBe('http://localhost:27777')
  })
})

describe('#410 code gift with PURCHASE_CODE_GIFTS off (parked before minting)', () => {
  it('a code gift is never minted as a voucher', async () => {
    const g = fakeGifts()
    const bodies = fakeGateway(honestMint)
    const d = { ...emailDelivery(), gift: 'code' as const, shopKey: 'e'.repeat(64), shopUrl: 'https://olive.example', codeExpiresAt: X }
    const out = await discharge('http://gw', obligation('email', d), portsWith(g.ports))
    expect(out.kind).toBe('attention')
    expect(bodies.some((b) => b.url.endsWith('/wallet/vouchers'))).toBe(false)
    expect(g.mails).toHaveLength(0)
  })
})
