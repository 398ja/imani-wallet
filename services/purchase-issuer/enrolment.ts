/**
 * A stall turns on card sales, from its own phone (imani-wallet#298, #290, #296).
 *
 * Before this, a stall could only be enrolled with this service by an operator script that held
 * the stall's key (`s3-enrol.mts`, `s3-seal.mts`, `attachDelegation.ts`). So no real merchant
 * could sell vouchers by card, and every paid purchase for a stall nobody had scripted sat OWED.
 *
 * ## The rule this is built around
 *
 * **The stall's key never leaves the stall's phone** (owner, 2026-10-18). Everything signed by
 * the stall is signed on the phone: the NIP-98 auth of each call here, the credential mint at the
 * gateway, the owner attestation inside it, and the `coupon:issue` delegation. This service only
 * ever receives SIGNED ARTEFACTS and public data, and never signs as the stall.
 *
 * ## And the credential's secret never leaves this service
 *
 * A credential's secret is the private half of the key it is locked to (`vault.ts`). The scripts
 * already had the right shape for it: the lock key is generated INSIDE purchase-issuer and only
 * its public half goes out. Kept, and made a protocol:
 *
 *   1. `POST /api/v1/card-sales/enrolment/begin` (NIP-98, the stall). This service makes a fresh
 *      lock key for that stall, holds it in memory, and answers its PUBLIC key plus the device
 *      enrolment proof gateway-customer wants for a new terminal key (signed by the lock key,
 *      `X-Imani-Terminal-Enrolment`).
 *   2. On the phone: the stall mints an `issue-and-redeem` terminal credential locked to that
 *      public key, checks the token it gets back, and signs a kind-30078 delegation naming it.
 *   3. `POST /api/v1/card-sales/enrolment` (NIP-98, the stall) with the credential id and the
 *      delegation event. This service checks the delegation, CONFIRMS the credential at the
 *      gateway at once (#296), seals the record, and the next pass can mint (#290): the vault
 *      write drops the cache, so no restart.
 *
 * The alternative, the phone generating the lock key and sending it here, would put an issuing
 * secret on the wire and in the phone's memory for no gain. This way the only copies of it are
 * in this process and, sealed, in the vault.
 *
 * ## What the confirm proves
 *
 * The credential id arrives from the caller. It is not trusted on its own: the gateway accepts a
 * confirm signed by the lock key only for a credential locked to that key, so a 204 means "this
 * id is a credential locked to the key this service just made". Anything else is not sealed.
 *
 * ## Never logged
 *
 * The lock key, obviously. Also the NIP-98 header and the request body: neither is secret, but a
 * log line that prints request material is the line someone later extends to print a key.
 */
import { createHash, timingSafeEqual } from 'node:crypto'

import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools/pure'

import type { ConfirmStanding } from './adapters'
import type { CredentialConfirmer } from './confirmation'
import { checkDelegation, couponExpiresAtMs, type DelegationCheck } from './delegatedWarrant'
import type { StallCredential } from './issuer'
import type { StallValidity } from './stallValidity'
import { countEnrolment } from './metrics'
import { MAX_RESEND, type ResendResult } from './salePull'
import { ReplayGuard, verifyNip98 } from './nip98Auth'
import { allowanceVerdict, normaliseUnit, type AllowanceReader } from './salesAllowance'
import type { CredentialVault } from './vault'

/** Where the stall calls. Under `/api/v1` so the edge can route this prefix and nothing else. */
export const ENROLMENT_PREFIX = '/api/v1/card-sales'

/** Why a never-expiring stall cannot sell by card. Mirrors the wallet's Settings copy (#312). */
export const CARD_SALES_NEED_VALIDITY =
  'Card sales need a voucher validity: vouchers that never expire can’t be sold by card. Choose 30, 60 or 90 days, or your own up to 730, in your shop settings.'
export const BEGIN_PATH = `${ENROLMENT_PREFIX}/enrolment/begin`
export const ENROL_PATH = `${ENROLMENT_PREFIX}/enrolment`
/**
 * The pull on login (imani-wallet#275): re-send this stall's missed card-sale records. NIP-98 as the
 * stall; body `{ "voucherIds": [...] }` (a filter, see `salePull.ts`).
 */
