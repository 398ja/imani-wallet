import { describe, it, expect, vi } from 'vitest';
import { upload } from '../src/upload';
import { BlossomUploadError, BlossomUploadErrorCode } from '../src/errors';
import type { BlossomServerConfig, SignFn } from '../src/types';

const baseConfig = (): BlossomServerConfig => ({
  url: 'https://blossom.example',
  maxAvatarBytes: 5 * 1024 * 1024,
  maxBannerBytes: 10 * 1024 * 1024,
  allowedMimeTypes: ['image/jpeg', 'image/png'],
});

const sign: SignFn = async (u) => ({
  ...u,
  pubkey: 'a'.repeat(64),
  id: 'b'.repeat(64),
  sig: 'c'.repeat(128),
});

describe('upload — client-side validation', () => {
  it('throws INVALID_MIME_TYPE for a text/plain blob before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const file = new Blob(['hello'], { type: 'text/plain' });
      await expect(
        upload({ file, slot: 'avatar', config: baseConfig(), sign }),
      ).rejects.toMatchObject({
        code: BlossomUploadErrorCode.INVALID_MIME_TYPE,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws FILE_TOO_LARGE for a 6 MB file with maxAvatarBytes=5MB', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const huge = new Uint8Array(6 * 1024 * 1024);
      const file = new Blob([huge], { type: 'image/jpeg' });
      await expect(
        upload({ file, slot: 'avatar', config: baseConfig(), sign }),
      ).rejects.toMatchObject({
        code: BlossomUploadErrorCode.FILE_TOO_LARGE,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws INVALID_SERVER_URL for an http:// URL', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const cfg: BlossomServerConfig = { ...baseConfig(), url: 'http://blossom.example' };
      const file = new Blob([new Uint8Array([1])], { type: 'image/jpeg' });
      await expect(
        upload({ file, slot: 'avatar', config: cfg, sign }),
      ).rejects.toMatchObject({
        code: BlossomUploadErrorCode.INVALID_SERVER_URL,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    'http://localhost:28089',
    'http://localhost',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
  ])('accepts %s — loopback http is not a downgrade', async (url) => {
    // The same carve-out the web platform makes: http://localhost is a Secure
    // Context, because nothing is on the wire to intercept. Rejecting it forced
    // local development onto a PUBLIC Blossom server, where every test avatar is
    // permanent — blobs are content-addressed, so there is no delete-mine.
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ url: `${url}/abc.jpg`, sha256: 'abc', size: 1, type: 'image/jpeg' }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const cfg: BlossomServerConfig = { ...baseConfig(), url };
      const file = new Blob([new Uint8Array([1])], { type: 'image/jpeg' });
      await upload({ file, slot: 'avatar', config: cfg, sign });
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    'http://blossom.example',
    'http://localhost.evil.com',
    'http://127.0.0.1.evil.com',
  ])('still rejects %s — only real loopback is exempt', async (url) => {
    // `localhost.evil.com` resolves wherever its owner points it. Matching on the
    // parsed hostname rather than a prefix is what keeps this a carve-out instead
    // of a hole.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const cfg: BlossomServerConfig = { ...baseConfig(), url };
      const file = new Blob([new Uint8Array([1])], { type: 'image/jpeg' });
      await expect(
        upload({ file, slot: 'avatar', config: cfg, sign }),
      ).rejects.toMatchObject({ code: BlossomUploadErrorCode.INVALID_SERVER_URL });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects with a BlossomUploadError instance (not a plain Error)', async () => {
    const file = new Blob(['hello'], { type: 'text/plain' });
    let caught: unknown = null;
    try {
      await upload({ file, slot: 'avatar', config: baseConfig(), sign });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BlossomUploadError);
  });
});
