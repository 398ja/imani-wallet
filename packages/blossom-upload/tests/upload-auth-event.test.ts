import { describe, it, expect } from 'vitest';
import { buildUnsignedAuthEvent, encodeAuthorizationHeader, DEFAULT_EXPIRATION_WINDOW_SECONDS } from '../src/auth';
import type { SignedAuthEvent } from '../src/types';

const HEX64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const HEX128 = HEX64 + HEX64;

describe('buildUnsignedAuthEvent', () => {
  it('emits the BUD-11 tag shape for t=media', () => {
    const event = buildUnsignedAuthEvent({
      pubkey: 'a'.repeat(64),
      verb: 'media',
      sha256Hex: HEX64,
      nowSeconds: 1700000000,
    });
    expect(event.kind).toBe(24242);
    expect(event.created_at).toBe(1700000000);
    expect(event.content).toBe('Upload optimized media');
    expect(event.tags).toEqual([
      ['t', 'media'],
      ['x', HEX64],
      ['expiration', String(1700000000 + DEFAULT_EXPIRATION_WINDOW_SECONDS)],
    ]);
  });

  it('emits content="Upload Blob" for t=upload', () => {
    const event = buildUnsignedAuthEvent({
      pubkey: 'a'.repeat(64),
      verb: 'upload',
      sha256Hex: HEX64,
      nowSeconds: 1700000000,
    });
    expect(event.content).toBe('Upload Blob');
    expect(event.tags[0]).toEqual(['t', 'upload']);
  });

  it('expiration is exactly now+300', () => {
    const event = buildUnsignedAuthEvent({
      pubkey: 'a'.repeat(64),
      verb: 'upload',
      sha256Hex: HEX64,
      nowSeconds: 999,
    });
    const exp = event.tags.find(([k]) => k === 'expiration')?.[1];
    expect(exp).toBe('1299');
  });

  it('x tag matches /^[0-9a-f]{64}$/', () => {
    const event = buildUnsignedAuthEvent({
      pubkey: 'a'.repeat(64),
      verb: 'media',
      sha256Hex: HEX64,
    });
    const x = event.tags.find(([k]) => k === 'x')?.[1];
    expect(x).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('encodeAuthorizationHeader', () => {
  function validSigned(): SignedAuthEvent {
    return {
      kind: 24242,
      pubkey: 'a'.repeat(64),
      created_at: 1700000000,
      tags: [
        ['t', 'media'],
        ['x', HEX64],
        ['expiration', '1700000300'],
      ],
      content: 'Upload optimized media',
      id: HEX64,
      sig: HEX128,
    };
  }

  it('produces "Nostr " + standard base64 of the JSON event', () => {
    // BUD-01 requires standard RFC 4648 base64 (with +/=). URL-safe was
    // rejected by the production Blossom server 2026-05-30 with "invalid base64 for
    // auth event".
    const header = encodeAuthorizationHeader(validSigned());
    expect(header.startsWith('Nostr ')).toBe(true);
    const b64 = header.slice('Nostr '.length);
    expect(b64).toMatch(/^[A-Za-z0-9+/]+=*$/);    // standard alphabet
  });

  it('decoding the base64 payload reproduces the signed event', () => {
    const header = encodeAuthorizationHeader(validSigned());
    const b64 = header.slice('Nostr '.length);
    const json = globalThis.atob(b64);
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe(HEX64);
    expect(parsed.sig).toBe(HEX128);
    expect(parsed.kind).toBe(24242);
    expect(parsed.pubkey).toBe('a'.repeat(64));
    expect(parsed.content).toBe('Upload optimized media');
  });

  it('throws on an invalid id length', () => {
    const bad: SignedAuthEvent = { ...validSigned(), id: 'short' };
    expect(() => encodeAuthorizationHeader(bad)).toThrow(/invalid id/);
  });

  it('throws on an invalid sig length', () => {
    const bad: SignedAuthEvent = { ...validSigned(), sig: 'short' };
    expect(() => encodeAuthorizationHeader(bad)).toThrow(/invalid sig/);
  });

  it('throws if kind was mutated away from 24242', () => {
    const bad: SignedAuthEvent = { ...validSigned(), kind: 24242 as 24242 };
    // Force the runtime check via a type cast — TS type still says 24242.
    (bad as { kind: number }).kind = 1;
    expect(() => encodeAuthorizationHeader(bad)).toThrow(/kind/);
  });
});
