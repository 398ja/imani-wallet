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
 * A terminal therefore can only issue **unwarranted**, and this module says so
 * with a signed `none` rather than silently omitting the field. That
 * distinction is the point: absent means "this coupon predates warrants",
 * `none` means "the issuer states nothing outside the service authorised this".
 * Collapsing them is how a stripped warrant reads as a legacy coupon.
 *
 * **And neither Sell nor cashback ever sends one (#159).** Every wallet that receives a coupon by
 * DM refuses `none`, `absent` and `failed` before the mint swap
 * (`refuseIfUnwarranted` in dmPoll.ts) — the customer's as well as the stall's.
 * A `none` coupon sold at a terminal is therefore refused by the very customer
 * who paid for it, while the terminal used to report "It is in their wallet
 * now". `issue.ts` asks `mayWarrantSale` before anything is minted and refuses
 * the sale with `TERMINAL_SALE_UNSUPPORTED`; `assertSaleWarranted` is the
 * backstop on the warrant actually built. Cashback asks the same two
 * questions in `cashbackIssue.ts`: its claim records the verdict without
 * refusing, but the issuing stall's till refuses the coupon when it is spent.
 * `none` is still produced here so a caller that skipped those checks would
 * send an honest signed statement rather than nothing.
 *
 * The honest fix for terminals is the `delegated` form — sign with the terminal
 * credential's lock key, which the stall delegated and can burn. That needs the
 * verifier to also check the credential was minted by `issuerId`, which
 * `issuanceWarrant.ts` does not yet do and refuses rather than half-checks. So
 * it is not attempted here: a warrant nobody can verify is worse than a
 * documented absence, because it reads as assurance.
 */
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'

import { issuingStall, type Actor } from './actor'
import { parseIssuanceWarrant, warrantSaleDigest } from './issuanceWarrant'
import { getSigner } from './nap'

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

  if (actor.kind !== 'owner') {
    // A terminal's key is not the stall's, so it cannot produce a verifiable
    // `merchant` warrant. Say that in a signed field rather than omitting one.
    return JSON.stringify({ form: 'none' })
  }

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
 * Why a terminal cannot sell yet, in words staff can act on.
 *
 * Shown on the Sell screen before a customer is scanned or any money is taken,
 * and thrown by `issueAndDeliver` for a request made around the screen.
 */
export const TERMINAL_SALE_UNSUPPORTED =
  'Selling from a terminal is not supported yet. A coupon sold here would carry no ' +
  'authorisation signed by the stall, and the customer\u2019s wallet refuses those, so ' +
  'they would pay for a coupon they never receive. Terminal sales need the \u201cdelegated\u201d ' +
  'warrant form, which this version does not support. Sell from the stall owner\u2019s own ' +
  'device. Nothing has been issued; do not take payment for this sale.'

/**
 * Why a terminal cannot issue cashback yet. The cashback twin of
 * `TERMINAL_SALE_UNSUPPORTED`: the customer pays nothing here, but the coupon
 * would be refused by the stall's own till when they came to spend it.
 */
export const TERMINAL_CASHBACK_UNSUPPORTED =
  'Cashback from a terminal is not supported yet. Its coupon would carry no authorisation ' +
  'signed by the stall, so your own till would refuse it when the customer came to spend it. ' +
  'Terminal issuing needs the \u201cdelegated\u201d warrant form, which this version does not ' +
  'support. Issue cashback from the stall owner\u2019s own device. Nothing has been issued.'

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
 * Only the owner: a terminal's key is not the stall's, and the `delegated`
 * form that would let it sign is not implemented (see the module comment). A
 * pure question about the actor, so the Sell screen can ask it before a
 * customer is scanned and `issueAndDeliver` can ask the identical one before
 * anything is minted.
 */
export function mayWarrantSale(actor: Actor): boolean {
  return actor.kind === 'owner'
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
    'Could not sign this sale with the stall\u2019s key, and a coupon the stall did not ' +
      'sign is refused when it is received. Sign in again as the stall and try again. ' +
      'Nothing has been issued.',
  )
}
