import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { computeSha256Hex } from '../src/hash';

describe('computeSha256Hex', () => {
  it('matches the known test vector for empty input', () => {
    // Standard SHA-256 of "" — well-known constant.
    const hex = computeSha256Hex(new Uint8Array(0));
    expect(hex).toEqual('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches the known test vector for "abc"', () => {
    const bytes = new TextEncoder().encode('abc');
    const hex = computeSha256Hex(bytes);
    expect(hex).toEqual('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('produces 64 lowercase hex characters', () => {
    const hex = computeSha256Hex(new Uint8Array([1, 2, 3, 4, 5]));
    expect(hex).toHaveLength(64);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches SubtleCrypto.digest("SHA-256", ...) on random buffers up to 5 MB', async () => {
    const sizes = [1, 100, 4096, 65_536, 1_000_000, 5_000_000];
    for (const size of sizes) {
      const bytes = new Uint8Array(size);
      // Deterministic pseudo-random fill so re-runs are stable.
      let seed = size;
      for (let i = 0; i < size; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        bytes[i] = seed & 0xff;
      }
      const ourHex = computeSha256Hex(bytes);
      const ref = await webcrypto.subtle.digest('SHA-256', bytes);
      let refHex = '';
      const view = new Uint8Array(ref);
      for (let i = 0; i < view.length; i++) {
        refHex += (view[i] ?? 0).toString(16).padStart(2, '0');
      }
      expect(ourHex).toEqual(refHex);
    }
  });
});
