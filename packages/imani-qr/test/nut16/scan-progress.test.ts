/**
 * packages/imani-qr/test/nut16/scan-progress.test.ts — Spec 035 US3 T043.
 *
 * `Nut16ScanProcessor` surfaces `fragment-accepted` events as fragments
 * arrive. The scanner UI (`voucher/js/scan.js`, wired in T025) consumes
 * these to render capture progress. This test drives the processor with
 * a synthetic animated-QR stream and asserts the progress signal
 * monotonically advances to completion.
 */
import { describe, expect, it } from 'vitest';
import { Nut16ScanProcessor } from '../../src/nut16/scanProcessor';
import { encode, type Nut16FrameIterator } from '../../src/nut16/encoder';

function makeLargeCashuToken(bytes: number): string {
  return 'cashuB' + 'A'.repeat(Math.max(0, bytes - 'cashuB'.length));
}

describe('Nut16ScanProcessor — fragment-accepted progress (spec 035 US3 T043 / FR-013)', () => {
  it('emits fragment-accepted with monotonically-increasing progress while accumulating an animated scan', () => {
    // 800 B — well above STATIC_BYTE_GUARD, so encode() produces an
    // animated stream we can stream into the processor frame-by-frame.
    const token = makeLargeCashuToken(800);
    const enc = encode(token);
    expect(enc.mode).toBe('animated');
    if (enc.mode !== 'animated') throw new Error('expected animated mode');
    const frames = enc.frames as Nut16FrameIterator;

    const processor = new Nut16ScanProcessor();
    const completionSeen: number[] = [];
    const receivedSeen: number[] = [];
    let completed = false;
    let reconstructed: string | null = null;

    // Drive frames into the processor. BC-UR fountain encoding may need
    // more frames than `fragmentsLength` to reconstruct; bound the loop
    // generously and bail once a final result is observed.
    for (let i = 0; i < 500 && !completed; i++) {
      const next = frames.next();
      if (!next || !next.value) break;
      const result = processor.process(next.value);
      for (const ev of result.events) {
        if (ev.kind === 'fragment-accepted') {
          completionSeen.push(ev.progress.estimatedCompletion);
          receivedSeen.push(ev.progress.receivedCount);
        } else if (ev.kind === 'reconstruction-complete') {
          completed = true;
          reconstructed = ev.cashuBToken;
        }
      }
    }

    expect(completed).toBe(true);
    expect(reconstructed).toBe(token);
    expect(completionSeen.length).toBeGreaterThan(0);
    // Receive count must be monotonic non-decreasing across the stream
    // (each fragment-accepted is a freshly-received unique part).
    for (let i = 1; i < receivedSeen.length; i++) {
      expect(receivedSeen[i]).toBeGreaterThanOrEqual(receivedSeen[i - 1]);
    }
    // The final progress event before completion should report
    // estimatedCompletion >= the first one.
    expect(completionSeen[completionSeen.length - 1])
      .toBeGreaterThanOrEqual(completionSeen[0]);
  });
});
