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
 * A terminal therefore issues **unwarranted**, and this module says so with a
 * signed `none` rather than silently omitting the field. That distinction is
 * the point: absent means "this coupon predates warrants", `none` means "the
 * issuer states nothing outside the service authorised this". Collapsing them
 * is how a stripped warrant reads as a legacy coupon.
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
import { warrantSaleDigest } from './issuanceWarrant'
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
    // could not have signed the alternative to. The sale still proceeds:
    // unwarranted issuance is the status quo and refusing it is a policy
    // decision nobody has taken.
    return undefined
  }

  // The owner's key IS the stall key, but assert it rather than assume it. If
  // these ever diverge - a session restored under a different key, an actor
  // built from a stale record - the warrant would be signed by something that
  // is not `issuerId` and every coupon from this sale would be refused at
  // redemption. Better to issue unwarranted than to issue unredeemable.
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
