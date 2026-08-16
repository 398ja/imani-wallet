/**
 * Currency resolution primitives (vanilla-JS mirror of
 * packages/auto-redemption/src/utils/currency.ts).
 *
 * Must stay in lock-step with the TS file — see
 * specs/007-fix-voucher-currency/contracts/token-transfer-dm.schema.md
 * section 2 for the canonical contract.
 *
 * Exposed on window as `ImaniCurrency` for easy consumption from non-module
 * scripts; also importable as an ES module.
 */

export const UNKNOWN = 'UNKNOWN';

/**
 * Canonicalize a currency string read from any source.
 * Returns null for non-string / empty / "UNKNOWN" (network-sourced) inputs.
 * @param {unknown} input
 * @returns {string|null}
 */
export function normalizeFaceUnit(input) {
  if (typeof input !== 'string') {
    return null;
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const upper = trimmed.toUpperCase();
  if (upper === UNKNOWN) {
    return null;
  }
  return upper;
}

/**
 * Five-step resolution chain with short-circuit semantics.
 * Mirrors resolveFaceUnit() from packages/auto-redemption/src/utils/resolveFaceUnit.ts.
 *
 * @param {{
 *   dmMetadata?: { face_unit?: unknown, faceUnit?: unknown } | null,
 *   getTokenMetadataResult?: { face_unit?: unknown } | null,
 *   inspectResult?: { face_unit?: unknown } | null,
 *   receiveResult?: { face_unit?: unknown, unit?: unknown } | null,
 *   merchantProfile?: { issuance_currency?: unknown, issuanceCurrency?: unknown } | null,
 *   tokenFingerprint?: string,
 *   eventId?: string,
 * }} inputs
 * @returns {{ faceUnit: string, source: ('dm'|'token_metadata'|'inspect'|'receive_result'|'merchant_profile'|'unknown') }}
 */
export function resolveFaceUnit(inputs) {
  const {
    dmMetadata,
    getTokenMetadataResult,
    inspectResult,
    receiveResult,
    merchantProfile,
    tokenFingerprint,
    eventId,
  } = inputs || {};

  const dm = normalizeFaceUnit(dmMetadata?.face_unit ?? dmMetadata?.faceUnit);
  if (dm !== null) {
    log('info', 'dm', dm, tokenFingerprint, eventId);
    return { faceUnit: dm, source: 'dm' };
  }
  log('warn-step', 'dm', null, tokenFingerprint, eventId);

  const meta = normalizeFaceUnit(getTokenMetadataResult?.face_unit);
  if (meta !== null) {
    log('info', 'token_metadata', meta, tokenFingerprint, eventId);
    return { faceUnit: meta, source: 'token_metadata' };
  }
  log('warn-step', 'token_metadata', null, tokenFingerprint, eventId);

  const insp = normalizeFaceUnit(inspectResult?.face_unit);
  if (insp !== null) {
    log('info', 'inspect', insp, tokenFingerprint, eventId);
    return { faceUnit: insp, source: 'inspect' };
  }
  log('warn-step', 'inspect', null, tokenFingerprint, eventId);

  const rcv = normalizeFaceUnit(receiveResult?.face_unit ?? receiveResult?.unit);
  if (rcv !== null) {
    log('info', 'receive_result', rcv, tokenFingerprint, eventId);
    return { faceUnit: rcv, source: 'receive_result' };
  }
  log('warn-step', 'receive_result', null, tokenFingerprint, eventId);

  // Fifth and final source: the merchant's NIP-78 profile, looked up by
  // issuer pubkey. The buy page caches this profile when resolving the
  // merchant at the start of a purchase, so consulting it at voucher-
  // save time costs nothing and closes the race where the gateway's
  // saga has just dispatched the DM but token-metadata / inspect /
  // receive-response endpoints haven't yet propagated face_unit.
  // Be permissive about the field name — backend, profile-service, and
  // NIP-78 events have historically diverged on `issuance_currency`
  // vs `issuanceCurrency` vs `face_unit` vs `currency` vs the first entry
  // of a `currencies` array. Accept any of them; first non-empty wins.
  let merchant = null;
  if (merchantProfile && typeof merchantProfile === 'object') {
    const candidates = [
      merchantProfile.issuance_currency,
      merchantProfile.issuanceCurrency,
      merchantProfile.face_unit,
      merchantProfile.faceUnit,
      merchantProfile.currency,
      merchantProfile.unit,
      Array.isArray(merchantProfile.currencies) ? merchantProfile.currencies[0] : null,
    ];
    for (const c of candidates) {
      const n = normalizeFaceUnit(c);
      if (n !== null) { merchant = n; break; }
    }
  }
  if (merchant !== null) {
    log('info', 'merchant_profile', merchant, tokenFingerprint, eventId);
    return { faceUnit: merchant, source: 'merchant_profile' };
  }
  log('warn-step', 'merchant_profile', null, tokenFingerprint, eventId);

  log('error-unresolved', 'unknown', null, tokenFingerprint, eventId);
  return { faceUnit: UNKNOWN, source: 'unknown' };
}

function log(kind, step, value, tokenFingerprint, eventId) {
  const fp = tokenFingerprint ? tokenFingerprint.slice(0, 8) : undefined;
  if (kind === 'info') {
    console.info(
      `[currency] step=${step} face_unit=${value}` +
        (fp ? ` fp=${fp}` : '') +
        (eventId ? ` event=${eventId.slice(0, 8)}` : '')
    );
  } else if (kind === 'warn-step') {
    console.warn(
      `[currency] step=${step} yielded nothing` +
        (fp ? ` fp=${fp}` : '') +
        (eventId ? ` event=${eventId.slice(0, 8)}` : '')
    );
  } else if (kind === 'error-unresolved') {
    console.error(
      `[currency] face_unit unresolvable — recording as UNKNOWN` +
        (fp ? ` fp=${fp}` : '') +
        (eventId ? ` event=${eventId.slice(0, 8)}` : '')
    );
  }
}

if (typeof window !== 'undefined') {
  try {
    window.ImaniCurrency = Object.freeze({
      UNKNOWN,
      normalizeFaceUnit,
      resolveFaceUnit,
    });
  } catch (_) {
    // best-effort exposure for classic scripts
  }
}
