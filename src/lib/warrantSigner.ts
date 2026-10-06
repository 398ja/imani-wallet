/**
 * Signing an issuance warrant at the counter, so a coupon carries proof that
 * the stall authorised it rather than only the service's word.
 *
 * A voucher carries one signature and it is the issuing service's. The stall
 * named in `issuerId` signs nothing, so a compromised service can mint any
 * amount in any stall's name and the result is indistinguishable from a genuine
 * coupon. This module is the half that fixes that: before the Sell request
 * leaves the device, the merchant's own key signs a digest covering the amount.
 *
 * ## Why this can only work on an owner's device
 *
 * The signature has to verify against `issuerId`, which is the STALL's pubkey.
 * That means the signing key must BE the stall's key.
 *
 * - **Owner** — the device key *is* the stall key (`actor.ts`: "this key IS the
 *   stall"). A `merchant` warrant is signable here and nowhere else in this
 *   build.
 * - **Terminal** — the device key is disposable, generated on the device and
 *   replaced at every re-enrolment. It is emphatically *not* the stall key, so
 *   a signature made with it would never verify against `issuerId`.
 *
 * A terminal therefore signs the **`terminal`** form (#160 phase 5, spec 5.1): `K` signs the
 * same sale digest with `issuerId` = the stall, and the warrant carries the terminal credential
 * the stall's issuing service minted to `K` (its signed secret, never the proof's `C`). A
 * verifier checks the service vouched for `K` as a selling till of this stall, then checks `K`'s
 * signature (`terminalWarrant.ts`, mirroring cashu-voucher's `verifyTerminal`).
 *
 * A terminal may sign one only in a live FULL session with a selling role (`mayWarrantSale`):
 * a REDUCED session could not confirm the credential is unspent, so it does not sell. Anything
 * this module cannot sign properly comes out as a signed `none`, never as nothing, so absent
 * keeps meaning "this coupon predates warrants". Neither Sell nor cashback ever sends a `none`
 * (#159): every wallet receiving a coupon by DM refuses it (`refuseIfUnwarranted` in
 * dmPoll.ts), so `assertSaleWarranted` refuses the sale before anything is minted.
 */
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'

import { issuingStall, type Actor } from './actor'
import { parseIssuanceWarrant, warrantSaleDigest } from './issuanceWarrant'
import { getSigner } from './nap'
import { canIssueNow, type TerminalSession } from './terminalSession'
import { requestCredential } from './terminalRequestCredential'

/**
 * The warrant JSON to send with a Sell request, or `undefined` to send none.
 *
 * `undefined` is returned only when the wallet cannot sign at all (locked, no
 * signer). Everything else produces a warrant, including the `none` form.
 */
export type SignedWarrant = string | undefined

/**
 * Builds the warrant for one sale.
 *
 * **`saleTotalMinor` is the whole sale, not one coupon.** The portal may split
 * it into several coupons and the device cannot predict how many, so the digest
 * covers the total and every coupon is verified against it as a ceiling. Passing
 * a per-coupon figure here would authorise a fraction of what is being issued.
 *
 * Returns JSON rather than an object because the string is carried verbatim into
 * the voucher's signed bytes: re-serialising it anywhere between here and the
 * signer would risk changing key order and breaking the very signature this
 * produces.
 */
export async function buildIssuanceWarrant(
  actor: Actor,
  saleTotalMinor: number,
  faceDecimals: number,
  unit: string,
): Promise<SignedWarrant> {
  const stall = issuingStall(actor)

  let signer
  try {
    signer = getSigner()
  } catch {
    // Locked or not yet unlocked. No warrant at all, rather than a `none` we
    // could not have signed the alternative to. What the caller does with that
    // is its own decision: Sell and cashback both refuse it
    // (`assertSaleWarranted`), because an absent warrant is refused when the
    // coupon is received.
    return undefined
  }

  if (actor.kind === 'terminal') return terminalWarrant(actor, signer, saleTotalMinor, faceDecimals, unit)

  // The owner's key IS the stall key, but assert it rather than assume it. If
  // these ever diverge - a session restored under a different key, an actor
  // built from a stale record - the warrant would be signed by something that
  // is not `issuerId` and every coupon from this sale would be refused at
  // redemption. A signed `none` says so honestly, and Sell then refuses to
  // send it at all (`assertSaleWarranted`): since #159 every recipient refuses
  // `none`, so it is unredeemable either way.
  if (signer.pubkey !== stall) {
    console.warn(
      '[warrant] signer is not the issuing stall; issuing without a merchant warrant.',
      'signer', signer.pubkey.slice(0, 12), 'stall', stall.slice(0, 12),
    )
    return JSON.stringify({ form: 'none' })
  }

  // Fresh per sale. Without it two identical sales by one stall produce one
  // digest twice, and a warrant observed on the first authorises coupons from
  // the second - a free second batch off one real authorisation.
  const nonce = crypto.randomUUID().replace(/-/g, '')

  const digest = warrantSaleDigest(stall, saleTotalMinor, faceDecimals, unit, nonce)

  // `withPrivkey` borrows the key and wipes the copy, which `privkeyHex()` does
  // not - see signer.ts. A warrant is signed on every sale, so this is the hot
  // path for key exposure and the scoped borrow is worth the awkwardness.
  const sig = signer.withPrivkey((key) => bytesToHex(schnorr.sign(digest, key)))

  return JSON.stringify({
    form: 'merchant',
    sale_total: saleTotalMinor,
    face_decimals: faceDecimals,
    unit,
    nonce,
    sig,
  })
}

