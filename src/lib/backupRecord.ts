/**
 * Where this account has a backup: Google Drive, a downloaded file, or both.
 *
 * A passphrase change has to know which copies exist. Rewriting Drive when the
 * account never backed up there creates a backup the person never made, and
 * shows Google's account chooser for nothing. A downloaded file cannot be
 * rewritten at all, so the person is offered a new one instead.
 *
 * Each kind holds the epoch ms of the latest backup of that kind. It is not
 * secret, so it lives in plain localStorage, keyed by account, and survives
 * logout (see `isKeptAcrossLogout` in unsavedReceipt.ts): logging out does not
 * delete the backups, so it must not forget them either. It also travels in the
 * backup file's profile, so a restore on a new device knows it.
 */
export type BackupKind = 'drive' | 'file'

export interface BackupRecord {
  drive?: number
  file?: number
}

export const BACKUP_RECORD_PREFIX = 'imani-wallet:backup-record:'

const storageKey = (pubkey: string) => BACKUP_RECORD_PREFIX + pubkey

/** Only well-formed timestamps; anything else is dropped. */
export function sanitiseBackupRecord(value: unknown): BackupRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const out: BackupRecord = {}
  for (const kind of ['drive', 'file'] as const) {
    const at = v[kind]
    if (typeof at === 'number' && Number.isFinite(at) && at > 0) out[kind] = at
  }
  return out.drive === undefined && out.file === undefined ? undefined : out
}

export function loadBackupRecord(pubkey: string): BackupRecord {
  try {
    if (!pubkey) return {}
    const raw = localStorage.getItem(storageKey(pubkey))
    return (raw && sanitiseBackupRecord(JSON.parse(raw))) || {}
  } catch {
    return {}
  }
}

/** Merge in another record, keeping the later timestamp of each kind. */
export function mergeBackupRecord(pubkey: string, incoming: BackupRecord | undefined): void {
  try {
    if (!pubkey) return
    const clean = sanitiseBackupRecord(incoming)
    if (!clean) return
    const current = loadBackupRecord(pubkey)
    const next: BackupRecord = { ...current }
    for (const kind of ['drive', 'file'] as const) {
      const at = clean[kind]
      if (at !== undefined && (current[kind] ?? 0) < at) next[kind] = at
    }
    localStorage.setItem(storageKey(pubkey), JSON.stringify(next))
  } catch {
    // Storage full or blocked: the record is a hint, never worth failing a backup over.
  }
}

export function recordBackup(pubkey: string, kind: BackupKind, at = Date.now()): void {
  mergeBackupRecord(pubkey, { [kind]: at })
}

/**
 * #348: the per-device list of key backup locations (keyBackups.ts). Declared here, beside the
 * record it extends, so the logout sweep's exemption needs no network module.
 */
export const KEY_BACKUPS_PREFIX = 'imani-wallet:key-backups:'

/**
 * Where this device saved its backup files (Android document URIs), per account. Device-local:
 * never published, a URI means nothing on another device. Kept across logout with the list.
 */
export const KEY_BACKUP_FILES_PREFIX = 'imani-wallet:key-backup-files:'

/** The latest "Check my backups" result on this device, per account. Kept across logout. */
export const KEY_BACKUP_CHECK_PREFIX = 'imani-wallet:key-backup-check:'
