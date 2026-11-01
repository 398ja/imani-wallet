import {
  DENIAL_REASONS,
  type LicenceLimits,
  type LicenceVerdict,
  type LicenceVoucher,
  type VerifyOptions,
} from './types.js'

/** The x of a 66-hex compressed key, or the key unchanged. */
function xOnly(key: string): string {
  const k = key.trim()
  return k.length === 66 && /^0[23]/.test(k) ? k.slice(2) : k
}

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

  // The seller pin (review of imani-wallet#197, MEDIUM-3). Before the lock, because a licence a
  // stranger minted to us is not ours to reason about either.
  if (options.sellerPublicKey && !sameKey(voucher.issuerId, options.sellerPublicKey)) {
    return {
      granted: false,
      reason: DENIAL_REASONS.NOT_SOLD_BY_US,
      detail: 'this licence was not sold by our licence seller',
    }
  }

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

  // Locked at the MINT, to the same key (review of imani-wallet#197). A plain VOUCHER's lock is
  // metadata the mint never checks, and gateway-customer refuses it, so the wallet must not show
  // "licensed" for one either.
  if (!voucher.mintLockKey) {
    return {
      granted: false,
      reason: DENIAL_REASONS.NOT_LOCKED_AT_MINT,
      detail: 'this licence is not locked at the mint, so the server will not count it',
    }
  }
  if (!sameKey(xOnly(voucher.mintLockKey), voucher.lockKey)) {
    return {
      granted: false,
      reason: DENIAL_REASONS.WRONG_KEY,
      detail: 'the mint lock is not the licence lock_key',
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

  // Before its window opens: a renewal delivered early (#407 §6) sits here until it starts. Signed,
  // so an answer rather than an outage. `<` because the opening instant belongs to the window.
  if (typeof voucher.validFrom === 'number' && Number.isFinite(voucher.validFrom) && options.now < voucher.validFrom) {
    return {
      granted: false,
      reason: DENIAL_REASONS.NOT_YET_VALID,
      detail: `this licence starts at ${voucher.validFrom}`,
    }
  }

  const features = voucher.features ?? []
  // A hand grant may lift only a LIMIT ("raise this stall to £200", #407 §7) and name no feature,
  // so a licence confers something if it names a feature OR a limit.
  if (features.length === 0 && !hasAnyLimit(voucher.limits)) {
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
      ...(voucher.limits ? { limits: copyLimits(voucher.limits) } : {}),
      ...(voucher.tier ? { tier: voucher.tier } : {}),
      ...(typeof voucher.validFrom === 'number' ? { validFrom: voucher.validFrom } : {}),
      ...(voucher.badge ? { badge: voucher.badge } : {}),
    },
  }
}

function hasAnyLimit(limits: LicenceLimits | undefined): boolean {
  return !!limits && (limits.sales !== undefined || limits.terminals !== undefined)
}

function copyLimits(limits: LicenceLimits): LicenceLimits {
  const out: LicenceLimits = {}
  if (limits.terminals !== undefined) out.terminals = limits.terminals
  if (limits.sales === null) out.sales = null
  else if (limits.sales) out.sales = { period: limits.sales.period, amounts: { ...limits.sales.amounts } }
  return out
}
