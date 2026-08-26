/**
 * Formatting utilities for sats, fiat, and time display
 */

console.log('[format] format.js loaded v3');

// ==================== Cashu Token Utilities ====================

/**
 * Decode base64url to bytes
 * @param {string} base64url - Base64url encoded string
 * @returns {Uint8Array} - Decoded bytes
 */
function base64urlToBytes(base64url) {
  // Convert base64url to base64
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');

  // Add padding if needed
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);

  // Decode base64 to bytes
  const binaryString = atob(padded);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Try to decompress bytes with various formats
 * @param {Uint8Array} bytes - Compressed bytes
 * @returns {Promise<Uint8Array|null>} - Decompressed bytes or null if decompression fails
 */
async function tryDecompress(bytes) {
  const formats = ['deflate-raw', 'deflate', 'gzip'];

  for (const format of formats) {
    try {
      const stream = new Blob([bytes]).stream();
      const decompressedStream = stream.pipeThrough(new DecompressionStream(format));
      const decompressedBlob = await new Response(decompressedStream).blob();
      const arrayBuffer = await decompressedBlob.arrayBuffer();
      console.log('[format] Decompressed with format:', format);
      return new Uint8Array(arrayBuffer);
    } catch (e) {
      // Try next format
    }
  }
  return null;
}

/**
 * Decode a cashuB token
 * cashuB tokens are CBOR-encoded and base64url encoded
 * Some tokens may also be compressed (gzip/deflate)
 * @param {string} base64Data - Base64url encoded data (without cashuB prefix)
 * @returns {Promise<Uint8Array>} - Decoded CBOR bytes
 */
async function decodeCashuBData(base64Data) {
  const bytes = base64urlToBytes(base64Data);

  // First, try CBOR decode directly (V4 tokens are NOT compressed)
  try {
    // Quick check: CBOR data typically starts with specific bytes
    // Map starts with 0xA0-0xBF or 0xB8-0xBB for larger maps
    // Array starts with 0x80-0x9F or 0x98-0x9B for larger arrays
    const firstByte = bytes[0];
    const isCborMap = (firstByte >= 0xA0 && firstByte <= 0xBF) || firstByte === 0xB8 || firstByte === 0xB9;
    const isCborArray = (firstByte >= 0x80 && firstByte <= 0x9F) || firstByte === 0x98 || firstByte === 0x99;

    if (isCborMap || isCborArray) {
      console.log('[format] Detected uncompressed CBOR data (first byte: 0x' + firstByte.toString(16) + ')');
      return bytes;
    }
  } catch (e) {
    // Continue to try decompression
  }

  // Try decompression (for older compressed tokens)
  const decompressed = await tryDecompress(bytes);
  if (decompressed) {
    return decompressed;
  }

  // If decompression failed but bytes might still be valid CBOR, return them
  // The CBOR decoder will throw if they're invalid
  console.log('[format] Using raw bytes (no decompression needed or possible)');
  return bytes;
}

/**
 * Decode CBOR bytes to JavaScript object
 * Simple CBOR decoder for cashuB tokens
 * @param {Uint8Array} data - CBOR encoded bytes
 * @returns {Object} - Decoded object
 */
