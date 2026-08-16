# @imani/blossom-upload

Blossom (BUD-02 / BUD-05 / BUD-11) image upload library. Shared between the customer wallet (`imani-apps`) and POSSA Merchant so the two apps never duplicate auth-event construction, request shaping, or response parsing.

**Spec**: [`specs/037-blossom-profile-media/`](../../specs/037-blossom-profile-media/) — single source of truth for the contract.

## Usage

```typescript
import { upload, BlossomUploadError, BlossomUploadErrorCode } from '@imani/blossom-upload';
import type { UploadOptions, UploadResult, SignFn, BlossomServerConfig } from '@imani/blossom-upload';

// 1. Resolve config from your app's runtime configuration source.
//    Customer wallet: GatewayConfig.blossomServerUrl from /api/v1/config.
//    POSSA Merchant: your own equivalent.
const config: BlossomServerConfig = {
  url: 'https://blossom.primal.net',          // MUST start with https://
  maxAvatarBytes: 5 * 1024 * 1024,
  maxBannerBytes: 10 * 1024 * 1024,
  allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
};

// 2. Wrap your existing Nostr signer in the SignFn shape.
//    The package NEVER sees the private key — only the signed event.
const sign: SignFn = async (unsignedEvent) => {
  // Local nsec example (customer wallet):
  //   return NostrUtils.signEvent(unsignedEvent, privateKeyHex);
  // NIP-46 bunker example (POSSA Merchant):
  //   return await bunker.signEvent(unsignedEvent);
  return /* signed event */;
};

// 3. Upload.
try {
  const result: UploadResult = await upload({
    file,                       // File from <input type="file">
    slot: 'avatar',             // or 'banner'
    config,
    sign,
    signal: abortController.signal,  // optional cancellation
  });
  // result.url is the content-addressed Blossom URL — write it into kind-0
  // via your app's existing updateProfile chokepoint.
  await api.updateProfile({ ...currentProfile, picture: result.url });
} catch (err) {
  if (err instanceof BlossomUploadError) {
    switch (err.code) {
      case BlossomUploadErrorCode.AUTH_FAILED:        // 401 / 403 / signer threw
      case BlossomUploadErrorCode.FILE_TOO_LARGE:     // size > limit
      case BlossomUploadErrorCode.INVALID_MIME_TYPE:  // type not in whitelist
      case BlossomUploadErrorCode.SERVER_REJECTED:    // 4xx / 5xx
      case BlossomUploadErrorCode.SERVER_UNREACHABLE: // network error
      case BlossomUploadErrorCode.CANCELLED:          // controller.abort()
      // … render localized UI copy by `err.code`.
    }
  }
}
```

## Contract

The complete cross-app contract lives in `specs/037-blossom-profile-media/contracts/`:

- [`blossom-upload-api.contract.md`](../../specs/037-blossom-profile-media/contracts/blossom-upload-api.contract.md) — public API + execution sequence
- [`host-integration.contract.md`](../../specs/037-blossom-profile-media/contracts/host-integration.contract.md) — what each host adapter must do / must not do
- [`kind-24242-auth-event.contract.md`](../../specs/037-blossom-profile-media/contracts/kind-24242-auth-event.contract.md) — BUD-11 auth event shape
- [`server-config.contract.md`](../../specs/037-blossom-profile-media/contracts/server-config.contract.md) — `blossomServerUrl` configuration
- [`updateprofile-integration.contract.md`](../../specs/037-blossom-profile-media/contracts/updateprofile-integration.contract.md) — kind-0 publish chokepoint

## Pinned specs

This package implements:

- [BUD-01](https://github.com/hzrd149/blossom/blob/master/buds/01.md) — Server requirements + GET retrieval
- [BUD-02](https://github.com/hzrd149/blossom/blob/master/buds/02.md) — `PUT /upload`
- [BUD-05](https://github.com/hzrd149/blossom/blob/master/buds/05.md) — `PUT /media` (metadata stripping)
- [BUD-11](https://github.com/hzrd149/blossom/blob/master/buds/11.md) — kind-24242 authorization tokens

Repo HEAD at implementation time: `ef3c79e40d38cee6cdc974056ae86a582e708197` (2026-04-22). Source files carry `@blossom-spec` docstrings pinning to this hash.

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
npm run lint
```

## Versioning

Semver. Additive changes (new optional field, new enum value) → minor. Removed export / renamed field / changed required argument → major. Pinned BUD commit hash update → minor.

## License

MIT
