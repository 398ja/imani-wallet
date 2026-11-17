/**
 * @vitest-environment jsdom
 *
 * Turning on card sales from the stall owner's phone (imani-wallet#298).
 *
 * The REAL wallet signer and the REAL `signedFetch`; only the network is faked, at `fetch`. The
 * gateway mints a genuine credential token for whatever the phone asked (as gateway-customer
 * does), and the purchase issuer is a stub that answers like `enrolment.ts`. Everything that left
 * the phone is captured, so the owner's rule can be checked against the wire itself: the stall's
 * key never leaves this phone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPublicKey, nip19, verifyEvent } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import { createWalletSigner } from '../signer'
import { buildLockedCredentialToken } from './voucherFixtures'
import { nip98Refusal, type WireRequest } from './nip98ServerCheck'

const STALL_KEY = schnorr.utils.randomSecretKey()
const STALL_HEX = bytesToHex(STALL_KEY)
const STALL = getPublicKey(STALL_KEY)
/** The issuer's lock key. Only its public half is ever given to the phone. */
const LOCK = getPublicKey(schnorr.utils.randomSecretKey())
/** What the wallet keeps at rest: an encrypted key backup. Must never be sent either. */
const STORED_ENVELOPE = JSON.stringify({ v: 1, iv: 'c3RvcmVkLWl2', ciphertext: 'c3RvcmVkLWtleS1jaXBoZXJ0ZXh0LW1hcmtlcg' })

const stallSigner = createWalletSigner(STALL_HEX)
vi.mock('../nap', () => ({ getSigner: () => stallSigner }))

const { turnOnCardSales, fetchCardSalesStatus, cardSalesReady, cardSalesReadiness, BEGIN_PATH, ENROL_PATH, DELEGATION_LIFETIME_DAYS } =
  await import('../cardSalesEnrolment')

