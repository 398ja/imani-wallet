import { useState } from 'react'

import { Screen, BackLink, PageHeader, ListSection, Button, Input, Alert } from '../components/ui'
import { keyStore } from '../lib/nap'
import { useDriveBackup } from '../lib/useDriveBackup'
import { listBackups } from '../lib/drive'
import { loadBackupRecord, recordBackup } from '../lib/backupRecord'
import { backupFilename, createBackup } from '../lib/backup'
import { downloadText } from '../lib/download'
import { loadProfile } from '../lib/profile'
import { legacyApi } from '../lib/legacyBridge'
import { decommissionTerminal, DECOMMISSION_COPY } from '../lib/terminalDecommission'
import type { CredentialMintApi } from '../lib/credentialRevocation'
import { userMessage } from '../lib/userMessage'
import { ConnectedSites } from '../components/ConnectedSites'
import { DriveOverwriteWarning } from '../components/DriveOverwriteWarning'
import {
  passphraseStrength,
  validateConfirmation,
  validatePassphrase,
  type Strength,
} from '../lib/validate'

/**
 * Security: change the passphrase, get the key out, leave.
 *
 * Both operations run entirely in the browser. The passphrase never reaches a
 * server — it only ever decrypts a local blob — which is also why there is no
 * "forgot passphrase" link anywhere in this app. Nothing on the other end could
 * answer it.
 */
export function SecurityPage({
  onLogout,
  terminal,
  pubkey,
}: {
  onLogout: () => void
  /** This device's own key, for the wallet wipe when decommissioning. */
  pubkey: string
  /**
   * True when this device is a terminal.
   *
   * A terminal gets a different danger zone entirely — not different wording
   * on the same button. Its holder has no backup key, no account and no sales
   * of their own, so the passphrase and key-reveal panels are meaningless to
   * them and the logout copy would be actively misleading.
   */
  terminal?: boolean
}) {
  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader title="Security" />

      {/* Both are about a personal key: changing the passphrase that encrypts
          it, and reading it back. A terminal's key is a disposable the owner
          issued authority against — never something its holder should write
          down — so neither panel belongs on one. */}
      {!terminal && (
        <>
          <ChangePassphrase pubkey={pubkey} />
          <ConnectedSites pubkey={pubkey} />
          </>
      )}

      <ListSection title="Danger zone">
        {terminal ? <DecommissionPanel pubkey={pubkey} /> : (
          <div className="p-4">
            <p className="mb-3 text-sm text-mono-500">
              Logging out erases your key from this browser. Make sure you have your backup key first.
            </p>
            <Button variant="outline" className="w-full !text-red-600 dark:!text-red-400" onClick={onLogout}>
              Log out
            </Button>
          </div>
        )}
      </ListSection>
    </Screen>
  )
}

/**
 * Taking a terminal out of service, from the device.
 *
 * Terminals ticket 08. Deliberately NOT the logout button with new words: the
 * operation is different (it hands authority back before erasing) and so is
 * everything it can honestly promise.
 *
 * The confirmation is the terminal's own copy. `decommissionTerminal` never
 * asks — `logout`'s prompt promises a backup key its holder does not have, so
 * this screen is the only thing that may do the asking.
 */
