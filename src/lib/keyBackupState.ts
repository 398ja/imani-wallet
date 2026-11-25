import { useEffect, useState } from 'react'

import {
  KEY_BACKUPS_CHANGED,
  backupsForCurrentKey,
  currentKeyFingerprint,
  loadKeyBackups,
  syncKeyBackups,
  type KeyBackup,
} from './keyBackups'

/**
 * How safe the signed-in user's key is, for the key icon beside their handle.
 *
 * - `verified` (green): a recorded backup holds the key this browser holds now, and that copy
 *   was confirmed: a Drive backup read back after writing, or a file re-checked with
 *   `verifyBackupFile` within `FILE_RECHECK_MAX_AGE_MS`.
 * - `missing` (orange): a backup was made, but it cannot be confirmed to hold the current key
 *   where it was put. The only backups hold an older key (the passphrase changed since), a file
 *   was downloaded but never re-checked or not re-checked recently, or a live Drive listing (when
 *   one is passed in) no longer has this key.
 * - `none` (red): no backup was ever recorded for this account.
 *
 * Drive cannot be asked silently on the web (every token costs a Google chooser), so the icon
 * never asks: it reads the recorded `lastVerifiedAt`. Any failure answers `missing`, never
 * `verified`.
 */
export type KeyBackupState = 'verified' | 'missing' | 'none'

/** A file nobody has re-opened in this long may have been moved, deleted or lost with a device. */
export const FILE_RECHECK_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000

export interface DeriveOptions {
  /** The fingerprint of the key held now. */
  fingerprint: string | null
  now?: number
  /**
   * Fingerprints a live Drive listing just found, or undefined when Drive was not asked. When
   * given, a Drive backup only counts if its key is still there.
   */
  driveFingerprints?: ReadonlySet<string>
}

export function deriveKeyBackupState(list: readonly KeyBackup[], options: DeriveOptions): KeyBackupState {
  try {
    if (list.length === 0) return 'none'
    const { fingerprint, now = Date.now(), driveFingerprints } = options
    if (!fingerprint) return 'missing'
    const confirmed = backupsForCurrentKey(list, fingerprint).some((b) => {
      if (!b.lastVerifiedAt) return false
      if (b.location === 'drive') return driveFingerprints ? driveFingerprints.has(b.keyFingerprint) : true
      return now - b.lastVerifiedAt <= FILE_RECHECK_MAX_AGE_MS
    })
    return confirmed ? 'verified' : 'missing'
  } catch {
    return 'missing'
  }
}

/** The state for this device's own account, from what it knows. Never throws. */
export function currentKeyBackupState(pubkey: string, now = Date.now()): KeyBackupState {
  try {
    return deriveKeyBackupState(loadKeyBackups(pubkey), { fingerprint: currentKeyFingerprint(), now })
  } catch {
    return 'missing'
  }
}

/** Live state for the signed-in user: re-reads on every change and syncs the relay record once. */
export function useKeyBackupState(pubkey: string): KeyBackupState {
  const [state, setState] = useState<KeyBackupState>(() => currentKeyBackupState(pubkey))
  useEffect(() => {
    let live = true
    const refresh = () => live && setState(currentKeyBackupState(pubkey))
    refresh()
    window.addEventListener(KEY_BACKUPS_CHANGED, refresh)
    void syncKeyBackups(pubkey).then(refresh, refresh)
    return () => {
      live = false
      window.removeEventListener(KEY_BACKUPS_CHANGED, refresh)
    }
  }, [pubkey])
  return state
}

/** The query flag the icon adds so the backup page explains why it was opened. */
export const BACKUP_RECOMMEND_PARAM = 'recommend'