let sent: (WireRequest & { headers: Headers })[] = []
let enrolAnswer: { status: number; body: unknown } = { status: 200, body: { enrolled: true, ready: true } }

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  sent = []
  enrolAnswer = { status: 200, body: { enrolled: true, confirmation: 'confirmed', ready: true } }
  localStorage.setItem('imani-wallet-key', STORED_ENVELOPE)
  let minted: string | null = null
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, window.location.origin)
    const headers = new Headers(init.headers)
    const body = typeof init.body === 'string' ? init.body : ''
    sent.push({ url: url.toString(), method: init.method ?? 'GET', authorization: headers.get('Authorization'), contentType: headers.get('Content-Type'), body, headers })
    if (url.pathname === BEGIN_PATH) return respond(200, { lockPubkey: LOCK, enrolmentProof: '1:1700000000:' + 'ab'.repeat(64) })
    if (url.pathname === '/api/v1/wallet/vouchers' && init.method === 'POST') {
      // The gateway mints exactly what it was asked for, signed by the stall (who asked).
      const request = JSON.parse(body) as { merchant_metadata: { owner_attestation: { expires_at: string } } }
      minted = buildLockedCredentialToken({
        stallKey: STALL_KEY,
        devicePubkey: LOCK,
        role: 'issue-and-redeem',
        metadata: JSON.stringify(request.merchant_metadata),
        expiresAt: Number(request.merchant_metadata.owner_attestation.expires_at),
        voucherId: 'cred-card-1',
      })
      return respond(201, { voucher_id: 'cred-card-1' })
    }
    if (url.pathname === '/api/v1/wallet/vouchers/cred-card-1') return respond(200, { status: 'ISSUED', token: minted })
    if (url.pathname === ENROL_PATH && init.method === 'POST') return respond(enrolAnswer.status, enrolAnswer.body)
    if (url.pathname === ENROL_PATH) return respond(200, { enrolled: false, ready: false, reason: 'card sales are not set up for this stall' })
    return respond(404, { error: 'not found' })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('turning on card sales', () => {
  // The four steps, in order, each NIP-98 signed by the stall, and the delegation names the
  // issuer's key for 380 days.
  it('begins, mints as the stall, delegates, and enrols', async () => {
    const result = await turnOnCardSales({ signer: stallSigner })

    expect(result).toEqual({ kind: 'ok', status: expect.objectContaining({ ready: true }) })
    const steps = sent.map((s) => `${s.method} ${new URL(s.url).pathname}`)
    expect(steps).toEqual([
      `POST ${BEGIN_PATH}`,
      'POST /api/v1/wallet/vouchers',
      'GET /api/v1/wallet/vouchers/cred-card-1',
      `POST ${ENROL_PATH}`,
    ])
    for (const s of sent) {
      expect(nip98Refusal(s)).toBeNull()
      const event = JSON.parse(atob(s.authorization!.slice('Nostr '.length))) as { pubkey: string }
      expect(event.pubkey).toBe(STALL)
    }

    // The mint is locked to the issuer's key and carries the issuer's terminal proof.
    const mint = sent[1]
    expect(JSON.parse(mint.body).merchant_metadata).toMatchObject({ lock_key: LOCK, role: 'issue-and-redeem', stall_pubkey: STALL })
    expect(mint.headers.get('X-Imani-Terminal-Enrolment')).toMatch(/^1:1700000000:/)

    const enrol = JSON.parse(sent[3].body) as { credentialId: string; delegation: Parameters<typeof verifyEvent>[0] }
    expect(enrol.credentialId).toBe('cred-card-1')
    expect(verifyEvent(enrol.delegation)).toBe(true)
    expect(enrol.delegation.pubkey).toBe(STALL)
    expect(enrol.delegation.tags).toContainEqual(['p', LOCK])
    expect(enrol.delegation.tags).toContainEqual(['scope', 'coupon:issue'])
    const expiry = Number(enrol.delegation.tags.find((t) => t[0] === 'expiration')![1])
    expect(expiry - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(DELEGATION_LIFETIME_DAYS * 86_400 - 5)
  })

  // Review of #302: the issuer mints (and `/ready` says yes) only while the delegation outlives a
  // coupon minted that day by a week. The delegation the phone signs must keep the stall on sale
  // for the credential's whole year, judged by the issuer's own `checkDelegation`. Red with 380
  // days: the stall went off sale 8 days after it turned card sales on.
  it('signs a delegation that keeps card sales on for the credential\u2019s whole year', async () => {
    const { checkDelegation } = await import('../../../services/purchase-issuer/delegatedWarrant')
    // The longest term a stall may choose (#312): card sales must stay on for it all year.
    const { MAX_VALIDITY_DAYS } = await import('@imani/merchant-record')
    const { CREDENTIAL_LIFETIME_DAYS } = await import('../terminalMint')
    await turnOnCardSales({ signer: stallSigner })
    const enrol = JSON.parse(sent[3].body) as { delegation: unknown }
    const lockKeyHex = 'ab'.repeat(32)
    // The test's LOCK is a pubkey only; re-point it at a lock key we hold, keeping the stall's signature honest.
    const resigned = await stallSigner.signEvent({
      ...(enrol.delegation as { kind: number; created_at: number; content: string; tags: string[][] }),
      tags: (enrol.delegation as { tags: string[][] }).tags.map((t) => (t[0] === 'p' ? ['p', getPublicKey(hexToBytes(lockKeyHex))] : t)),
    })
    const credential = { stallPubkey: STALL, credentialId: 'c', lockKeyHex, delegation: JSON.stringify(resigned) }
    const day = 86_400_000
    const sellsOn = (d: number) => checkDelegation(credential, Date.now() + d * day + MAX_VALIDITY_DAYS * day).ok
    expect(sellsOn(0)).toBe(true)
    // The credential's last full day (it expires at 365 days and a few minutes).
    expect(sellsOn(CREDENTIAL_LIFETIME_DAYS - 1)).toBe(true)
  })

  // THE OWNER'S RULE. Nothing that left this phone carries the stall's private key: not as hex,
  // not as an nsec, not as any 64-hex string that IS the key, and not the stored key backup.
  it('sends no private-key material, in any request', async () => {
    await turnOnCardSales({ signer: stallSigner })
    expect(sent.length).toBeGreaterThanOrEqual(4)

    const nsec = nip19.nsecEncode(STALL_KEY)
    const envelope = JSON.parse(STORED_ENVELOPE) as { ciphertext: string }
    for (const s of sent) {
      const wire = [s.url, s.body, ...[...s.headers.entries()].map(([k, v]) => `${k}: ${v}`)].join('\n')
      const decodedAuth = s.authorization ? atob(s.authorization.slice('Nostr '.length)) : ''
      for (const text of [wire, decodedAuth]) {
        expect(text.toLowerCase()).not.toContain(STALL_HEX)
        expect(text).not.toContain(nsec)
        expect(text).not.toMatch(/nsec1[02-9ac-hj-np-z]{20,}/)
        expect(text).not.toContain(envelope.ciphertext)
        expect(text).not.toContain(btoa(String.fromCharCode(...hexToBytes(STALL_HEX))))
        // Every 64-hex string on the wire is public: none of them is a key that signs as the stall.
        for (const hex of text.toLowerCase().match(/[0-9a-f]{64}/g) ?? []) {
          let derived = ''
          try {
            derived = getPublicKey(hexToBytes(hex))
          } catch {
            derived = ''
          }
          expect(derived).not.toBe(STALL)
        }
      }
    }
  })

  // The issuer's refusal is shown in its own words, and nothing is claimed to be on.
  it('reports the issuer refusing, in its own words', async () => {
    enrolAnswer = { status: 422, body: { error: 'delegation refused: the stored delegation does not outlive the coupon by a week' } }
    const result = await turnOnCardSales({ signer: stallSigner })
    expect(result).toEqual({ kind: 'error', reason: expect.stringContaining('does not outlive the coupon') })
  })

  // An issuer that cannot be reached: an error, and the mint is never attempted.
  it('stops before minting when the issuer cannot be reached', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('network down')
    })
    const result = await turnOnCardSales({ signer: stallSigner })
    expect(result.kind).toBe('error')
  })
})

