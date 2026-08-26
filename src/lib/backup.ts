import { loadProfile, sanitiseProfile, saveProfile, type Profile } from './profile'

/**
 * Account backup and restore.
 *
 * The file carries nap's OWN encrypted envelope verbatim — the
 * `{version, kdf:{name,hash,iterations,salt}, iv, ciphertext}` record its
 * WebCrypto keystore writes to localStorage — plus the public profile.
 *
 * Copying that envelope rather than re-encrypting the key is the whole design.
 * It means:
 *   - no second encryption scheme to review, and no chance of the backup being
 *     weaker than the thing it backs up;
 *   - the file is already passphrase-protected, so a copy on a USB stick is no
 *     more dangerous than the browser profile it came from;
 *   - it is self-describing (the KDF parameters travel with it), so a file
 *     written today still opens after the defaults change.
 *
 * The alternative — writing the nsec into the file — would put plaintext key
 * material on disk, which is precisely what RFC §1181 and nap's keystore exist
 * to prevent. The Download button on the backup key already covers the user who
 * wants that, with a warning attached.
 */

/** Must match the name given to `createWebCryptoKeyStore` in lib/nap.ts. */
const KEYSTORE_STORAGE_KEY = 'imani-wallet-key'

const FORMAT = 'imani-wallet-backup'
const VERSION = 1

export interface BackupFile {
  format: typeof FORMAT
  version: number
  createdAt: string
  /** nap's encrypted envelope, opaque here and passed through untouched. */
  key: unknown
  profile: Profile | null
}

export class BackupError extends Error {}

/**
 * @throws BackupError when this browser holds no key to back up
 */
export function createBackup(pubkey: string): string {
  const key = localStorage.getItem(KEYSTORE_STORAGE_KEY)
  if (!key) throw new BackupError('There is no key stored in this browser to back up.')

  const file: BackupFile = {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    key: JSON.parse(key) as unknown,
    profile: loadProfile(pubkey),
  }
  return JSON.stringify(file, null, 2)
}

export function backupFilename(profile: Profile | null): string {
  // The handle makes two backups from two accounts distinguishable in a
  // downloads folder, which is where they will actually be looked at.
  const who = profile?.nip05?.split('@')[0] ?? profile?.pubkey.slice(0, 8) ?? 'account'
  return `imani-wallet-backup-${who}.json`
}

/** A backup file that has been validated but NOT yet written anywhere. */
export interface ParsedBackup {
  key: unknown
  profile: Profile | null
}

/**
 * Validate a backup file. Writes nothing.
 *
 * Split from `applyBackup` deliberately. Restore is reached from the login
 * screen — i.e. from a browser that already holds a key — so parsing and
 * installing must not be the same step. See `applyBackup`.
 *
 * @throws BackupError on anything that is not a usable backup file
 */
export function parseBackup(text: string): ParsedBackup {
  let parsed: Partial<BackupFile>
  try {
    parsed = JSON.parse(text) as Partial<BackupFile>
  } catch {
    throw new BackupError('That file is not a wallet backup.')
  }

  if (parsed.format !== FORMAT) throw new BackupError('That file is not a wallet backup.')
  if (typeof parsed.version !== 'number' || parsed.version > VERSION) {
    throw new BackupError('That backup was made by a newer version of the wallet.')
  }
  // Check the envelope has the shape nap will read, here rather than at unlock:
  // a truncated file should say so now, not fail as "wrong passphrase" later.
  const key = parsed.key as { ciphertext?: unknown; kdf?: unknown; iv?: unknown } | undefined
  if (!key || !key.ciphertext || !key.kdf || !key.iv) {
    throw new BackupError('That backup is missing its key, or is damaged.')
  }

  // The profile is public metadata, but it still comes out of a file the user
  // was handed, so it is a trust boundary. `saveProfile` keys off `pubkey`, and
  // a record without one writes `imani-wallet:profile:undefined` — which then
  // breaks the login screen's recognition card, because that counts stored
  // profiles and expects exactly one.
  const profile = parsed.profile
  const usableProfile =
    profile && typeof profile.pubkey === 'string' && profile.pubkey !== ''
      ? sanitiseProfile(profile)
      : null

  return { key: parsed.key, profile: usableProfile }
}

/**
 * Install a parsed backup, but only if the passphrase actually opens it.
 *
 * The order here is the point. An earlier version wrote the key the moment a
 * file was chosen, before asking for anything — so picking the wrong file, or
 * one whose passphrase had been misremembered, destroyed the only encrypted
 * copy of the key already in this browser. The app's own copy tells the user
 * there is no recovery, and it was right.
 *
 * So: snapshot what is there, write, verify by decrypting, and put the old
 * record back if the verification fails.
 *
 * @param unlock decrypts against the newly written record; returns the key hex
 * @throws whatever `unlock` throws, having first rolled back
 */
export async function applyBackup(
  backup: ParsedBackup,
  unlock: () => Promise<string>,
): Promise<{ privkeyHex: string; profile: Profile | null }> {
  const previous = localStorage.getItem(KEYSTORE_STORAGE_KEY)
  localStorage.setItem(KEYSTORE_STORAGE_KEY, JSON.stringify(backup.key))

  let privkeyHex: string
  try {
    privkeyHex = await unlock()
  } catch (e) {
    // Put the browser back exactly as it was, including the no-key case.
    if (previous === null) localStorage.removeItem(KEYSTORE_STORAGE_KEY)
    else localStorage.setItem(KEYSTORE_STORAGE_KEY, previous)
    throw e
  }

  // Only once the key is proven usable is it safe to touch anything else.
  if (backup.profile) saveProfile(backup.profile)
  return { privkeyHex, profile: backup.profile }
}
