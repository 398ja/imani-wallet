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
/** Answers to successive enrol POSTs (#306); `enrolAnswer` once they run out. `'throw'` drops the call. */
let enrolAnswers: ({ status: number; body: unknown } | 'throw')[] = []
/** What `GET /enrolment` says, in order; the last one repeats. */
let statusAnswers: unknown[] = []
let mints = 0

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  sent = []
  enrolAnswers = []
  statusAnswers = [{ enrolled: false, ready: false, reason: 'card sales are not set up for this stall' }]
  mints = 0
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
      mints++
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
    if (url.pathname === ENROL_PATH && init.method === 'POST') {
      const next = enrolAnswers.shift() ?? enrolAnswer
      if (next === 'throw') throw new TypeError('timed out')
      return respond(next.status, next.body)
    }
    if (url.pathname === ENROL_PATH) return respond(200, statusAnswers.length > 1 ? statusAnswers.shift() : statusAnswers[0])
    if (url.pathname.startsWith('/api/v1/wallet/terminal-credentials/')) return new Response(null, { status: 204 })
    return respond(404, { error: 'not found' })
  })
})

/** The (last) enrol POST's body. */
function enrolBody(): string {
  return sent.filter((s) => new URL(s.url).pathname === ENROL_PATH && s.method === 'POST').at(-1)!.body
}

