import type { OwnerAttestation } from './ownerAttestation'
import { secp256k1 } from '@noble/curves/secp256k1.js'

import { grantFor, type TerminalRole } from './terminalRole'
import { mayEnrol, type EnrolDecision } from './terminalAllowance'
import { MAX_WAITING } from './terminalRoster'
import type { LicenceStatus } from './licenceStatus'
import type { TerminalCredential } from './actor'

/**
 * Putting a device on the counter, from the owner's side.
 *
 * Terminals ticket 05. The owner names a terminal, picks its role, scans the
 * code the device is showing, and issues it its authority.
 *
 * ## Why this is a module and not just a screen
 *
 * Three rules have to hold at the moment of enrolment, and two of them are not
 * about the UI at all:
 *
 * 1. **A terminal cannot go live without a role.** The role decides what the
 *    device may do, so a default would be a policy decision made by a form.
 * 2. **Authority is issued for the OWNER's stall and no other.** The stall is
 *    not a field on this screen; it is who the owner is. A screen that took it
 *    as input would be a screen that could grant away someone else's business.
 * 3. **The subscription gate lives here.** Subscriptions ticket 07: "the gate
 *    is at enrolment, on the owner's device, because a terminal cannot exist
 *    without the owner creating it." `terminalAllowance` already decides; this
 *    is where the decision is consulted, at the point of enrolment rather than
 *    by hiding a button.
 *
 * ## What is deliberately NOT here
 *
 * Minting. The credential is a P2PK-locked voucher and the composite
 * `P2PK_VOUCHER` kind is out of scope upstream, so `prepareEnrolment` returns
 * everything the mint call will need and ticket 10 supplies the call. Keeping
 * the decisions here means that ticket adds a network round trip and no rules.
 */

/** What the owner has filled in, before anything is issued. */
export interface EnrolmentRequest {
  /** What the owner calls this terminal, for their own records. */
  name: string
  /** Chosen from the fixed catalog. There is no default — see below. */
  role: TerminalRole | null
  /** The public key scanned off the device's screen. */
  terminalPubkey: string
}

/**
 * The longest terminal name, in UTF-16 code units (the unit of an HTML `maxLength`).
 *
 * The name is signed into the credential's `merchant_metadata`, so it rides in every warrant the
 * till builds, and the portal refuses a warrant over 4,096 units (`IssuanceWarrantGate`). An
 * uncapped name of about 2,600 characters made every sale from that till refused as malformed
 * (review rw1). 64 is far more than "Front counter" needs and far inside the warrant limit.
 */
export const TERMINAL_NAME_MAX_CHARS = 64

/** The trimmed name cut to `TERMINAL_NAME_MAX_CHARS` units, never splitting a surrogate pair. */
export function clampTerminalName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length <= TERMINAL_NAME_MAX_CHARS) return trimmed
  let end = TERMINAL_NAME_MAX_CHARS
  const last = trimmed.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return trimmed.slice(0, end).trimEnd()
}

export const ENROLMENT_REFUSAL = {
  NO_NAME: 'no-name',
  NO_ROLE: 'no-role',
  NO_TERMINAL: 'no-terminal',
  /**
   * 64 hex characters that are not an x-only point on secp256k1 (#160 phase 0).
   *
   * Nobody holds the private half of such a "key", and the gateway's lock code
   * falls back to issuing an UNLOCKED voucher when handed one: a bearer
   * authority to the stall that anyone holding the token could use.
   */
  NOT_A_KEY: 'not-a-key',
  /** The stall's own device cannot be enrolled as one of its own terminals. */
  SELF: 'self',
  /** No subscription, and the free allowance is used. */
  NOT_ALLOWED: 'not-allowed',
  /** Two terminals already wait for their device (decision 4 on #160). */
  TOO_MANY_WAITING: 'too-many-waiting',
  /**
   * This device key already has a live credential on the roster (#160 review,
   * BLOCKER). Minting another would replace its row and drop the only way to
   * revoke the first.
   */
  ALREADY_LIVE: 'already-live',
  OFFLINE: 'offline',
} as const

export type EnrolmentRefusal = (typeof ENROLMENT_REFUSAL)[keyof typeof ENROLMENT_REFUSAL]

export type EnrolmentCheck =
  | { ready: true }
  | { ready: false; reason: EnrolmentRefusal; message: string }

