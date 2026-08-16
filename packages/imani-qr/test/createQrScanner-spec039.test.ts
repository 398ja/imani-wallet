/**
 * Spec 039 — createQrScanner wiring contract.
 *
 * Pins:
 * - FR-001/002 `onProgress({readCount, total})` fires per accepted NUT-16
 *   fragment, sourced from the SINGLE `Nut16ScanProcessor` instance
 *   owned by `QrScanner`.
 * - FR-002 single-decoder invariant — createQrScanner DOES NOT
 *   instantiate its own `Nut16ScanProcessor`; the dead second-decoder
 *   branch was deleted.
 *
 * Test strategy: mock the `QrScanner` module so we can drive
 * `onScan` + `onNut16Event` callbacks deterministically without a DOM
 * or `qr-scanner` runtime.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Nut16ScanEvent } from '../src/nut16/types';

// Spec 039 review (PR #300, comment 3339728175) — this package is
// `"type": "module"`, so `__dirname` is genuinely undefined in pure
// ESM. The source-shape grep test below uses `import.meta.url` +
// `fileURLToPath` to resolve the createQrScanner.ts path safely
// regardless of how the runner loads us.
const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = dirname(__filename_esm);

class FakeQrScanner {
  public scanListeners: ((result: { raw: string }) => void)[] = [];
  public nut16Listeners: ((event: Nut16ScanEvent) => void)[] = [];
  constructor(_config?: unknown) {}
  onScan(listener: (result: { raw: string }) => void) {
    this.scanListeners.push(listener);
    return () => undefined;
  }
  onNut16Event(listener: (event: Nut16ScanEvent) => void) {
    this.nut16Listeners.push(listener);
    return () => undefined;
  }
  async emitFragmentEvent(event: Nut16ScanEvent) {
    for (const l of this.nut16Listeners) l(event);
  }
  async emitScan(raw: string) {
    for (const l of this.scanListeners) await l({ raw });
  }
}

let lastFake: FakeQrScanner | null = null;

vi.mock('../src/scanner/QrScanner.js', () => ({
  QrScanner: vi.fn().mockImplementation((config?: unknown) => {
    lastFake = new FakeQrScanner(config);
    return lastFake;
  })
}));

// Mock handler modules that pull in side-effects we don't need here.
vi.mock('../src/handlers/PaymentRequestHandler.js', () => ({
  PaymentRequestHandler: vi.fn().mockImplementation(() => ({}))
}));
vi.mock('../src/handlers/IdentityHandler.js', () => ({
  IdentityHandler: vi.fn().mockImplementation(() => ({}))
}));
vi.mock('../src/handlers/TokenHandler.js', () => ({
  TokenHandler: vi.fn().mockImplementation(() => ({}))
}));

import { createQrScanner } from '../src/createQrScanner';

describe('createQrScanner — spec 039 wiring', () => {
  beforeEach(() => {
    lastFake = null;
  });

  it('FR-001: onProgress fires per accepted NUT-16 fragment with {readCount, total}', async () => {
    const onProgress = vi.fn();
    const onScanProgress = vi.fn();
    createQrScanner({ onProgress, onScanProgress, autoExecute: false });
    expect(lastFake).not.toBeNull();

    await lastFake!.emitFragmentEvent({
      kind: 'fragment-accepted',
      progress: { receivedCount: 1, estimatedTotal: 3, estimatedCompletion: 0.33 }
    });
    await lastFake!.emitFragmentEvent({
      kind: 'fragment-accepted',
      progress: { receivedCount: 2, estimatedTotal: 3, estimatedCompletion: 0.66 }
    });
    await lastFake!.emitFragmentEvent({
      kind: 'fragment-accepted',
      progress: { receivedCount: 3, estimatedTotal: 3, estimatedCompletion: 1 }
    });

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, { readCount: 1, total: 3 });
    expect(onProgress).toHaveBeenNthCalledWith(2, { readCount: 2, total: 3 });
    expect(onProgress).toHaveBeenNthCalledWith(3, { readCount: 3, total: 3 });
    expect(onScanProgress).toHaveBeenCalledTimes(3);
  });

  it('FR-001: onProgress carries total=null until the decoder commits to a part count', async () => {
    const onProgress = vi.fn();
    createQrScanner({ onProgress, autoExecute: false });
    await lastFake!.emitFragmentEvent({
      kind: 'fragment-accepted',
      progress: { receivedCount: 1, estimatedTotal: 0, estimatedCompletion: 0.1 }
    });
    expect(onProgress).toHaveBeenCalledWith({ readCount: 1, total: null });
  });

  it('FR-001: non-fragment events (ignored / error / reset / complete) do NOT fire onProgress', async () => {
    const onProgress = vi.fn();
    createQrScanner({ onProgress, autoExecute: false });
    await lastFake!.emitFragmentEvent({
      kind: 'fragment-ignored',
      reason: 'NOT_A_UR_FRAGMENT'
    });
    await lastFake!.emitFragmentEvent({
      kind: 'reconstruction-complete',
      cashuBToken: 'cashuB-assembled'
    });
    await lastFake!.emitFragmentEvent({
      kind: 'reconstruction-error',
      code: 'CRC_MISMATCH',
      message: 'bad crc'
    });
    await lastFake!.emitFragmentEvent({ kind: 'decoder-reset' });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('FR-002 single-decoder invariant: createQrScanner source does NOT instantiate Nut16ScanProcessor', () => {
    // Source-shape grep. Strips line comments before matching so the
    // explanatory comment that mentions the dead code doesn't false-trip.
    const raw = readFileSync(
      join(__dirname_esm, '..', 'src', 'createQrScanner.ts'),
      'utf-8'
    );
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/^\s*\/\/.*$/gm, '')        // line comments
      .replace(/\/\/[^\n]*$/gm, '');       // trailing line comments
    expect(stripped).not.toMatch(/new\s+Nut16ScanProcessor\s*\(/);
  });

  it('routes the assembled cashuB token through the normal scan path', async () => {
    const onRoute = vi.fn();
    createQrScanner({ onRoute, autoExecute: false });
    await lastFake!.emitScan('cashuBabcdef1234');
    expect(onRoute).toHaveBeenCalledTimes(1);
  });
});