function DecommissionPanel({ pubkey }: { pubkey: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)

  return (
    <div className="p-4">
      <p className="mb-3 text-sm text-mono-500">{DECOMMISSION_COPY.body}</p>

      {error ? (
        // Says what did NOT happen. A holder who believes the device is clean
        // and is wrong has a live key in their pocket.
        <Alert>{error}</Alert>
      ) : null}

      {asking ? (
        <div className="expand-row mt-3 rounded-xl bg-amber-50 p-3 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
          <p className="text-sm">{DECOMMISSION_COPY.confirmBody}</p>
          <div className="mt-3 flex gap-2">
            {/* Keeping it first and plain, as everywhere else in this app: the
                destructive option should never be where a thumb lands. */}
            <Button variant="outline" size="sm" onClick={() => setAsking(false)} disabled={busy}>
              Keep it in service
            </Button>
            <Button
              size="sm"
              className="!bg-red-600 !text-white hover:!bg-red-700"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                setError(null)
                void (async () => {
                  // The same client `burn.ts` spends through, because this IS
                  // a spend — reusing it means one place decides how a proof
                  // reaches the mint.
                  const api = (await legacyApi()) as unknown as CredentialMintApi
                  const out = await decommissionTerminal(api, pubkey)
                  if (!out.done) {
                    setError(out.message)
                    setBusy(false)
                    setAsking(false)
                  }
                  // On success `decommissionTerminal` navigates away, so there
                  // is nothing to reset — the component is gone.
                })()
              }}
            >
              {busy ? 'Handing back…' : DECOMMISSION_COPY.confirm}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          className="w-full !text-red-600 dark:!text-red-400"
          onClick={() => setAsking(true)}
        >
          {DECOMMISSION_COPY.title}
        </Button>
      )}
    </div>
  )
}

/**
 * Rotate the passphrase — and the copies encrypted with the old one.
 *
 * The rotation itself is two calls to nap: decrypt with the old, re-encrypt
 * with the new. What is easy to miss is that it only re-encrypts the record in
 * THIS browser. Every copy made earlier still carries the previous envelope, so
 * a Drive backup taken before the change goes on opening with the passphrase
 * the customer believes they have just replaced — and they find that out on a
 * new phone, holding a passphrase that does not work, with no way to tell
 * whether they misremembered it or the wallet lied.
 *
 * So a Drive copy is rewritten as part of the change, not left to the
 * customer to remember, but only when this account HAS a Drive backup
 * (backupRecord.ts), or, with nothing recorded (a backup made before records
 * existed), when `listBackups` finds this account's file there. Writing one it never made would create a backup the
 * person did not ask for, behind an account chooser they did not expect. Google will show its account chooser, which cannot be
 * suppressed, so this is not silent; what it must not be is skipped. If it
 * fails or is cancelled the passphrase change still stands — it already
 * succeeded locally — and the message says exactly which copy is now stale
 * rather than reporting a failure that did not happen.
 *
 * A file downloaded earlier is stale in the same way and cannot be reached, so
 * the person is offered a new file right there. A file record that is missing
 * cannot be checked, so then the line is neutral ("If you saved...").
 */
