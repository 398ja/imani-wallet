import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'

import { discharge, type Obligation, type Ports } from '../discharge'
import { claimEmail, claimWindowEnd, DAY_MS, openSeal, SealRefused, windowTooShort } from '../giftLock'
import { describeGift, parseGiftDelivery, parseOwedPurchase } from '../purchasesApi'
import { seal } from '../../../apps/gifting/src/lib/gift'
import { STALL, delegatedCredential, ninetyDayTerm } from './stallFixture'

/** #410: gifting-site purchases at the issuer. */

const R = 'c'.repeat(64)
const BOB = 'b'.repeat(64)

const row = (over: Record<string, unknown> = {}) => ({
  eventId: 'evt_1',
  paymentRequestId: 'pr_1',
  stallPubkey: STALL,
  recipientPubkey: BOB,
  amountMinor: 2000,
  currency: 'EUR',
  livemode: false,
  attempts: 0,
  processorReference: 'pi_1',
  draftId: 'd1',
  delivery: { kind: 'handle', refundPubkey: R, recipientEmail: null, sealed: null, message: 'hi', from: null, buyerEmail: 'me@example.com', claimWindowDays: 30 },
  ...over,
})

describe('the owed row carries the pinned delivery', () => {
  it('parses a handle gift', () => {
    expect(parseOwedPurchase(row())?.delivery).toMatchObject({ kind: 'handle', refundPubkey: R, claimWindowDays: 30 })
  })
  it('a wallet purchase has none', () => {
    expect(parseOwedPurchase(row({ delivery: null }))?.delivery).toBeNull()
    expect(parseOwedPurchase(row({ delivery: undefined }))?.delivery).toBeNull()
  })
  it('drops a row whose delivery is malformed, or whose recipient key disagrees with its kind', () => {
    expect(parseOwedPurchase(row({ delivery: { kind: 'carrier pigeon' } }))).toBeNull()
    expect(parseOwedPurchase(row({ delivery: { ...row().delivery, refundPubkey: null } }))).toBeNull()
    expect(parseOwedPurchase(row({ delivery: { ...row().delivery, message: 'x'.repeat(281) } }))).toBeNull()
    expect(parseOwedPurchase(row({ delivery: { ...row().delivery, kind: 'email' } }))).toBeNull()
    expect(parseOwedPurchase(row({ recipientPubkey: null }))).toBeNull()
    expect(parseOwedPurchase(row({ recipientPubkey: null, delivery: { ...row().delivery, kind: 'email', recipientEmail: 'bob@example.com', sealed: 'v1.a.b' } }))).not.toBeNull()
  })
  it('never logs the email, message or seal', () => {
    const d = parseGiftDelivery({ ...row().delivery, kind: 'email', recipientEmail: 'bob@example.com', sealed: 'v1.secret.x', message: 'private' })!
    const line = describeGift(d)
    expect(line).not.toMatch(/bob@|secret|private/)
    expect(line).toMatch(/email gift/)
  })
})

const OBLIGATION: Obligation = {
  id: 'evt_1',
  paymentRequestId: '0123456789abcdef0123456789abcdef',
  stallPubkey: STALL,
  faceValue: 2000,
  faceUnit: 'EUR',
  faceDecimals: 2,
  memo: '',
  recipient: { kind: 'pubkey', pubkey: BOB },
  attempts: 0,
  processorReference: 'pi_3Test',
}

const ports = (): Ports => ({
  validityFor: ninetyDayTerm,
  credentialFor: async () => delegatedCredential(),
  tokenFor: async () => '',
  now: () => Date.now(),
  sleep: async () => {},
})

describe('a handle or email gift is never minted unlocked (G7, G-R2)', () => {
  afterEach(() => vi.restoreAllMocks())
  for (const kind of ['handle', 'email'] as const) {
    it(`${kind}: blocked before anything is minted`, async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch')
      const outcome = await discharge('http://gw', { ...OBLIGATION, gift: { kind } }, ports())
      expect(outcome.kind).toBe('blocked')
      expect(fetchMock).not.toHaveBeenCalled()
    })
  }
  it('self is delivered like a wallet purchase (it mints)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }))
    await discharge('http://gw', { ...OBLIGATION, gift: { kind: 'self' } }, ports())
    expect(fetchMock).toHaveBeenCalled()
  })
})

describe('G11: the claim window', () => {
  const t = Date.UTC(2026, 0, 1)
  it('is 30 days by default', () => expect(claimWindowEnd(t, 30, null)).toBe(t + 30 * DAY_MS))
  it('is capped by the voucher expiry minus 24h', () => expect(claimWindowEnd(t, 30, t + 10 * DAY_MS)).toBe(t + 9 * DAY_MS))
  it('a voucher expiring within a day is too short to arm', () => {
    expect(windowTooShort(t, claimWindowEnd(t, 30, t + DAY_MS))).toBe(true)
    expect(windowTooShort(t, claimWindowEnd(t, 30, t + 90 * DAY_MS))).toBe(false)
  })
})

describe('G4: opening the sealed link secret', () => {
  const issuer = generateSecretKey()
  const issuerHex = bytesToHex(issuer)
  const link = bytesToHex(generateSecretKey())
  const binding = { stallPubkey: STALL, amountMinor: 2000, recipient: 'bob@example.com' }
  const sealed = seal(getPublicKey(issuer), binding, { linkSecret: link })

  it('opens for this issuer and this purchase', () => {
    expect(openSeal(issuerHex, sealed, { ...binding, recipient: 'Bob@Example.com' })).toEqual({ linkSecret: link })
  })
  it('refuses another issuer, another stall, amount or address, and junk', () => {
    expect(() => openSeal(bytesToHex(generateSecretKey()), sealed, binding)).toThrow(SealRefused)
    expect(() => openSeal(issuerHex, sealed, { ...binding, stallPubkey: BOB })).toThrow(SealRefused)
    expect(() => openSeal(issuerHex, sealed, { ...binding, amountMinor: 1 })).toThrow(SealRefused)
    expect(() => openSeal(issuerHex, sealed, { ...binding, recipient: 'eve@example.com' })).toThrow(SealRefused)
    expect(() => openSeal(issuerHex, 'v1.x', binding)).toThrow(SealRefused)
  })
  it('a refusal never carries the secret', () => {
    try {
      openSeal(issuerHex, sealed, { ...binding, amountMinor: 1 })
    } catch (e) {
      expect(String(e)).not.toContain(link)
    }
  })
})

describe('the claim email (G-R4)', () => {
  const link = 'ab'.repeat(32)
  const mail = claimEmail({
    to: 'bob@example.com',
    walletOrigin: 'https://imani.casa/',
    linkSecret: link,
    stallName: 'Alice Bakery',
    amount: '€20.00',
    claimBy: new Date(Date.UTC(2026, 10, 27)),
    from: null,
    message: 'Happy birthday',
  })
  it('puts the secret in the URL fragment only, never the subject', () => {
    const u = new URL(mail.claimUrl)
    expect(u.pathname).toBe('/claim')
    expect(u.search).toBe('')
    expect(u.hash).toBe(`#${link}`)
    expect(mail.subject).not.toContain(link)
    expect(mail.subject).toBe('Someone sent you a voucher for Alice Bakery')
  })
  it('says who, what, by when, how, and not to forward it', () => {
    expect(mail.text).toMatch(/Someone sent you a €20\.00 voucher for Alice Bakery/)
    expect(mail.text).toMatch(/Happy birthday/)
    expect(mail.text).toMatch(/Claim it by/)
    expect(mail.text).toMatch(/Don't forward it/)
  })
})
