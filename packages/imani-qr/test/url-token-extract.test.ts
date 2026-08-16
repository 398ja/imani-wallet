/**
 * packages/imani-qr/test/url-token-extract.test.ts — Spec 035 US1 T005.
 *
 * URL-embedded Cashu-token extraction (FR-003). The detector falls back to
 * URL extraction when the standard pattern match returns UNKNOWN, so a
 * scanned QR whose content is a URL with an embedded cashu token routes
 * the same as a bare token — without ever opening the long outer URL
 * (which would HTTP 414 for large tokens).
 */
import { describe, expect, it } from 'vitest';
import { extractEmbeddedCashuToken, detect, QrType } from '../src/detector';

const small = 'cashuB' + 'A'.repeat(100); // ~106 bytes
const big = 'cashuB' + 'A'.repeat(800);   // ~806 bytes
const altA = 'cashuA' + 'x'.repeat(80);

describe('extractEmbeddedCashuToken (FR-003)', () => {
  it('extracts a single embedded token from the query string', () => {
    const url = `https://wallet.example/receive.html?token=${encodeURIComponent(big)}`;
    expect(extractEmbeddedCashuToken(url)).toBe(big);
  });

  it('extracts when the token is in any query key (not just ?token=)', () => {
    const url = `https://wallet.example/r?foo=bar&voucher=${encodeURIComponent(small)}`;
    expect(extractEmbeddedCashuToken(url)).toBe(small);
  });

  it('extracts from the hash fragment when it carries a token value', () => {
    const url = `https://wallet.example/r#token=${encodeURIComponent(small)}`;
    expect(extractEmbeddedCashuToken(url)).toBe(small);
  });

  it('extracts when the fragment is the raw token (no key=)', () => {
    const url = `https://wallet.example/r#${encodeURIComponent(small)}`;
    expect(extractEmbeddedCashuToken(url)).toBe(small);
  });

  it('returns null when no token is present', () => {
    expect(extractEmbeddedCashuToken('https://wallet.example/r?foo=bar')).toBeNull();
  });

  it('returns null when more than one valid token is present (ambiguous, FR-003)', () => {
    const url = `https://wallet.example/r?one=${encodeURIComponent(small)}&two=${encodeURIComponent(altA)}`;
    expect(extractEmbeddedCashuToken(url)).toBeNull();
  });

  it('returns null for a non-URL string', () => {
    expect(extractEmbeddedCashuToken('hello world')).toBeNull();
    expect(extractEmbeddedCashuToken('')).toBeNull();
    expect(extractEmbeddedCashuToken(small)).toBeNull(); // bare token isn't a URL
  });

  it('accepts a cashu:cashuB-prefixed value in a URL', () => {
    const t = 'cashu:cashuB' + 'A'.repeat(60);
    const url = `https://wallet.example/r?x=${encodeURIComponent(t)}`;
    expect(extractEmbeddedCashuToken(url)).toBe(t);
  });
});

describe('QrTypeDetector.detect — URL-embedded token fallback (spec 035 US1)', () => {
  it('detects a URL containing exactly one cashu token as CASHU_TOKEN with normalized=extracted', () => {
    const url = `https://wallet.example/receive.html?token=${encodeURIComponent(big)}`;
    const result = detect(url);
    expect(result.type).toBe(QrType.CASHU_TOKEN);
    expect(result.normalized).toBe(big);
    expect(result.raw).toBe(url);
  });

  it('keeps URLs with no valid embedded token as UNKNOWN', () => {
    const result = detect('https://wallet.example/x');
    expect(result.type).toBe(QrType.UNKNOWN);
  });

  it('does not extract when two valid tokens are embedded', () => {
    const url = `https://wallet.example/r?one=${encodeURIComponent(altA)}&two=${encodeURIComponent(big)}`;
    const result = detect(url);
    expect(result.type).toBe(QrType.UNKNOWN);
  });

  it('preserves bare-token detection (regression guard — the URL fallback must not interfere)', () => {
    const result = detect(small);
    expect(result.type).toBe(QrType.CASHU_TOKEN);
    expect(result.normalized).toBe(small);
  });
});
