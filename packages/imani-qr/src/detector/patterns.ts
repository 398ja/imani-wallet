import { QrType } from './types';
import { UR_FRAGMENT_PATTERN } from '../nut16/types';

export const CASHU_URI_PREFIX = 'cashu:';
export const NOSTR_URI_PREFIX = 'nostr:';
export const VREQ_PREFIX = 'vreqa';
export const NPUB_PREFIX = 'npub1';
export const CASHU_A_PREFIX = 'cashua';
export const CASHU_B_PREFIX = 'cashub';
/**
 * DEV-131 — the prefix `pass.ts` (`BARCODE_PREFIX`) puts on a voucher pass
 * barcode. Lower-case, because every comparison against it lower-cases first.
 */
export const VOUCHER_REDEEM_PREFIX = 'voucher:';

export const NIP05_PATTERN = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export const DEFAULT_PATTERNS: Partial<Record<QrType, RegExp>> = {
  [QrType.PAYMENT_REQUEST]: /^vreqa/i,
  [QrType.CASHU_TOKEN]: /^cashu[ab]/i,
  [QrType.NPUB]: /^npub1[a-z0-9]{58}$/i,
  [QrType.NIP05]: NIP05_PATTERN,
  // Spec 028 — NUT-16 BC-UR fragment. ur:bytes/ never collides with the
  // higher-priority cashu / nostr prefixes above.
  [QrType.UR_FRAGMENT]: UR_FRAGMENT_PATTERN,
  // DEV-131 — a voucher pass barcode. Collides with nothing above: it is not a
  // cashu/vreq/npub prefix, and NIP05_PATTERN requires an `@`.
  //
  // `stripPrefix` removes `cashu:` and `nostr:` only, so the `voucher:` scheme
  // reaches this pattern intact — which is what makes the payload
  // distinguishable at all. A bare UUID would match nothing and mean nothing.
  [QrType.VOUCHER_REDEEM]: /^voucher:.+/i
};

export const TYPE_DESCRIPTIONS: Record<QrType, string> = {
  [QrType.PAYMENT_REQUEST]: 'Payment Request',
  [QrType.CASHU_TOKEN]: 'Cashu Token',
  [QrType.NPUB]: 'Nostr Public Key',
  [QrType.NIP05]: 'Nostr Username',
  [QrType.UR_FRAGMENT]: 'Animated QR Frame',
  [QrType.VOUCHER_REDEEM]: 'Voucher',
  [QrType.UNKNOWN]: 'Unknown'
};

/**
 * Spec 035 US1 (FR-003) — Cashu-token-in-URL extraction.
 *
 * Returns the embedded Cashu token if (and only if) the input parses as a
 * URL and contains EXACTLY ONE valid Cashu token across its query string
 * and fragment. Returns null for non-URLs, URLs with no token, and URLs
 * with ambiguous (>1) token candidates.
 *
 * Used by `QrTypeDetector.detect` as a fallback after standard pattern
 * matching returns UNKNOWN, so a scanned QR whose content is a URL with an
 * embedded token routes the same as a bare token — without ever opening
 * the long URL (which would HTTP 414 for large tokens).
 */
export function extractEmbeddedCashuToken(text: string): string | null {
  if (typeof text !== 'string' || text.length === 0) return null;

  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }

  const candidates: string[] = [];

  url.searchParams.forEach((value) => {
    if (isCashuTokenString(value)) candidates.push(value);
  });

  if (url.hash && url.hash.length > 1) {
    const frag = url.hash.startsWith('#') ? url.hash.substring(1) : url.hash;
    let hashHadParams = false;
    try {
      const hashParams = new URLSearchParams(frag);
      hashParams.forEach((value) => {
        if (isCashuTokenString(value)) {
          hashHadParams = true;
          candidates.push(value);
        }
      });
    } catch {
      // fall through to the raw-fragment check below
    }
    // If the fragment didn't contain key=value pairs, also try the raw
    // fragment itself (e.g. `#cashuB...`).
    if (!hashHadParams && isCashuTokenString(frag)) {
      candidates.push(frag);
    }
  }

  return candidates.length === 1 ? candidates[0] : null;
}

function isCashuTokenString(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0) return false;
  const trimmed = s.trim().toLowerCase();
  const check = trimmed.startsWith(CASHU_URI_PREFIX)
    ? trimmed.substring(CASHU_URI_PREFIX.length)
    : trimmed;
  return check.startsWith(CASHU_A_PREFIX) || check.startsWith(CASHU_B_PREFIX);
}
