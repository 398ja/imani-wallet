/**
 * Blossom upload — main entry point.
 *
 * Execution: validate → hash → sign → PUT /media → on 404 fall back to
 * PUT /upload → parse Blob Descriptor → return UploadResult.
 *
 * @blossom-spec BUD-02 § "PUT /upload" + BUD-05 § "PUT /media" + BUD-11 § "Validation" — github.com/hzrd149/blossom @ ef3c79e40d38cee6cdc974056ae86a582e708197
 */

import type {
  BlossomServerConfig,
  UploadOptions,
  UploadResult,
  UploadSlot,
  SignedAuthEvent,
} from './types';
import { BlossomUploadError, BlossomUploadErrorCode } from './errors';
import { computeSha256Hex } from './hash';
import { buildUnsignedAuthEvent, encodeAuthorizationHeader, type AuthVerb } from './auth';

interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded?: number;
}

export async function upload(opts: UploadOptions): Promise<UploadResult> {
  validateConfigUrl(opts.config);
  validateMimeType(opts.file, opts.config);
  validateSize(opts.file, opts.slot, opts.config);

  if (opts.signal?.aborted) throw cancelled();

  // Read bytes once; do not retain after the call returns (FR-020).
  const buffer = await opts.file.arrayBuffer();
  if (opts.signal?.aborted) throw cancelled();
  const bytes = new Uint8Array(buffer);
  const sha256Hex = computeSha256Hex(bytes);
  if (opts.signal?.aborted) throw cancelled();

  // Host can opt out of the /media probe (e.g. when client-side EXIF
  // stripping makes /media's value moot, or the server's /media response
  // lacks CORS headers and the browser hides the status from us).
  if (opts.config.preferEndpoint === 'upload') {
    const uploadResult = await tryUpload({ opts, bytes, sha256Hex, endpoint: 'upload' });
    if (uploadResult.ok) {
      return descriptorToResult({
        descriptor: uploadResult.descriptor,
        sha256Hex,
        sizeBytes: bytes.byteLength,
        mimeFallback: opts.file.type,
        server: opts.config.url,
        endpoint: 'upload',
      });
    }
    throw uploadResult.error;
  }

  // Try BUD-05 /media first (preferred for EXIF stripping — SC-004).
  const mediaResult = await tryUpload({ opts, bytes, sha256Hex, endpoint: 'media' });

  if (mediaResult.ok) {
    return descriptorToResult({
      descriptor: mediaResult.descriptor,
      sha256Hex,
      sizeBytes: bytes.byteLength,
      mimeFallback: opts.file.type,
      server: opts.config.url,
      endpoint: 'media',
    });
  }

  // /media not supported by this server — fall back to BUD-02 /upload.
  //
  // The spec says servers without BUD-05 should respond 404, but Primal's
  // server (verified 2026-05-30) returns 401 "invalid action in auth event"
  // because it interprets the `t=media` verb as unknown. Treat 404, 405,
  // and 401-with-action-related reason as "endpoint not available" and
  // fall back to /upload rather than surfacing AUTH_FAILED to the user.
  if (mediaResult.notSupported) {
    const uploadResult = await tryUpload({ opts, bytes, sha256Hex, endpoint: 'upload' });
    if (uploadResult.ok) {
      return descriptorToResult({
        descriptor: uploadResult.descriptor,
        sha256Hex,
        sizeBytes: bytes.byteLength,
        mimeFallback: opts.file.type,
        server: opts.config.url,
        endpoint: 'upload',
      });
    }
    throw uploadResult.error;
  }

  throw mediaResult.error;
}

// ------------------------------------------------------------------- validation

/**
 * Hosts where plain http is not a downgrade: the request never leaves the
 * machine. `[::1]` carries its brackets because that is what `URL.hostname`
 * returns for an IPv6 literal.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The same carve-out browsers make. `http://localhost` is a Secure Context by
 * specification, for the same reason https is required everywhere else: nothing
 * is on the wire to intercept. Without this, a local Blossom server cannot be
 * used at all — which pushed development onto a PUBLIC server, and every test
 * avatar uploaded there is permanent (blobs are content-addressed; there is no
 * delete-mine).
 */