describe('status', () => {
  // The stall reads its own status, signed.
  it('reads the stall status', async () => {
    const result = await fetchCardSalesStatus(stallSigner)
    expect(result).toEqual({ kind: 'ok', status: expect.objectContaining({ enrolled: false, ready: false }) })
    expect(nip98Refusal(sent[0])).toBeNull()
  })
})

describe('readiness for a shopper (fail safe)', () => {
  // Only an explicit `ready: true` sells. A 404 (an older issuer), an error, or a non-answer is no.
  it('is true only for an explicit yes', async () => {
    const answer = (status: number, body: unknown) => (async () => respond(status, body)) as unknown as typeof fetch
    expect(await cardSalesReady(STALL, answer(200, { ready: true }))).toBe(true)
    expect(await cardSalesReady(STALL, answer(200, { ready: false }))).toBe(false)
    expect(await cardSalesReady(STALL, answer(200, { ready: 'yes' }))).toBe(false)
    expect(await cardSalesReady(STALL, answer(404, { error: 'not found' }))).toBe(false)
    expect(await cardSalesReady(STALL, answer(503, {}))).toBe(false)
    const down = (async () => {
      throw new TypeError('offline')
    }) as unknown as typeof fetch
    expect(await cardSalesReady(STALL, down)).toBe(false)
  })

  // #312: the one reason a shopper is told. A never-expiring stall reads `no-expiry`; any other
  // refusal (including the other validity codes) stays plain `not-ready`, failing safe.
  it('reads validity_never_expires as no-expiry, and every other refusal as not-ready', async () => {
    const answer = (status: number, body: unknown) => (async () => respond(status, body)) as unknown as typeof fetch
    expect(await cardSalesReadiness(STALL, answer(200, { ready: false, reason: 'validity_never_expires' }))).toBe('no-expiry')
    expect(await cardSalesReadiness(STALL, answer(200, { ready: false, reason: 'validity_unknown' }))).toBe('not-ready')
    expect(await cardSalesReadiness(STALL, answer(200, { ready: true }))).toBe('ready')
    expect(await cardSalesReady(STALL, answer(200, { ready: false, reason: 'validity_never_expires' }))).toBe(false)
  })

  // gc#317: a Free stall at (or, for one amount, past) its allowance reads `sales-limit`, never ready.
  it('reads the sales-limit codes as sales-limit', async () => {
    const answer = (status: number, body: unknown) => (async () => respond(status, body)) as unknown as typeof fetch
    for (const reason of ['sales_limit_reached', 'sales_limit_exceeded']) {
      expect(await cardSalesReadiness(STALL, answer(200, { ready: false, reason }))).toBe('sales-limit')
      expect(await cardSalesReady(STALL, answer(200, { ready: false, reason }))).toBe(false)
    }
  })
})