export const RESEND_PATH = `${ENROLMENT_PREFIX}/sales/resend`
/** At most one resend per stall in this window (each one may publish `MAX_RESEND` records). */
export const RESEND_COOLDOWN_MS = 60_000
/** Public: may shoppers be sold a card purchase for this stall? `/ready/<stall pubkey>`. */
export const READY_PREFIX = `${ENROLMENT_PREFIX}/ready/`

/** How long a begun enrolment waits for its credential. Minting takes seconds; a phone may sleep. */
export const PENDING_TTL_MS = 30 * 60_000
/**
 * Begun enrolments held at once. Anyone can make a key and begin, so this is bounded, and when it
 * is full the OLDEST begun enrolment is dropped rather than the newcomer refused (#306): refusing
 * let anyone with a thousand throwaway keys lock every real stall out of enrolling.
 */
export const MAX_PENDING = 1_000
/**
 * A stall that begins again within this long gets the SAME lock key back (#306). So one key
 * cannot churn fresh lock keys in a loop, and a phone retrying a lost answer, or retrying its
 * enrol, keeps the key its minted credential is locked to.
 */
export const BEGIN_COOLDOWN_MS = 60_000
/** The largest body accepted. A delegation event is well under 1 KiB. */
export const MAX_BODY_BYTES = 16 * 1024

/** Mirrors `ENROLMENT_*` in `src/lib/terminalEnrolProof.ts`; this image may not import it. */
const ENROLMENT_TAG = 'imani-terminal-enrolment'
const US = '\u001f'

const HEX64 = /^[0-9a-f]{64}$/
/** gateway-customer voucher ids are UUIDs; accepted a little wider, never with a path in it. */
const CREDENTIAL_ID = /^[0-9A-Za-z-]{8,64}$/

export interface EnrolmentRequest {
  method: string
  /** Path and query, as received. */
  path: string
  authorization?: string
  body: string
}

export interface EnrolmentResponse {
  status: number
  body: Record<string, unknown>
}

/** What a stall is told about itself. */
export interface EnrolmentStatus {
  enrolled: boolean
  /**
   * The enrolled credential's id (#306). Told only to the stall itself (the NIP-98 caller), never
   * on `/ready`: the phone uses it to cancel the credential a re-enrolment supersedes.
   */
  credentialId?: string
  /** The credential's standing at the gateway, when this process knows it. */
  confirmation: ConfirmStanding | 'unknown' | null
  /** The delegation's expiry, epoch seconds. */
  delegationExpiresAt: number | null
  /** False when the delegation would not cover a coupon minted now (renew it). */
  delegationValid: boolean
  /** Card purchases can mint now: enrolled, delegation valid, credential not expired. */
  ready: boolean
  /** The plain reason when not ready. */
  reason?: string
  /**
   * A stable code for the reasons the stall fixes in its own settings rather than by re-enrolling
   * (imani-wallet#312). Also on the public `/ready` answer, so Buy can say why.
   *
   * - `validity_never_expires`: the stall's coupons never expire; a card coupon cannot outlive
   *   its delegation, so card sales need a voucher validity.
   * - `validity_outlives_delegation`: the stall's term ends after the delegation (less a week).
   * - `validity_unknown`: the stall's merchant record could not be read just now.
   */
  reasonCode?: ReadinessCode
}

export type ReadinessCode =
  | 'validity_never_expires'
  | 'validity_outlives_delegation'
  | 'validity_unknown'
  /** The stall is on the Free plan and has used its lifetime sales allowance (gc#317). */
  | 'sales_limit_reached'
  /** This amount would take a Free stall past its allowance. Only told to a trusted caller. */
  | 'sales_limit_exceeded'
  /**
   * The stall has no paid plan in force: card payments are Essentials and above, never Starter. From
   * the gateway's `paid_plan: false`; a gateway that did not answer refuses nothing.
   */
  | 'card_payments_not_in_plan'

