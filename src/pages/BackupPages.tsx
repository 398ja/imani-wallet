import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Cloud, CloudDownload, Download } from 'lucide-react'

import { Screen, BackLink, PageHeader, Panel, Button, Input, Alert, Switch } from '../components/ui'
import { applyBackup, backupFilename, createBackup, parseBackup, type ParsedBackup } from '../lib/backup'
import { downloadText } from '../lib/download'
import { driveConfigured, getEscrow, putEscrow } from '../lib/drive'
import { createEscrow, installEscrow, nsecProtected, parseEscrow, type ParsedEscrow } from '../lib/escrow'
import { handleLabel } from '../lib/format'
import { keyStore } from '../lib/nap'
import { profileName, refreshProfile, type Profile } from '../lib/profile'

/**
 * Save a copy of the account.
 *
 * The file holds the same passphrase-encrypted key the browser holds, so it is
 * useless to anyone without the passphrase — which is what makes it a backup
 * rather than a second thing to keep secret.
 */
export function BackupPage({ profile }: { profile: Profile }) {
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const save = () => {
    setError(null)
    try {
      downloadText(backupFilename(profile), createBackup(profile.pubkey))
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader title="Backup" subtitle="Keep a copy of your account somewhere safe." />

      <Panel className="mb-4 p-4">
        <p className="text-sm text-mono-600 dark:text-mono-300">
          This file contains your key, encrypted with your passphrase, and your profile. You will
          need both the file and your passphrase to restore.
        </p>
        <Button className="mt-4 w-full" onClick={save}>
          <Download className="h-4 w-4" />
          <span className="ml-2">Download backup file</span>
        </Button>
        {done && <p className="mt-2 text-sm text-green-700 dark:text-green-500">Backup downloaded.</p>}
        {error && <Alert>{error}</Alert>}
      </Panel>

      <DriveEscrowPanel profile={profile} />

      <p className="text-sm text-mono-500">
        A backup file will not help if you forget your passphrase. For that you need your backup key,
        under{' '}
        <Link to="/settings/security" className="pressable underline hover:text-mono-900 dark:hover:text-mono-50">
          Security
        </Link>
        .
      </p>
    </Screen>
  )
}

/**
 * Escrow the account to the customer's own Google Drive.
 *
 * The recovery path every competitor has and this wallet did not. It costs no
 * self-custody: the file goes to a hidden folder in storage the customer owns,
 * it is fetched browser-to-Google, and no Imani server ever sees a key. "There
 * is no honeypot" stays literally true.
 *
 * The switch is the fork the product had to settle. Left on, the escrowed key
 * carries nap's passphrase envelope untouched and the passphrase is still
 * needed to restore — safest, but a forgotten passphrase is still a lost
 * account. Turned off, the key travels as hex and the customer's Google account
 * is the only gate: no unrecoverable secret anywhere, at the price of trusting
 * Google as the recovery factor. Both are defensible, so the customer picks,
 * and the default is the safe one.
 *
 * Either way the passphrase is typed here, because reading the key out of the
 * keystore requires it — the same gate as revealing the backup key.
 */
function DriveEscrowPanel({ profile }: { profile: Profile }) {
  const [passphrase, setPassphrase] = useState('')
  const [protect, setProtect] = useState(true)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!driveConfigured()) return null

  const escrow = async () => {
    setBusy(true)
    setError(null)
    setDone(false)
    try {
      // Verified before anything is uploaded, in both branches. A wrong
      // passphrase would otherwise escrow an envelope the customer cannot open,
      // and they would find out on the far side with nothing else left.
      const privkeyHex = await keyStore.loadKey(passphrase)
      await putEscrow(createEscrow(profile.pubkey, protect ? undefined : privkeyHex))
      setDone(true)
      setPassphrase('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel className="mb-4 p-4">
      <p className="text-sm text-mono-600 dark:text-mono-300">
        Put a copy in your own Google Drive, in a hidden folder only this app can see. It never
        touches an Imani server, and you can delete it from Drive at any time.
      </p>

      <div className="mt-4">
        <Switch
          label="Ask for my passphrase to restore"
          hint={
            protect
              ? 'Safest. You will need this passphrase on the new device.'
              : 'Signing in to Google is then enough to get your account back.'
          }
          checked={protect}
          onChange={setProtect}
          disabled={busy}
        />
      </div>

      <Input
        className="mt-3"
        type="password"
        placeholder="Your passphrase"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        autoComplete="current-password"
      />

      <Button className="mt-3 w-full" disabled={busy || passphrase === ''} onClick={() => void escrow()}>
        <Cloud className="h-4 w-4" />
        <span className="ml-2">{busy ? 'Backing up…' : 'Back up to Google Drive'}</span>
      </Button>

      {done && (
        <p className="mt-2 text-sm text-green-700 dark:text-green-500">
          Saved to your Google Drive.
        </p>
      )}
      {error && <Alert>{error}</Alert>}
    </Panel>
  )
}

/**
 * Restore from the customer's own Google Drive.
 *
 * The order of the screen is the order the customer needs: sign in, then be
 * TOLD whose account this is before being asked for anything. The npub and the
 * profile ride in the clear precisely so this step can happen — someone who has
 * lost a phone should not have to recognise a passphrase prompt to find out
 * whether they are even looking at the right account.
 *
 * The passphrase field appears only when the escrowed key is protected. When it
 * is not, the field asks for a NEW passphrase for this device instead: the copy
 * in Drive is the recovery path, so a device passphrase is no longer a secret
 * that can be lost.
 */
function DriveRestorePanel({ onUnlock }: { onUnlock: (privkeyHex: string) => Promise<void> }) {
  const [escrow, setEscrow] = useState<ParsedEscrow | null>(null)
  const [name, setName] = useState<string | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  // The escrowed profile is a snapshot from whenever the backup was written, so
  // the relay is asked for a fresher one. Best-effort: a customer standing in a
  // shop with no signal must still be able to restore, and the npub below is
  // identification enough on its own.
  useEffect(() => {
    if (!escrow) return
    let live = true
    void refreshProfile(escrow.pubkey)
      .then((p) => live && setName(profileName(p)))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [escrow])

  if (!driveConfigured()) return null

  const fetchEscrow = async () => {
    setBusy(true)
    setError(null)
    try {
      const text = await getEscrow()
      if (text === null) {
        setError('That Google account has no wallet backup in it.')
        return
      }
      const parsed = parseEscrow(text)
      setEscrow(parsed)
      setName(parsed.profile ? profileName(parsed.profile) : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const restore = async () => {
    if (!escrow) return
    setBusy(true)
    setError(null)
    try {
      await onUnlock(await installEscrow(escrow, passphrase))
      navigate('/', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const protectedKey = escrow !== null && nsecProtected(escrow.nsec)

  return (
    <>
      {!escrow && (
        <Button size="lg" className="w-full" disabled={busy} onClick={() => void fetchEscrow()}>
          <CloudDownload className="h-4 w-4" />
          <span className="ml-2">{busy ? 'Checking Google Drive…' : 'Restore from Google Drive'}</span>
        </Button>
      )}

      {escrow && (
        <Panel className="p-4">
          <p className="text-sm text-mono-500">This backup holds the account</p>
          <p className="mt-1 font-medium text-mono-900 dark:text-mono-50">
            {name ?? 'Unnamed account'}
          </p>
          {/* Shown in full, not truncated. It is the only thing on this screen
              that cannot be faked by whoever wrote the file, and it is what a
              customer with two accounts checks before overwriting one. */}
          <p className="mt-1 break-all font-mono text-xs text-mono-500">{escrow.npub}</p>

          <p className="mt-3 text-sm text-mono-600 dark:text-mono-300">
            {protectedKey
              ? 'Enter the passphrase this backup was made with.'
              : 'Choose a passphrase for this device. It protects the key here only — your Drive backup will still get you back in if you forget it.'}
          </p>

          <Input
            className="mt-2"
            type="password"
            placeholder={protectedKey ? 'Passphrase' : 'Choose a passphrase'}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete={protectedKey ? 'current-password' : 'new-password'}
            autoFocus
          />

          <Button
            size="lg"
            className="mt-3 w-full"
            disabled={busy || passphrase === ''}
            onClick={() => void restore()}
          >
            {busy ? 'Restoring…' : 'Restore this account'}
          </Button>

          {error && <Alert>{error}</Alert>}
        </Panel>
      )}

      {!escrow && error && <Alert>{error}</Alert>}
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