/**
 * The `terminal` warrant for one sale, or a signed `none` when this till cannot vouch for it.
 *
 * Every check here is one a verifier makes, asked first so a sale it would refuse is never sent:
 * the installed signer is the actor's `K`, and the credential this till unlocked with is locked
 * to `K` and names this stall. The role and FULL session are `mayWarrantSale`'s question.
 */
function terminalWarrant(
  actor: Extract<Actor, { kind: 'terminal' }>,
  signer: ReturnType<typeof getSigner>,
  saleTotalMinor: number,
  faceDecimals: number,
  unit: string,
): string {
  const stall = actor.stallPubkey
  const credential = requestCredential()
  if (signer.pubkey !== actor.terminalPubkey || !credential || credential.stallPubkey !== stall) {
    console.warn('[warrant] terminal has no credential or signer for its key; issuing without a warrant.')
    return JSON.stringify({ form: 'none' })
  }
  const nonce = crypto.randomUUID().replace(/-/g, '')
  const digest = warrantSaleDigest(stall, saleTotalMinor, faceDecimals, unit, nonce)
  const signature = signer.withPrivkey((key) => bytesToHex(schnorr.sign(digest, key)))
  // Key order is the spec's wire form (5.1). `credential` is the secret only: the proof's `C` is
  // what would make it spendable, and it never leaves the device.
  return JSON.stringify({
    form: 'terminal',
    sale_total: saleTotalMinor,
    face_decimals: faceDecimals,
    unit,
    nonce,
    signature,
    credential: credential.secret,
  })
}

/**
 * Why a terminal cannot sell right now, in words staff can act on.
 *
 * Shown on the Sell screen before a customer is scanned or any money is taken,
 * and thrown by `issueAndDeliver` for a request made around the screen.
 */
export const TERMINAL_SALE_UNSUPPORTED =
  'This terminal cannot sell right now. It needs a full session as a selling till, and this ' +
  'one is set up for redeeming only, or opened without reaching the network. Lock it and open ' +
  'it again, or ask the stall owner. Nothing has been issued; do not take payment for this sale.'

/**
 * Why a terminal cannot issue cashback right now. The cashback twin of
 * `TERMINAL_SALE_UNSUPPORTED`.
 */
export const TERMINAL_CASHBACK_UNSUPPORTED =
  'This terminal cannot issue cashback right now. It needs a full session as a selling till. ' +
  'Lock it and open it again, or ask the stall owner. Nothing has been issued.'

/**
 * A sale refused because no verifiable warrant could be signed for it.
 *
 * Its own type so a caller (and a test) can tell this refusal - which happens
 * before anything is minted - from a failure partway through issuance.
 */
export class UnwarrantedSaleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnwarrantedSaleError'
  }
}

/**
 * Whether this actor can sign a warrant a customer's wallet will accept.
 *
 * The owner always. A terminal only in a live FULL session with a selling role (`canIssueNow`):
 * its `terminal` warrant is checked by the portal against a credential the mint has just said
 * is unspent, and a REDUCED session never asked. A pure question, so the Sell screen can ask it
 * before a customer is scanned and `issueAndDeliver` can ask the identical one before anything
 * is minted.
 */
export function mayWarrantSale(actor: Actor, session: TerminalSession | null = null): boolean {
  if (actor.kind === 'owner') return true
  return canIssueNow(actor, session)
}

/**
 * Whether this device holds what a `terminal` warrant needs right now: the credential the till
 * unlocked with, naming this actor's stall. Always true for the owner. Asked by `issueAndDeliver`
 * before it reports any progress, so a till that lost its credential (locked mid-sale) is
 * refused before the screen shows "Issuing".
 */
export function holdsWarrantCredential(actor: Actor): boolean {
  if (actor.kind === 'owner') return true
  return requestCredential()?.stallPubkey === actor.stallPubkey
}

/**
 * Refuses a sale whose warrant every recipient would refuse.
 *
 * Called on the warrant `buildIssuanceWarrant` actually returned, BEFORE the
 * issuance request leaves the device. Anything other than a signed warrant -
 * `none` (a terminal, or an owner session whose key is not the stall's) or no
 * warrant at all (a locked wallet) - is refused by the customer's wallet in
 * `refuseIfUnwarranted`, so issuing it would mint a coupon nobody can take.
 */
export function assertSaleWarranted(warrant: SignedWarrant): void {
  const parsed = parseIssuanceWarrant(warrant)
  if (parsed.state === 'present') return

  if (parsed.state === 'absent-legacy') {
    throw new UnwarrantedSaleError(
      'Could not sign this sale: the wallet is locked. Unlock it and try again. ' +
        'Nothing has been issued.',
    )
  }
  throw new UnwarrantedSaleError(
    'Could not sign this sale for the stall, and a coupon nobody signed for the stall is ' +
      'refused when it is received. Sign in again (or lock and reopen this terminal) and try ' +
      'again. Nothing has been issued.',
  )
}
