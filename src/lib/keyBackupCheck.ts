import {
  backupFingerprint,
  backupsForCurrentKey,
  currentKeyFingerprint,
  deviceId,
  foundMissing,
  lastConfirmedAt,
  loadKeyBackups,
  recordBackupMissing,
  recordKeyBackup,
  validateBackupText,
  type FileCheck,
  type KeyBackup,
} from './keyBackups'
import { FILE_RECHECK_MAX_AGE_MS } from './keyBackupState'
import { CANCELLED, DriveError } from './googleToken'
import type { ReadSaved } from './backupFileStore'

/**
 * "Check my backups": check every backup Imani knows of for this key, where it was put, without
 * asking where. The key icon follows from what the check records.
 *
 * Each backup is checked for two things: it is still there, and the key in it belongs to this
 * npub (the backup's npub and pubkey name this account, and its key envelope is the one this
 * device unlocks the account with).
 *
 * - Google Drive: the account's own file is read straight back (`readAccountBackup`).
 * - A file saved by this device's app: opened again where it was saved (`readSavedFile`).
 * - A file whose location this device never learnt (a browser download, a file saved on another
 *   device): reported from its record. A browser cannot open a download by itself, so the person
 *   may confirm it by picking it.
 *
 * Found and matching: recorded as checked. Not there, or another key: recorded as missing, so the
 * record stops vouching for it on every device. Could not ask (offline, cancelled, no grant):
 * nothing recorded, nothing changes.
 */

export type DriveCheck = 'ok' | 'old-key' | 'gone' | 'unreachable' | 'cancelled' | 'not-set-up'

export type FileResult =
  /** Opened where it was saved; holds this npub's current key. */
  | { kind: 'ok' }
  /** Opened, but it is not a good backup of this account's current key. */
  | { kind: 'mismatch'; why: Exclude<FileCheck, 'ok'> }
  /** Not there any more. */
  | { kind: 'gone' }
  /** There, as far as anyone knows, but it could not be opened now. */
  | { kind: 'unreadable' }
  /** This device does not know where it is; judged from its record. */
  | { kind: 'unlocated'; current: boolean; countsUntil: number }

export interface FileStatus {
  backup: KeyBackup
  result: FileResult
}

export interface BackupsCheck {
  /** Null when no Drive backup is known for this key, so Drive was not asked. */
  drive: DriveCheck | null
  files: FileStatus[]
  /** No backup at all is known for the current key. */
  none: boolean
}

export interface CheckPorts {
  /** This account's backup text in Drive, or null when there is none. */
  readDrive: (pubkey: string) => Promise<string | null>
  driveConfigured: () => boolean
  /** The file this device saved for this key, opened where it was saved. */
  readFile: (pubkey: string, fingerprint: string) => Promise<ReadSaved>
  now?: () => number
}

async function checkDrive(pubkey: string, fingerprint: string, ports: CheckPorts, now: number): Promise<DriveCheck> {
  if (!ports.driveConfigured()) return 'not-set-up'
  let text: string | null
  try {
    text = await ports.readDrive(pubkey)
  } catch (e) {
    // A failure to ask is not an answer: the record stays as it was.
    return e instanceof DriveError && e.message === CANCELLED ? 'cancelled' : 'unreachable'
  }
  if (text === null) {
    recordBackupMissing(pubkey, 'drive', fingerprint, now)
    return 'gone'
  }
  if (validateBackupText(pubkey, text) !== 'ok') {
    recordBackupMissing(pubkey, 'drive', fingerprint, now)
    return 'old-key'
  }
  recordKeyBackup(pubkey, 'drive', { verified: true, fingerprint, at: now })
  return 'ok'
}

function unlocated(b: KeyBackup, now: number): FileResult {
  const at = lastConfirmedAt(b)
  const countsUntil = at + FILE_RECHECK_MAX_AGE_MS
  return { kind: 'unlocated', current: !foundMissing(b) && at <= now && now <= countsUntil, countsUntil }
}

async function checkFile(pubkey: string, b: KeyBackup, ports: CheckPorts, now: number): Promise<FileResult> {
  // Only this device knows where its own files went.
  if (b.deviceId !== deviceId()) return unlocated(b, now)
  let read: ReadSaved
  try {
    read = await ports.readFile(pubkey, b.keyFingerprint)
  } catch {
    read = { kind: 'unreadable' }
  }
  switch (read.kind) {
    case 'unknown':
      return unlocated(b, now)
    case 'unreadable':
      return { kind: 'unreadable' }
    case 'gone':
      recordBackupMissing(pubkey, 'file', b.keyFingerprint, now)
      return { kind: 'gone' }
    case 'text': {
      const why = validateBackupText(pubkey, read.text)
      if (why !== 'ok') {
        recordBackupMissing(pubkey, 'file', b.keyFingerprint, now)
        return { kind: 'mismatch', why }
      }
      recordKeyBackup(pubkey, 'file', {
        verified: true,
        fingerprint: backupFingerprint(read.text) ?? b.keyFingerprint,
        at: now,
        ...(b.fileName ? { fileName: b.fileName } : {}),
      })
      return { kind: 'ok' }
    }
  }
}

/** Check every known backup of the current key, where it is. Never throws. */
export async function checkKeyBackups(pubkey: string, ports: CheckPorts): Promise<BackupsCheck> {
  const now = ports.now?.() ?? Date.now()
  const fingerprint = currentKeyFingerprint()
  const current = fingerprint ? backupsForCurrentKey(loadKeyBackups(pubkey), fingerprint) : []
  const hasDrive = current.some((b) => b.location === 'drive')
  const drive = hasDrive && fingerprint ? await checkDrive(pubkey, fingerprint, ports, now) : null
  const files: FileStatus[] = []
  for (const b of current.filter((x) => x.location === 'file')) {
    files.push({ backup: b, result: await checkFile(pubkey, b, ports, now) })
  }
  return { drive, files, none: current.length === 0 }
}
