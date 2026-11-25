import { Capacitor } from '@capacitor/core'

import { KEY_BACKUP_FILES_PREFIX } from './backupRecord'
import { downloadText } from './download'
import { BackupFile } from './native/backupFile'

/**
 * Saving a key backup file so the app can find it again, and reading it back.
 *
 * - Android app: saved through the system "save as" screen. The app keeps a lasting read grant on
 *   the document it wrote and remembers where (`KEY_BACKUP_FILES_PREFIX`, this device only). A
 *   check opens that document again with no picker and no storage permission.
 * - Browser: a web page is never told where a download went and cannot open it again unasked. The
 *   file is downloaded as before and the location stays unknown, so a check can only say so.
 */

export type SavedFile = { located: true } | { located: false }

export type ReadSaved =
  | { kind: 'text'; text: string }
  /** No document there any more: deleted or moved. */
  | { kind: 'gone' }
  /** This device never learnt where the file went (a browser download, or saved on another device). */
  | { kind: 'unknown' }
  /** The document may be there, but it could not be opened now (grant revoked, provider error). */
  | { kind: 'unreadable' }

const storageKey = (pubkey: string) => KEY_BACKUP_FILES_PREFIX + pubkey

function loadLocations(pubkey: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(storageKey(pubkey))
    const parsed = raw ? (JSON.parse(raw) as unknown) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Remember where this device saved the file holding `fingerprint`. */
export function rememberFileLocation(pubkey: string, fingerprint: string, uri: string): void {
  try {
    localStorage.setItem(storageKey(pubkey), JSON.stringify({ ...loadLocations(pubkey), [fingerprint]: uri }))
  } catch {
    // Storage full or blocked: a later check reports the location as unknown.
  }
}

export function fileLocation(pubkey: string, fingerprint: string): string | null {
  const uri = loadLocations(pubkey)[fingerprint]
  return typeof uri === 'string' && uri ? uri : null
}

/**
 * Save a backup file. On Android the "save as" screen picks where, and the app remembers it.
 * Rejects when it could not be saved; a closed save screen resolves `{ located: false }` with
 * nothing saved, as a dismissed share sheet did.
 */
export async function saveBackupFile(pubkey: string, fingerprint: string | undefined, fileName: string, text: string): Promise<SavedFile & { saved: boolean }> {
  if (!Capacitor.isNativePlatform()) {
    await downloadText(fileName, text)
    return { located: false, saved: true }
  }
  try {
    const { uri } = await BackupFile.create({ fileName, text })
    if (fingerprint) rememberFileLocation(pubkey, fingerprint, uri)
    return { located: true, saved: true }
  } catch (e) {
    if ((e as { code?: string } | null)?.code === 'cancelled') return { located: false, saved: false }
    throw new Error('Could not save the backup file. Please try again.')
  }
}

/** Open the file this device saved for `fingerprint`, where it saved it. Never throws. */
export async function readSavedFile(pubkey: string, fingerprint: string): Promise<ReadSaved> {
  const uri = fileLocation(pubkey, fingerprint)
  if (!uri || !Capacitor.isNativePlatform()) return { kind: 'unknown' }
  try {
    const { text } = await BackupFile.read({ uri })
    return { kind: 'text', text }
  } catch (e) {
    return (e as { code?: string } | null)?.code === 'gone' ? { kind: 'gone' } : { kind: 'unreadable' }
  }
}
