import {
  DENIAL_REASONS,
  type LicenceVerdict,
  type LicenceVoucher,
  type VerifyOptions,
} from './types.js'

/** Constant-time-ish comparison of two hex strings, case-insensitively. */
function sameKey(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Does this voucher unlock anything, for this presenter, at this moment?
 *
 * The order below is deliberate and is the order a reviewer should check:
 *
 * 1. **Issuer first.** A voucher we did not sign is not ours to reason about,
 *    and every later check would be reading fields an attacker chose. This is
 *    the check that stops a customer minting their own subscription.
 * 2. **Signature next**, because until it verifies, `expiresAt` and `features`
 *    are claims rather than facts. Checking expiry before the signature would
 *    mean refusing an "expired" voucher whose expiry was never signed — a
 *    correct answer reached by luck.
 * 3. **The binding**, which is what makes possession insufficient.
 * 4. **Expiry**, from the caller's clock.
 * 5. **The grant**, last, because a licence conferring nothing is a
 *    misconfiguration rather than an attack and should be reported as itself.
 *
 * Every refusal names a reason. A caller that can only see `false` cannot tell
 * "your subscription ended" from "that licence belongs to another device", and
 * those have different remedies.
 */
export function verifyLicence(
  voucher: LicenceVoucher | null | undefined,
  options: VerifyOptions,
): LicenceVerdict {
  if (!voucher) {
    // Not an error. A stall with no licence is the ordinary free case, and
    // reporting it as a failure would make every log line about it noise.
    return {
      granted: false,
      reason: DENIAL_REASONS.ABSENT,
      detail: 'no licence was presented',
    }
  }

  if (!sameKey(voucher.issuerPublicKey, options.issuerPublicKey)) {
    return {
      granted: false,
      reason: DENIAL_REASONS.WRONG_ISSUER,
      detail: 'this licence was not issued by us',
    }
  }

  if (!options.verifySignature(voucher)) {
    // Signed by our key according to the field, and the signature does not hold.
    // That is either corruption or forgery, and neither is worth distinguishing
    // to a caller — both mean the fields below cannot be trusted.
    return {
      granted: false,
      reason: DENIAL_REASONS.BAD_SIGNATURE,
      detail: 'the licence signature did not verify',
    }
  }

  /**
   * From here every field is SIGNED, so it is a fact rather than a claim.
   */

  if (!voucher.lockKey) {
    // Refused rather than accepted. A voucher with no lock is one that
    // possession alone unlocks, which is the bearer-credential failure ADR 0006
    // §2 rejects — and it is the shape the wallet's parser currently produces
    // for a plain VOUCHER secret, so this branch is reachable today rather than
    // theoretical.
    return {
      granted: false,
      reason: DENIAL_REASONS.UNLOCKED,
      detail: 'this licence carries no lock key, so holding it would be enough',
    }
  }

  if (!sameKey(voucher.lockKey, options.presenter)) {
    return {
      granted: false,
      reason: DENIAL_REASONS.WRONG_KEY,
      detail: 'this licence is locked to a different key',
    }
  }

  if (typeof voucher.expiresAt !== 'number' || !Number.isFinite(voucher.expiresAt)) {
    // A licence with no expiry is a licence that never ends, which is not a
    // product we sell. Refused rather than granted indefinitely.
    return {
      granted: false,
      reason: DENIAL_REASONS.NO_EXPIRY,
      detail: 'this licence carries no expiry',
    }
  }

  // `<=`, not `<`. A licence expiring exactly now has expired: the boundary
  // belongs to the past, and picking the other one would make the last second
  // of a subscription behave differently from every second before it.
  if (voucher.expiresAt <= options.now) {
    return {
      granted: false,
      reason: DENIAL_REASONS.EXPIRED,
      detail: `this licence expired at ${voucher.expiresAt}`,
    }
  }

  const features = voucher.features ?? []
  if (features.length === 0) {
    return {
      granted: false,
      reason: DENIAL_REASONS.NO_FEATURES,
      detail: 'this licence confers no features',
    }
  }

  return {
    granted: true,
    grant: {
      // Copied, not aliased. The caller holds the voucher and could otherwise
      // mutate the granted list through it after the decision was made.
      features: [...features],
      subscriptionId: voucher.subscriptionId,
      expiresAt: voucher.expiresAt,
      pilot: voucher.pilot === true,
    },
  }
}
