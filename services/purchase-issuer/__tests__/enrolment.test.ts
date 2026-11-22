/**
 * @vitest-environment node
 *
 * A stall turns on card sales from its own phone (imani-wallet#298), and the next card purchase is
 * issued with no restart (#290). Real vault on disk, real confirmer, real worker pass; only the
 * gateway and payment-adapter are faked, by URL.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha256'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileCredentialStore } from '../adapters'
import { CredentialConfirmer } from '../confirmation'
import { BEGIN_COOLDOWN_MS, BEGIN_PATH, ENROL_PATH, EnrolmentService, MAX_PENDING, READY_PREFIX, RESEND_PATH } from '../enrolment'
import { attemptCount, renderMetrics, resetMetricsForTest } from '../metrics'
import type { OwedPurchase, PurchasesApi } from '../purchasesApi'
import { portsFor } from '../server'
import { readConfig } from '../config'
import { CredentialVault } from '../vault'
import { runPass, type WorkerDeps } from '../worker'
import { delegationJson, ninetyDayTerm, STALL, STALL_SK } from './stallFixture'
import type { StallValidity } from '../stallValidity'
import type { SalesPosition } from '../salesAllowance'

const ORIGIN = 'https://wallet.test'
const GATEWAY = 'http://gateway:8082'
const KEY = 'a'.repeat(64)

/** A NIP-98 header as the stall's phone signs it. `sk` defaults to the stall's own key. */
function signed(method: string, path: string, body = '', sk: string = STALL_SK, url = `${ORIGIN}${path}`): string {
  const tags = [
    ['u', url],
    ['method', method],
    ...(body ? [['payload', bytesToHex(sha256(new TextEncoder().encode(body)))]] : []),
    // As the wallet's `nip98Header` does: two requests in one second are two events.
    ['nonce', bytesToHex(generateSecretKey())],
  ]
  const event = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' },
    hexToBytes(sk),
  )
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

interface Gateway {
  confirmStatus: number
  calls: string[]
  fetchImpl: typeof fetch
}

