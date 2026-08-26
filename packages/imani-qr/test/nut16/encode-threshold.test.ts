/**
 * packages/imani-qr/test/nut16/encode-threshold.test.ts — Spec 035 US3 T022.
 *
 * STATIC_BYTE_GUARD boundary: `encode()` must return `mode:'static'`
 * for tokens whose byte length is ≤ guard, and `mode:'animated'` (a
 * BC-UR fountain stream) for tokens strictly larger than the guard.
 * Spec 035 US3 T024 lowered the guard from 400 → 240; the assertions
 * below test the boundary as an invariant of `STATIC_BYTE_GUARD`
 * rather than hard-coding 240, so a future ratchet stays green.
 */
import { describe, expect, it } from 'vitest';
import { encode } from '../../src/nut16/encoder';
import { STATIC_BYTE_GUARD } from '../../src/nut16/types';

// Real-shape cashuB tokens — the encoder requires a cashu V4 prefix; the
// body content is opaque from the encoder's perspective, so we synthesise
// strings of the right byte length to land exactly at the boundary.
function makeTokenOfBytes(bytes: number): string {
  const prefix = 'cashuB';
  if (bytes <= prefix.length) return prefix;
  return prefix + 'A'.repeat(bytes - prefix.length);
}

describe('encode() — STATIC_BYTE_GUARD boundary (spec 035 US3 T022)', () => {
  it('a token AT the guard renders as a single static QR', () => {
    const token = makeTokenOfBytes(STATIC_BYTE_GUARD);
    const result = encode(token);
    expect(result.mode).toBe('static');
    if (result.mode === 'static') {
      expect(result.staticContent).toBe(token);
    }
  });

  it('a token ONE BYTE below the guard renders as a single static QR', () => {
    const token = makeTokenOfBytes(STATIC_BYTE_GUARD - 1);
    const result = encode(token);
    expect(result.mode).toBe('static');
  });

  it('a token ONE BYTE above the guard renders animated (multi-frame)', () => {
    const token = makeTokenOfBytes(STATIC_BYTE_GUARD + 1);
    const result = encode(token);
    expect(result.mode).toBe('animated');
    if (result.mode === 'animated') {
      expect(typeof result.frames?.next).toBe('function');
    }
  });

  it('a large 800-byte token renders animated', () => {
    const token = makeTokenOfBytes(800);
    const result = encode(token);
    expect(result.mode).toBe('animated');
  });

  it('a tiny 50-byte token renders static (regression guard for the small-token UX)', () => {
    const token = makeTokenOfBytes(50);
    const result = encode(token);
    expect(result.mode).toBe('static');
  });

  it('the STATIC_BYTE_GUARD is in the documented target band 200-240 (spec 035 D4)', () => {
    expect(STATIC_BYTE_GUARD).toBeGreaterThanOrEqual(200);
    expect(STATIC_BYTE_GUARD).toBeLessThanOrEqual(240);
  });
});
