/**
 * Stable error vocabulary for @imani/blossom-upload.
 *
 * Host adapters MUST map by the `code` field; they MUST NOT parse the
 * free-text `message` for control flow. Adding a new enum value is
 * additive (minor bump); removing one is breaking (major bump).
 *
 * @blossom-spec BUD-01 § "Error responses" (X-Reason header) — github.com/hzrd149/blossom @ ef3c79e40d38cee6cdc974056ae86a582e708197
 */

export enum BlossomUploadErrorCode {
  /** File's MIME type is not in BlossomServerConfig.allowedMimeTypes. Client-side. */
  INVALID_MIME_TYPE = 'INVALID_MIME_TYPE',
  /** File exceeds BlossomServerConfig.maxAvatarBytes / .maxBannerBytes. Client-side. */
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  /** BlossomServerConfig.url is not https://… or otherwise malformed. Client-side. */
  INVALID_SERVER_URL = 'INVALID_SERVER_URL',
  /** Server returned 401/403 OR the SignFn threw / rejected. */
  AUTH_FAILED = 'AUTH_FAILED',
  /** Server returned 4xx OR 5xx with a body the package could parse. */
  SERVER_REJECTED = 'SERVER_REJECTED',
  /** Network failure, DNS, TLS, or other transport error before any response. */
  SERVER_UNREACHABLE = 'SERVER_UNREACHABLE',
  /** User invoked AbortController.abort() while the upload was in flight. */
  CANCELLED = 'CANCELLED',
  /**
   * Anything else — defensive catch-all. Should be rare; if seen in production,
   * it's a bug in the package or an unexpected runtime state.
   */
  INTERNAL = 'INTERNAL',
}

export interface BlossomUploadErrorInit {
  readonly code: BlossomUploadErrorCode;
  readonly message: string;
  readonly httpStatus?: number;
  readonly serverReason?: string;
  readonly cause?: unknown;
}

export class BlossomUploadError extends Error {
  readonly code: BlossomUploadErrorCode;
  readonly httpStatus: number | undefined;
  readonly serverReason: string | undefined;
  // Native ES2022 Error.cause is supported on every browser baseline this
  // package targets; declared via the constructor super() options bag.
  readonly causeValue: unknown;

  constructor(init: BlossomUploadErrorInit) {
    super(init.message, { cause: init.cause });
    this.name = 'BlossomUploadError';
    this.code = init.code;
    this.httpStatus = init.httpStatus;
    this.serverReason = init.serverReason;
    this.causeValue = init.cause;
    // Preserve prototype chain when transpiled — Error subclasses need this
    // for `instanceof` checks to work cross-realm.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