function isLoopbackHttp(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function validateConfigUrl(config: BlossomServerConfig): void {
  const url = config.url;
  if (typeof url !== 'string' || (!url.startsWith('https://') && !isLoopbackHttp(url))) {
    throw new BlossomUploadError({
      code: BlossomUploadErrorCode.INVALID_SERVER_URL,
      message:
        'Blossom server URL must start with "https://" (or be http:// on ' +
        `localhost) — got: ${String(url)}`,
    });
  }
}

function validateMimeType(file: Blob, config: BlossomServerConfig): void {
  if (!config.allowedMimeTypes.includes(file.type)) {
    throw new BlossomUploadError({
      code: BlossomUploadErrorCode.INVALID_MIME_TYPE,
      message: `File type "${file.type}" not allowed. Allowed: ${config.allowedMimeTypes.join(', ')}`,
    });
  }
}

function validateSize(file: Blob, slot: UploadSlot, config: BlossomServerConfig): void {
  const limit = slot === 'avatar' ? config.maxAvatarBytes : config.maxBannerBytes;
  if (file.size > limit) {
    throw new BlossomUploadError({
      code: BlossomUploadErrorCode.FILE_TOO_LARGE,
      message: `File is ${file.size} bytes; ${slot} limit is ${limit} bytes.`,
    });
  }
}

// ------------------------------------------------------------------- upload step

type EndpointKind = 'media' | 'upload';

interface UploadAttempt {
  readonly opts: UploadOptions;
  readonly bytes: Uint8Array;
  readonly sha256Hex: string;
  readonly endpoint: EndpointKind;
}

type UploadAttemptResult =
  | { ok: true; descriptor: BlobDescriptor }
  | { ok: false; notSupported: boolean; error: BlossomUploadError };

async function tryUpload(attempt: UploadAttempt): Promise<UploadAttemptResult> {
  const { opts, bytes, sha256Hex, endpoint } = attempt;
  const verb: AuthVerb = endpoint === 'media' ? 'media' : 'upload';

  let signed: SignedAuthEvent;
  try {
    // The host's SignFn is responsible for stamping the pubkey on the returned
    // event from its own key material. We pass an empty placeholder; tests
    // verify the contract.
    const unsigned = buildUnsignedAuthEvent({ pubkey: '', verb, sha256Hex });
    signed = await opts.sign(unsigned);
  } catch (signErr) {
    return {
      ok: false,
      notSupported: false,
      error: new BlossomUploadError({
        code: BlossomUploadErrorCode.AUTH_FAILED,
        message: 'Signing the Blossom upload authorization event failed.',
        cause: signErr,
      }),
    };
  }

  let authorization: string;
  try {
    authorization = encodeAuthorizationHeader(signed);
  } catch (encodeErr) {
    return {
      ok: false,
      notSupported: false,
      error: new BlossomUploadError({
        code: BlossomUploadErrorCode.INTERNAL,
        message: `Signed auth event failed shape validation: ${(encodeErr as Error).message}`,
        cause: encodeErr,
      }),
    };
  }

  const url = `${opts.config.url}/${endpoint}`;
  let response: Response;
  try {
    // `Content-Length` is on the fetch forbidden-header list; the browser
    // ignores it (the actual length is set automatically from the body)
    // and some non-browser runtimes (service workers, fetch polyfills)
    // can choke on it. Caught by Copilot review on POSSA Merchant
    // PR #11 — same fix here so the next vendor re-sync of this package
    // into possa-merchant doesn't reintroduce the header.
    const init: RequestInit = {
      method: 'PUT',
      headers: {
        Authorization: authorization,
        'Content-Type': opts.file.type,
        'X-SHA-256': sha256Hex,
      },
      // fetch BodyInit accepts ArrayBuffer; cast away from Uint8Array's
      // tagged union for cross-DOM-lib compatibility.
      body: bytes.buffer as ArrayBuffer,
    };
    if (opts.signal) init.signal = opts.signal;
    response = await fetch(url, init);
  } catch (fetchErr) {
    if (isAbortError(fetchErr)) {
      return { ok: false, notSupported: false, error: cancelled() };
    }
    // A CORS-blocked response and a dead network are the same TypeError here —
    // the browser refuses to hand us a Response at all, so the status-based
    // fallback below never sees the 401. That is not hypothetical: Primal's
    // /media answers 401 "invalid action in auth event" with NO
    // Access-Control-Allow-Origin (verified 2026-08-16), while its /upload
    // answers 200 with `ACAO: *`. Reading the status was the only thing making
    // the fallback work, so on the /media PROBE a fetch-level failure has to
    // count as "endpoint unavailable" too. Cost when genuinely offline: one
    // wasted PUT before /upload fails the same way, with a comparable message.
    return {
      ok: false,
      notSupported: endpoint === 'media',
      error: new BlossomUploadError({
        code: BlossomUploadErrorCode.SERVER_UNREACHABLE,
        message: `Network error while uploading to ${url}: ${(fetchErr as Error).message}`,
        cause: fetchErr,
      }),
    };
  }

  if (response.ok) {
    let descriptor: BlobDescriptor;
    try {
      descriptor = (await response.json()) as BlobDescriptor;
    } catch (parseErr) {
      return {
        ok: false,
        notSupported: false,
        error: new BlossomUploadError({
          code: BlossomUploadErrorCode.INTERNAL,
          message: `Server response on ${endpoint} was not valid JSON.`,
          cause: parseErr,
        }),
      };
    }
    if (!descriptor || typeof descriptor.url !== 'string') {
      return {
        ok: false,
        notSupported: false,
        error: new BlossomUploadError({
          code: BlossomUploadErrorCode.INTERNAL,
          message: `Server returned a Blob Descriptor missing the "url" field on ${endpoint}.`,
        }),
      };
    }
    return { ok: true, descriptor };
  }

  // /media being unsupported manifests as either 404 (per BUD-05 spec),
  // 405, or 401 (Primal returns 401 "invalid action in auth event" because
  // it interprets the `t=media` verb as unknown — verified 2026-05-30).
  // Treating 401 on /media as "endpoint unavailable" costs an extra PUT
  // in the genuine-auth-failure case, but the retry against /upload
  // surfaces a comparable error, so the user-visible outcome is no worse.
  const status = response.status;
  const notSupported =
    endpoint === 'media' && (status === 404 || status === 405 || status === 401);
  return {
    ok: false,
    notSupported,
    error: await mapHttpError(response, endpoint),
  };
}

// ------------------------------------------------------------------- helpers

async function mapHttpError(response: Response, endpoint: EndpointKind): Promise<BlossomUploadError> {
  // Reason precedence: X-Reason header (hzrd149 reference impl) → body text
  // (Primal returns a plain-text reason in the body, e.g.
  // "invalid action in auth event"). Body read is best-effort — we don't
  // want a read failure to mask the real HTTP status.
  let serverReason: string | undefined =
    response.headers.get('x-reason') ?? response.headers.get('X-Reason') ?? undefined;
  if (serverReason === undefined) {
    try {
      const text = (await response.text()).trim();
      if (text && text.length <= 240) serverReason = text;
    } catch (_e) { /* ignore */ }
  }
  const status = response.status;
  let code: BlossomUploadErrorCode;
  if (status === 401 || status === 403) {
    code = BlossomUploadErrorCode.AUTH_FAILED;
  } else if (status >= 400 && status < 600) {
    code = BlossomUploadErrorCode.SERVER_REJECTED;
  } else {
    code = BlossomUploadErrorCode.INTERNAL;
  }
  const message = `Blossom ${endpoint} endpoint returned HTTP ${status}${
    serverReason ? `: ${serverReason}` : ''
  }`;
  if (serverReason !== undefined) {
    return new BlossomUploadError({ code, message, httpStatus: status, serverReason });
  }
  return new BlossomUploadError({ code, message, httpStatus: status });
}

function cancelled(): BlossomUploadError {
  return new BlossomUploadError({
    code: BlossomUploadErrorCode.CANCELLED,
    message: 'Upload was cancelled before it completed.',
  });
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

function descriptorToResult(args: {
  descriptor: BlobDescriptor;
  sha256Hex: string;
  sizeBytes: number;
  mimeFallback: string;
  server: string;
  endpoint: EndpointKind;
}): UploadResult {
  const { descriptor, sha256Hex, sizeBytes, mimeFallback, server, endpoint } = args;
  return {
    url: descriptor.url,
    sha256: typeof descriptor.sha256 === 'string' ? descriptor.sha256 : sha256Hex,
    mimeType:
      typeof descriptor.type === 'string' && descriptor.type ? descriptor.type : mimeFallback,
    sizeBytes: typeof descriptor.size === 'number' ? descriptor.size : sizeBytes,
    server,
    endpoint,
  };
}
