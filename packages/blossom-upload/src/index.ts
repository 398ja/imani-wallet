/**
 * @imani/blossom-upload — Blossom protocol upload library.
 *
 * Spec 037 (`specs/037-blossom-profile-media/`). Shared between the customer
 * wallet (imani-apps) and POSSA Merchant — single implementation of the
 * Blossom protocol layer so the two apps never duplicate auth-event
 * construction, request shaping, or response parsing.
 *
 * @blossom-spec BUD-01 / BUD-02 / BUD-05 / BUD-11 — github.com/hzrd149/blossom @ ef3c79e40d38cee6cdc974056ae86a582e708197 (2026-04-22)
 */

// Public type surface (data-model.md)
export type {
  BlossomServerConfig,
  UploadSlot,
  UnsignedAuthEvent,
  SignedAuthEvent,
  SignFn,
  UploadOptions,
  UploadResult,
} from './types';

// Error vocabulary
export { BlossomUploadError, BlossomUploadErrorCode } from './errors';

// Main entry — populated in T020
export { upload } from './upload';
