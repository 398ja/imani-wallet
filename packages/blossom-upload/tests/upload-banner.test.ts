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

describe('upload — banner slot picks maxBannerBytes (T033 / US 2)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects an 11 MB file for slot="banner" (just above the 10 MB limit)', async () => {
    const blob = new Blob([new Uint8Array(11 * 1024 * 1024)], { type: 'image/jpeg' });
    await expect(
      upload({ file: blob, slot: 'banner', config: CONFIG, sign }),
    ).rejects.toMatchObject({ code: BlossomUploadErrorCode.FILE_TOO_LARGE });
  });

  it('rejects an 11 MB file for slot="avatar" too (same fixture, smaller limit)', async () => {
    const blob = new Blob([new Uint8Array(11 * 1024 * 1024)], { type: 'image/jpeg' });
    await expect(
      upload({ file: blob, slot: 'avatar', config: CONFIG, sign }),
    ).rejects.toMatchObject({ code: BlossomUploadErrorCode.FILE_TOO_LARGE });
  });

  it('accepts a 9 MB file for slot="banner" (within the 10 MB limit)', async () => {
    const blob = new Blob([new Uint8Array(9 * 1024 * 1024)], { type: 'image/jpeg' });
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          url: 'https://blossom.example/abc.jpg',
          sha256: 'x',
          size: 9 * 1024 * 1024,
          type: 'image/jpeg',
        }),
        { status: 201 },
      ),
    );
    const result = await upload({ file: blob, slot: 'banner', config: CONFIG, sign });
    expect(result.endpoint).toBe('media');
  });
});