function decodeCbor(data) {
  let offset = 0;

  function readByte() {
    return data[offset++];
  }

  function readBytes(count) {
    const bytes = data.slice(offset, offset + count);
    offset += count;
    return bytes;
  }

  function readUint(additionalInfo) {
    if (additionalInfo < 24) return additionalInfo;
    if (additionalInfo === 24) return readByte();
    if (additionalInfo === 25) {
      return (readByte() << 8) | readByte();
    }
    if (additionalInfo === 26) {
      return (readByte() << 24) | (readByte() << 16) | (readByte() << 8) | readByte();
    }
    if (additionalInfo === 27) {
      // 64-bit - JavaScript can't handle full precision, but tokens don't need it
      let high = (readByte() << 24) | (readByte() << 16) | (readByte() << 8) | readByte();
      let low = (readByte() << 24) | (readByte() << 16) | (readByte() << 8) | readByte();
      return high * 0x100000000 + low;
    }
    if (additionalInfo === 31) {
      // Indefinite length - handled specially by caller
      return -1;
    }
    throw new Error('Invalid CBOR additional info: ' + additionalInfo);
  }

  function isBreak() {
    // Peek at next byte to check for break (0xff)
    return offset < data.length && data[offset] === 0xff;
  }

  function consumeBreak() {
    if (data[offset] === 0xff) {
      offset++;
      return true;
    }
    return false;
  }

  function decode() {
    const initial = readByte();
    const majorType = initial >> 5;
    const additionalInfo = initial & 0x1f;

    switch (majorType) {
      case 0: // Unsigned integer
        return readUint(additionalInfo);

      case 1: // Negative integer
        return -1 - readUint(additionalInfo);

      case 2: { // Byte string
        const length = readUint(additionalInfo);
        if (length === -1) {
          // Indefinite-length byte string - concatenate chunks until break
          const chunks = [];
          while (!isBreak()) {
            const chunk = decode();
            if (chunk instanceof Uint8Array) {
              chunks.push(chunk);
            }
          }
          consumeBreak();
          const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
          const result = new Uint8Array(totalLength);
          let pos = 0;
          for (const chunk of chunks) {
            result.set(chunk, pos);
            pos += chunk.length;
          }
          return result;
        }
        return readBytes(length);
      }

      case 3: { // Text string
        const length = readUint(additionalInfo);
        if (length === -1) {
          // Indefinite-length text string - concatenate chunks until break
          let result = '';
          while (!isBreak()) {
            result += decode();
          }
          consumeBreak();
          return result;
        }
        const bytes = readBytes(length);
        return new TextDecoder().decode(bytes);
      }

      case 4: { // Array
        const length = readUint(additionalInfo);
        const arr = [];
        if (length === -1) {
          // Indefinite-length array - read until break
          while (!isBreak()) {
            arr.push(decode());
          }
          consumeBreak();
        } else {
          for (let i = 0; i < length; i++) {
            arr.push(decode());
          }
        }
        return arr;
      }

      case 5: { // Map
        const length = readUint(additionalInfo);
        const obj = {};
        if (length === -1) {
          // Indefinite-length map - read key-value pairs until break
          while (!isBreak()) {
            const key = decode();
            const value = decode();
            obj[key] = value;
          }
          consumeBreak();
        } else {
          for (let i = 0; i < length; i++) {
            const key = decode();
            const value = decode();
            obj[key] = value;
          }
        }
        return obj;
      }

      case 6: // Tag (ignore tag number, decode tagged value)
        readUint(additionalInfo);
        return decode();

      case 7: // Simple/float
        if (additionalInfo === 20) return false;
        if (additionalInfo === 21) return true;
        if (additionalInfo === 22) return null;
        if (additionalInfo === 23) return undefined;
        throw new Error('Unsupported CBOR simple value: ' + additionalInfo);

      default:
        throw new Error('Unknown CBOR major type: ' + majorType);
    }
  }

  return decode();
}

/**
 * Convert byte array to hex string
 * @param {Uint8Array} bytes - Byte array
 * @returns {string} - Hex string
 */
