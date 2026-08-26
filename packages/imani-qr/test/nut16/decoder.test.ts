import { describe, expect, it } from 'vitest';

import { createDecoder } from '../../src/nut16/decoder';
import {
  LONG_CASHU_B,
  MEDIUM_CASHU_B,
  SHORT_CASHU_B,
  buildFragments,
} from './fixtures/sample-tokens';

function driveTo(decoder: ReturnType<typeof createDecoder>, fragments: string[]): void {
  for (const frag of fragments) {
    decoder.receive(frag);
    if (decoder.isComplete()) return;
  }
}

describe('Nut16Decoder', () => {
  describe('initial (IDLE) state', () => {
    it('result() throws before any fragment is fed', () => {
      const decoder = createDecoder();
      expect(() => decoder.result()).toThrow();
      expect(decoder.isComplete()).toBe(false);
    });

    it('progress() returns zeroed-out values before any fragment', () => {
      const decoder = createDecoder();
      const p = decoder.progress();
      expect(p.receivedCount).toBe(0);
    });
  });

  describe('progressing state', () => {
    it('transitions IDLE → PROGRESSING on a valid first fragment', () => {
      const decoder = createDecoder();
      const fragments = buildFragments(MEDIUM_CASHU_B);
      const status = decoder.receive(fragments[0]);
      expect(['progress', 'complete']).toContain(status.kind);
      if (status.kind === 'progress') {
        expect(status.progress.receivedCount).toBeGreaterThan(0);
      }
    });

    it('progress.receivedCount is monotonically non-decreasing across multiple fragments', () => {
      const decoder = createDecoder();
      const fragments = buildFragments(LONG_CASHU_B);
      let last = 0;
      for (const frag of fragments) {
        const status = decoder.receive(frag);
        if (status.kind === 'progress') {
          expect(status.progress.receivedCount).toBeGreaterThanOrEqual(last);
          last = status.progress.receivedCount;
        }
        if (status.kind === 'complete') break;
      }
    });
  });

  describe('completion', () => {
    it('reaches COMPLETE for a short token and result() returns the input', () => {
      const decoder = createDecoder();
      driveTo(decoder, buildFragments(SHORT_CASHU_B));
      expect(decoder.isComplete()).toBe(true);
      expect(decoder.result()).toBe(SHORT_CASHU_B);
    });

    it('reaches COMPLETE for a medium token and round-trips byte-for-byte', () => {
      const decoder = createDecoder();
      driveTo(decoder, buildFragments(MEDIUM_CASHU_B));
      expect(decoder.isComplete()).toBe(true);
      expect(decoder.result()).toBe(MEDIUM_CASHU_B);
    });

    it('reaches COMPLETE for a long token', () => {
      const decoder = createDecoder();
      driveTo(decoder, buildFragments(LONG_CASHU_B));
      expect(decoder.isComplete()).toBe(true);
      expect(decoder.result()).toBe(LONG_CASHU_B);
    });

    it('progress.estimatedCompletion is 1 after completion', () => {
      const decoder = createDecoder();
      driveTo(decoder, buildFragments(MEDIUM_CASHU_B));
      expect(decoder.progress().estimatedCompletion).toBe(1);
    });
  });

  describe('ignored fragments', () => {
    it('ignores non-UR strings with reason NOT_A_UR_FRAGMENT', () => {
      const decoder = createDecoder();
      const status = decoder.receive('cashuBabcdef');
      expect(status).toEqual({ kind: 'ignored', reason: 'NOT_A_UR_FRAGMENT' });
    });

    it('ignores fragments fed after completion with reason DIFFERENT_SEQUENCE', () => {
      const decoder = createDecoder();
      driveTo(decoder, buildFragments(SHORT_CASHU_B));
      const extraFragment = buildFragments(MEDIUM_CASHU_B)[0];
      const status = decoder.receive(extraFragment);
      expect(status).toEqual({ kind: 'ignored', reason: 'DIFFERENT_SEQUENCE' });
    });

    it('ignores empty string', () => {
      const decoder = createDecoder();
      expect(decoder.receive('').kind).toBe('ignored');
    });
  });

  describe('idempotency', () => {
    it('feeding the same valid fragment twice does not corrupt the decoder', () => {
      const decoder = createDecoder();
      const fragments = buildFragments(MEDIUM_CASHU_B);
      decoder.receive(fragments[0]);
      decoder.receive(fragments[0]);
      // Continue to completion
      for (let i = 1; i < fragments.length; i += 1) {
        decoder.receive(fragments[i]);
        if (decoder.isComplete()) break;
      }
      expect(decoder.isComplete()).toBe(true);
      expect(decoder.result()).toBe(MEDIUM_CASHU_B);
    });
  });

  describe('reset', () => {
    it('reset() clears completion and allows a new sequence to be decoded', () => {
      const decoder = createDecoder();
      driveTo(decoder, buildFragments(SHORT_CASHU_B));
      expect(decoder.isComplete()).toBe(true);

      decoder.reset();
      expect(decoder.isComplete()).toBe(false);
      expect(() => decoder.result()).toThrow();
      expect(decoder.progress().receivedCount).toBe(0);

      driveTo(decoder, buildFragments(MEDIUM_CASHU_B));
      expect(decoder.isComplete()).toBe(true);
      expect(decoder.result()).toBe(MEDIUM_CASHU_B);
    });

    it('reset() on an idle decoder is a no-op', () => {
      const decoder = createDecoder();
      expect(() => decoder.reset()).not.toThrow();
      expect(decoder.isComplete()).toBe(false);
    });
  });

  describe('malformed fragments', () => {
    it('does not crash on a UR-shaped but malformed fragment', () => {
      const decoder = createDecoder();
      const status = decoder.receive('ur:bytes/1-1/notbytewords');
      expect(['error', 'progress', 'complete']).toContain(status.kind);
      // Should not throw or get permanently stuck
      expect(() => decoder.reset()).not.toThrow();
    });
  });
});
