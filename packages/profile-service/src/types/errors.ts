/**
 * Profile service error codes
 */
export enum ProfileErrorCode {
  NETWORK_ERROR = 'NETWORK_ERROR',
  RELAY_TIMEOUT = 'RELAY_TIMEOUT',
  INVALID_PUBKEY = 'INVALID_PUBKEY',
  NIP05_RESOLUTION_FAILED = 'NIP05_RESOLUTION_FAILED',
  PROFILE_NOT_FOUND = 'PROFILE_NOT_FOUND',
  CACHE_ERROR = 'CACHE_ERROR',
  FOLLOW_SYNC_FAILED = 'FOLLOW_SYNC_FAILED',
  RATE_LIMITED = 'RATE_LIMITED',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  STORAGE_ERROR = 'STORAGE_ERROR',
}

/**
 * Profile service error
 */
export class ProfileError extends Error {
  readonly code: ProfileErrorCode;
  readonly cause?: Error;
  readonly retryable: boolean;

  constructor(
    code: ProfileErrorCode,
    message: string,
    options?: { cause?: Error; retryable?: boolean }
  ) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
    this.cause = options?.cause;
    this.retryable = options?.retryable ?? isRetryable(code);

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ProfileError);
    }
  }
}

/**
 * Determine if an error code is retryable by default
 */
function isRetryable(code: ProfileErrorCode): boolean {
  switch (code) {
    case ProfileErrorCode.NETWORK_ERROR:
    case ProfileErrorCode.RELAY_TIMEOUT:
    case ProfileErrorCode.RATE_LIMITED:
      return true;
    case ProfileErrorCode.INVALID_PUBKEY:
    case ProfileErrorCode.PROFILE_NOT_FOUND:
    case ProfileErrorCode.VALIDATION_ERROR:
      return false;
    default:
      return false;
  }
}

/**
 * Create a network error
 */
export function networkError(message: string, cause?: Error): ProfileError {
  return new ProfileError(ProfileErrorCode.NETWORK_ERROR, message, {
    cause,
    retryable: true,
  });
}

/**
 * Create a relay timeout error
 */
export function relayTimeoutError(relay: string): ProfileError {
  return new ProfileError(
    ProfileErrorCode.RELAY_TIMEOUT,
    `Relay timeout: ${relay}`,
    { retryable: true }
  );
}

/**
 * Create an invalid pubkey error
 */
export function invalidPubkeyError(pubkey: string): ProfileError {
  return new ProfileError(
    ProfileErrorCode.INVALID_PUBKEY,
    `Invalid pubkey: ${pubkey}`,
    { retryable: false }
  );
}

/**
 * Create a NIP-05 resolution error
 */
export function nip05ResolutionError(
  identifier: string,
  cause?: Error
): ProfileError {
  return new ProfileError(
    ProfileErrorCode.NIP05_RESOLUTION_FAILED,
    `Failed to resolve NIP-05: ${identifier}`,
    { cause, retryable: true }
  );
}

/**
 * Create a profile not found error
 */
export function profileNotFoundError(pubkey: string): ProfileError {
  return new ProfileError(
    ProfileErrorCode.PROFILE_NOT_FOUND,
    `Profile not found: ${pubkey}`,
    { retryable: false }
  );
}

/**
 * Create a cache error
 */
export function cacheError(message: string, cause?: Error): ProfileError {
  return new ProfileError(ProfileErrorCode.CACHE_ERROR, message, {
    cause,
    retryable: false,
  });
}

/**
 * Create a follow sync error
 */
export function followSyncError(message: string, cause?: Error): ProfileError {
  return new ProfileError(ProfileErrorCode.FOLLOW_SYNC_FAILED, message, {
    cause,
    retryable: true,
  });
}

/**
 * Create a rate limit error
 */
export function rateLimitError(retryAfterMs?: number): ProfileError {
  const message = retryAfterMs
    ? `Rate limited. Retry after ${retryAfterMs}ms`
    : 'Rate limited';
  return new ProfileError(ProfileErrorCode.RATE_LIMITED, message, {
    retryable: true,
  });
}

/**
 * Create a validation error
 */
export function validationError(message: string): ProfileError {
  return new ProfileError(ProfileErrorCode.VALIDATION_ERROR, message, {
    retryable: false,
  });
}

/**
 * Create a storage error
 */
export function storageError(message: string, cause?: Error): ProfileError {
  return new ProfileError(ProfileErrorCode.STORAGE_ERROR, message, {
    cause,
    retryable: false,
  });
}
