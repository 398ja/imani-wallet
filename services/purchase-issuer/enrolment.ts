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
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools/pure'

import type { ConfirmStanding } from './adapters'
import type { CredentialConfirmer } from './confirmation'
import { checkDelegation } from './delegatedWarrant'
import { DEFAULT_EXPIRES_IN_DAYS, type StallCredential } from './issuer'
import { countEnrolment } from './metrics'
import { ReplayGuard, verifyNip98 } from './nip98Auth'
import type { CredentialVault } from './vault'

/** Where the stall calls. Under `/api/v1` so the edge can route this prefix and nothing else. */
export const ENROLMENT_PREFIX = '/api/v1/card-sales'
export const BEGIN_PATH = `${ENROLMENT_PREFIX}/enrolment/begin`
export const ENROL_PATH = `${ENROLMENT_PREFIX}/enrolment`
/** Public: may shoppers be sold a card purchase for this stall? `/ready/<stall pubkey>`. */
export const READY_PREFIX = `${ENROLMENT_PREFIX}/ready/`

/** How long a begun enrolment waits for its credential. Minting takes seconds; a phone may sleep. */
export const PENDING_TTL_MS = 30 * 60_000
/** Begun enrolments held at once. Anyone can make a key and begin, so this is bounded. */
export const MAX_PENDING = 1_000
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
}

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
}

export class EnrolmentService {
  private readonly pending = new Map<string, Pending>()
  private readonly replay = new ReplayGuard()
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
        return await this.ready(path.slice(READY_PREFIX.length))
      }
      if (request.method === 'POST' && path === BEGIN_PATH) return await this.authed(request, (s) => this.begin(s))
      if (request.method === 'POST' && path === ENROL_PATH) {
        return await this.authed(request, (s) => this.enrol(s, request.body))
      }
      if (request.method === 'GET' && path === ENROL_PATH) {
        return await this.authed(request, async (s) => ({ status: 200, body: { ...(await this.status(s)) } }))
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

  /** Step 1: a fresh lock key for this stall. Its private half stays here. */
  private async begin(stall: string): Promise<EnrolmentResponse> {
    this.sweep()
    if (!this.pending.has(stall) && this.pending.size >= MAX_PENDING) {
      return { status: 503, body: { error: 'too many enrolments in progress; try again in a few minutes' } }
    }
    const lockKeyHex = bytesToHex(schnorr.utils.randomSecretKey())
    const lockPubkey = getPublicKey(hexToBytes(lockKeyHex))
    // Beginning again REPLACES a begun one: the phone that lost its answer simply starts over.
    this.pending.set(stall, { lockKeyHex, at: this.now() })
    const createdAt = Math.floor(this.now() / 1000)
    const digest = sha256(utf8ToBytes([ENROLMENT_TAG, '1', lockPubkey, String(createdAt)].join(US)))
    const sig = bytesToHex(schnorr.sign(digest, hexToBytes(lockKeyHex)))
    return {
      status: 200,
      body: {
        lockPubkey,
        // `X-Imani-Terminal-Enrolment` for the mint: proof that this key was made as a terminal.
        enrolmentProof: `1:${createdAt}:${sig}`,
        expiresAt: Math.floor((this.now() + PENDING_TTL_MS) / 1000),
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
    const verdict = checkDelegation(candidate, this.now() + DEFAULT_EXPIRES_IN_DAYS * 86_400_000)
    if (!verdict.ok) return refuse(422, `delegation refused: ${verdict.reason}`)

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
    const verdict = checkDelegation(credential, this.now() + DEFAULT_EXPIRES_IN_DAYS * 86_400_000)
    const delegationExpiresAt = expirationOf(credential.delegation)
    let reason: string | undefined
    if (confirmation === 'expired') reason = 'The card-sales credential expired or was cancelled. Turn card sales on again.'
    else if (!verdict.ok) reason = `Card sales need renewing (${verdict.reason}).`
    // `unconfirmed`/`unknown` stay ready: the confirm is retried before the first mint, and a
    // gateway blip must not take a working stall off sale.
    return {
      enrolled: true,
      confirmation,
      delegationExpiresAt,
      delegationValid: verdict.ok,
      ready: reason === undefined,
      ...(reason ? { reason } : {}),
    }
  }

  /** Public readiness, for the Buy button. Says nothing a stall's `acceptsCards` does not. */
  private async ready(stallRaw: string): Promise<EnrolmentResponse> {
    const stall = decodeURIComponent(stallRaw).toLowerCase()
    if (!HEX64.test(stall)) return { status: 400, body: { error: 'that is not a stall address' } }
    const status = await this.status(stall)
    return { status: 200, body: { ready: status.ready } }
  }

  private sweep(): void {
    const cutoff = this.now() - PENDING_TTL_MS
    for (const [stall, entry] of this.pending) {
      if (entry.at <= cutoff) this.pending.delete(stall)
    }
  }
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
