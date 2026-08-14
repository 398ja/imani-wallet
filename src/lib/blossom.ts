import { upload, type BlossomServerConfig, type SignFn, type UploadSlot } from '@imani/blossom-upload'

import { gatewayConfig } from './config'
import { getSigner } from './nap'

/**
 * Avatar and banner uploads.
 *
 * There is no media server in the imani stack and there is not meant to be: the
 * browser PUTs straight to an external Blossom host (BUD-02/05/11) and the
 * gateway only names it, through `blossom_server_url` on GET /api/v1/config.
 * The gateway normalises an unset value to null rather than "", so "no media
 * server configured" is distinguishable from a broken one — callers disable
 * their file inputs rather than failing at upload time.
 *
 * The upload itself is imani-apps' `@imani/blossom-upload`, used whole. It
 * handles the hash, the kind-24242 auth event, the /media→/upload fallback and
 * the size and MIME checks; the wallet supplies only a signer.
 */

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const

/** BUD-11 limits, matching bottin's 5 MB client-side cap for avatars. */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024
const MAX_BANNER_BYTES = 10 * 1024 * 1024

export const ACCEPT_ATTRIBUTE = ALLOWED.join(',')

/**
 * Bridge nap's signer to the package's SignFn.
 *
 * The package never sees the key — it hands over an unsigned event and gets a
 * signed one back, which is why a locked wallet fails here rather than silently
 * uploading unauthenticated.
 */
const sign: SignFn = async (unsigned) => {
  const signed = await getSigner().signEvent({
    kind: unsigned.kind,
    created_at: unsigned.created_at,
    // The package types tags as readonly tuples; nostr-tools wants string[][].
    tags: unsigned.tags.map((t) => [...t]),
    content: unsigned.content,
  })
  return { ...unsigned, id: signed.id, sig: signed.sig, pubkey: signed.pubkey }
}

/** The configured host, or null when uploads are unavailable. */
export async function blossomServer(): Promise<BlossomServerConfig | null> {
  const { blossomServerUrl } = await gatewayConfig()
  if (!blossomServerUrl) return null

  return {
    url: blossomServerUrl.replace(/\/$/, ''),
    maxAvatarBytes: MAX_AVATAR_BYTES,
    maxBannerBytes: MAX_BANNER_BYTES,
    allowedMimeTypes: ALLOWED,
  }
}

/** @returns the URL to store on the profile. */
export async function uploadImage(
  file: File,
  slot: UploadSlot,
  config: BlossomServerConfig,
): Promise<string> {
  const result = await upload({ file, slot, config, sign })
  return result.url
}
