import { TERMINAL_ACTIONS, isValidGrant, mayAct, roleOf, type TerminalRole } from './terminalRole'

/**
 * Who a device is acting FOR, and the authority it holds to do so.
 *
 * Terminals ticket 02. Issuance currently takes its issuer from whoever the
 * portal authenticated, and `issue.ts` says so deliberately — which is correct
 * while a stall is one durable key, and wrong the moment a device signs in with
 * a disposable one. A terminal's key `K` is generated on the device and expected
 * to be replaced at every re-enrolment, so coupons stamped with it would name an
 * issuer that stops existing, leaving customers holding coupons nobody can
 * honour.
 *
 * This module is the answer to "which stall is this?", separated from issuance
 * so that the answer has one definition and issuance has one source.
 *
 * ## The owner's own device is not a terminal
 *
 * The subscriptions spec settles this: "The owner's device is counted, not
 * converted. It keeps authenticating as the stall, holds the stall's key, and is
 * never enrolled." So there are two shapes here, not one:
 *
 *   - `OWNER`  — signed in as the stall itself. The stall IS the session key.
 *   - `TERMINAL` — signed in with a disposable key, carrying a credential that
 *     names the stall it may act for.
 *
 * Both answer `stallPubkey`, which is the whole point: `issue.ts` asks one
 * question and never learns which kind of device it is running on.
 *
 * ## Why the fallback has to go rather than be kept "for the owner case"
 *
 * The ticket is explicit: "Falling back to the session pubkey is the failure
 * this ticket exists to remove, so the fallback must not survive as a
 * convenience." An owner session is not a fallback — it is a positive claim,
 * constructed deliberately, that this key IS the stall. A terminal session with
 * no credential produces NOTHING, and issuance refuses.
 */

/** Signed in as the stall itself: the owner's own device, per the spec. */
export interface OwnerActor {
  kind: 'owner'
  /** The stall's own key. It signed in, so it is the stall by definition. */
  stallPubkey: string
}

/** A device acting for a stall under a credential it was enrolled with. */
export interface TerminalActor {
  kind: 'terminal'
  /** The stall named in the credential — NOT the key that signed in. */
  stallPubkey: string
  role: TerminalRole
  /** The disposable key this device generated. Recorded, never stamped. */
  terminalPubkey: string
  permissions: readonly string[]
}

export type Actor = OwnerActor | TerminalActor

/** A stall pubkey: 32-byte hex. Same shape `terminalRole.ts` enforces. */
const STALL_PUBKEY = /^[0-9a-f]{64}$/

function normalisedKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase()
  return STALL_PUBKEY.test(key) ? key : null
}

/**
 * The owner's own device, signed in as the stall.
 *
 * Constructed from the session pubkey, and that is not the banned fallback: it
 * is the positive statement that this key is the stall's own. A stall issuing on
 * its own device is unaffected by this ticket and its coupons are stamped
 * exactly as they are today — which is the fourth acceptance criterion.
 */
export function ownerActor(sessionPubkey: string): OwnerActor | null {
  const stall = normalisedKey(sessionPubkey)
  return stall ? { kind: 'owner', stallPubkey: stall } : null
}

/**
 * What a terminal presents at login, as this app reads it.
 *
 * Deliberately the FIELDS rather than the voucher: the credential is a
 * P2PK-locked voucher whose composite `P2PK_VOUCHER` kind the mint cannot
 * represent yet (the spec puts that upstream work out of scope). Taking the
 * parsed fields means this module is finished and testable now, and the ticket
 * that lands the real credential path only has to produce this shape.
 */
export interface TerminalCredential {
  /** The stall that issued this credential. The coupon's issuer. */
  stallPubkey: unknown
  /** The role from the credential's tags. Outside data: validated, not trusted. */
  role: unknown
  /** The key the credential is locked to, which must be this device's. */
  lockedTo: unknown
  /** Permissions the session was granted. Checked against the role. */
  permissions?: readonly string[]
}

/**
 * A terminal actor from a presented credential, or null.
 *
 * Null on anything that does not check out, and the checks are all refusals a
 * caller must not be able to talk its way past:
 *
 * 1. **The stall must be a real key.** A malformed one would stamp coupons with
 *    an issuer nobody could look up.
 * 2. **The role must be in the catalog.** It arrives from a voucher tag, through
 *    a mint and a QR code, so `roleOf` refuses rather than defaulting.
 * 3. **The credential must be locked to THIS device.** A credential is not a
 *    bearer token: possession of the bytes is not authority, holding the key it
 *    is locked to is. Without this, a credential photographed off a screen would
 *    authorise the photographer — and the spec's claim that the enrolment QRs
 *    are safe to observe rests on exactly this check.
 * 4. **The permissions must match the role, for this stall.** `isValidGrant`
 *    refuses a set that is larger, smaller, or for someone else's business.
 */
export function terminalActor(
  credential: TerminalCredential,
  devicePubkey: string,
): TerminalActor | null {
  const stall = normalisedKey(credential.stallPubkey)
  if (!stall) return null

  const role = roleOf(credential.role)
  if (!role) return null

  const device = normalisedKey(devicePubkey)
  const lockedTo = normalisedKey(credential.lockedTo)
  if (!device || !lockedTo || lockedTo !== device) return null

  const permissions = credential.permissions ?? []
  if (!isValidGrant(permissions, role, stall)) return null

  return {
    kind: 'terminal',
    stallPubkey: stall,
    role,
    terminalPubkey: device,
    permissions: [...permissions],
  }
}

/**
 * The stall a coupon issued by this actor must be stamped with.
 *
 * The one question `issue.ts` asks. It is a function rather than a field read so
 * that there is a single place to look when asking "where does the issuer come
 * from", and so that the terminal case cannot be reached by spreading an object.
 */
export function issuingStall(actor: Actor): string {
  return actor.stallPubkey
}

/**
 * May this actor issue a coupon for its stall?
 *
 * An owner always may — subject to the gateway's own `coupon:issue`, which is
 * the boundary that actually counts; this is affordance, exactly as `canTrade`
 * documents itself.
 *
 * A terminal may only with the issuance action for ITS stall. A redeem-only
 * terminal is refused here and would be refused at the API too, which is the
 * spec's requirement that the role be enforced "at the API and not merely in
 * the UI".
 */
export function mayIssue(actor: Actor): boolean {
  if (actor.kind === 'owner') return true
  return mayAct(actor.permissions, TERMINAL_ACTIONS.ISSUE, actor.stallPubkey)
}

/** May this actor redeem for its stall? Every role can; an owner always can. */
export function mayRedeem(actor: Actor): boolean {
  if (actor.kind === 'owner') return true
  return mayAct(actor.permissions, TERMINAL_ACTIONS.REDEEM, actor.stallPubkey)
}
