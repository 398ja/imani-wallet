/**
 * Public type surface for @imani/blossom-upload.
 *
 * Both the customer wallet (imani-apps) and POSSA Merchant consume these
 * types via their adapters. Spec 037, data-model.md.
 *
 * @blossom-spec BUD-02 (Blob upload) + BUD-05 (Media optimization) + BUD-11 (Authorization) — github.com/hzrd149/blossom @ ef3c79e40d38cee6cdc974056ae86a582e708197
 */

/**
 * Host-app-supplied configuration for the Blossom upload pipeline.
 *
 * The host reads this from its own runtime config substrate. The package
 * validates the URL at first use and throws BlossomUploadError.INVALID_SERVER_URL
 * if it does not start with "https://".
 */
export interface BlossomServerConfig {
  /** Base URL of the Blossom server, MUST start with "https://", no trailing slash. */
  readonly url: string;
  /** Maximum bytes for an avatar upload. Default 5 MB; configurable per app. */
  readonly maxAvatarBytes: number;
  /** Maximum bytes for a banner upload. Default 10 MB; configurable per app. */
  readonly maxBannerBytes: number;
  /** Whitelist of MIME types this app accepts for image uploads. */
  readonly allowedMimeTypes: readonly string[];
  /**
   * Endpoint preference. Default `"auto"` — try BUD-05 `/media` first, fall
   * back to BUD-02 `/upload` on 404 / 405 / 401. Set to `"upload"` to skip
   * the `/media` probe entirely; useful when the host already strips
   * privacy-sensitive metadata client-side, AND/OR when the deployed
   * Blossom server's `/media` 401 / 404 response lacks CORS headers and
   * therefore can't be inspected by the browser (the network-error fallback
   * doesn't trigger because the browser blocks the response).
   */
  readonly preferEndpoint?: 'auto' | 'upload';
}

/** Which kind-0 image slot this upload targets. Drives the file-size limit lookup. */
export type UploadSlot = 'avatar' | 'banner';

/**
 * Unsigned kind-24242 Blossom authorization event. The package constructs this
 * from the file's SHA-256 and the target endpoint verb; the host's SignFn signs
 * it and returns the SignedAuthEvent.
 *
 * Constraints come from BUD-11 § "Authorization tokens".
 */
export interface UnsignedAuthEvent {
  readonly kind: 24242;
  readonly created_at: number;
  readonly tags: ReadonlyArray<readonly [string, string]>;
  readonly content: string;
  readonly pubkey: string;
}

/** A signed event suitable for the Authorization header. */
export interface SignedAuthEvent extends UnsignedAuthEvent {
  readonly id: string;
  readonly sig: string;
}

/**
 * Signing callback the host app supplies. Unconditionally async so it can
 * accommodate both local-nsec signers and remote signers (NIP-46 bunkers).
 *
 * If the callback throws or rejects, the package maps the failure to
 * BlossomUploadError.AUTH_FAILED with the original error attached as `cause`.
 */
export type SignFn = (unsigned: UnsignedAuthEvent) => Promise<SignedAuthEvent>;

/** Single input to `upload()`. */
export interface UploadOptions {
  /** The file the user picked. The package reads its bytes once via .arrayBuffer(). */
  readonly file: Blob;
  /** Which slot to upload into. Selects the size limit + content-label string. */
  readonly slot: UploadSlot;
  /** Resolved server config from the host's runtime config. */
  readonly config: BlossomServerConfig;
  /** Host-supplied signer. The package never sees the user's key. */
  readonly sign: SignFn;
  /** Optional cancellation signal. The host owns the AbortController. */
  readonly signal?: AbortSignal;
}

/**
 * Successful upload result. The `url` field is the content-addressed Blossom URL
 * that the host app writes into kind-0 `picture` or `banner` via its existing
 * profile-publish chokepoint.
 */
export interface UploadResult {
  /** Full URL the server returned. Includes a file extension per BUD-02. */
  readonly url: string;
  /** Lowercase hex SHA-256 of the uploaded bytes. */
  readonly sha256: string;
  /** MIME type as the server stored it. May differ from the input if /media transcoded. */
  readonly mimeType: string;
  /** Size in bytes as the server received it. */
  readonly sizeBytes: number;
  /** Base URL of the server that served the result (matches config.url). */
  readonly server: string;
  /**
   * Which endpoint actually accepted the upload — "media" if BUD-05 succeeded,
   * "upload" if the BUD-02 fallback was used. SC-004 (EXIF stripping) is
   * guaranteed only when the value is "media".
   */
  readonly endpoint: 'media' | 'upload';
}