const enrolPosts = () => sent.filter((s) => new URL(s.url).pathname === ENROL_PATH && s.method === 'POST')
const cancels = () => sent.filter((s) => new URL(s.url).pathname.startsWith('/api/v1/wallet/terminal-credentials/')).map((s) => new URL(s.url).pathname)
const instant = async () => {}

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
      `GET ${ENROL_PATH}`,
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
    const mint = sent.find((s) => new URL(s.url).pathname === '/api/v1/wallet/vouchers')!
    expect(JSON.parse(mint.body).merchant_metadata).toMatchObject({ lock_key: LOCK, role: 'issue-and-redeem', stall_pubkey: STALL })
    expect(mint.headers.get('X-Imani-Terminal-Enrolment')).toMatch(/^1:1700000000:/)

    const enrol = JSON.parse(enrolBody()) as { credentialId: string; delegation: Parameters<typeof verifyEvent>[0] }
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
    const enrol = JSON.parse(enrolBody()) as { delegation: unknown }
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

  // #306 item 4: STRUCTURAL, not a scan for encodings. A scan only finds the encodings it knows
  // (hex, nsec, base64), and missed a key split in two or written as a decimal. This lists every
  // field that may leave the phone, per request, with the shape its value must have. A new field,
  // or a value of an unexpected shape, fails here whatever it encodes.
  it('sends only allowlisted fields, each of a known public shape', async () => {
    await turnOnCardSales({ signer: stallSigner })
    const hex = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`)
    const pub = (v: string) => v === STALL || v === LOCK
    const digest = (v: string) => hex(64).test(v) && !pub(v)
    const nip98: Record<string, (v: unknown) => boolean> = {
      kind: (v) => v === 27235,
      created_at: (v) => Number.isInteger(v),
      'tags.*.*': (v) => typeof v === 'string' && (/^(u|method|payload|nonce)$/.test(v) || /^(GET|POST)$/.test(v) || v.startsWith('http://localhost') || hex(64).test(v) || hex(32).test(v)),
      content: (v) => v === '',
      pubkey: (v) => v === STALL,
      id: (v) => digest(String(v)),
      sig: (v) => hex(128).test(String(v)),
    }
    const bodies: Record<string, Record<string, (v: unknown) => boolean>> = {
      [`GET ${ENROL_PATH}`]: {},
      [`POST ${BEGIN_PATH}`]: {},
      'GET /api/v1/wallet/vouchers/cred-card-1': {},
      'POST /api/v1/wallet/vouchers': {
        face_value: (v) => v === 1,
        face_unit: (v) => v === 'sat',
        face_decimals: (v) => v === 0,
        backing_strategy: (v) => v === 'PROPORTIONAL',
        issuer_id: (v) => v === STALL,
        memo: (v) => v === 'Imani terminal credential',
        expires_in_days: (v) => v === 365,
        'merchant_metadata.terminal': (v) => v === true,
        'merchant_metadata.stall_pubkey': (v) => v === STALL,
        'merchant_metadata.role': (v) => v === 'issue-and-redeem',
        'merchant_metadata.lock_key': (v) => v === LOCK,
        'merchant_metadata.name': (v) => v === 'Card sales',
        'merchant_metadata.owner_attestation.v': (v) => v === '1',
        'merchant_metadata.owner_attestation.expires_at': (v) => /^\d{10}$/.test(String(v)),
        'merchant_metadata.owner_attestation.nonce': (v) => digest(String(v)),
        'merchant_metadata.owner_attestation.sig': (v) => hex(128).test(String(v)),
      },
      [`POST ${ENROL_PATH}`]: {
        credentialId: (v) => v === 'cred-card-1',
        'delegation.kind': (v) => v === 30078,
        'delegation.created_at': (v) => Number.isInteger(v),
        'delegation.tags.*.*': (v) =>
          typeof v === 'string' && (/^(d|p|scope|expiration|imani:issuer-delegation|coupon:issue)$/.test(v) || v === LOCK || /^\d{10}$/.test(v)),
        'delegation.content': (v) => v === '',
        'delegation.pubkey': (v) => v === STALL,
        'delegation.id': (v) => digest(String(v)),
        'delegation.sig': (v) => hex(128).test(String(v)),
      },
    }
    const headers: Record<string, RegExp> = {
      authorization: /^Nostr [A-Za-z0-9+/=]+$/,
      'content-type': /^application\/json$/,
      'idempotency-key': /^[0-9a-f-]{36}$/,
      'x-idempotency-expires-at': /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/,
      'x-imani-terminal-enrolment': /^1:\d{10}:[0-9a-f]{128}$/,
    }
    const leaves = (value: unknown, path = ''): [string, unknown][] =>
      value !== null && typeof value === 'object'
        ? Object.entries(value).flatMap(([k, v]) => leaves(v, path === '' ? (Array.isArray(value) ? '*' : k) : `${path}.${Array.isArray(value) ? '*' : k}`))
        : [[path, value]]
    const check = (allowed: Record<string, (v: unknown) => boolean>, value: unknown, where: string) => {
      for (const [path, leaf] of leaves(value)) {
        expect(Object.keys(allowed), `${where}: field ${path} is not on the allowlist`).toContain(path)
        expect(allowed[path](leaf), `${where}: ${path} has an unexpected value`).toBe(true)
      }
    }

    expect(sent.length).toBeGreaterThanOrEqual(5)
    for (const s of sent) {
      const url = new URL(s.url)
      const route = `${s.method} ${url.pathname}`
      expect(Object.keys(bodies), `unexpected request ${route}`).toContain(route)
      expect(url.search, `${route} carries a query`).toBe('')
      check(bodies[route], s.body === '' ? {} : JSON.parse(s.body), route)
      for (const [name, value] of s.headers.entries()) {
        expect(Object.keys(headers), `${route}: header ${name}`).toContain(name)
        expect(value).toMatch(headers[name])
      }
      check(nip98, JSON.parse(atob(s.authorization!.slice('Nostr '.length))), `${route} auth`)
    }
  })

  // #306 item 1: a 502 from the enrol is retried with the SAME credential, never a fresh mint, so
  // failed attempts no longer burn the gateway's two pending slots.
  it('retries a 502 enrol with the same minted credential', async () => {
    enrolAnswers = [{ status: 502, body: { error: 'the gateway did not confirm the credential; try again in a moment' } }, 'throw']
    const result = await turnOnCardSales({ signer: stallSigner, sleep: instant })
    expect(result.kind).toBe('ok')
    expect(mints).toBe(1)
    expect(enrolPosts()).toHaveLength(3)
    expect(new Set(enrolPosts().map((s) => s.body)).size).toBe(1)
    expect(cancels()).toEqual([])
  })

  // An answer lost on the way back, but the issuer did seal it: on, and nothing is cancelled.
  it('counts an enrol whose answer was lost but which landed', async () => {
    enrolAnswers = ['throw', 'throw', 'throw']
    statusAnswers = [{ enrolled: false, ready: false }, { enrolled: true, credentialId: 'cred-card-1', ready: true }]
    const result = await turnOnCardSales({ signer: stallSigner, sleep: instant })
    expect(result).toEqual({ kind: 'ok', status: expect.objectContaining({ credentialId: 'cred-card-1' }) })
    expect(mints).toBe(1)
    expect(cancels()).toEqual([])
  })

  // Every attempt failed, and the issuer does not hold it: its pending slot is given back now.
  it('cancels its own unconfirmed credential when the enrol never lands', async () => {
    enrolAnswer = { status: 502, body: { error: 'the gateway did not confirm the credential; try again in a moment' } }
    const result = await turnOnCardSales({ signer: stallSigner, sleep: instant })
    expect(result).toEqual({ kind: 'error', reason: expect.stringContaining('did not confirm') })
    expect(mints).toBe(1)
    expect(enrolPosts()).toHaveLength(3)
    expect(cancels()).toEqual(['/api/v1/wallet/terminal-credentials/cred-card-1/cancel'])
    const cancel = sent.find((s) => new URL(s.url).pathname.endsWith('/cancel'))!
    expect(nip98Refusal(cancel)).toBeNull()
  })

  // A refusal that a retry cannot fix (422) is not retried.
  it('does not retry a refusal', async () => {
    enrolAnswer = { status: 422, body: { error: 'delegation refused: nope' } }
    await turnOnCardSales({ signer: stallSigner, sleep: instant })
    expect(enrolPosts()).toHaveLength(1)
  })

  // #306 item 2: re-enrolling (or renewing) cancels the credential it replaced.
  it('cancels the superseded card-sales credential on re-enrol', async () => {
    statusAnswers = [{ enrolled: true, credentialId: 'cred-old-0', ready: true }]
    const result = await turnOnCardSales({ signer: stallSigner, sleep: instant })
    expect(result.kind).toBe('ok')
    expect(cancels()).toEqual(['/api/v1/wallet/terminal-credentials/cred-old-0/cancel'])
  })

  // A failed re-enrol leaves the working credential alone.
  it('keeps the old credential when a re-enrol fails', async () => {
    statusAnswers = [{ enrolled: true, credentialId: 'cred-old-0', ready: true }]
    enrolAnswer = { status: 422, body: { error: 'delegation refused: nope' } }
    await turnOnCardSales({ signer: stallSigner, sleep: instant })
    expect(cancels()).not.toContain('/api/v1/wallet/terminal-credentials/cred-old-0/cancel')
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

  // Card payments are Essentials and above: a Starter stall reads `not-in-plan`, never ready.
  it('reads card_payments_not_in_plan as not-in-plan', async () => {
    const answer = (status: number, body: unknown) => (async () => respond(status, body)) as unknown as typeof fetch
    expect(await cardSalesReadiness(STALL, answer(200, { ready: false, reason: 'card_payments_not_in_plan' }))).toBe('not-in-plan')
    expect(await cardSalesReady(STALL, answer(200, { ready: false, reason: 'card_payments_not_in_plan' }))).toBe(false)
  })
})
