import { useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { AlertCircle, CheckCircle2 } from 'lucide-react'

import { Alert, Button, ListSection } from './ui'
import { backupFileAccept } from '../lib/backupFileAccept'
import {
  backupsForCurrentKey,
  currentKeyFingerprint,
  describeKeyBackup,
  KEY_BACKUP_COPY,
  KEY_BACKUPS_CHANGED,
  loadKeyBackups,
  syncKeyBackups,
  verifyBackupFile,
  type FileCheck,
  type KeyBackup,
} from '../lib/keyBackups'
import { checkKeyBackups, loadLastCheck, type BackupsCheck, type DriveCheck, type LastCheck } from '../lib/keyBackupCheck'
import { driveConfigured, readAccountBackup } from '../lib/drive'
import { readSavedFile } from '../lib/backupFileStore'

/**
 * Right after a backup (#348, owner rule 2026-10-20): where the key went, in plain words, and not
 * to delete it.
 */
export function KeyBackupSaved({ location, fileName }: { location: 'drive' | 'file'; fileName?: string }) {
  const where =
    location === 'drive'
      ? KEY_BACKUP_COPY.savedDrive
      : KEY_BACKUP_COPY.savedFile(fileName ?? 'a backup file', Capacitor.isNativePlatform())
  return (
    <div role="status" data-testid={`key-backup-saved-${location}`} className="mt-2 text-xs text-green-700 dark:text-green-500">
      <p>{where}</p>
      <p className="mt-1 font-medium">{KEY_BACKUP_COPY.keep}</p>
    </div>
  )
}

/** The locations known for this account, refreshed when one is recorded. */
export function useKeyBackups(pubkey: string): KeyBackup[] {
  const [list, setList] = useState(() => loadKeyBackups(pubkey))
  useEffect(() => {
    const refresh = () => setList(loadKeyBackups(pubkey))
    window.addEventListener(KEY_BACKUPS_CHANGED, refresh)
    // Every device's backups, from relay ∪ gateway. Best effort: offline shows this device's.
    void syncKeyBackups(pubkey).then((merged) => merged && setList(merged))
    return () => window.removeEventListener(KEY_BACKUPS_CHANGED, refresh)
  }, [pubkey])
  return list
}

/**
 * The same locations and reminder, compact, on the logout screen before confirming (#348).
 */
export function KeyBackupSummary({ pubkey }: { pubkey: string }) {
  const current = backupsForCurrentKey(useKeyBackups(pubkey), currentKeyFingerprint())
  if (current.length === 0) {
    return (
      <p className="mb-3 text-sm text-red-600 dark:text-red-400" data-testid="key-backup-summary">
        {KEY_BACKUP_COPY.none}
      </p>
    )
  }
  return (
    <div className="mb-3 text-sm text-mono-600 dark:text-mono-300" data-testid="key-backup-summary">
      <p>Your key is backed up here:</p>
      <ul className="mt-1 list-disc pl-5">
        {current.map((b) => (
          <li key={`${b.location}|${b.deviceId}`}>{describeKeyBackup(b)}</li>
        ))}
      </ul>
      <p className="mt-1 font-medium">{KEY_BACKUP_COPY.keep}</p>
    </div>
  )
}

const CHECK_COPY: Record<FileCheck, string> = {
  ok: KEY_BACKUP_COPY.checkOk,
  stale: KEY_BACKUP_COPY.checkStale,
  'other-account': KEY_BACKUP_COPY.checkOther,
  'not-a-backup': KEY_BACKUP_COPY.checkBad,
}

const DRIVE_COPY: Record<DriveCheck, string> = {
  ok: KEY_BACKUP_COPY.checkDriveOk,
  'old-key': KEY_BACKUP_COPY.checkDriveOld,
  gone: KEY_BACKUP_COPY.checkDriveGone,
  unreachable: KEY_BACKUP_COPY.checkDriveUnreachable,
  cancelled: KEY_BACKUP_COPY.checkDriveCancelled,
  'not-set-up': KEY_BACKUP_COPY.checkDriveNotSetUp,
}

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' })
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** One line per backup the check looked at, in the order the card lists them. */
function checkLines(result: BackupsCheck): { text: string; good: boolean }[] {
  if (result.none) return [{ text: KEY_BACKUP_COPY.checkNone, good: false }]
  const lines: { text: string; good: boolean }[] = []
  if (result.drive) lines.push({ text: DRIVE_COPY[result.drive], good: result.drive === 'ok' })
  for (const f of result.files) {
    const name = f.backup.fileName ?? 'Backup file'
    const r = f.result
    if (r.kind === 'ok') lines.push({ text: KEY_BACKUP_COPY.checkFileOk(name), good: true })
    else if (r.kind === 'gone') lines.push({ text: KEY_BACKUP_COPY.checkFileGone(name), good: false })
    else if (r.kind === 'mismatch') lines.push({ text: KEY_BACKUP_COPY.checkFileMismatch(name), good: false })
    else if (r.kind === 'unreadable') lines.push({ text: KEY_BACKUP_COPY.checkFileUnreadable(name), good: false })
    else if (r.current) lines.push({ text: KEY_BACKUP_COPY.checkFileCounts(name, day(r.countsUntil)), good: true })
    else lines.push({ text: KEY_BACKUP_COPY.checkFileExpired(name), good: false })
  }
  return lines
}

/**
 * Settings, "Your key backup": the last "Check my backups" and when it ran, nothing older. The check
 * looks at each backup of this key where it is, without asking where: that it is still there, and
 * that the key in it is this npub's. A file whose location this device never learnt (a browser
 * download) can be confirmed by picking it. Nothing here needs the passphrase.
 */
export function YourKeyBackup({ pubkey }: { pubkey: string }) {
  const all = useKeyBackups(pubkey)
  const current = backupsForCurrentKey(all, currentKeyFingerprint())
  const hasFile = current.some((b) => b.location === 'file')
  const input = useRef<HTMLInputElement>(null)
  const [check, setCheck] = useState<FileCheck | null>(null)
  const [result, setResult] = useState<LastCheck | null>(() => loadLastCheck(pubkey))
  const [checking, setChecking] = useState(false)

  const pick = async (file: File | undefined) => {
    if (!file) return
    setCheck(verifyBackupFile(pubkey, await file.text(), file.name))
  }

  const checkAll = async () => {
    setChecking(true)
    setCheck(null)
    try {
      await checkKeyBackups(pubkey, { readDrive: readAccountBackup, driveConfigured, readFile: readSavedFile })
      setResult(loadLastCheck(pubkey))
    } finally {
      setChecking(false)
    }
  }

  return (
    <ListSection title={KEY_BACKUP_COPY.title}>
      <div className="space-y-3 p-4" data-testid="your-key-backup">
        {current.length === 0 && <Alert>{KEY_BACKUP_COPY.none}</Alert>}
        <div data-testid="key-backup-check-result" role="status">
          <p className="text-xs text-mono-500">
            {result ? KEY_BACKUP_COPY.lastChecked(when(result.at)) : KEY_BACKUP_COPY.neverChecked}
          </p>
          {result && (
            <ul className="mt-1 space-y-1">
              {checkLines(result).map((l) => (
                <li key={l.text} className="flex items-center gap-2 text-sm text-mono-700 dark:text-mono-200">
                  {l.good ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" aria-label="OK" />
                  ) : (
                    <AlertCircle className="h-4 w-4 shrink-0 text-red-500" aria-label="Needs attention" />
                  )}
                  {l.text}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex gap-2">
          <a
            href="/settings/backup"
            className="flex-1 rounded-xl border border-mono-200 px-3 py-2 text-center text-sm font-medium text-mono-900 dark:border-mono-700 dark:text-mono-50"
          >
            {KEY_BACKUP_COPY.backUp}
          </a>
          <Button variant="secondary" className="flex-1" disabled={checking || current.length === 0} onClick={() => void checkAll()}>
            {checking ? KEY_BACKUP_COPY.checking : KEY_BACKUP_COPY.check}
          </Button>
        </div>
        {hasFile && (
          <>
            <button
              type="button"
              className="text-xs font-medium text-mono-600 underline underline-offset-2 dark:text-mono-300"
              onClick={() => input.current?.click()}
            >
              {KEY_BACKUP_COPY.pickFile}
            </button>
            <input
              ref={input}
              type="file"
              accept={backupFileAccept()}
              className="hidden"
              data-testid="key-backup-check-input"
              onChange={(e) => void pick(e.target.files?.[0])}
            />
          </>
        )}
        {check && (
          <p role="status" className={`text-xs ${check === 'ok' ? 'text-green-700 dark:text-green-500' : 'text-red-600 dark:text-red-400'}`}>
            {CHECK_COPY[check]}
          </p>
        )}
      </div>
    </ListSection>
  )
}