const PUBKEY = /^[0-9a-f]{64}$/

/**
 * Whether `hex` is an x-only public key somebody could actually hold.
 *
 * Lifted from `scripts/mint-terminal-credential.mjs`, which already refused
 * these for the same reason: an off-curve key is nobody's key, and the gateway
 * quietly issues an unlocked voucher for one. Prefixing `02` is how BIP-340
 * reads an x-only key as a point.
 */
export function isOnCurve(hex: string): boolean {
  if (!PUBKEY.test(hex)) return false
  try {
    secp256k1.Point.fromHex('02' + hex)
    return true
  } catch {
    return false
  }
}

export interface EnrolmentContext {
  /** The owner's stall. Taken from the session, never from the form. */
  stallPubkey: string
  /** What the licence check currently believes. */
  licence: LicenceStatus
  /**
   * Terminals in service, excluding the owner's own device. Waiting rows are
   * not counted: they do not use up the tier's allowance (decision 4 on #160).
   */
  enrolledCount: number
  /**
   * Terminals still waiting for their device. At most `MAX_WAITING`.
   *
   * A hint only: this phone's roster cannot see another phone or tab. The
   * gateway enforces the same limit when the credential is minted (409
   * `TERMINAL_PENDING_LIMIT`, gateway-customer#187), so this check exists to
   * say so before the owner fills in the form.
   */
  waitingCount?: number
  /** Whether the scanned key already holds a live credential on this roster. */
  alreadyLive?: boolean
  /** Whether the device can reach the network. Enrolment needs it. */
  online: boolean
}

/**
 * Can this enrolment go ahead?
 *
 * Every refusal names something the owner can act on, and they are checked in
 * the order an owner would encounter them: what they have not filled in first,
 * then what they are not allowed to do.
 *
 * The subscription refusal is passed through from `mayEnrol` verbatim rather
 * than reworded. That message already names the limit and the contact route,
 * and having two sentences for one situation is how they drift apart.
 */
export function checkEnrolment(
  request: EnrolmentRequest,
  context: EnrolmentContext,
): EnrolmentCheck {
  if (!request.name.trim()) {
    return {
      ready: false,
      reason: ENROLMENT_REFUSAL.NO_NAME,
      message: 'Give this terminal a name, so you can tell your devices apart later.',
    }
  }

  // No default role, deliberately: "a terminal cannot go live without a role"
  // is the ticket's first criterion, and a default would be the app choosing
  // what a device may do.
  if (!request.role) {
    return {
      ready: false,
      reason: ENROLMENT_REFUSAL.NO_ROLE,
      message: 'Choose what this terminal is allowed to do.',
    }
  }

  if (!PUBKEY.test(request.terminalPubkey)) {
    return {
      ready: false,
      reason: ENROLMENT_REFUSAL.NO_TERMINAL,
      message: 'Scan the code showing on the terminal.',
    }
  }

  // Checked here, before minting, not discovered afterwards in a token that
  // turned out to be unlocked. The words are the owner's: they scanned a code,
  // they did not choose a curve point.
  if (!isOnCurve(request.terminalPubkey.toLowerCase())) {
    return {
      ready: false,
      reason: ENROLMENT_REFUSAL.NOT_A_KEY,
      message:
        'That is not a terminal code. Scan the code on the terminal again, or start setup ' +
        'on that device once more.',
    }
  }

  // The owner's own device is terminal 1 and is counted, not converted. Letting
  // it enrol itself would hand the stall a credential locked to the stall's own
  // key — a second, weaker authority over the same business, and a migration of
  // the one device that needs none.
  if (request.terminalPubkey.toLowerCase() === context.stallPubkey.toLowerCase()) {
    return {
      ready: false,
      reason: ENROLMENT_REFUSAL.SELF,
      message: 'This is your own device. It already trades for your stall and needs no setup.',
    }
  }

  // Re-adding a key that is already out would mint a second credential and
  // replace the row holding the first one's token, leaving it live and
  // unrevocable (#160 review). The owner cancels or revokes it first.
  if (context.alreadyLive) {
    return {
      ready: false,
      reason: ENROLMENT_REFUSAL.ALREADY_LIVE,
      message:
        'This device is already on your list with a live authority. Cancel or revoke it ' +
        'there first, then add it again.',
    }
  }

  // Decision 4 on #160: waiting rows are free, so they are capped instead. Two
  // at a time is enough to retry a botched setup, and not enough to stock a
  // drawer with unconfirmed authorities to the stall.
  if ((context.waitingCount ?? 0) >= MAX_WAITING) {
    return {
      ready: false,
      reason: ENROLMENT_REFUSAL.TOO_MANY_WAITING,
      message:
        'Two terminals are already waiting for their device. Finish or cancel one first.',
    }
  }

  const allowance: EnrolDecision = mayEnrol(context.licence, context.enrolledCount)
  if (!allowance.allowed) {
    return { ready: false, reason: ENROLMENT_REFUSAL.NOT_ALLOWED, message: allowance.message }
  }

  // Last, because it is the only one that might fix itself. Minting needs the
  // mint and there is no degraded path: the spec refuses to pre-issue a stock
  // of unassigned credentials, since those are bearer authorities to the stall
  // sitting in a drawer.
  if (!context.online) {
    return {
      ready: false,
      reason: ENROLMENT_REFUSAL.OFFLINE,
      message:
        'Setting up a terminal needs a connection. Try again when you are back online — ' +
        'terminals are best set up before the market opens.',
    }
  }

  return { ready: true }
}

