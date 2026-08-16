import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

function makeBlob(): Blob {
  return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
}

function descriptor(url: string) {
  return new Response(
    JSON.stringify({ url, sha256: 'x', size: 3, type: 'image/jpeg' }),
    { status: 201 },
  );
}

describe('upload — BUD-05 → BUD-02 fallback', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('(a) falls back to /upload with t=upload + content="Upload Blob" when /media returns 404', async () => {
    const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(descriptor('https://blossom.example/abc.jpg'));

    const result = await upload({ file: makeBlob(), slot: 'avatar', config: CONFIG, sign });

    expect(mock).toHaveBeenCalledTimes(2);
    const firstCall = mock.mock.calls[0]!;
    const secondCall = mock.mock.calls[1]!;
    expect(firstCall[0]).toBe('https://blossom.example/media');
    expect(secondCall[0]).toBe('https://blossom.example/upload');
    // Decode the Authorization header on the SECOND call and assert t=upload.
    const auth = (secondCall[1] as RequestInit).headers as Record<string, string>;
    const b64 = auth['Authorization']!.slice('Nostr '.length);
    const parsed = JSON.parse(globalThis.atob(b64));
    expect(parsed.content).toBe('Upload Blob');
    expect(parsed.tags).toEqual(expect.arrayContaining([['t', 'upload']]));
    expect(result.endpoint).toBe('upload');
  });

  it('(a2) falls back to /upload when /media returns 401 (Primal behavior — verified 2026-05-30)', async () => {
    // The production Blossom server implements BUD-02 only; PUT /media with t=media
    // returns 401 "invalid action in auth event" rather than the
    // spec-prescribed 404. Make sure the package treats both as
    // "endpoint unavailable" and retries against /upload.
    const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mock
      .mockResolvedValueOnce(new Response('invalid action in auth event', { status: 401 }))
      .mockResolvedValueOnce(descriptor('https://blossom.example/abc.jpg'));

    const result = await upload({ file: makeBlob(), slot: 'avatar', config: CONFIG, sign });

    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[0]![0]).toBe('https://blossom.example/media');
    expect(mock.mock.calls[1]![0]).toBe('https://blossom.example/upload');
    expect(result.endpoint).toBe('upload');
  });

  it('(d) preferEndpoint:"upload" skips /media entirely and goes straight to /upload', async () => {
    // When the host knows /media isn't useful (e.g. client-side EXIF strip
    // already covers SC-004, or the server's /media response lacks CORS
    // headers), it can short-circuit by setting preferEndpoint:"upload".
    const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(descriptor('https://blossom.example/abc.jpg'));

    const result = await upload({
      file: makeBlob(),
      slot: 'avatar',
      config: { ...CONFIG, preferEndpoint: 'upload' },
      sign,
    });

    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]![0]).toBe('https://blossom.example/upload');
    expect(result.endpoint).toBe('upload');
  });

  it('(a4) falls back to /upload when /media REJECTS the fetch (CORS-hidden 401)', async () => {
    // The case (a2) cannot catch. Primal's /media answers 401 with no
    // Access-Control-Allow-Origin (verified 2026-08-16), so the browser never
    // hands us a Response — fetch rejects with a TypeError and there is no
    // status to branch on. Before this was handled, the upload died here and
    // the working /upload endpoint was never tried.
    const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mock
      .mockRejectedValueOnce(new TypeError('NetworkError when attempting to fetch resource.'))
      .mockResolvedValueOnce(descriptor('https://blossom.example/abc.jpg'));

    const result = await upload({ file: makeBlob(), slot: 'avatar', config: CONFIG, sign });

    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[0]![0]).toBe('https://blossom.example/media');
    expect(mock.mock.calls[1]![0]).toBe('https://blossom.example/upload');
    expect(result.endpoint).toBe('upload');
  });

  it('(a5) a rejected fetch on /upload surfaces the error instead of retrying', async () => {
    // The other half of (a4): genuinely offline must still fail, and fail once.
    // Only the /media PROBE may treat a rejection as "endpoint unavailable".
    const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockRejectedValue(new TypeError('NetworkError when attempting to fetch resource.'));

    await expect(
      upload({ file: makeBlob(), slot: 'avatar', config: CONFIG, sign }),
    ).rejects.toThrow();

    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('(a3) falls back to /upload when /media returns 405', async () => {
    const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mock
      .mockResolvedValueOnce(new Response('method not allowed', { status: 405 }))
      .mockResolvedValueOnce(descriptor('https://blossom.example/abc.jpg'));

    const result = await upload({ file: makeBlob(), slot: 'avatar', config: CONFIG, sign });

    expect(mock).toHaveBeenCalledTimes(2);
    expect(result.endpoint).toBe('upload');
  });

  it('(b) request log shows /media BEFORE /upload (never goes straight to /upload)', async () => {
    const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(descriptor('https://blossom.example/abc.jpg'));

    await upload({ file: makeBlob(), slot: 'avatar', config: CONFIG, sign });

    const callUrls = mock.mock.calls.map((c) => c[0]);
    expect(callUrls[0]).toContain('/media');
    expect(callUrls[1]).toContain('/upload');
  });

  it('(c) when /media returns 200, the package does NOT call /upload at all', async () => {
    const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(descriptor('https://blossom.example/abc.jpg'));

    const result = await upload({ file: makeBlob(), slot: 'avatar', config: CONFIG, sign });

    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]![0]).toBe('https://blossom.example/media');
    expect(result.endpoint).toBe('media');
  });
});
