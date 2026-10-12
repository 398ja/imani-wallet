/**
 * The cashback claim link a merchant shows as a QR or shares (claim links phase 2, spec 2.3).
 *
 *   https://<wallet-origin>/c/<claimRef>#k=<claimKey>
 *
 * It opens the wallet directly, not the claim host, and it is byte-for-byte the shape the wallet's
 * own `/c/:ref` route already reads. The key is only ever in the fragment: browsers never send a
 * fragment in a request or in `Referer`.
 *
 * Nothing here logs, stores or sends a link. A caller must not either (spec 2.4).
 */

/** A claim reference, as the claim service issues it. */
const CLAIM_REF_RE = /^[A-Za-z0-9_-]{8,64}$/
/** 32 bytes of AES-256 key, base64url, unpadded. */
const CLAIM_KEY_RE = /^[A-Za-z0-9_-]{43}$/
const CLAIM_PATH_RE = /^\/c\/([A-Za-z0-9_-]{8,64})$/

/**
 * The link for one cashback, or null when any part is malformed.
 *
 * `walletOrigin` is this wallet's own origin (`window.location.origin`), never a host taken from a
 * server answer, so a link always names the wallet the merchant is using.
 */
export function formatCashbackLink(walletOrigin: string, ref: string, key: string): string | null {
  if (!CLAIM_REF_RE.test(ref) || !CLAIM_KEY_RE.test(key)) return null
  const origin = originOf(walletOrigin)
  return origin ? `${origin}/c/${ref}#k=${key}` : null
}

/** The claim reference in a claim-host URL such as the portal's `claimUrl`, or null. */
export function claimRefFromUrl(raw: string | undefined | null): string | null {
  if (!raw) return null
  try {
    return CLAIM_PATH_RE.exec(new URL(raw).pathname)?.[1] ?? null
  } catch {
    return null
  }
}

/** Whether a string is a whole claim key. */
export function isClaimKey(key: unknown): key is string {
  return typeof key === 'string' && CLAIM_KEY_RE.test(key)
}

function originOf(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch {
    return null
  }
}