function bytesToHex(bytes) {
  if (typeof bytes === 'string') return bytes;
  if (!(bytes instanceof Uint8Array)) return String(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert CBOR-decoded V4 token to JSON token format
 * V4 tokens use single-letter keys, convert to full names
 * @param {Object} cborToken - CBOR decoded token object
 * @returns {Object} - JSON token object with full field names
 */
function convertV4TokenToJson(cborToken) {
  // V4 token structure uses short keys:
  // m = mint URL, u = unit, d = memo, t = token entries
  // Each token entry: i = keyset id, p = proofs
  // Each proof: a = amount, s = secret, c = C (signature as bytes)

  // Check for Imani voucher token (custom format with "VOUCHER" marker)
  // These tokens have an array structure: ["VOUCHER", <voucher_id>, <issuer_id>, ...]
  if (Array.isArray(cborToken) && cborToken.length > 0) {
    const firstElement = cborToken[0];
    if (typeof firstElement === 'string' && firstElement.includes('VOUCHER')) {
      throw new Error('Imani voucher token - not a standard cashu token');
    }
  }

  const result = {
    token: []
  };

  if (cborToken.m) {
    // Single mint URL for all entries
    const mintUrl = cborToken.m;

    if (cborToken.t && Array.isArray(cborToken.t)) {
      const proofs = [];
      for (const entry of cborToken.t) {
        // Keyset ID might be bytes or string
        const keysetId = entry.i instanceof Uint8Array ? bytesToHex(entry.i) : entry.i;

        if (entry.p && Array.isArray(entry.p)) {
          for (const proof of entry.p) {
            // C (signature) is typically bytes, convert to hex
            const cValue = proof.c instanceof Uint8Array ? bytesToHex(proof.c) : proof.c;
            // Secret is typically a string
            const secret = proof.s instanceof Uint8Array ? new TextDecoder().decode(proof.s) : proof.s;

            proofs.push({
              id: keysetId,
              amount: proof.a,
              secret: secret,
              C: cValue
            });
          }
        }
      }
      result.token.push({
        mint: mintUrl,
        proofs: proofs
      });
    }
  }

  if (cborToken.u) result.unit = cborToken.u;
  if (cborToken.d) result.memo = cborToken.d;

  return result;
}

/**
 * Decode a Cashu token (handles both cashuA and cashuB formats)
 * - cashuA: base64url encoded JSON (V3 tokens)
 * - cashuB: base64url encoded, compressed CBOR (V4 tokens)
 * @param {string} token - Cashu token string
 * @returns {Promise<Object>} - Decoded token object
 */
async function decodeCashuToken(token) {
  if (!token) throw new Error('No token provided');

  let data = token.trim();
  let isCompressed = false;

  // Remove cashu: URI prefix if present
  if (data.startsWith('cashu:')) {
    data = data.slice(6);
  }

  // Check prefix and remove it
  if (data.startsWith('cashuB')) {
    isCompressed = true;
    data = data.slice(6);
  } else if (data.startsWith('cashuA')) {
    data = data.slice(6);
  }

  // Remove any fragment/hash metadata (e.g., #fv=1000&fu=EUR)
  const hashIndex = data.indexOf('#');
  if (hashIndex !== -1) {
    data = data.substring(0, hashIndex);
  }

  try {
    if (isCompressed) {
      // cashuB: V4 token - CBOR encoded (may or may not be compressed)
      console.log('[format] Decoding cashuB token...');
      const cborBytes = await decodeCashuBData(data);

      // Try CBOR decode first (V4 format)
      try {
        const cborData = decodeCbor(cborBytes);
        console.log('[format] Decoded as CBOR V4 token');
        return convertV4TokenToJson(cborData);
      } catch (cborError) {
        // Fallback: try as JSON (legacy compressed tokens)
        console.log('[format] CBOR decode failed, trying JSON fallback:', cborError.message);
        const jsonString = new TextDecoder().decode(cborBytes);
        return JSON.parse(jsonString);
      }
    } else {
      // cashuA: just base64url decode JSON
      const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
      const jsonString = atob(padded);
      return JSON.parse(jsonString);
    }
  } catch (error) {
    // Log token details for debugging (first 80 chars)
    const tokenPreview = token.length > 80 ? token.substring(0, 80) + '...' : token;
    console.error('[format] Failed to decode token:', error.message, 'token:', tokenPreview, 'length:', token.length, 'cashuB:', isCompressed);
    throw new Error('Invalid token format: ' + error.message);
  }
}

/**
 * Get token info without full decode (for validation/preview)
 * @param {string} token - Cashu token string
 * @returns {Promise<Object>} - { mint, totalAmount, proofCount }
 */
async function getTokenInfo(token) {
  const decoded = await decodeCashuToken(token);

  let totalAmount = 0;
  let proofCount = 0;
  let mint = '';

  if (decoded.token && Array.isArray(decoded.token)) {
    decoded.token.forEach(t => {
      if (t.mint) mint = t.mint;
      if (t.proofs && Array.isArray(t.proofs)) {
        t.proofs.forEach(p => {
          totalAmount += p.amount || 0;
          proofCount++;
        });
      }
    });
  }

  return { mint, totalAmount, proofCount, decoded };
}

/**
 * Synchronously sum all proof amounts from a Cashu token string.
 * Used to derive face_value from actual token proofs at load time,
 * making face_value tamper-proof against relay sync overwrites.
 *
 * For cashuB (V4 CBOR): base64url decode → CBOR decode → sum proof.a
 * For cashuA (V3 JSON): base64url decode → JSON parse → sum proof.amount
 * Skips async decompression — returns null for old compressed tokens.
 *
 * @param {string} tokenString - Cashu token string (cashuA... or cashuB...)
 * @returns {number|null} - Sum of proof amounts, or null if decoding fails
 */
function sumTokenProofs(tokenString) {
  if (!tokenString) return null;

  try {
    let data = tokenString.trim();

    // Remove cashu: URI prefix if present
    if (data.startsWith('cashu:')) {
      data = data.slice(6);
    }

    let isCashuB = false;
    if (data.startsWith('cashuB')) {
      isCashuB = true;
      data = data.slice(6);
    } else if (data.startsWith('cashuA')) {
      data = data.slice(6);
    }

    // Remove fragment metadata (e.g., #fv=1000&fu=EUR)
    const hashIndex = data.indexOf('#');
    if (hashIndex !== -1) {
      data = data.substring(0, hashIndex);
    }

    let decoded;
    if (isCashuB) {
      // cashuB: base64url → bytes → CBOR decode (sync path only)
      const bytes = base64urlToBytes(data);

      // Check if it looks like uncompressed CBOR
      const firstByte = bytes[0];
      const isCborMap = (firstByte >= 0xA0 && firstByte <= 0xBF) || firstByte === 0xB8 || firstByte === 0xB9;
      const isCborArray = (firstByte >= 0x80 && firstByte <= 0x9F) || firstByte === 0x98 || firstByte === 0x99;

      if (!isCborMap && !isCborArray) {
        // Likely compressed — can't decode synchronously
        return null;
      }

      const cborData = decodeCbor(bytes);
      decoded = convertV4TokenToJson(cborData);
    } else {
      // cashuA: base64url → JSON
      const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
      const jsonString = atob(padded);
      decoded = JSON.parse(jsonString);
    }

    // Sum all proof amounts
    let total = 0;
    if (decoded.token && Array.isArray(decoded.token)) {
      for (const entry of decoded.token) {
        if (entry.proofs && Array.isArray(entry.proofs)) {
          for (const proof of entry.proofs) {
            total += proof.amount || 0;
          }
        }
      }
    }

    return total > 0 ? total : null;
  } catch (e) {
    console.warn('[format] sumTokenProofs failed:', e.message);
    return null;
  }
}

// ==================== Number Formatting ====================

/**
 * Resolve the locale used for number formatting. We deliberately do NOT
 * use the currency's "home" locale (e.g. XAF → fr-CM, EUR → de-DE) for
 * the digit-grouping/decimal conventions, because that yields confusing
 * mixed conventions for a single user — an en-US customer holding EUR
 * vouchers would see "€12.345,67" while their USD balance shows
 * "$12,345.67". Instead, every amount uses the USER's locale (browser
 * `navigator.language` chain, falling back to en-US) for separators and
 * decimal style. The CURRENCY config still drives symbol + position +
 * decimal-count (XAF stays symbol-after with 0 decimals; EUR stays
 * symbol-before with 2 decimals). Matches the spec-046 stance for
 * amount-input parsing: locale comes from the user, not the currency.
 */
function _resolveUserLocale() {
  try {
    if (typeof navigator !== 'undefined') {
      if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
        return navigator.languages[0];
      }
      if (typeof navigator.language === 'string' && navigator.language) {
        return navigator.language;
      }
    }
  } catch (_e) { /* defensive */ }
  return 'en-US';
}

/**
 * Post-process an Intl.NumberFormat output so the thousands separator is
 * always visible to the customer.
 *
 * Why: since CLDR 39 (~ Node 18 / Chrome 99 / Firefox 116), the French
 * thousands separator returned by `Intl.NumberFormat('fr-*', ...)` is
 * U+202F (NARROW NO-BREAK SPACE) instead of the historical U+0020
 * (regular space). U+202F is roughly 1/6 em wide and renders as nearly
 * zero-width in many fonts / on small screens — so `7 137 FCFA` looks
 * like `7137 FCFA` to the customer and they (rightly) report "missing
 * thousand separator". The same affects U+00A0 (NO-BREAK SPACE) which
 * some locales use as the separator too.
 *
 * We canonicalise both to a regular U+0020 space so every customer sees
 * the same readable gap. This trades the NBSP property (no line break
 * inside the number) for visibility, which is the right trade for a
 * wallet UI where amounts are short, already on their own line, and
 * never expected to break across lines.
 */
function _normaliseThousandsSeparator(formatted) {
  if (typeof formatted !== 'string') return formatted;
  // U+202F NARROW NO-BREAK SPACE, U+00A0 NO-BREAK SPACE
  return formatted.replace(/[  ]/g, ' ');
}

function formatSats(sats) {
  if (sats === null || sats === undefined) return '0';
  // User locale drives separators (was pinned to 'en-US' historically;
  // now consistent with formatFaceValue).
  return _normaliseThousandsSeparator(
    new Intl.NumberFormat(_resolveUserLocale()).format(Math.floor(sats))
  );
}

function formatSatsWithUnit(sats) {
  return `${formatSats(sats)} ₿`;
}

function parseSats(str) {
  if (!str) return 0;
  return parseInt(str.toString().replace(/[^0-9]/g, ''), 10) || 0;
}

/**
 * No-op placeholder for backwards compatibility.
 * BTC price fetching has been removed - vouchers use fixed issuance ratios.
 */
async function fetchBtcPrice() {
  // No-op: BTC price fetching removed
  return Promise.resolve();
}

function formatCountdown(secondsRemaining) {
  if (secondsRemaining <= 0) return 'Expired';
  const minutes = Math.floor(secondsRemaining / 60);
  const seconds = secondsRemaining % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}:${mins.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function coerceDateValue(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number') {
    const timestampMs = value > 1e12 ? value : value * 1000;
    const numericDate = new Date(timestampMs);
    return Number.isNaN(numericDate.getTime()) ? null : numericDate;
  }

  if (typeof value === 'string') {
    const parsedDate = new Date(value);
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  }

  if (typeof value === 'object') {
    if (typeof value.getTime === 'function') {
      const candidateTime = value.getTime();
      if (Number.isFinite(candidateTime)) {
        const dateFromGetTime = new Date(candidateTime);
        return Number.isNaN(dateFromGetTime.getTime()) ? null : dateFromGetTime;
      }
    }

    if (typeof value.toISOString === 'function') {
      const isoDate = new Date(value.toISOString());
      return Number.isNaN(isoDate.getTime()) ? null : isoDate;
    }
  }

  return null;
}

function formatExpiryDate(expiresAt) {
  const date = coerceDateValue(expiresAt) || new Date(expiresAt);
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function isExpired(expiresAt) {
  // No expiry means never expires
  if (!expiresAt) return false;

  const date = coerceDateValue(expiresAt);
  if (!date) return false;

  return date < new Date();
}

function getSecondsRemaining(expiry) {
  let expiryMs;
  if (typeof expiry === 'number') {
    expiryMs = expiry * 1000;
  } else {
    expiryMs = new Date(expiry).getTime();
  }
  return Math.floor((expiryMs - Date.now()) / 1000);
}

function truncate(str, maxLength = 20) {
  if (!str || str.length <= maxLength) return str;
  const half = Math.floor((maxLength - 3) / 2);
  return `${str.slice(0, half)}...${str.slice(-half)}`;
}

// ==================== Device locale accessor (spec 046) ====================

/**
 * Resolve the device's number-format locale tag — used by every amount input bridge
 * (`shared/localeAmountInputIntegration.js`) AND every display-side caller of
 * `formatFaceValue` / `formatAmount` to keep input + display locale sources identical
 * (spec 046, single deterministic source of truth).
 *
 * Returns `navigator.languages?.[0] ?? navigator.language ?? 'en-US'`. The wallet's
 * UI-language chain in `shared/i18n/bootstrap.js` is a different signal and is NOT
 * consulted here — a user with a French-locale device using the English UI still gets
 * comma-as-decimal because that's what their keyboard shows.
 *
 * @returns {string} BCP-47 locale tag (e.g. "fr-FR", "en-US", "pt-BR")
 */
function getDeviceLocale() {
  try {
    if (typeof navigator !== 'undefined') {
      const first = navigator.languages && navigator.languages[0];
      if (first) return first;
      if (navigator.language) return navigator.language;
    }
  } catch (_e) { /* fall through */ }
  return 'en-US';
}
// Defensive: expose on window so consumers that defensively guard
// `typeof window.getDeviceLocale === 'function'` (e.g. the web-component
// base class, T021) always see the accessor — classic-script function
// declarations are global, but the explicit attach is cheap insurance.
if (typeof window !== 'undefined') {
  window.getDeviceLocale = getDeviceLocale;
}

// ==================== Face Value Formatting (Phase 7 - MINIMAL backing) ====================

/**
 * Currency symbols for supported face currencies
 */
const CURRENCY_SYMBOLS = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  CHF: 'CHF',
  JPY: '¥',
  CAD: 'C$',
  AUD: 'A$',
  XAF: 'FCFA',
  XOF: 'FCFA',
  SAT: '₿',
  BTC: '₿'
};

/**
 * Currency configurations (symbol position, decimal separator, etc.)
 */
const CURRENCY_CONFIG = {
  EUR: { symbol: '€', position: 'before', decimals: 2, locale: 'de-DE' },
  USD: { symbol: '$', position: 'before', decimals: 2, locale: 'en-US' },
  GBP: { symbol: '£', position: 'before', decimals: 2, locale: 'en-GB' },
  CHF: { symbol: 'CHF', position: 'after', decimals: 2, locale: 'de-CH' },
  JPY: { symbol: '¥', position: 'before', decimals: 0, locale: 'ja-JP' },
  CAD: { symbol: 'C$', position: 'before', decimals: 2, locale: 'en-CA' },
  AUD: { symbol: 'A$', position: 'before', decimals: 2, locale: 'en-AU' },
  XAF: { symbol: 'FCFA', position: 'after', decimals: 0, locale: 'fr-CM' },
  XOF: { symbol: 'FCFA', position: 'after', decimals: 0, locale: 'fr-SN' },
  FCFA: { symbol: 'FCFA', position: 'after', decimals: 0, locale: 'fr-CM' },
  CFA: { symbol: 'CFA', position: 'after', decimals: 0, locale: 'fr-CM' },
  NGN: { symbol: '₦', position: 'before', decimals: 2, locale: 'en-NG' },
  KES: { symbol: 'KSh', position: 'before', decimals: 2, locale: 'en-KE' },
  ZAR: { symbol: 'R', position: 'before', decimals: 2, locale: 'en-ZA' },
  GHS: { symbol: '₵', position: 'before', decimals: 2, locale: 'en-GH' },
  UGX: { symbol: 'USh', position: 'before', decimals: 0, locale: 'en-UG' },
  TZS: { symbol: 'TSh', position: 'before', decimals: 0, locale: 'sw-TZ' },
  KRW: { symbol: '₩', position: 'before', decimals: 0, locale: 'ko-KR' },
  BRL: { symbol: 'R$', position: 'before', decimals: 2, locale: 'pt-BR' },
  MXN: { symbol: '$', position: 'before', decimals: 2, locale: 'es-MX' },
  SAT: { symbol: '₿', position: 'after', decimals: 0, locale: 'en-US', suffix: ' ₿' },
  BTC: { symbol: '₿', position: 'before', decimals: 8, locale: 'en-US' }
};

/**
 * Currency preset amounts for voucher purchase UI
 * Values are in minor units (cents for EUR/USD, whole units for XAF/XOF/JPY)
 */
const CURRENCY_PRESETS = {
  EUR: [1000, 2500, 5000, 10000],       // €10, €25, €50, €100
  USD: [1000, 2500, 5000, 10000],       // $10, $25, $50, $100
  GBP: [1000, 2500, 5000, 10000],       // £10, £25, £50, £100
  CHF: [1000, 2500, 5000, 10000],       // CHF 10, 25, 50, 100
  JPY: [1000, 2500, 5000, 10000],       // ¥1000, ¥2500, ¥5000, ¥10000
  CAD: [1000, 2500, 5000, 10000],       // C$10, C$25, C$50, C$100
  AUD: [1000, 2500, 5000, 10000],       // A$10, A$25, A$50, A$100
  XAF: [5000, 10000, 25000, 50000],     // 5000 FCFA, 10000 FCFA, 25000 FCFA, 50000 FCFA
  XOF: [5000, 10000, 25000, 50000],     // 5000 FCFA, 10000 FCFA, 25000 FCFA, 50000 FCFA
  SAT: [1000, 5000, 10000, 21000],      // 1K, 5K, 10K, 21K sats
  BTC: [10000, 100000, 1000000, 10000000] // 0.0001, 0.001, 0.01, 0.1 BTC
};

/**
 * Resolve decimal places for a currency amount.
 * Checks sources in priority order: explicit overrides first, then currency default.
 * @param {string} unit - Currency code
 * @param {...(number|null|undefined)} sources - Decimal sources in priority order
 *   (e.g., group.decimals, voucher.face_decimals)
 * @returns {number} Resolved decimal places
 */
function resolveDecimals(unit, ...sources) {
    for (const src of sources) {
        if (src !== null && src !== undefined && src >= 0) {
            return src;
        }
    }
    const normalizedUnit = (unit || 'EUR').toUpperCase();
    const config = CURRENCY_CONFIG[normalizedUnit];
    return config ? config.decimals : 2;
}

/**
 * Format a minor-unit amount for display with currency symbol.
 * Convenience wrapper that resolves decimals then calls formatFaceValue.
 * @param {number} minorUnits - Amount in minor units
 * @param {string} unit - Currency code
 * @param {...(number|null|undefined)} decimalSources - Decimal sources in priority order
 * @returns {string} Formatted string (e.g., "€2.00", "500 FCFA")
 */
function formatAmount(minorUnits, unit, ...args) {
    // Spec 046 — last arg may be a locale tag (e.g. "fr-FR"); everything before it is a
    // decimal-source candidate. We detect by typeof string; otherwise fall through.
    let displayLocale = null;
    let decimalSources = args;
    if (args.length > 0 && typeof args[args.length - 1] === 'string') {
        displayLocale = args[args.length - 1];
        decimalSources = args.slice(0, -1);
    }
    const decimals = resolveDecimals(unit, ...decimalSources);
    return formatFaceValue(minorUnits, unit, decimals, displayLocale);
}

/**
 * Format face value for display with currency symbol
 * @param {number} faceValue - Value in minor units (e.g., cents for EUR)
 * @param {string} unit - Currency code (EUR, USD, GBP, SAT, etc.)
 * @param {number} [decimals] - Decimal places (auto-detected from currency if not specified)
 * @param {string|null} [displayLocale] - Spec 046 — when non-null, overrides the currency's
 *   bundled locale for the Intl.NumberFormat call below. Pass `getDeviceLocale()` from a
 *   caller that wants device-locale formatting; pass null (or omit) for back-compat.
 * @returns {string} Formatted value (e.g., "€50.00", "$25.50", "10,000 ₿")
 */
function formatFaceValue(faceValue, unit = 'EUR', decimals = null, displayLocale = null) {
  if (faceValue === null || faceValue === undefined) return '—';

  // Normalize unit to uppercase for case-insensitive matching
  const normalizedUnit = (unit || 'EUR').toUpperCase();

  const config = CURRENCY_CONFIG[normalizedUnit] || { symbol: unit, position: 'before', decimals: 2, locale: 'en-US' };
  const decimalPlaces = decimals !== null ? decimals : config.decimals;
  const divisor = Math.pow(10, decimalPlaces);
  const value = faceValue / divisor;

  // Format the number — when displayLocale is supplied (spec 046), render in
  // that locale; otherwise fall back to the USER's resolved locale (spec 045).
  // Wrap the result with the U+202F / U+00A0 → U+0020 normaliser (spec 045)
  // so the thousands separator is consistently visible regardless of locale.
  const formatLocale = displayLocale || _resolveUserLocale();
  const formatted = _normaliseThousandsSeparator(
    new Intl.NumberFormat(formatLocale, {
      minimumFractionDigits: decimalPlaces,
      maximumFractionDigits: decimalPlaces
    }).format(value)
  );

  // Handle SAT/BTC special cases
  if (normalizedUnit === 'SAT') {
    return `${formatSats(faceValue)} ₿`;
  }
  if (normalizedUnit === 'BTC') {
    return `₿${formatted}`;
  }

  // Position symbol before or after
  if (config.position === 'after') {
    return `${formatted} ${config.symbol}`;
  }
  return `${config.symbol}${formatted}`;
}

/**
 * Format face value with secondary sats display
 * @param {number} faceValue - Face value in minor units
 * @param {string} unit - Currency code
 * @param {number} decimals - Decimal places
 * @param {number} tokenAmount - Backing sats amount
 * @returns {string} e.g., "€50.00 (10 ₿)"
 */
function formatFaceValueWithBacking(faceValue, unit, decimals, tokenAmount) {
  const faceFormatted = formatFaceValue(faceValue, unit, decimals);
  if (tokenAmount !== undefined && tokenAmount !== null) {
    return `${faceFormatted} (${formatSats(tokenAmount)} ₿)`;
  }
  return faceFormatted;
}

/**
 * Format backing badge for display
 * @param {number} tokenAmount - Sats backing the token
 * @param {string} [strategy='MINIMAL'] - Backing strategy (MINIMAL, FULL, LEGACY)
 * @param {boolean} [needsRefresh=false] - Whether voucher needs refresh from API
 * @returns {string} Formatted badge (e.g., "Backed by 10 ₿ · MINIMAL")
 */
function formatTokenBacking(tokenAmount, strategy = 'MINIMAL', needsRefresh = false) {
  if (needsRefresh) {
    return 'Loading backing info...';
  }

  if (tokenAmount === null || tokenAmount === undefined) {
    return 'Unknown backing';
  }

  const satsFormatted = formatSats(tokenAmount);

  // Don't show strategy label for LEGACY
  if (strategy === 'LEGACY') {
    return `Backed by ${satsFormatted} ₿`;
  }

  return `Backed by ${satsFormatted} ₿ · ${strategy}`;
}

/**
 * Format issuance ratio for debugging/info display
 * @param {number} faceValue - Face value in minor units
 * @param {number} tokenAmount - Token amount in sats
 * @returns {string} Ratio display (e.g., "500:1 face/₿")
 */
function formatIssuanceRatio(faceValue, tokenAmount) {
  if (!tokenAmount || tokenAmount === 0) return 'N/A';
  const ratio = Math.round(faceValue / tokenAmount);
  return `${ratio}:1 face/₿`;
}

/**
 * Format rounding delta for split preview
 * @param {number} requested - Requested face value in minor units
 * @param {number} actual - Actual face value after rounding
 * @param {string} unit - Currency code
 * @param {number} decimals - Decimal places
 * @param {string} [mode='FLOOR'] - Rounding mode (FLOOR, CEIL, ROUND)
 * @returns {string|null} Rounding note or null if no rounding needed
 */
function formatRoundingDelta(requested, actual, unit, decimals, mode = 'FLOOR') {
  if (requested === actual) return null;

  const requestedFormatted = formatFaceValue(requested, unit, decimals);
  const actualFormatted = formatFaceValue(actual, unit, decimals);
  const delta = Math.abs(requested - actual);
  const deltaFormatted = formatFaceValue(delta, unit, decimals);

  const modeLabel = mode.toLowerCase();
  return `Rounded ${modeLabel} from ${requestedFormatted} to ${actualFormatted} (Δ${deltaFormatted})`;
}

/**
 * Format a voucher's primary display value
 * Shows face value for MINIMAL/FULL, sats for LEGACY
 * @param {Object} voucher - Voucher object from storage
 * @returns {string} Primary display value
 */
function formatVoucherValue(voucher) {
  if (!voucher) return '—';

  const strategy = voucher.backing_strategy || 'LEGACY';

  if (strategy === 'LEGACY') {
    // Legacy vouchers show sats as primary
    return formatSatsWithUnit(voucher.token_amount || voucher.balance || 0);
  }

  // Always derive decimals from currency for known zero-decimal currencies
  const unit = (voucher.face_unit || 'EUR').toUpperCase();
  const decimals = ImaniMoney.isZeroDecimal(unit) ? 0 : (voucher.face_decimals ?? 2);

  // MINIMAL/FULL show face value as primary
  return formatFaceValue(
    voucher.face_value,
    voucher.face_unit || 'EUR',
    decimals
  );
}

/**
 * Format a voucher's complete display (primary + backing)
 * @param {Object} voucher - Voucher object from storage
 * @returns {Object} { primary: string, secondary: string, badge: string }
 */
function formatVoucherDisplay(voucher) {
  if (!voucher) {
    return { primary: '—', secondary: null, badge: null };
  }

  const strategy = voucher.backing_strategy || 'LEGACY';

  if (strategy === 'LEGACY') {
    return {
      primary: formatSatsWithUnit(voucher.token_amount || voucher.balance || 0),
      secondary: null,
      badge: null
    };
  }

  // Always derive decimals from currency for known zero-decimal currencies
  // This fixes vouchers that were stored with incorrect face_decimals
  const unit = (voucher.face_unit || 'EUR').toUpperCase();
  const decimals = ImaniMoney.isZeroDecimal(unit) ? 0 : (voucher.face_decimals ?? 2);

  return {
    primary: formatFaceValue(
      voucher.face_value,
      voucher.face_unit || 'EUR',
      decimals
    ),
    secondary: formatTokenBacking(voucher.token_amount, strategy),
    badge: strategy
  };
}