/** The gateway and nothing else: confirm, mint, deliver. */
function gateway(): Gateway {
  const g: Gateway = {
    confirmStatus: 204,
    calls: [],
    fetchImpl: (async (url: string, init: RequestInit = {}) => {
      g.calls.push(`${init.method ?? 'GET'} ${url}`)
      if (url.includes('/terminal-credentials/')) return new Response(null, { status: g.confirmStatus })
      if (url.endsWith('/api/v1/wallet/vouchers')) {
        return new Response(JSON.stringify({ voucher_id: 'v-sold', token: 'cashuBtoken', issuer_id: STALL }), { status: 201 })
      }
      if (url.endsWith('/api/v1/dm/tokens/send')) {
        return new Response(JSON.stringify({ event_id: 'ev1', fulfilment_recorded: true }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch,
  }
  return g
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-enrol-'))
  const path = join(dir, 'credentials.json')
  const vault = new CredentialVault(KEY, new FileCredentialStore(path))
  const gw = gateway()
  const confirmer = new CredentialConfirmer(GATEWAY, gw.fetchImpl)
  const service = new EnrolmentService({ vault, confirmer, publicOrigin: ORIGIN, validityFor: ninetyDayTerm })
  const call = (method: string, p: string, body = '', authorization?: string) =>
    service.handle({ method, path: p, body, authorization: authorization ?? signed(method, p, body) })
  return { dir, path, vault, gw, confirmer, service, call }
}

/** The phone's half: begin, "mint" (the id stands in for gc's answer), sign the delegation, enrol. */
async function enrolAs(
  call: Awaited<ReturnType<typeof setup>>['call'],
  credentialId = 'cred-0001',
  delegate?: (lock: string) => string,
) {
  const begun = await call('POST', BEGIN_PATH)
  const lock = begun.body.lockPubkey as string
  const delegation = delegate ? delegate(lock) : delegationJson({ delegate: lock })
  const body = JSON.stringify({ credentialId, delegation })
  return { begun, lock, enrolled: await call('POST', ENROL_PATH, body) }
}

function owed(over: Partial<OwedPurchase> = {}): OwedPurchase {
  return {
    eventId: 'evt_1',
    paymentRequestId: '0123456789abcdef0123456789abcdef',
    stallPubkey: STALL,
    recipientPubkey: 'c'.repeat(64),
    amountMinor: 500,
    currency: 'gbp',
    livemode: false,
    attempts: 0,
    processorReference: 'pi_1',
    ...over,
  }
}

function workerFor(vault: CredentialVault, confirmer: CredentialConfirmer, gw: Gateway): WorkerDeps {
  const config = readConfig({
    PURCHASE_API_URL: 'http://payment-adapter:8080',
    PURCHASE_API_TOKEN: 't',
    PURCHASE_GATEWAY_URL: GATEWAY,
    PURCHASE_VAULT_KEY: KEY,
    PURCHASE_LIVEMODE: 'false',
  })
  const api = {
    owed: vi.fn().mockResolvedValue([owed()]),
    claim: vi.fn().mockResolvedValue('claimed'),
    discharge: vi.fn().mockResolvedValue('accepted'),
    reportFailure: vi.fn().mockResolvedValue(undefined),
  } as unknown as PurchasesApi
  // Issue and deliver use the global fetch; the confirmer was given the same fake.
  vi.stubGlobal('fetch', gw.fetchImpl)
  return { api, ports: portsFor(config, gw.fetchImpl, vault, confirmer, ninetyDayTerm), gatewayUrl: GATEWAY, livemode: false }
}

beforeEach(() => resetMetricsForTest())
afterEach(() => vi.unstubAllGlobals())

describe('who may enrol', () => {
  // Only the stall can enrol itself: an unsigned call is refused 401 and nothing is begun.
  it('refuses an unsigned caller', async () => {
    const { service } = await setup()
    const answer = await service.handle({ method: 'POST', path: BEGIN_PATH, body: '' })
    expect(answer.status).toBe(401)
  })

  // A request signed for another URL (or replayed from another origin) is refused.
  it('refuses a signature made for a different URL', async () => {
    const { call } = await setup()
    const answer = await call('POST', BEGIN_PATH, '', signed('POST', BEGIN_PATH, '', STALL_SK, `https://evil.test${BEGIN_PATH}`))
    expect(answer.status).toBe(401)
  })

  // A captured, valid request cannot be sent a second time.
  it('refuses a replayed signature', async () => {
    const { call } = await setup()
    const auth = signed('POST', BEGIN_PATH)
    expect((await call('POST', BEGIN_PATH, '', auth)).status).toBe(200)
    expect((await call('POST', BEGIN_PATH, '', auth)).status).toBe(401)
  })

  // A different key cannot finish a stall's enrolment: what it signs enrols ITSELF, and it has no
  // enrolment in progress, so it is refused and the stall's vault record is untouched.
  it('does not let another key enrol the stall', async () => {
    const { call, vault } = await setup()
    await call('POST', BEGIN_PATH)
    const intruder = bytesToHex(generateSecretKey())
    const body = JSON.stringify({ credentialId: 'cred-evil', delegation: delegationJson() })
    const answer = await call('POST', ENROL_PATH, body, signed('POST', ENROL_PATH, body, intruder))
    expect(answer.status).toBe(409)
    expect(await vault.get(STALL)).toBeNull()
  })

  // Not configured with its public origin: refused, never guessed from the Host header.
  it('is off when the public origin is not configured', async () => {
    const { vault, confirmer } = await setup()
    const service = new EnrolmentService({ vault, confirmer, publicOrigin: null, validityFor: ninetyDayTerm })
    const answer = await service.handle({ method: 'POST', path: BEGIN_PATH, body: '', authorization: signed('POST', BEGIN_PATH) })
    expect(answer.status).toBe(503)
  })
})

describe('the delegation', () => {
  // A delegation naming a different key than the one this service made is refused, nothing sealed.
  it('refuses one that names another delegate', async () => {
    const { call, vault } = await setup()
    const other = bytesToHex(generateSecretKey())
    const { enrolled } = await enrolAs(call, 'cred-0001', () =>
      delegationJson({ delegate: finalizeEvent({ kind: 1, created_at: 0, tags: [], content: '' }, hexToBytes(other)).pubkey }),
    )
    expect(enrolled.status).toBe(422)
    expect(String(enrolled.body.error)).toMatch(/different key/)
    expect(await vault.get(STALL)).toBeNull()
  })

  // Signed by somebody other than the calling stall: refused.
  it('refuses one not signed by the stall', async () => {
    const { call, vault } = await setup()
    const other = bytesToHex(generateSecretKey())
    const { enrolled } = await enrolAs(call, 'cred-0001', (lock) => delegationJson({ delegate: lock, stallSk: other }))
    expect(enrolled.status).toBe(422)
    expect(await vault.get(STALL)).toBeNull()
  })

  // Wrong scope, and one that would not outlive a coupon minted now by the skew margin: refused.
  it('refuses the wrong scope and a too-short expiry', async () => {
    const { call } = await setup()
    const scope = await enrolAs(call, 'cred-0001', (lock) => delegationJson({ delegate: lock, scope: 'coupon:redeem' }))
    expect(scope.enrolled.status).toBe(422)
    // One day past the stall's 90-day term, inside the week's margin (#312: the stall's term).
    const soon = Math.floor(Date.now() / 1000) + 91 * 86_400
    const short = await enrolAs(call, 'cred-0002', (lock) => delegationJson({ delegate: lock, expiresAt: soon }))
    expect(short.enrolled.status).toBe(422)
    expect(String(short.enrolled.body.error)).toMatch(/outlive/)
  })
})

describe('enrolment', () => {
  // The credential is CONFIRMED at the gateway before it is sealed (#296), signed by the lock key.
  it('confirms at once, then seals', async () => {
    const { call, vault, gw } = await setup()
    const { enrolled, lock } = await enrolAs(call)
    expect(enrolled.status).toBe(200)
    expect(enrolled.body).toMatchObject({ enrolled: true, ready: true, confirmation: 'confirmed' })
    expect(gw.calls).toEqual([`POST ${GATEWAY}/api/v1/wallet/terminal-credentials/cred-0001/confirm`])
    const held = await vault.get(STALL)
    expect(held?.credentialId).toBe('cred-0001')
    expect(JSON.parse(held!.delegation!).tags).toContainEqual(['p', lock])
    expect(renderMetrics()).toContain('imani_purchase_issuer_enrolments_total{result="enrolled"} 1')
  })

  // The answer carries only public things: the lock key's private half never leaves this service.
  it('never sends or stores the lock key in the clear', async () => {
    const { call, vault, path } = await setup()
    const { begun } = await enrolAs(call)
    const secret = (await vault.get(STALL))!.lockKeyHex
    expect(JSON.stringify(begun.body)).not.toContain(secret)
    expect(await readFile(path, 'utf8')).not.toContain(secret)
  })

  // A gateway that says EXPIRED (410) is not sealed; a gateway that is down leaves it retryable.
  it('seals nothing the gateway did not confirm', async () => {
    const { call, vault, gw } = await setup()
    gw.confirmStatus = 503
    const first = await enrolAs(call)
    expect(first.enrolled.status).toBe(502)
    expect(await vault.get(STALL)).toBeNull()
    gw.confirmStatus = 410
    const second = await enrolAs(call, 'cred-0002')
    expect(second.enrolled.status).toBe(409)
    expect(await vault.get(STALL)).toBeNull()
  })

  // #306: after a 502 the phone sends the SAME credential again, and it is sealed. The status the
  // stall reads names the credential (so the phone can tell a lost answer from a failure); the
  // public `/ready` never does.
  it('seals the same credential when the phone retries a 502', async () => {
    const { call, vault, gw } = await setup()
    gw.confirmStatus = 503
    const begun = await call('POST', BEGIN_PATH)
    const body = JSON.stringify({ credentialId: 'cred-0001', delegation: delegationJson({ delegate: begun.body.lockPubkey as string }) })
    expect((await call('POST', ENROL_PATH, body)).status).toBe(502)
    gw.confirmStatus = 204
    const retried = await call('POST', ENROL_PATH, body)
    expect(retried.status).toBe(200)
    expect(retried.body.credentialId).toBe('cred-0001')
    expect((await vault.get(STALL))?.credentialId).toBe('cred-0001')
    const ready = await call('GET', `${READY_PREFIX}${STALL}`)
    expect(JSON.stringify(ready.body)).not.toContain('cred-0001')
  })

  // Re-enrolling REPLACES the stall's one record with the new credential and key, safely.
  it('replaces the record on re-enrolment', async () => {
    const { call, vault, path } = await setup()
    await enrolAs(call, 'cred-0001')
    const firstKey = (await vault.get(STALL))!.lockKeyHex
    const again = await enrolAs(call, 'cred-0002')
    expect(again.enrolled.status).toBe(200)
    const held = await vault.get(STALL)
    expect(held?.credentialId).toBe('cred-0002')
    expect(held?.lockKeyHex).not.toBe(firstKey)
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(1)
  })
})

describe('#306: the begin map cannot be filled to lock stalls out', () => {
  afterEach(() => vi.useRealTimers())

  // A stall that begins again within the cooldown gets the SAME lock key: its minted credential
  // stays enrollable, and a loop of begins cannot churn keys.
  it('answers the same lock key within the cooldown, a fresh one after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { call } = await setup()
    const first = await call('POST', BEGIN_PATH)
    vi.setSystemTime(Date.now() + BEGIN_COOLDOWN_MS - 1000)
    const again = await call('POST', BEGIN_PATH)
    expect(again.status).toBe(200)
    expect(again.body.lockPubkey).toBe(first.body.lockPubkey)
    expect(again.body.expiresAt).toBe(first.body.expiresAt)
    vi.setSystemTime(Date.now() + 2000)
    const later = await call('POST', BEGIN_PATH)
    expect(later.body.lockPubkey).not.toBe(first.body.lockPubkey)
  })

  // A thousand throwaway keys begin; a real stall still can, and it is the oldest that goes.
  it('evicts the oldest begun enrolment instead of refusing a new one', async () => {
    const { call } = await setup()
    const firstIntruder = bytesToHex(generateSecretKey())
    expect((await call('POST', BEGIN_PATH, '', signed('POST', BEGIN_PATH, '', firstIntruder))).status).toBe(200)
    for (let i = 1; i < MAX_PENDING; i++) {
      expect((await call('POST', BEGIN_PATH, '', signed('POST', BEGIN_PATH, '', bytesToHex(generateSecretKey())))).status).toBe(200)
    }
    // Full. The real stall still begins, and enrols.
    const { enrolled } = await enrolAs(call, 'cred-0001')
    expect(enrolled.status).toBe(200)
    // The oldest was the one dropped: its enrol now finds nothing in progress.
    const body = JSON.stringify({ credentialId: 'cred-0002', delegation: delegationJson() })
    const evicted = await call('POST', ENROL_PATH, body, signed('POST', ENROL_PATH, body, firstIntruder))
    expect(evicted.status).toBe(409)
  }, 60_000)
})

describe('status', () => {
  // The stall's own GET: enrolled, confirmation, delegation expiry, readiness. No gateway call.
  it('reports needs-setup, then on, for the stall', async () => {
    const { call, gw } = await setup()
    const before = await call('GET', ENROL_PATH)
    expect(before.status).toBe(200)
    expect(before.body).toMatchObject({ enrolled: false, ready: false })
    await enrolAs(call)
    const calls = gw.calls.length
    const after = await call('GET', ENROL_PATH)
    expect(after.body).toMatchObject({
      enrolled: true,
      confirmation: 'confirmed',
      delegationValid: true,
      delegationExpiresAt: 4_000_000_000,
      ready: true,
    })
    expect(gw.calls.length).toBe(calls)
  })

  // An expired credential reads as not ready, with the reason.
  it('reports an expired credential as not ready', async () => {
    const { call, confirmer, vault } = await setup()
    await enrolAs(call)
    const expiring = new CredentialConfirmer(GATEWAY, (async () => new Response(null, { status: 410 })) as unknown as typeof fetch)
    await expiring.confirm((await vault.get(STALL))!)
    const service = new EnrolmentService({ vault, confirmer: expiring, publicOrigin: ORIGIN, validityFor: ninetyDayTerm })
    expect(await service.status(STALL)).toMatchObject({ enrolled: true, confirmation: 'expired', ready: false })
    expect(confirmer.standingOf('cred-0001')).toBe('confirmed')
  })

  // The public readiness check the Buy button uses: unauthenticated, says only ready or not.
  it('answers readiness publicly, and nothing else', async () => {
    const { call, service } = await setup()
    const before = await service.handle({ method: 'GET', path: `${READY_PREFIX}${STALL}`, body: '' })
    expect(before.body).toEqual({ ready: false })
    await enrolAs(call)
    const after = await service.handle({ method: 'GET', path: `${READY_PREFIX}${STALL}`, body: '' })
    expect(after.body).toEqual({ ready: true })
    expect((await service.handle({ method: 'GET', path: `${READY_PREFIX}nope`, body: '' })).status).toBe(400)
  })
})

describe('#290: issued with no restart', () => {
  // THE regression. The worker reads the vault (empty), the stall enrols through the running
  // service, and the very next pass mints for that stall's paid purchase. No new process.
  it('issues a sale for a stall enrolled after the vault was first read', async () => {
    const { call, vault, confirmer, gw } = await setup()
    const deps = workerFor(vault, confirmer, gw)

    const first = await runPass(deps)
    expect(first.discharged).toBe(0)
    expect(attemptCount('no_credential')).toBe(1)
    expect(renderMetrics()).toContain('imani_purchase_issuer_owed_unenrolled 1')

    expect((await enrolAs(call)).enrolled.status).toBe(200)

    const second = await runPass(deps)
    expect(second.discharged).toBe(1)
    expect(gw.calls.some((c) => c === `POST ${GATEWAY}/api/v1/wallet/vouchers`)).toBe(true)
    expect(renderMetrics()).toContain('imani_purchase_issuer_owed_unenrolled 0')
  })
})

describe('#312: readiness follows the stall\u2019s voucher validity', () => {
  /** An enrolled stall whose readiness is judged against `validity`. */
  async function enrolledWith(validity: StallValidity, delegation?: (lock: string) => string) {
    const { call, vault, confirmer } = await setup()
    expect((await enrolAs(call, 'cred-0001', delegation)).enrolled.status).toBe(200)
    const service = new EnrolmentService({ vault, confirmer, publicOrigin: ORIGIN, validityFor: async () => validity })
    const ready = await service.handle({ method: 'GET', path: `${READY_PREFIX}${STALL}`, body: '' })
    return { service, ready: ready.body, status: await service.status(STALL) }
  }
  const days = (n: number): StallValidity => ({ kind: 'days', days: n, source: 'record' })

  // A never-expiring stall is NOT ready, BEFORE anyone pays: Buy stays off, with a code it can show.
  it('answers not ready for a never-expiring stall, with validity_never_expires', async () => {
    const { ready, status } = await enrolledWith(days(0))
    expect(ready).toEqual({ ready: false, reason: 'validity_never_expires' })
    expect(status).toMatchObject({ ready: false, reasonCode: 'validity_never_expires', delegationValid: false })
    expect(status.reason).toMatch(/voucher validity/)
  })

  // A term longer than the delegation less a week: not ready, with its own code.
  it('answers not ready when the term outlives the delegation', async () => {
    const soon = Math.floor(Date.now() / 1000) + 200 * 86_400
    const short = (lock: string) => delegationJson({ delegate: lock, expiresAt: soon })
    const { ready } = await enrolledWith(days(730), short)
    expect(ready).toEqual({ ready: false, reason: 'validity_outlives_delegation' })
  })

  // 30, 60, 90 and the 730 maximum are all ready under the phone's long delegation.
  it.each([30, 60, 90, 730])('answers ready for a %i-day stall', async (n) => {
    const { ready } = await enrolledWith(days(n))
    expect(ready).toEqual({ ready: true })
  })

  // An unreadable record is not ready either: fail safe, never a sale on a guess.
  it('answers not ready when the record cannot be read', async () => {
    const { ready } = await enrolledWith({ kind: 'unreadable', reason: 'down' })
    expect(ready).toEqual({ ready: false, reason: 'validity_unknown' })
  })

  // Enrolment is judged against the stall's ACTUAL term: a never-expiring stall may still enrol
  // (readiness then tells it what to change), but a delegation too short for its term is refused.
  it('lets a never-expiring stall enrol, and refuses a delegation shorter than the stall\u2019s term', async () => {
    const { vault, confirmer } = await setup()
    const never = new EnrolmentService({ vault, confirmer, publicOrigin: ORIGIN, validityFor: async () => days(0) })
    const callNever = (method: string, p: string, body = '') =>
      never.handle({ method, path: p, body, authorization: signed(method, p, body) })
    const ok = await enrolAs(callNever)
    expect(ok.enrolled.status).toBe(200)

    const long = new EnrolmentService({ vault, confirmer, publicOrigin: ORIGIN, validityFor: async () => days(730) })
    const callLong = (method: string, p: string, body = '') =>
      long.handle({ method, path: p, body, authorization: signed(method, p, body) })
    const soon = Math.floor(Date.now() / 1000) + 400 * 86_400
    const refused = await enrolAs(callLong, 'cred-0002', (lock) => delegationJson({ delegate: lock, expiresAt: soon }))
    expect(refused.enrolled.status).toBe(422)
  })
})

describe('gc#317: readiness follows the stall\u2019s Free plan sales allowance', () => {
  const TOKEN = 'pa-shared-token'
  const gbp = async (): Promise<StallValidity> => ({ kind: 'days', days: 90, source: 'record', currency: 'GBP' })

  /** An enrolled stall, with readiness asked through `allowanceFor`. */
  async function enrolledWithAllowance(position: SalesPosition, validityFor: () => Promise<StallValidity> = gbp) {
    const { call, vault, confirmer } = await setup()
    expect((await enrolAs(call)).enrolled.status).toBe(200)
    const asked: Array<{ stall: string; unit: string }> = []
    const service = new EnrolmentService({
      vault,
      confirmer,
      publicOrigin: ORIGIN,
      validityFor,
      internalToken: TOKEN,
      allowanceFor: async (credential, unit) => {
        asked.push({ stall: credential.stallPubkey, unit })
        return position
      },
    })
    const ready = async (query = '', authorization?: string) =>
      (await service.handle({ method: 'GET', path: `${READY_PREFIX}${STALL}${query}`, body: '', authorization })).body
    return { ready, asked }
  }

  // jan's case: a Free stall at its allowance is NOT ready, so Buy is off and nobody pays.
  it('answers not ready, sales_limit_reached, for a stall at its allowance', async () => {
    const { ready, asked } = await enrolledWithAllowance({ kind: 'limited', unit: 'GBP', remainingMinor: 0 })
    expect(await ready()).toEqual({ ready: false, reason: 'sales_limit_reached' })
    // Asked in the currency the stall's own signed record names.
    expect(asked).toEqual([{ stall: STALL, unit: 'GBP' }])
  })

  // A paid plan, or allowance left: ready, as before.
  it.each<SalesPosition>([{ kind: 'unlimited' }, { kind: 'limited', unit: 'GBP', remainingMinor: 1 }])(
    'answers ready for %o',
    async (position) => {
      const { ready } = await enrolledWithAllowance(position)
      expect(await ready()).toEqual({ ready: true })
    },
  )

  // Card payments are Essentials and above: no paid plan, no card sale, allowance or not.
  it.each<SalesPosition>([
    { kind: 'unlimited', paidPlan: false },
    { kind: 'limited', unit: 'GBP', remainingMinor: 10_000, paidPlan: false },
  ])('answers not ready, card_payments_not_in_plan, for a Starter stall (%o)', async (position) => {
    const { ready } = await enrolledWithAllowance(position)
    expect(await ready()).toEqual({ ready: false, reason: 'card_payments_not_in_plan' })
  })

  // The checkout's own question (payment-adapter, with the token and an amount) is refused too.
  it('refuses the checkout for a Starter stall, before any amount is judged', async () => {
    const { ready } = await enrolledWithAllowance({ kind: 'limited', unit: 'GBP', remainingMinor: 10_000, paidPlan: false })
    expect(await ready('?unit=GBP&amount=500', `Bearer ${TOKEN}`)).toEqual({ ready: false, reason: 'card_payments_not_in_plan' })
  })

  // A paid plan sells; a gateway that said nothing about the plan (older, or its store down) refuses nothing.
  it.each<SalesPosition>([
    { kind: 'unlimited', paidPlan: true },
    { kind: 'unlimited' },
  ])('stays ready for %o', async (position) => {
    const { ready } = await enrolledWithAllowance(position)
    expect(await ready()).toEqual({ ready: true })
  })

  // Advice only: a gateway that cannot answer must not take every stall off sale. The mint re-checks.
  it('stays ready when the allowance cannot be read', async () => {
    const { ready } = await enrolledWithAllowance({ kind: 'unknown', reason: 'down' })
    expect(await ready()).toEqual({ ready: true })
  })

  // `unit=` (payment-adapter sends the Stripe currency) wins over the record's, for the internal caller.
  it('asks in the unit the internal caller names', async () => {
    const { ready, asked } = await enrolledWithAllowance({ kind: 'unlimited' })
    await ready('?unit=eur', `Bearer ${TOKEN}`)
    expect(asked[0].unit).toBe('EUR')
  })

  // From anyone else it is ignored: an invented unit must not cost a gateway read, or read as reached.
  it('ignores a unit from a public caller', async () => {
    const { ready, asked } = await enrolledWithAllowance({ kind: 'unlimited' })
    await ready('?unit=xyz')
    expect(asked[0].unit).toBe('GBP')
  })

  // No unit anywhere (no record currency, none asked): nothing to advise, nothing asked.
  it('does not ask without a unit', async () => {
    const none = async (): Promise<StallValidity> => ({ kind: 'days', days: 90, source: 'default' })
    const { ready, asked } = await enrolledWithAllowance({ kind: 'limited', unit: 'GBP', remainingMinor: 0 }, none)
    expect(await ready()).toEqual({ ready: true })
    expect(asked).toEqual([])
  })

  // With the shared token, the amount counts: more than is left is refused for this sale only.
  it('refuses an amount over what is left, for the internal caller', async () => {
    const { ready } = await enrolledWithAllowance({ kind: 'limited', unit: 'GBP', remainingMinor: 7000 })
    const auth = `Bearer ${TOKEN}`
    expect(await ready('?unit=GBP&amount=7001', auth)).toEqual({ ready: false, reason: 'sales_limit_exceeded' })
    expect(await ready('?unit=GBP&amount=7000', auth)).toEqual({ ready: true })
  })

  // Without it the amount is ignored: told to anyone, it would let a stranger bisect a stall's sales.
  it.each([undefined, 'Bearer wrong', `Nostr ${TOKEN}`, 'Bearer '])('ignores the amount for %s', async (auth) => {
    const { ready } = await enrolledWithAllowance({ kind: 'limited', unit: 'GBP', remainingMinor: 7000 })
    expect(await ready('?unit=GBP&amount=999999', auth)).toEqual({ ready: true })
  })

  // An empty configured token trusts nobody, even a caller presenting an empty bearer.
  it('trusts nobody when no token is configured', async () => {
    const { call, vault, confirmer } = await setup()
    await enrolAs(call)
    const service = new EnrolmentService({
      vault,
      confirmer,
      publicOrigin: ORIGIN,
      validityFor: gbp,
      internalToken: '',
      allowanceFor: async () => ({ kind: 'limited', unit: 'GBP', remainingMinor: 10 }),
    })
    const answer = await service.handle({
      method: 'GET',
      path: `${READY_PREFIX}${STALL}?amount=500`,
      body: '',
      authorization: 'Bearer ',
    })
    expect(answer.body).toEqual({ ready: true })
  })

  // A not-ready stall keeps its own reason, and the gateway is not asked for nothing.
  it('keeps an earlier reason and does not ask', async () => {
    const never = async (): Promise<StallValidity> => ({ kind: 'days', days: 0, source: 'record', currency: 'GBP' })
    const { ready, asked } = await enrolledWithAllowance({ kind: 'limited', unit: 'GBP', remainingMinor: 0 }, never)
    expect(await ready()).toEqual({ ready: false, reason: 'validity_never_expires' })
    expect(asked).toEqual([])
  })
})

describe('the pull on login: resend (imani-wallet#275)', () => {
  async function resendService(result: import('../salePull').ResendResult | undefined) {
    const { vault, confirmer } = await setup()
    const asked: Array<{ stall: string; ids: readonly string[] }> = []
    const service = new EnrolmentService({
      vault,
      confirmer,
      publicOrigin: ORIGIN,
      validityFor: ninetyDayTerm,
      ...(result ? { resend: async (stall: string, ids: readonly string[]) => (asked.push({ stall, ids }), result) } : {}),
    })
    const call = (body: string, authorization?: string) =>
      service.handle({ method: 'POST', path: RESEND_PATH, body, authorization: authorization ?? signed('POST', RESEND_PATH, body) })
    return { call, asked }
  }

  it('re-sends for the SIGNER, with the ids as a filter', async () => {
    const { call, asked } = await resendService({ kind: 'sent', sent: 1, failed: [], unknown: ['x-100000'] })
    const answer = await call(JSON.stringify({ voucherIds: ['8027e345', 'x-100000'] }))
    expect(answer).toEqual({ status: 200, body: { sent: 1, failed: [], unknown: ['x-100000'] } })
    expect(asked).toEqual([{ stall: STALL, ids: ['8027e345', 'x-100000'] }])
  })

  it('refuses an unsigned caller, and another key asks only for its own sales', async () => {
    const { call, asked } = await resendService({ kind: 'sent', sent: 0, failed: [], unknown: [] })
    expect((await call('{}', 'Nostr e30=')).status).toBe(401)
    const intruder = bytesToHex(generateSecretKey())
    await call('{}', signed('POST', RESEND_PATH, '{}', intruder))
    expect(asked.map((a) => a.stall)).not.toContain(STALL)
  })

  it('refuses malformed ids and too many of them', async () => {
    const { call, asked } = await resendService({ kind: 'sent', sent: 0, failed: [], unknown: [] })
    expect((await call(JSON.stringify({ voucherIds: ['../etc'] }))).status).toBe(400)
    expect((await call(JSON.stringify({ voucherIds: Array.from({ length: 51 }, (_, i) => `v-${i}000`) }))).status).toBe(400)
    expect((await call('not json')).status).toBe(400)
    expect(asked).toEqual([])
  })

  it('allows one resend per stall per cooldown, and does not burn it on an outage', async () => {
    const { call, asked } = await resendService({ kind: 'sent', sent: 0, failed: [], unknown: [] })
    expect((await call('{}')).status).toBe(200)
    expect((await call('{}')).status).toBe(429)
    expect(asked).toHaveLength(1)
    const down = await resendService({ kind: 'unavailable' })
    expect((await down.call('{}')).status).toBe(503)
    expect((await down.call('{}')).status).toBe(503)
  })

  it('answers 404 for an unenrolled stall, 503 when payment-adapter is down or resend is not wired', async () => {
    expect((await (await resendService({ kind: 'not-enrolled' })).call('{}')).status).toBe(404)
    expect((await (await resendService({ kind: 'unavailable' })).call('{}')).status).toBe(503)
    expect((await (await resendService(undefined)).call('{}')).status).toBe(503)
  })
})
