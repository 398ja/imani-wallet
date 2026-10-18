import { useEffect, useRef, useState } from 'react'
import { nip19 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'
import { Link, useNavigate } from 'react-router-dom'
import { Check, Cloud, CloudDownload, Copy, Download } from 'lucide-react'

import { Screen, BackLink, PageHeader, Panel, Button, Input, Alert, IdentityInline } from '../components/ui'
import { applyBackup, backupFilename, createBackup, parseBackup, type ParsedBackup } from '../lib/backup'
import { downloadText } from '../lib/download'
import { getBackup } from '../lib/drive'
import { useDriveBackup } from '../lib/useDriveBackup'
import { handleLabel } from '../lib/format'
import { keyStore } from '../lib/nap'
import { refreshProfile, type Profile } from '../lib/profile'

/**
 * Save a copy of the account.
 *
 * The file holds the same passphrase-encrypted key the browser holds, so it is
 * useless to anyone without the passphrase — which is what makes it a backup
 * rather than a second thing to keep secret.
 */
export function BackupPage({ profile, terminal }: { profile: Profile; terminal?: boolean }) {
  const drive = useDriveBackup(profile.pubkey)
  const [passphrase, setPassphrase] = useState('')
  const [nsec, setNsec] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const download = () => {
    setError(null)
    try {
      downloadText(backupFilename(profile), createBackup(profile.pubkey))
      setDownloaded(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const reveal = async () => {
    setBusy(true)
    setError(null)
    try {
      const hex = await keyStore.loadKey(passphrase)
      setNsec(nip19.nsecEncode(hexToBytes(hex)))
      setPassphrase('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!nsec) return
    try {
      await navigator.clipboard.writeText(nsec)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be refused — insecure context, denied permission.
      // Silently doing nothing would leave the user believing their only backup
      // key is on the clipboard when it is not. The key is already on screen
      // here, so say so and let them select it.
      setError('Could not copy. Select the key above and copy it manually.')
    }
  }

  // A terminal holds a disposable credential the stall owner issued authority
  // against, not an account key its holder should ever write down. Offering one
  // the reveal would send them hunting for a backup key that was never theirs —
  // the rule Security has always applied, carried over with the panel rather
  // than left behind on the screen it came from.
  const canReveal = !terminal

  const buttons = (canReveal && nsec ? 1 : 0) + 2

  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader title="Backup" subtitle="Keep a copy of your account somewhere safe." />

      <Panel className="mb-4 p-4">
        <p className="text-sm text-mono-600 dark:text-mono-300">
          The file holds your key, encrypted with your passphrase, and your profile — you need both
          it and the passphrase to restore.
          {canReveal && ' Your backup key is the key itself, and needs nothing else.'}
        </p>

        {canReveal && nsec && (
          <Panel className="mt-3 break-all bg-mono-100 p-3 font-mono text-xs text-mono-900 dark:bg-mono-800 dark:text-mono-50">
            {nsec}
          </Panel>
        )}

        {/* Same shape as the screen after onboarding: one row, one decision.
            Copy is the only one that needs the passphrase, so it joins the row
            once the key is out rather than sitting there disabled. */}
        <div className={`mt-3 grid gap-2 ${buttons === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
          {canReveal && nsec && (
            <Button variant="secondary" className="flex-col px-2 py-2 text-xs" onClick={() => void copy()}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              <span className="mt-1">{copied ? 'Copied' : 'Copy key'}</span>
            </Button>
          )}

          <Button variant="secondary" className="flex-col px-2 py-2 text-xs" onClick={download}>
            <Download className="h-4 w-4" />
            <span className="mt-1">{downloaded ? 'Saved' : 'Download file'}</span>
          </Button>

          <Button
            variant="secondary"
            className="flex-col px-2 py-2 text-xs"
            disabled={drive.busy}
            onClick={() => void drive.save()}
          >
            <Cloud className="h-4 w-4" />
            <span className="mt-1">{drive.busy ? 'Saving…' : 'Google Drive'}</span>
          </Button>
        </div>

        {drive.done && (
          <p className="mt-2 text-sm text-green-700 dark:text-green-500">Saved to your Google Drive.</p>
        )}

        {canReveal && nsec && (
          <Button variant="ghost" className="mt-2 w-full" onClick={() => setNsec(null)}>
            Hide key
          </Button>
        )}

        {/* Re-asking for the passphrase is not ceremony: an unlocked wallet left
            open on a market stall would otherwise hand its key to anyone who
            opens this screen. The file and the Drive copy need no such gate —
            both are encrypted before they go anywhere. */}
        {canReveal && !nsec && (
          <div className="mt-4 border-t border-mono-200 pt-4 dark:border-mono-800">
            <p className="text-sm text-mono-500">
              Anyone with your backup key controls your account and your vouchers. Only show it
              somewhere private.
            </p>
            <Input
              className="mt-2"
              type="password"
              placeholder="Passphrase"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="current-password"
            />
            <Button
              variant="secondary"
              className="mt-2 w-full"
              disabled={busy || !passphrase}
              onClick={() => void reveal()}
            >
              {busy ? 'Checking…' : 'Show my backup key'}
            </Button>
          </div>
        )}

        {/* Both, because they fail independently: a Drive refusal must not be
            swallowed just because the local download went fine. `drive.save`
            reports through its own state rather than throwing, so this is the
            only place its message can surface. */}
        {(error ?? drive.error) && <Alert>{error ?? drive.error}</Alert>}
      </Panel>
    </Screen>
  )
}

/** The backup's account as a hex pubkey: from the verified npub, else the profile. */
function backupPubkey(backup: ParsedBackup): string | null {
  if (backup.npub) {
    try {
      const decoded = nip19.decode(backup.npub)
      if (decoded.type === 'npub') return decoded.data
    } catch {
      // parseBackup already rejected a bad npub; fall through to the profile.
    }
  }
  return backup.profile?.pubkey ?? null
}

/**
 * Whose account a backup holds, as the app shows a person everywhere else:
 * avatar, name, NIP-05 — not a 63-character npub.
 *
 * Built from the profile stored IN the backup, so it names the account with no
 * signal at all; a fresher relay answer replaces it when one lands. Not a link:
 * leaving this screen would throw away the restore in progress.
 *
 * No key on this screen, not even behind a tap: customers should not meet
 * protocol terms or raw keys. Two accounts are told apart by face, name and
 * handle, and a backup with no profile falls back to the component's short form.
 */
function BackupAccount({ backup, refreshedName }: { backup: ParsedBackup; refreshedName: string | null }) {
  const pubkey = backupPubkey(backup)
  const stored = backup.profile
  if (!pubkey) {
    return <p className="mt-1 font-medium text-mono-900 dark:text-mono-50">Unnamed account</p>
  }
  return (
    <div className="mt-2">
      <IdentityInline
        pubkey={pubkey}
        size="md"
        linkToProfile={false}
        fallbackName={refreshedName ?? stored?.displayName}
        fallbackHandle={stored?.nip05}
        fallbackPicture={stored?.picture}
      />
    </div>
  )
}

/**
 * Restore from the customer's own Google Drive.
 *
 * The order of the screen is the order the customer needs: sign in, then be
 * TOLD whose account this is before being asked for anything. The public
 * profile rides in the clear precisely so this step can happen — someone who has lost a phone
 * should not have to recognise an account by whether a passphrase prompt
 * accepts their typing.
 *
 * The passphrase is then required, exactly as it is for a file off disk. Drive
 * is where the file lives, never what protects it: an attacker with the
 * customer's Google account gets an encrypted envelope and nothing else.
 */
function DriveRestorePanel({ onUnlock }: { onUnlock: (privkeyHex: string) => Promise<void> }) {
  const [parsed, setParsed] = useState<ParsedBackup | null>(null)
  const [name, setName] = useState<string | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  // The stored profile is a snapshot from whenever the backup was written, so
  // the relay is asked for a fresher one. Best-effort: a customer standing in a
  // shop with no signal must still be able to restore, and the
  // stored profile identifies the account on its own.
  useEffect(() => {
    const pubkey = parsed?.profile?.pubkey
    if (!pubkey) return
    let live = true
    void refreshProfile(pubkey)
      .then((p) => live && setName(p.displayName ?? null))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [parsed])

  const fetchBackup = async () => {
    setBusy(true)
    setError(null)
    try {
      const text = await getBackup()
      if (text === null) {
        setError('That Google account has no wallet backup in it.')
        return
      }
      const backup = parseBackup(text)
      setParsed(backup)
      setName(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const restore = async () => {
    if (!parsed) return
    setBusy(true)
    setError(null)
    try {
      const { privkeyHex } = await applyBackup(parsed, () => keyStore.loadKey(passphrase))
      await onUnlock(privkeyHex)
      navigate('/', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {!parsed && (
        <Button size="lg" className="w-full" disabled={busy} onClick={() => void fetchBackup()}>
          <CloudDownload className="h-4 w-4" />
          <span className="ml-2">{busy ? 'Checking Google Drive…' : 'Restore from Google Drive'}</span>
        </Button>
      )}

      {parsed && (
        <Panel className="p-4">
          <p className="text-sm text-mono-500">This backup holds the account</p>
          <BackupAccount backup={parsed} refreshedName={name} />

          <p className="mt-3 text-sm text-mono-600 dark:text-mono-300">
            Enter the passphrase for this account.
          </p>

          <Input
            className="mt-2"
            type="password"
            placeholder="Passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="current-password"
            autoFocus
          />

          <Button
            size="lg"
            className="mt-3 w-full"
            disabled={busy || !passphrase}
            onClick={() => void restore()}
          >
            {busy ? 'Restoring…' : 'Restore this account'}
          </Button>

          {error && <Alert>{error}</Alert>}
        </Panel>
      )}

      {!parsed && error && <Alert>{error}</Alert>}
    </>
  )
}

/**
 * Restore from a backup file.
 *
 * Public: reached from the login screen by someone who has no key in this
 * browser yet. Restoring writes the encrypted key back and then still asks for
 * the passphrase — the file on its own must not be enough to get in.
 */
export function RestorePage({ onUnlock }: { onUnlock: (privkeyHex: string) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<ParsedBackup | null>(null)
  const [loaded, setLoaded] = useState<string | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  // Parsing only. Choosing a file must not touch the key this browser already
  // holds — /restore is linked from the login screen, so there usually is one,
  // and picking the wrong file would otherwise destroy it before anyone had
  // typed a passphrase.
  const pick = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    try {
      const backup = parseBackup(await file.text())
      setParsed(backup)
      const nip05 = backup.profile?.nip05
      setLoaded((nip05 && handleLabel(nip05)) ?? backup.profile?.displayName ?? file.name)
    } catch (e) {
      setParsed(null)
      setLoaded(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const unlock = async () => {
    if (!parsed) return
    setBusy(true)
    setError(null)
    try {
      // applyBackup installs the key, verifies it with this passphrase, and
      // rolls back to the previous record if the passphrase does not open it.
      const { privkeyHex } = await applyBackup(parsed, () => keyStore.loadKey(passphrase))
      await onUnlock(privkeyHex)
      navigate('/', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-5 p-6">
      <PageHeader title="Restore" subtitle="Get your account back on this device." />

      <DriveRestorePanel onUnlock={onUnlock} />

      <p className="text-sm text-mono-500">Or open a backup file from another browser or device.</p>

      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        onChange={(e) => void pick(e.target.files?.[0])}
        className="block w-full text-sm text-mono-500 file:mr-3 file:rounded-xl file:border-0 file:bg-mono-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-mono-900 dark:file:bg-mono-800 dark:file:text-mono-50"
      />

      {loaded && (
        <>
          {parsed && (backupPubkey(parsed) || parsed.profile) ? (
            <Panel className="p-4">
              <p className="text-sm text-mono-500">This backup holds the account</p>
              <BackupAccount backup={parsed} refreshedName={null} />
            </Panel>
          ) : null}
          <p className="text-sm text-mono-500">
            Loaded <span className="font-medium text-mono-900 dark:text-mono-50">{loaded}</span>.
            Enter the passphrase for this backup.
          </p>
          <Input
            type="password"
            placeholder="Passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="current-password"
            autoFocus
          />
          <Button
            size="lg"
            className="w-full"
            disabled={busy || !passphrase}
            onClick={() => void unlock()}
          >
            {busy ? 'Restoring…' : 'Restore and unlock'}
          </Button>
        </>
      )}

      {error && <Alert>{error}</Alert>}

      <p className="text-center text-sm text-mono-500">
        <Link to="/onboarding" className="pressable underline hover:text-mono-900 dark:hover:text-mono-50">
          Back
        </Link>
      </p>
    </div>
  )
}
