import { useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { Cloud, FileText } from 'lucide-react'

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

/**
 * Settings, "Your key backup": every known backup of this key across devices, where it is, and the
 * reminder. A file can be re-checked by picking it. Nothing here needs the passphrase.
 */
export function YourKeyBackup({ pubkey }: { pubkey: string }) {
  const all = useKeyBackups(pubkey)
  const current = backupsForCurrentKey(all, currentKeyFingerprint())
  const stale = all.length > current.length
  const input = useRef<HTMLInputElement>(null)
  const [check, setCheck] = useState<FileCheck | null>(null)

  const pick = async (file: File | undefined) => {
    if (!file) return
    setCheck(verifyBackupFile(pubkey, await file.text(), file.name))
  }

  return (
    <ListSection title={KEY_BACKUP_COPY.title}>
      <div className="space-y-3 p-4" data-testid="your-key-backup">
        {current.length === 0 ? (
          <Alert>{KEY_BACKUP_COPY.none}</Alert>
        ) : (
          <>
            <ul className="space-y-2">
              {current.map((b) => (
                <li key={`${b.location}|${b.deviceId}`} className="flex gap-2 text-sm text-mono-700 dark:text-mono-200">
                  {b.location === 'drive' ? (
                    <Cloud className="mt-0.5 h-4 w-4 shrink-0 text-mono-400" aria-hidden />
                  ) : (
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-mono-400" aria-hidden />
                  )}
                  <span>
                    {describeKeyBackup(b)}
                    <span className="block text-xs text-mono-500">
                      {b.lastVerifiedAt ? 'Checked' : 'Saved'}{' '}
                      {new Date(b.lastVerifiedAt ?? b.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs font-medium text-mono-700 dark:text-mono-200">{KEY_BACKUP_COPY.keep}</p>
          </>
        )}
        {stale && <p className="text-xs text-mono-500">{KEY_BACKUP_COPY.stale}</p>}
        <div className="flex gap-2">
          <a
            href="/settings/backup"
            className="flex-1 rounded-xl border border-mono-200 px-3 py-2 text-center text-sm font-medium text-mono-900 dark:border-mono-700 dark:text-mono-50"
          >
            {KEY_BACKUP_COPY.backUp}
          </a>
          <Button variant="secondary" className="flex-1" onClick={() => input.current?.click()}>
            {KEY_BACKUP_COPY.check}
          </Button>
          <input
            ref={input}
            type="file"
            accept={backupFileAccept()}
            className="hidden"
            data-testid="key-backup-check-input"
            onChange={(e) => void pick(e.target.files?.[0])}
          />
        </div>
        {check && (
          <p role="status" className={`text-xs ${check === 'ok' ? 'text-green-700 dark:text-green-500' : 'text-red-600 dark:text-red-400'}`}>
            {CHECK_COPY[check]}
          </p>
        )}
      </div>
    </ListSection>
  )
}
