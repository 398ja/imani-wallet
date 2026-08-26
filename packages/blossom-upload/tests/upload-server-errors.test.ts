import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { upload } from '../src/upload';
import { BlossomUploadErrorCode } from '../src/errors';
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

const blob = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });

describe('upload — HTTP server-error mapping (T045 / US 4)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('401 on both /media and /upload → AUTH_FAILED with the /upload reason', async () => {
    // 401 on /media triggers fallback to /upload (Primal returns 401 when
    // it doesn't recognise the BUD-05 verb — see upload-fallback test a2).
    // A genuine auth failure is therefore visible as 401 from /upload.
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Response('invalid action', { status: 401 }))
      .mockResolvedValueOnce(
        new Response('unauthorized', {
          status: 401,
          headers: { 'X-Reason': 'invalid signature' },
        }),
      );
    let err: unknown;
    try {
      await upload({ file: blob(), slot: 'avatar', config: CONFIG, sign });
    } catch (e) { err = e; }
    expect((err as { code: string }).code).toBe(BlossomUploadErrorCode.AUTH_FAILED);
    expect((err as { httpStatus: number }).httpStatus).toBe(401);
    expect((err as { serverReason: string }).serverReason).toBe('invalid signature');
  });

  it('403 on /media (no fallback) → AUTH_FAILED', async () => {
    // 403 is not in the notSupported list — error surfaces directly.
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('forbidden', { status: 403 }),
    );
    await expect(
      upload({ file: blob(), slot: 'avatar', config: CONFIG, sign }),
    ).rejects.toMatchObject({ code: BlossomUploadErrorCode.AUTH_FAILED, httpStatus: 403 });
  });

  it('413 → SERVER_REJECTED with serverReason from X-Reason', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('too big', {
        status: 413,
        headers: { 'X-Reason': 'blob too big' },
      }),
    );
    let err: unknown;
    try {
      await upload({ file: blob(), slot: 'avatar', config: CONFIG, sign });
    } catch (e) { err = e; }
    expect((err as { code: string }).code).toBe(BlossomUploadErrorCode.SERVER_REJECTED);
    expect((err as { httpStatus: number }).httpStatus).toBe(413);
    expect((err as { serverReason: string }).serverReason).toBe('blob too big');
  });

  it('415 → SERVER_REJECTED', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('nope', { status: 415 }),
    );
    await expect(
      upload({ file: blob(), slot: 'avatar', config: CONFIG, sign }),
    ).rejects.toMatchObject({ code: BlossomUploadErrorCode.SERVER_REJECTED });
  });

  it('503 → SERVER_REJECTED', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('unavailable', { status: 503 }),
    );
    await expect(
      upload({ file: blob(), slot: 'avatar', config: CONFIG, sign }),
    ).rejects.toMatchObject({ code: BlossomUploadErrorCode.SERVER_REJECTED, httpStatus: 503 });
  });

  it('signer throwing → AUTH_FAILED with cause', async () => {
    const bad: SignFn = async () => { throw new Error('signer down'); };
    let err: unknown;
    try {
      await upload({ file: blob(), slot: 'avatar', config: CONFIG, sign: bad });
    } catch (e) { err = e; }
    expect((err as { code: string }).code).toBe(BlossomUploadErrorCode.AUTH_FAILED);
    expect((err as Error).cause).toBeInstanceOf(Error);
  });
});

describe('upload — network unreachable (T046)', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('fetch TypeError → SERVER_UNREACHABLE with cause attached', async () => {
    const netErr = new TypeError('Failed to fetch');
    // Rejects every call, not just the first: a rejected fetch on the /media
    // PROBE now falls back to /upload, because a CORS-hidden error is
    // indistinguishable from a dead socket here (see upload.ts). Genuinely
    // offline means both attempts reject, and the assertions below — the
    // actual contract, SERVER_UNREACHABLE with the cause attached — are
    // unchanged. upload-fallback.test.ts (a5) pins the attempt count at 2.
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(netErr);
    let err: unknown;
    try {
      await upload({ file: blob(), slot: 'avatar', config: CONFIG, sign });
    } catch (e) { err = e; }
    expect((err as { code: string }).code).toBe(BlossomUploadErrorCode.SERVER_UNREACHABLE);
    expect((err as Error).cause).toBe(netErr);
  });
});

describe('upload — AbortController cancellation (T047)', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('AbortError from fetch → CANCELLED', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(abortErr);
    await expect(
      upload({ file: blob(), slot: 'avatar', config: CONFIG, sign }),
    ).rejects.toMatchObject({ code: BlossomUploadErrorCode.CANCELLED });
  });

  it('signal aborted before fetch → throws CANCELLED, fetch is never called', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      upload({ file: blob(), slot: 'avatar', config: CONFIG, sign, signal: controller.signal }),
    ).rejects.toMatchObject({ code: BlossomUploadErrorCode.CANCELLED });
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});