interface Pending {
  lockKeyHex: string
  at: number
}

export interface EnrolmentDeps {
  vault: CredentialVault
  confirmer: CredentialConfirmer
  /** The public origin the stall signs NIP-98 for, e.g. https://app.example. Null: not configured. */
  publicOrigin: string | null
  now?: () => number
  /**
   * The stall's current coupon validity (#312, `stallValidity.ts`). Readiness depends on it: a
   * stall whose term no delegated card coupon can honour is not ready, BEFORE anyone pays.
   */
  validityFor: (stallPubkey: string) => Promise<StallValidity>
  /**
   * The stall's Free plan sales allowance (`salesAllowance.ts`). Absent: readiness ignores the
   * allowance, as before. Its answer is advice: an unknown keeps a stall ready, because the mint
   * re-checks, and a gateway blip must not take every stall off sale.
   */
  allowanceFor?: AllowanceReader
  /**
   * The internal token payment-adapter presents (`PURCHASE_API_TOKEN`). Only a caller holding it
   * may ask about one amount: told to anyone, `amount=` would let a stranger binary-search a stall's
   * remaining allowance and so its lifetime sales. Absent or empty: no caller is trusted.
   */
  internalToken?: string
  /** The pull on login (`salePull.ts`). Absent: `RESEND_PATH` answers 503. */
  resend?: (stallPubkey: string, voucherIds: readonly string[]) => Promise<ResendResult>
}

export class EnrolmentService {
  private readonly pending = new Map<string, Pending>()
  private readonly replay = new ReplayGuard()
  /** Last resend per stall (epoch ms): one stall cannot turn the issuer into a publish amplifier. */
  private readonly lastResend = new Map<string, number>()
  private readonly deps: EnrolmentDeps
  private readonly now: () => number

  constructor(deps: EnrolmentDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
  }

  /** Routes one request under `ENROLMENT_PREFIX`. Never throws. */
  async handle(request: EnrolmentRequest): Promise<EnrolmentResponse> {
    try {
      const path = request.path.split('?')[0]
      if (request.method === 'GET' && path.startsWith(READY_PREFIX)) {
        return await this.ready(path.slice(READY_PREFIX.length), request)
      }
      if (request.method === 'POST' && path === BEGIN_PATH) return await this.authed(request, (s) => this.begin(s))
      if (request.method === 'POST' && path === ENROL_PATH) {
        return await this.authed(request, (s) => this.enrol(s, request.body))
      }
      if (request.method === 'GET' && path === ENROL_PATH) {
        return await this.authed(request, async (s) => ({ status: 200, body: { ...(await this.status(s)) } }))
      }
      if (request.method === 'POST' && path === RESEND_PATH) {
        return await this.authed(request, (s) => this.resend(s, request.body))
      }
      return { status: 404, body: { error: 'not found' } }
    } catch {
      // Nothing about the request is echoed: it may be attacker-supplied.
      console.error(JSON.stringify({ event: 'card_sales_enrolment_error' }))
      return { status: 500, body: { error: 'enrolment failed; nothing was changed' } }
    }
  }

  /**
   * The caller, from its NIP-98 signature, or a refusal. 401 for every authentication failure,
   * with the reason, so a phone with a wrong clock is told about the clock.
   */
  private async authed(
    request: EnrolmentRequest,
    then: (stall: string) => Promise<EnrolmentResponse>,
  ): Promise<EnrolmentResponse> {
    if (this.deps.publicOrigin === null) {
      // Fail closed. Deriving the signed URL from a Host header lets a request signed for any
      // origin be replayed here.
      return { status: 503, body: { error: 'card-sales enrolment is not configured (PURCHASE_PUBLIC_ORIGIN)' } }
    }
    if (Buffer.byteLength(request.body, 'utf8') > MAX_BODY_BYTES) {
      return { status: 413, body: { error: 'request too large' } }
    }
    const auth = verifyNip98({
      header: request.authorization,
      url: `${this.deps.publicOrigin}${request.path}`,
      method: request.method,
      body: request.body,
      now: Math.floor(this.now() / 1000),
    })
    if (!auth.ok) {
      countEnrolment('unauthenticated')
      return { status: 401, body: { error: `not signed by a stall: ${auth.reason}` } }
    }
    if (!this.replay.accept(auth.eventId, this.now())) {
      countEnrolment('unauthenticated')
      return { status: 401, body: { error: 'this signed request was already used; sign a new one' } }
    }
    return then(auth.pubkey)
  }

