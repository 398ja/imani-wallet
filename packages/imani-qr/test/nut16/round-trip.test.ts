import { describe, expect, it } from 'vitest';

import { createDecoder } from '../../src/nut16/decoder';
import { encode } from '../../src/nut16/encoder';

const BASE64_URL_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

function makeCashuB(payloadLength: number, seed = 0): string {
  let body = '';
  for (let i = 0; i < payloadLength; i += 1) {
    body += BASE64_URL_CHARS[(seed + i * 31 + 7) % BASE64_URL_CHARS.length];
  }
  return `cashuB${body}`;
}

function roundTripAnimated(token: string, maxFragmentLength = 100): string {
  const result = encode(token, { forceAnimated: true, maxFragmentLength });
  if (result.mode !== 'animated') throw new Error('expected animated');
  const decoder = createDecoder();
  // Pull up to 4× the natural fragment count to handle fountain-code redundancy.
  const maxPulls = Math.max(result.estimatedFrameCount * 4, 10);
  for (let i = 0; i < maxPulls; i += 1) {
    decoder.receive(result.frames.next().value);
    if (decoder.isComplete()) break;
  }
  expect(decoder.isComplete()).toBe(true);
  return decoder.result();
}

describe('encode() ↔ createDecoder() round-trip', () => {
  it('round-trips a small token', () => {
    const token = makeCashuB(50);
    expect(roundTripAnimated(token)).toBe(token);
  });

  it('round-trips a medium token', () => {
    const token = makeCashuB(500);
    expect(roundTripAnimated(token)).toBe(token);
  });

  it('round-trips a large token (2000 bytes)', () => {
    const token = makeCashuB(2000);
    expect(roundTripAnimated(token)).toBe(token);
  });

  it('round-trips with a small maxFragmentLength', () => {
    const token = makeCashuB(800);
    expect(roundTripAnimated(token, 30)).toBe(token);
  });

  it('fuzz: round-trips 50 tokens of varied lengths and seeds', () => {
    for (let i = 0; i < 50; i += 1) {
      const length = 32 + (i * 47) % 1500;
      const token = makeCashuB(length, i * 13);
      expect(roundTripAnimated(token)).toBe(token);
    }
  });

  it('round-trips with proof-count-headroom-equivalent sizes (covers SC-001 32-proof target)', () => {
    // A 32-proof token with DLEQ + P2PK is ~5000 bytes worst case.
    // Test up to 6000 bytes to confirm we comfortably exceed the SC-001 target.
    for (const length of [1000, 2000, 4000, 6000]) {
      const token = makeCashuB(length);
      expect(roundTripAnimated(token)).toBe(token);
    }
  });

  it('static-mode tokens are returned verbatim (no UR wrapping)', () => {
    const token = makeCashuB(50);
    const result = encode(token);
    expect(result.mode).toBe('static');
    if (result.mode === 'static') {
      expect(result.staticContent).toBe(token);
    }
  });
});