function ChangePassphrase({ pubkey }: { pubkey: string }) {
  const drive = useDriveBackup(pubkey)
  // Read once per render: a backup made elsewhere in the app is in storage by the time this shows.
  const record = loadBackupRecord(pubkey)
  const hasDrive = record.drive !== undefined
  const [fileStale, setFileStale] = useState(false)
  const [fileKnown, setFileKnown] = useState(false)
  const [driveUnchecked, setDriveUnchecked] = useState(false)
  const [fileSaved, setFileSaved] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nextError = next === '' ? undefined : validatePassphrase(next)
  const confirmError = confirm === '' ? undefined : validateConfirmation(next, confirm)
  const complete = current !== '' && next !== '' && confirm !== '' && !nextError && !confirmError

  const change = async () => {
    setBusy(true)
    setError(null)
    setDone(false)
    setFileStale(false)
    setFileSaved(false)
    setFileError(null)
    // Decided before the change: what existed then is what is now stale.
    let rewriteDrive = drive.configured && hasDrive
    const hadFile = record.file !== undefined
    setDriveUnchecked(false)
    try {
      // Decrypt with the old, re-encrypt with the new. nap owns the crypto —
      // this is not a second key-handling implementation, it is two calls to the
      // one that already exists. A wrong current passphrase throws here, before
      // anything is overwritten.
      const hex = await keyStore.loadKey(current)
      await keyStore.save(hex, next)
      setDone(true)
      setCurrent('')
      setNext('')
      setConfirm('')
      setFileStale(true)
      setFileKnown(hadFile)

      // No Drive record (e.g. backed up before records existed): ask Drive
      // rather than assume. Rewrite only a file that is already there; never
      // create one the person did not make.
      if (drive.configured && !hasDrive) {
        try {
          const found = await listBackups()
          if (found.some((b) => !b.revisionId && b.pubkey === pubkey)) {
            recordBackup(pubkey, 'drive')
            rewriteDrive = true
          }
        } catch {
          setDriveUnchecked(true)
        }
      }

      // After the local record, never before it: a Drive write that succeeded
      // against a rotation that then failed would leave Drive holding a
      // passphrase this device does not have.
      //
      // Not wrapped in its own try/catch — `save` reports through `drive.error`
      // rather than throwing, and a catch here would be dead code that reads
      // like a safety net. The rotation has already succeeded either way, so a
      // Drive failure must not reach the outer catch and be reported as one.
      if (rewriteDrive) await drive.save()
    } catch (e) {
      setError(userMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const saveFile = async () => {
    setFileError(null)
    try {
      await downloadText(backupFilename(loadProfile(pubkey)), createBackup(pubkey))
      recordBackup(pubkey, 'file')
      setFileSaved(true)
    } catch (e) {
      setFileError(userMessage(e))
    }
  }

  return (
    <ListSection title="Passphrase">
      <div className="space-y-3 p-4">
        {/* #559: the change below rewrites this account's Google Drive copy too. */}
        {drive.configured && hasDrive && (
          <>
            <p className="text-xs text-mono-500">Changing your passphrase also updates your Google Drive backup.</p>
            <DriveOverwriteWarning />
          </>
        )}
        <Input
          type="password"
          placeholder="Current passphrase"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
        />
        <div>
          <Input
            type="password"
            placeholder="New passphrase"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
          />
          {next !== '' && <StrengthBar strength={passphraseStrength(next)} />}
          {nextError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{nextError}</p>}
        </div>
        <div>
          <Input
            type="password"
            placeholder="Confirm new passphrase"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
          {confirmError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{confirmError}</p>}
        </div>
        <Button className="w-full" disabled={busy || !complete} onClick={() => void change()}>
          {busy ? 'Changing…' : 'Change passphrase'}
        </Button>
        {done && (
          <>
            <p className="text-sm text-green-700 dark:text-green-500">
              Passphrase changed.
              {drive.configured && drive.done && ' Your Google Drive backup was updated too.'}
            </p>
            {drive.error && (
              <Alert>
                Your passphrase changed, but the copy in Google Drive still opens with the old one.
                Back up again under Settings → Backup.
              </Alert>
            )}
            {driveUnchecked && (
              <Alert>We could not check Google Drive. If you backed up there, back up again under Settings &gt; Backup.</Alert>
            )}
            {fileStale && (
              <div className="space-y-2">
                <p className="text-xs text-mono-500">
                  {fileSaved
                    ? 'New backup file saved. It opens with your new passphrase.'
                    : fileKnown
                      ? 'Your backup file still opens with your old passphrase.'
                      : 'If you saved a backup file before, it still opens with your old passphrase.'}
                </p>
                {!fileSaved && (
                  <Button variant="secondary" className="w-full" onClick={() => void saveFile()}>
                    Save new backup file
                  </Button>
                )}
                {fileError && <Alert>{fileError}</Alert>}
              </div>
            )}
          </>
        )}
        {error && <Alert>{error}</Alert>}
      </div>
    </ListSection>
  )
}

const STRENGTH_STYLE: Record<Strength, { width: string; className: string }> = {
  weak: { width: '25%', className: 'bg-red-500' },
  fair: { width: '50%', className: 'bg-orange-500' },
  good: { width: '75%', className: 'bg-yellow-500' },
  strong: { width: '100%', className: 'bg-green-600' },
}

function StrengthBar({ strength }: { strength: Strength }) {
  const { width, className } = STRENGTH_STYLE[strength]
  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-mono-200 dark:bg-mono-800">
        <div
          className={`h-full transition-all duration-200 ease-out motion-reduce:transition-none ${className}`}
          style={{ width }}
        />
      </div>
      <span className="text-xs capitalize text-mono-500">{strength}</span>
    </div>
  )
}
