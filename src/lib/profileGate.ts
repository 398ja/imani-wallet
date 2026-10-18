import { getPublicKey } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

import { gatewayConfig } from './config'
import { claimHandle } from './registration'
import { buildProfileEvent, emptyProfile, loadProfile, saveProfile, type Profile } from './profile'
import { publish } from './relay'
import { createWalletSigner } from './signer'

/**
 * No account without a profile (owner rule, 2026-10-18, #325).
 *
 * Every account on the service has a directory record: a handle, claimed at
 * registration through `POST /api/v1/nip05`. A key brought to a fresh device
 * (from a backup, or pasted) is only let in once the directory confirms that
 * record exists for its public key. The profile cached inside a backup file
 * is not enough: it is whatever the file says, and the directory is the
 * authority.
 *
 * A key with no record is not logged in as an anonymous account. The caller
 * stops before writing anything and asks for a handle, which `claimProfile`
 * claims exactly as registration does. Only then is the key installed.
 */

/** The directory could not be asked. Never treated as "no profile". */
export class DirectoryUnavailableError extends Error {
  constructor() {
    super('Could not check your profile just now. Check your connection and try again.')
    this.name = 'DirectoryUnavailableError'
  }
}

/** The key opened, but its account has no profile yet. Nothing has been written. */
export class ProfileMissingError extends Error {
  constructor(readonly privkeyHex: string) {
    super('This account needs a profile before it can be used.')
    this.name = 'ProfileMissingError'
  }
}

/**
 * The handle the directory holds for this public key, or null when it holds
 * none.
 *
 * Fails CLOSED on anything but a clear answer: a gateway hiccup must not be
 * read as "no profile" (that would push someone with a perfectly good account
 * into claiming a second handle), nor as "has a profile" (that would let an
 * anonymous key in).
 *
 * @throws DirectoryUnavailableError when the directory gives no clear answer
 */
export async function directoryHandle(pubkey: string): Promise<string | null> {
  let response: Response
  try {
    response = await fetch(`/api/v1/resolve/pubkey/${encodeURIComponent(pubkey)}`, {
      credentials: 'include',
    })
  } catch {
    throw new DirectoryUnavailableError()
  }
  if (response.status === 404) return null
  if (!response.ok) throw new DirectoryUnavailableError()

  const body = (await response.json().catch(() => null)) as { nip05?: unknown; hex_pubkey?: unknown } | null
  const nip05 = typeof body?.nip05 === 'string' ? body.nip05.trim() : ''
  const hex = typeof body?.hex_pubkey === 'string' ? body.hex_pubkey.toLowerCase() : pubkey
  // An answer about someone else is no answer.
  if (hex !== pubkey.toLowerCase()) throw new DirectoryUnavailableError()
  return nip05 === '' ? null : nip05
}

/**
 * Check a key that has just been opened. Writes nothing.
 *
 * @returns the account's handle, when it has a profile
 * @throws ProfileMissingError when it has none
 * @throws DirectoryUnavailableError when the directory could not say
 */
export async function requireProfile(privkeyHex: string): Promise<string> {
  const pubkey = getPublicKey(hexToBytes(privkeyHex))
  const nip05 = await directoryHandle(pubkey)
  if (!nip05) throw new ProfileMissingError(privkeyHex)
  return nip05
}

/** Store the directory's handle on the local profile, so the header has it at once. */
export function rememberHandle(privkeyHex: string, nip05: string): void {
  const pubkey = getPublicKey(hexToBytes(privkeyHex))
  const current = loadProfile(pubkey) ?? emptyProfile(pubkey)
  if (current.nip05 === nip05) return
  saveProfile({ ...current, nip05, displayName: current.displayName ?? nip05.split('@')[0] })
}

/**
 * Give an existing key the profile it is missing: claim the handle, then
 * announce the profile, in registration's order.
 *
 * The claim is NIP-98 signed by the key itself, so it needs no session. A
 * taken handle throws `HandleTakenError` having written nothing.
 *
 * @param base what is already known about the account (the backup's stored
 *        profile): its display name and picture are kept, else the handle
 *        becomes the display name, as a customer registration does
 */
export async function claimProfile(privkeyHex: string, handle: string, base?: Profile | null): Promise<Profile> {
  const pubkey = getPublicKey(hexToBytes(privkeyHex))
  const signer = createWalletSigner(privkeyHex)
  const { nip05Domain } = await gatewayConfig()

  await claimHandle(handle, pubkey, signer)

  const current = loadProfile(pubkey) ?? (base?.pubkey === pubkey ? base : null) ?? emptyProfile(pubkey)
  const profile: Profile = {
    ...current,
    nip05: `${handle}@${nip05Domain}`,
    displayName: current.displayName?.trim() || handle,
    updatedAt: Date.now(),
  }
  // A relay that will not take the kind-0 is not a failed claim: the handle is
  // the profile's anchor and it is now held. Same contract as `register`.
  try {
    const signed = await signer.signEvent(buildProfileEvent(profile))
    profile.eventAt = signed.created_at
    await publish(signed)
  } catch {
    // Reported by absence, as registration does.
  }
  saveProfile(profile)
  return profile
}
