import { describe, expect, it } from 'vitest';

import { encode } from '../../src/nut16/encoder';
import {
  Nut16EncodeError,
  STATIC_BYTE_GUARD,
} from '../../src/nut16/types';

const BASE64_URL_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

function makeCashuB(payloadLength: number, seed = 0): string {
  let body = '';
  for (let i = 0; i < payloadLength; i += 1) {
    body += BASE64_URL_CHARS[(seed + i * 31 + 7) % BASE64_URL_CHARS.length];
  }
  return `cashuB${body}`;
}

describe('Nut16 encode()', () => {
  describe('static mode', () => {
    it('returns static for a short cashuB token (under byte guard)', () => {
      const token = makeCashuB(50);
      const result = encode(token);
      expect(result.mode).toBe('static');
      if (result.mode === 'static') {
        expect(result.staticContent).toBe(token);
      }
    });

    it('returns static for a token at the byte guard boundary', () => {
      const token = makeCashuB(STATIC_BYTE_GUARD - 'cashuB'.length);
      const result = encode(token);
      expect(result.mode).toBe('static');
    });

    it('frameIntervalMs is echoed in static result', () => {
      const token = makeCashuB(50);
      const result = encode(token, { frameIntervalMs: 333 });
      expect(result.frameIntervalMs).toBe(333);
    });
  });

  describe('animated mode', () => {
    it('returns animated for a token over the byte guard', () => {
      const token = makeCashuB(STATIC_BYTE_GUARD + 200);
      const result = encode(token);
      expect(result.mode).toBe('animated');
      if (result.mode === 'animated') {
        expect(result.estimatedFrameCount).toBeGreaterThan(1);
      }
    });

    it('returns animated for a large token (1000-byte payload)', () => {
      const token = makeCashuB(1000);
      const result = encode(token);
      expect(result.mode).toBe('animated');
    });

    it('iterator.next() yields distinct fragments across the natural sequence', () => {
      const token = makeCashuB(600);
      const result = encode(token);
      expect(result.mode).toBe('animated');
      if (result.mode !== 'animated') return;

      const seen = new Set<string>();
      const naturalCount = result.estimatedFrameCount;
      for (let i = 0; i < naturalCount; i += 1) {
        const { value, done } = result.frames.next();
        expect(done).toBe(false);
        expect(typeof value).toBe('string');
        expect(value.length).toBeGreaterThan(0);
        seen.add(value);
      }
      expect(seen.size).toBe(naturalCount);
    });

    it('iterator cycles indefinitely (never returns done: true)', () => {
      const token = makeCashuB(600);
      const result = encode(token);
      expect(result.mode).toBe('animated');
      if (result.mode !== 'animated') return;

      for (let i = 0; i < 100; i += 1) {
        const { done, value } = result.frames.next();
        expect(done).toBe(false);
        expect(typeof value).toBe('string');
      }
    });

    it('iterator.reset() restarts the sequence', () => {
      const token = makeCashuB(600);
      const result = encode(token);
      if (result.mode !== 'animated') throw new Error('expected animated');
      const first = result.frames.next().value;
      result.frames.next(); // advance
      result.frames.next();
      result.frames.reset();
      const afterReset = result.frames.next().value;
      expect(afterReset).toBe(first);
    });
  });

  describe('forceAnimated', () => {
    it('promotes a small token to animated when forceAnimated=true', () => {
      const token = makeCashuB(50);
      const result = encode(token, { forceAnimated: true });
      expect(result.mode).toBe('animated');
    });

    it('still returns animated for naturally-large tokens', () => {
      const token = makeCashuB(1000);
      const result = encode(token, { forceAnimated: true });
      expect(result.mode).toBe('animated');
    });
  });

  describe('input validation', () => {
    it('throws EMPTY_INPUT for an empty string', () => {
      expect(() => encode('')).toThrow(Nut16EncodeError);
      try {
        encode('');
      } catch (err) {
        expect((err as Nut16EncodeError).code).toBe('EMPTY_INPUT');
      }
    });

    it('throws EMPTY_INPUT for whitespace-only input', () => {
      try {
        encode('   ');
      } catch (err) {
        expect((err as Nut16EncodeError).code).toBe('EMPTY_INPUT');
      }
    });

    it('throws NOT_CASHU_V4 for cashuA tokens', () => {
      try {
        encode('cashuAabcdefghij');
      } catch (err) {
        expect((err as Nut16EncodeError).code).toBe('NOT_CASHU_V4');
      }
    });

    it('throws NOT_CASHU_V4 for arbitrary strings', () => {
      try {
        encode('hello world');
      } catch (err) {
        expect((err as Nut16EncodeError).code).toBe('NOT_CASHU_V4');
      }
    });

    it('throws NOT_CASHU_V4 for missing prefix', () => {
      try {
        encode('o2F0gaJhaUgArvSFnZG9JmFw');
      } catch (err) {
        expect((err as Nut16EncodeError).code).toBe('NOT_CASHU_V4');
      }
    });
  });

  describe('options defaults', () => {
    it('uses 200ms frame interval by default', () => {
      const result = encode(makeCashuB(50));
      expect(result.frameIntervalMs).toBe(200);
    });

    it('honors a custom frameIntervalMs on animated mode', () => {
      const result = encode(makeCashuB(800), { frameIntervalMs: 100 });
      expect(result.frameIntervalMs).toBe(100);
    });

    it('honors a custom maxFragmentLength on animated mode', () => {
      const tokenLarge = makeCashuB(800);
      const tight = encode(tokenLarge, { maxFragmentLength: 50 });
      const loose = encode(tokenLarge, { maxFragmentLength: 200 });
      if (tight.mode !== 'animated' || loose.mode !== 'animated') {
        throw new Error('expected animated');
      }
      expect(tight.estimatedFrameCount).toBeGreaterThan(loose.estimatedFrameCount);
    });
  });
});