  /** The pull on login: re-send the stall's missed sale records (imani-wallet#275). */
  private async resend(stall: string, raw: string): Promise<EnrolmentResponse> {
    if (!this.deps.resend) return { status: 503, body: { error: 'sale record resend is not configured' } }
    let body: { voucherIds?: unknown }
    try {
      body = raw === '' ? {} : (JSON.parse(raw) as typeof body)
    } catch {
      return { status: 400, body: { error: 'the body is not JSON' } }
    }
    const ids = body?.voucherIds === undefined ? [] : body.voucherIds
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_RESEND ||
      !ids.every((id) => typeof id === 'string' && CREDENTIAL_ID.test(id))
    ) {
      return { status: 400, body: { error: `voucherIds must be at most ${MAX_RESEND} voucher ids` } }
    }
    const now = this.now()
    const last = this.lastResend.get(stall)
    if (last !== undefined && now - last < RESEND_COOLDOWN_MS) {
      return { status: 429, body: { error: 'sale records were re-sent moments ago; try again later' } }
    }
    this.lastResend.set(stall, now)
    for (const [s, at] of this.lastResend) if (now - at >= RESEND_COOLDOWN_MS) this.lastResend.delete(s)
    const result = await this.deps.resend(stall, ids as string[])
    // An outage must not cost the stall its next try.
    if (result.kind !== 'sent') this.lastResend.delete(stall)
    if (result.kind === 'not-enrolled') return { status: 404, body: { error: 'card sales are not set up for this stall' } }
    if (result.kind === 'unavailable') {
      return { status: 503, body: { error: 'the stall\u2019s card sales could not be read just now; try again later' } }
    }
    return { status: 200, body: { sent: result.sent, failed: result.failed, unknown: result.unknown } }
  }

  /** Step 1: a fresh lock key for this stall. Its private half stays here. */
  private async begin(stall: string): Promise<EnrolmentResponse> {
    this.sweep()
    const earlier = this.pending.get(stall)
    let lockKeyHex: string
    if (earlier && this.now() - earlier.at < BEGIN_COOLDOWN_MS) {
      // Within the cooldown the same key is answered again (#306). Not refreshed: the cooldown
      // runs from the key's own creation, so a loop of begins cannot keep one alive past it.
      lockKeyHex = earlier.lockKeyHex
    } else {
      // Full: drop the OLDEST begun enrolment, never refuse this one (#306). A `Map` iterates in
      // insertion order, and every entry is re-inserted when it is replaced, so the first is the
      // oldest.
      this.pending.delete(stall)
      while (this.pending.size >= MAX_PENDING) {
        const oldest = this.pending.keys().next().value
        if (oldest === undefined) break
        this.pending.delete(oldest)
      }
      lockKeyHex = bytesToHex(schnorr.utils.randomSecretKey())
      // Beginning again after the cooldown REPLACES a begun one: the phone simply starts over.
      this.pending.set(stall, { lockKeyHex, at: this.now() })
    }
    const lockPubkey = getPublicKey(hexToBytes(lockKeyHex))
    const begunAt = this.pending.get(stall)!.at
    const createdAt = Math.floor(this.now() / 1000)
    const digest = sha256(utf8ToBytes([ENROLMENT_TAG, '1', lockPubkey, String(createdAt)].join(US)))
    const sig = bytesToHex(schnorr.sign(digest, hexToBytes(lockKeyHex)))
    return {
      status: 200,
      body: {
        lockPubkey,
        // `X-Imani-Terminal-Enrolment` for the mint: proof that this key was made as a terminal.
        enrolmentProof: `1:${createdAt}:${sig}`,
        expiresAt: Math.floor((begunAt + PENDING_TTL_MS) / 1000),
      },
    }
  }

  /** Step 3: the minted credential's id and the stall's delegation. */
  private async enrol(stall: string, raw: string): Promise<EnrolmentResponse> {
    const refuse = (status: number, error: string): EnrolmentResponse => {
      countEnrolment('refused')
      return { status, body: { error } }
    }
    this.sweep()
    const pending = this.pending.get(stall)
    if (!pending) return refuse(409, 'no enrolment in progress for this stall; start again')

    let body: { credentialId?: unknown; delegation?: unknown }
    try {
      body = JSON.parse(raw) as typeof body
    } catch {
      return refuse(400, 'the body is not JSON')
    }
    const credentialId = typeof body?.credentialId === 'string' ? body.credentialId : ''
    if (!CREDENTIAL_ID.test(credentialId)) return refuse(400, 'credentialId is not a credential id')
    const delegation =
      typeof body.delegation === 'string'
        ? body.delegation
        : body.delegation && typeof body.delegation === 'object'
          ? JSON.stringify(body.delegation)
          : ''
    if (delegation === '') return refuse(400, 'delegation (the signed kind-30078 event) is required')

    const candidate: StallCredential = {
      stallPubkey: stall,
      credentialId,
      lockKeyHex: pending.lockKeyHex,
      delegation,
    }
    // The same check the mint applies, so a delegation stored here is one the next sale accepts:
    // signed by THIS stall (the NIP-98 caller), `coupon:issue`, the `imani:issuer-delegation`
    // record, naming the lock key made in step 1, outliving a coupon minted now by
    // DELEGATION_SKEW_MARGIN_MS.
    //
    // Against the stall's ACTUAL term, not the 730-day maximum (#312). The maximum cannot be the
    // test: the phone signs for 737 days, which covers 730 + 7 only at the very second it is
    // signed, so every enrolment would be refused a moment later. And the actual term is what the
    // next sale mints. A term the delegation cannot back (never expires, unreadable) does not stop
    // the stall enrolling: the delegation itself is checked as for a same-day coupon, and
    // readiness then says what the stall must change, so Buy stays off until it does.
    const verdict = this.coversTerm(candidate, await this.deps.validityFor(stall))
    if (!verdict.ok && verdict.code === undefined) return refuse(422, `delegation refused: ${verdict.reason}`)
    if (!verdict.ok && verdict.code === 'outlives_delegation') {
      return refuse(422, `delegation refused: ${verdict.reason}`)
    }

    // CONFIRM before sealing (#296). Also the proof that this id is a credential locked to the
    // key made in step 1 (see the module header).
    const standing = await this.deps.confirmer.confirm(candidate)
    if (standing === 'expired') {
      this.pending.delete(stall)
      return refuse(409, 'the gateway says this credential expired or was cancelled; start again')
    }
    if (standing !== 'confirmed') {
      // Kept pending, so the phone can send the same request again once the gateway answers.
      return refuse(502, 'the gateway did not confirm the credential; try again in a moment')
    }

    // Replaces any earlier record for this stall (`vault.put`), and drops the cache, so the next
    // pass reads it with no restart (#290).
    await this.deps.vault.put(candidate)
    this.pending.delete(stall)
    countEnrolment('enrolled')
    console.log(
      JSON.stringify({
        event: 'card_sales_enrolled',
        stall: stall.slice(0, 16),
        credential: credentialId.slice(0, 8),
      }),
    )
    return { status: 200, body: { ...(await this.status(stall)) } }
  }

  /** What this stall's card sales look like from here. Never calls the gateway. */
  async status(stall: string): Promise<EnrolmentStatus> {
    const credential = await this.deps.vault.get(stall)
    if (credential === null) {
      return {
        enrolled: false,
        confirmation: null,
        delegationExpiresAt: null,
        delegationValid: false,
        ready: false,
        reason: 'Card sales are not set up for this stall.',
      }
    }
    const confirmation = this.deps.confirmer.standingOf(credential.credentialId) ?? 'unknown'
    // Judged against the stall's CURRENT term, read the same way the mint reads it (#312).
    const validity = await this.deps.validityFor(stall)
    const verdict = this.coversTerm(credential, validity)
    const delegationExpiresAt = expirationOf(credential.delegation)
    let reason: string | undefined
    let reasonCode: ReadinessCode | undefined
    if (confirmation === 'expired') reason = 'The card-sales credential expired or was cancelled. Turn card sales on again.'
    else if (!verdict.ok && verdict.code === undefined) reason = `Card sales need renewing (${verdict.reason}).`
    else if (validity.kind === 'unreadable') {
      reason = 'Your voucher validity could not be checked just now. Try again in a minute.'
      reasonCode = 'validity_unknown'
    } else if (!verdict.ok && verdict.code === 'never_expires') {
      reason = CARD_SALES_NEED_VALIDITY
      reasonCode = 'validity_never_expires'
    } else if (!verdict.ok && verdict.code === 'outlives_delegation') {
      reason = `Your voucher validity (${validity.days} days) is longer than card sales are set up for. Choose a shorter validity, or set up card sales again.`
      reasonCode = 'validity_outlives_delegation'
    }
    // `unconfirmed`/`unknown` stay ready: the confirm is retried before the first mint, and a
    // gateway blip must not take a working stall off sale.
    return {
      enrolled: true,
      credentialId: credential.credentialId,
      confirmation,
      delegationExpiresAt,
      // A delegation that cannot back this term is not "valid" for card sales, whatever its date.
      delegationValid: verdict.ok,
      ready: reason === undefined,
      ...(reason ? { reason } : {}),
      ...(reasonCode ? { reasonCode } : {}),
    }
  }

  /**
   * Does this credential's delegation back a coupon minted now for the stall's term? An
   * unreadable term is checked as a same-day coupon, so the delegation's own faults still show.
   */
  private coversTerm(credential: StallCredential, validity: StallValidity): DelegationCheck {
    const now = this.now()
    if (validity.kind === 'unreadable') return checkDelegation(credential, now)
    return checkDelegation(credential, couponExpiresAtMs(now, validity.days))
  }

  /**
   * Public readiness, for the Buy button. Says nothing a stall's `acceptsCards` does not, except
   * that a Free stall at its allowance cannot sell (gc#317), which a disabled Buy shows anyway, and
   * that a stall with no paid plan cannot sell by card at all (`card_payments_not_in_plan`). Told
   * publicly so Buy can say why; for most stalls it is public anyway through the verification badge
   * a paid plan earns, though a hand grant without a badge is a paid plan this answer reveals.
   *
   * `?unit=` (the currency the sale will be in, payment-adapter sends the stall's Stripe currency)
   * and `?amount=` (minor units) are honoured only for the internal caller, see `internalToken`.
   * Anyone else is answered in the stall's signed record's `issuanceCurrency`, amount aside.
   */
  private async ready(stallRaw: string, request: EnrolmentRequest): Promise<EnrolmentResponse> {
    const stall = decodeURIComponent(stallRaw).toLowerCase()
    if (!HEX64.test(stall)) return { status: 400, body: { error: 'that is not a stall address' } }
    const status = await this.status(stall)
    if (!status.ready) {
      // The code only, never the free-text reason: this answer is public (#312).
      return { status: 200, body: { ready: false, ...(status.reasonCode ? { reason: status.reasonCode } : {}) } }
    }
    const limit = await this.salesLimit(stall, request)
    if (limit === PLAN_UNKNOWN) {
      // Only ever for payment-adapter's checkout (the trusted caller): it reads a non-200 as unknown
      // and refuses with "try again", before Stripe. A card sale is never let through on a plan
      // nobody could check, because nothing after the charge checks it again (review).
      return { status: 503, body: { error: 'the stall’s plan could not be checked, try again' } }
    }
    return { status: 200, body: limit === null ? { ready: true } : { ready: false, reason: limit } }
  }

  /**
   * A plan refusal for this stall, or null when its plan does not stop the sale: no paid plan
   * (`card_payments_not_in_plan`, first, whatever the allowance), else the Free sales allowance.
   *
   * The plan is asked even with no unit to judge an allowance in (review): it is read in
   * `PLAN_ONLY_UNIT` and only `paid_plan` is used. For the trusted caller (payment-adapter's
   * checkout, the last moment nothing is charged) a plan nobody could check is `PLAN_UNKNOWN`,
   * refused as "try again". For the public Buy check it stays advice and ready, since the checkout
   * asks again. A gateway that answers 200 with no `paid_plan` predates it and refuses nothing.
   */
  private async salesLimit(stall: string, request: EnrolmentRequest): Promise<ReadinessCode | typeof PLAN_UNKNOWN | null> {
    const reader = this.deps.allowanceFor
    if (!reader) return null
    const query = new URLSearchParams(request.path.split('?')[1] ?? '')
    // `unit=` and `amount=` are the internal caller's only. From anyone else a unit of their choosing
    // would be one more gateway read per code they invent, and a unit the free tier does not price
    // reads as "reached", so the public answer always uses the stall's own record.
    const trusted = this.trusted(request.authorization)
    let unit = trusted ? normaliseUnit(query.get('unit')) : null
    if (unit === null) {
      const validity = await this.deps.validityFor(stall)
      unit = validity.kind === 'days' ? (validity.currency ?? null) : null
    }
    // No unit to judge an allowance in: the plan is still asked, in a unit the free tier always prices.
    const planOnly = unit === null
    const credential = await this.deps.vault.get(stall)
    if (credential === null) return null
    const amount = trusted ? minorAmount(query.get('amount')) : null
    const position = await reader(credential, unit ?? PLAN_ONLY_UNIT)
    if (position.paidPlan === false) {
      console.info(JSON.stringify({ event: 'card_sales_refused_not_in_plan', stall: stall.slice(0, 16) }))
      return 'card_payments_not_in_plan'
    }
    if (position.kind === 'unknown') {
      // Logged, so a gateway that never answers is seen.
      console.warn(JSON.stringify({ event: 'card_sales_allowance_unknown', stall: stall.slice(0, 16), reason: position.reason }))
      if (trusted && position.paidPlan === undefined) return PLAN_UNKNOWN
      // The allowance alone is advice: kept ready (see `allowanceFor`).
      return null
    }
    if (planOnly) return null
    const verdict = allowanceVerdict(position, amount)
    if (verdict === 'reached') return 'sales_limit_reached'
    if (verdict === 'exceeded') return 'sales_limit_exceeded'
    return null
  }

  /** Does this request carry the internal token? Constant-time, and never for an empty token. */
  private trusted(header: string | undefined): boolean {
    const token = this.deps.internalToken ?? ''
    if (token === '' || !header || !header.startsWith('Bearer ')) return false
    const presented = createHash('sha256').update(header.slice('Bearer '.length)).digest()
    return timingSafeEqual(presented, createHash('sha256').update(token).digest())
  }

  private sweep(): void {
    const cutoff = this.now() - PENDING_TTL_MS
    for (const [stall, entry] of this.pending) {
      if (entry.at <= cutoff) this.pending.delete(stall)
    }
  }
}

/** `salesLimit`'s answer when the trusted caller asked and the plan could not be checked. */
const PLAN_UNKNOWN = 'plan_unknown' as const

/**
 * The unit the plan is read in when no sale currency is known. Only `paid_plan` is used from that
 * answer; USD because the free tier prices it in every catalog.
 */
const PLAN_ONLY_UNIT = 'USD'

/** A positive whole number of minor units, or null. */
function minorAmount(raw: string | null): number | null {
  if (raw === null || !/^\d{1,15}$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function expirationOf(delegation: string | undefined): number | null {
  if (!delegation) return null
  try {
    const event = JSON.parse(delegation) as { tags?: unknown }
    const tags = Array.isArray(event.tags) ? (event.tags as unknown[][]) : []
    const value = Number(tags.find((t) => Array.isArray(t) && t[0] === 'expiration')?.[1])
    return Number.isSafeInteger(value) ? value : null
  } catch {
    return null
  }
}
