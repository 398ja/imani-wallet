import { getPublicKey, nip19 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

import { applyBackup } from './backup'
import { keyStore } from './nap'
import { loadProfile, sanitiseProfile, saveProfile, type Profile } from './profile'

/**
 * The account escrow file — the thing that goes in the customer's own Drive.
 *
 * A near-relative of lib/backup.ts and deliberately not the same format. The
 * backup file is handed to a person who already knows whose it is; an escrow
 * file is fetched by a browser that knows nothing, on behalf of someone who has
 * just lost their phone. So two things differ:
 *
 * - `npub` and `pubkey` sit in the clear. Restore has to be able to say WHOSE
 *   account this is, and resolve the profile off the relay, BEFORE it asks for
 *   anything. Neither is secret — the npub is the identity, not a credential.
 * - `nsec` carries either shape. A hex string when the customer chose not to
 *   protect the escrowed copy (their Google account is then the only gate), or
 *   nap's own encrypted envelope when they did. `nsecProtected()` tells them
 *   apart, and restore asks for a passphrase only in the second case — the
 *   "enter the password if applicable" half of the flow.
 *
 * The envelope is copied verbatim out of nap's keystore, exactly as backup.ts
 * copies it and for the same reasons: no second encryption scheme to review,
 * and the KDF parameters travel with the ciphertext so a file written today
 * still opens after the defaults change.
 */

/** Must match the name given to `createWebCryptoKeyStore` in lib/nap.ts. */
const KEYSTORE_STORAGE_KEY = 'imani-wallet-key'

const FORMAT = 'imani-wallet-escrow'
const VERSION = 1

/** nap's encrypted envelope. Opaque here — passed through untouched. */
export interface KeyEnvelope {
  version: number
  kdf: unknown
  iv: string
  ciphertext: string
}

export interface EscrowFile {
  format: typeof FORMAT
  version: number
  createdAt: string
  /** bech32, so a human who opens the file in Drive can see whose it is. */
  npub: string
  /** The same identity as hex, which is what every API here actually takes. */
  pubkey: string
  /** 64-char hex when unprotected, nap's envelope when passphrase-protected. */
  nsec: string | KeyEnvelope
  profile: Profile | null
}

export class EscrowError extends Error {}

/** The name the file takes in the appDataFolder. One per Google account. */
export const ESCROW_FILENAME = 'imani-wallet-escrow.json'

export function nsecProtected(nsec: string | KeyEnvelope): nsec is KeyEnvelope {
  return typeof nsec !== 'string'
}

/**
 * Build the escrow file for the signed-in account.
 *
 * @param privkeyHex the unlocked key, or `undefined` to escrow the encrypted
 *   envelope instead. Passing the key means writing it to Drive in the clear:
 *   the caller is the one that must have asked, and BackupPage does.
 * @throws EscrowError when protecting and this browser holds no envelope
 */
export function createEscrow(pubkey: string, privkeyHex?: string): string {
  let nsec: string | KeyEnvelope

  if (privkeyHex) {
    // Validated rather than trusted. A malformed key here would round-trip
    // happily and only fail on the far side, on the device of someone with no
    // other copy left.
    if (!/^[0-9a-f]{64}$/.test(privkeyHex)) throw new EscrowError('That is not a 64-character hex key.')
    nsec = privkeyHex
  } else {
    const stored = localStorage.getItem(KEYSTORE_STORAGE_KEY)
    if (!stored) throw new EscrowError('There is no key stored in this browser to escrow.')
    nsec = JSON.parse(stored) as KeyEnvelope
  }

  const file: EscrowFile = {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    npub: nip19.npubEncode(pubkey),
    pubkey,
    nsec,
    profile: loadProfile(pubkey),
  }

  return JSON.stringify(file, null, 2)
}

/** An escrow file that has been validated but NOT installed anywhere. */
export interface ParsedEscrow {
  npub: string
  pubkey: string
  nsec: string | KeyEnvelope
  profile: Profile | null
  createdAt: string
}

/**
 * Validate an escrow file. Writes nothing.
 *
 * Split from installing it for the same reason backup.ts splits parse from
 * apply: restore is reached from the login screen, so a browser that still
 * holds a usable key must not lose it to a file that turns out to be junk.
 *
 * @throws EscrowError on anything not usable as an escrow file
 */
export function parseEscrow(text: string): ParsedEscrow {
  let parsed: Partial<EscrowFile>
  try {
    parsed = JSON.parse(text) as Partial<EscrowFile>
  } catch {
    throw new EscrowError('That file is not a wallet escrow.')
  }

  if (parsed.format !== FORMAT) throw new EscrowError('That file is not a wallet escrow.')
  if (typeof parsed.version !== 'number' || parsed.version > VERSION) {
    throw new EscrowError('That escrow was made by a newer version of the wallet.')
  }

  // The pubkey is the load-bearing field: it names the account before anything
  // is decrypted, and a restore that shows the wrong npub is worse than one
  // that refuses. So it is derived from the npub rather than believed, and the
  // two must agree.
  if (typeof parsed.npub !== 'string' || !parsed.npub.startsWith('npub1')) {
    throw new EscrowError('That escrow does not name an account.')
  }
  let pubkey: string
  try {
    const decoded = nip19.decode(parsed.npub)
    if (decoded.type !== 'npub') throw new Error()
    pubkey = decoded.data
  } catch {
    throw new EscrowError('That escrow does not name an account.')
  }
  if (parsed.pubkey !== pubkey) {
    throw new EscrowError('That escrow is damaged: its npub and public key disagree.')
  }

  const nsec = parsed.nsec
  if (typeof nsec === 'string') {
    if (!/^[0-9a-f]{64}$/.test(nsec)) throw new EscrowError('That escrow is missing its key, or is damaged.')
    // An unprotected escrow that does not belong to the npub beside it would
    // silently restore a different account than the one shown on the screen.
    if (nip19.npubEncode(pubkeyOf(nsec)) !== parsed.npub) {
      throw new EscrowError('That escrow is damaged: its key does not match its npub.')
    }
  } else if (!nsec || !nsec.ciphertext || !nsec.kdf || !nsec.iv) {
    throw new EscrowError('That escrow is missing its key, or is damaged.')
  }

  // Public metadata, but it still arrives in a file, so it is a trust boundary.
  const profile = parsed.profile
  const usableProfile =
    profile && typeof profile.pubkey === 'string' && profile.pubkey === pubkey
      ? sanitiseProfile(profile)
      : null

  return {
    npub: parsed.npub,
    pubkey,
    nsec,
    profile: usableProfile,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
  }
}

function pubkeyOf(privkeyHex: string): string {
  return getPublicKey(hexToBytes(privkeyHex))
}

/**
 * Install a parsed escrow into this browser, and return the unlocked key.
 *
 * @param passphrase for a protected escrow, the one it was written with; for an
 *   unprotected one, a fresh passphrase for THIS device. The escrowed copy is
 *   the recovery path either way, so a device passphrase can be forgotten
 *   without losing the account — which is the whole point of escrowing.
 * @throws whatever the keystore throws on a wrong passphrase
 */
export async function installEscrow(escrow: ParsedEscrow, passphrase: string): Promise<string> {
  if (nsecProtected(escrow.nsec)) {
    // Reuses backup.ts's install, which snapshots the record it overwrites and
    // puts it back if the passphrase turns out to be wrong. Restore is reached
    // from the login screen, where the browser may still hold a usable key.
    const { privkeyHex } = await applyBackup(
      { key: escrow.nsec, profile: escrow.profile },
      () => keyStore.loadKey(passphrase),
    )
    return privkeyHex
  }

  // Nothing to verify — the key is right here, and parseEscrow has already
  // checked it derives the npub shown on the confirmation screen. That screen
  // is what guards the overwrite; there is no passphrase failure to roll back.
  await keyStore.save(escrow.nsec, passphrase)
  if (escrow.profile) saveProfile(escrow.profile)
  return escrow.nsec
}
