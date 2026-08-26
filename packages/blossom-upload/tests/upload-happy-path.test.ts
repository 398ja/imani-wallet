import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { upload } from '../src/upload';
import type { BlossomServerConfig, SignFn } from '../src/types';

const SHA = '36a9e7f1c95b82ffb99743e0c5c4ce95d83c9a430aac59f84ef3cbfab6145068'; // sha256("test"+...)

const CONFIG: BlossomServerConfig = {
  url: 'https://blossom.example',
  maxAvatarBytes: 5 * 1024 * 1024,
  maxBannerBytes: 10 * 1024 * 1024,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
};

const okDescriptor = (sha256: string) => ({
  url: `https://blossom.example/${sha256}.jpg`,
  sha256,
  size: 1024,
  type: 'image/jpeg',
  uploaded: 1700000000,
});

function makeSignFn(): SignFn {
  return async (unsigned) => ({
    ...unsigned,
    pubkey: 'a'.repeat(64),
    id: 'b'.repeat(64),
    sig: 'c'.repeat(128),
  });
}

function makeBlob(bytes: Uint8Array, type = 'image/jpeg'): Blob {
  return new Blob([bytes], { type });
}

describe('upload — happy path on /media', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PUTs /media first, returns the server URL with endpoint="media"', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const file = makeBlob(bytes);
    const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(
      new Response(JSON.stringify(okDescriptor(SHA)), { status: 201 }),
    );

    const result = await upload({
      file,
      slot: 'avatar',
      config: CONFIG,
      sign: makeSignFn(),
    });

    expect(mock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = mock.mock.calls[0]!;
    expect(calledUrl).toBe('https://blossom.example/media');
    expect((init as RequestInit).method).toBe('PUT');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toMatch(/^Nostr [A-Za-z0-9+/]+=*$/);
    expect(headers['X-SHA-256']).toMatch(/^[0-9a-f]{64}$/);
    expect(result.endpoint).toBe('media');
    expect(result.url).toContain('blossom.example');
    expect(result.server).toBe('https://blossom.example');
  });

  it('passes through the Blob Descriptor fields onto UploadResult', async () => {
    const file = makeBlob(new Uint8Array([7, 7, 7]));
    const desc = okDescriptor(SHA);
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(desc), { status: 201 }),
    );

    const result = await upload({
      file,
      slot: 'avatar',
      config: CONFIG,
      sign: makeSignFn(),
    });

    expect(result.url).toBe(desc.url);
    expect(result.sha256).toBe(desc.sha256);
    expect(result.mimeType).toBe(desc.type);
    expect(result.sizeBytes).toBe(desc.size);
  });
});
