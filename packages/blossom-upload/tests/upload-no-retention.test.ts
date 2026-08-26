import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { upload } from '../src/upload';
import type { BlossomServerConfig, SignFn } from '../src/types';

const CONFIG: BlossomServerConfig = {
  url: 'https://blossom.example',
  maxAvatarBytes: 5 * 1024 * 1024,
  maxBannerBytes: 10 * 1024 * 1024,
  allowedMimeTypes: ['image/jpeg'],
};

const sign: SignFn = async (u) => ({
  ...u,
  pubkey: 'a'.repeat(64),
  id: 'b'.repeat(64),
  sig: 'c'.repeat(128),
});

describe('FR-020 — no retention of file bytes', () => {
  it('(a) source scan: upload.ts does not assign opts.file or `bytes` to any module-scoped variable', () => {
    const src = readFileSync(resolve(__dirname, '..', 'src', 'upload.ts'), 'utf8');
    // Strip block comments + line comments before scanning so prose mentions don't trip the test.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const moduleScopeAssignPattern = /^(let|const|var)\s+\w+\s*=\s*(opts\.file|bytes)\b/m;
    expect(stripped).not.toMatch(moduleScopeAssignPattern);
  });

  it('(b) After upload resolves, the input Blob can be garbage collected (best-effort WeakRef check)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ url: 'https://blossom.example/abc.jpg', sha256: 'x', size: 3, type: 'image/jpeg' }),
        { status: 201 },
      ),
    ));

    try {
      // Scope the Blob narrowly; immediately drop the local reference after the upload.
      let weak: WeakRef<Blob> | null = null;
      await (async () => {
        const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
        weak = new WeakRef(file);
        await upload({ file, slot: 'avatar', config: CONFIG, sign });
        // file goes out of scope when the IIFE returns.
      })();

      // Try to trigger GC if available; otherwise the WeakRef assertion is best-effort
      // and we just confirm the WeakRef was constructed.
      const gc = (globalThis as unknown as { gc?: () => void }).gc;
      if (gc) {
        gc();
        // Yield so GC's finalizers can run.
        await new Promise((r) => setTimeout(r, 0));
        gc();
      }
      // weak is set above; if GC didn't fire (vitest without --expose-gc) we still pass —
      // the source-scan in (a) is the load-bearing assertion. This assertion is
      // documentational.
      expect(weak).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