/**
 * A credential this side has just built, with its fields known precisely.
 *
 * `TerminalCredential` types its fields `unknown` on purpose: it describes what
 * arrives from OUTSIDE, where the role and keys are claims to be validated
 * rather than facts. Here we are the ones constructing it, so the caller should
 * not have to re-validate what we just wrote — a narrower type at the point of
 * creation, and the loose one at the point of receipt.
 */
export type PreparedCredential = TerminalCredential & {
  name: string
  stallPubkey: string
  role: TerminalRole
  lockedTo: string
  permissions: readonly string[]
  /** The owner's idle lock, signed into the credential (#160 review). */
  idleLockMinutes?: number
  /**
   * The owner's attestation of this till, signed with the stall key at enrolment (#160 decision
   * 5). Persisted on the `minting` row, so a resumed mint sends it unchanged.
   */
  attestation?: OwnerAttestation
  /**
   * The device's enrolment proof header value, `1:<created_at>:<sig>` (inv-terminal-not-merchant):
   * gateway-customer refuses a new terminal without it. Absent on a renewal, which re-mints to a key
   * the stall already enrolled.
   */
  enrolmentProof?: string
  /**
   * On a renewal, the till's CURRENT credential token (rev-option-a R2). gateway-customer signed it,
   * so it proves this stall enrolled the key before, for a till minted before the gateway kept a
   * registry row for it. Sent as `X-Imani-Terminal-Renews`; never part of the credential.
   */
  renewsToken?: string
  /**
   * A FIRST enrolment of an online shop (the redeem-only terminal a shop plugin generated): sent as
   * `X-Imani-Online-Shop: 1`, so gateway-customer can refuse it with `422 FEATURE_NOT_IN_PLAN` when
   * the stall's plan lacks `ecommerce`. Never sent with `renewsToken`: a shop must be able to renew,
   * so the codes it already holds can finish.
   */
  onlineShop?: boolean
}

/**
 * Everything the credential must contain, ready for the mint.
 *
 * Throws rather than returning a partial. `checkEnrolment` is the place that
 * reports problems to a person; reaching here with an invalid request is a
 * programming error, and emitting a half-formed credential would be worse than
 * failing — it would be an authority nobody can account for.
 *
 * The stall comes from the CONTEXT, never the request. That is the ticket's
 * fifth criterion made structural: there is no field in which an owner could
 * name a different stall, so authority cannot be issued for one.
 */
export function prepareEnrolment(
  request: EnrolmentRequest,
  context: EnrolmentContext,
): PreparedCredential {
  const check = checkEnrolment(request, context)
  if (!check.ready) throw new Error(check.message)
  // `checkEnrolment` has established the role; this narrows it for TypeScript.
  if (!request.role) throw new Error('Choose what this terminal is allowed to do.')

  const stall = context.stallPubkey.toLowerCase()

  return {
    name: clampTerminalName(request.name),
    stallPubkey: stall,
    role: request.role,
    // Locked to the key the device showed. This is what makes the returned QR
    // safe to observe: it grants nothing to anyone who does not hold `K`.
    lockedTo: request.terminalPubkey.toLowerCase(),
    permissions: grantFor(request.role, stall),
  }
}
