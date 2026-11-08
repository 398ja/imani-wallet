import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getPublicKey, nip19 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'
import { ChevronRight, CloudDownload, FileText, Loader2 } from 'lucide-react'

import { Alert, Button, IdentityInline, Input, Panel } from './ui'
import { applyBackup, parseBackup, type ParsedBackup } from '../lib/backup'
import { recordBackup } from '../lib/backupRecord'
import { refuseIfAnotherWallet } from '../lib/keySlotGuard'
import { userMessage } from '../lib/userMessage'
import { listBackups, type DriveBackup } from '../lib/drive'
import { backupFileAccept } from '../lib/backupFileAccept'
import { keyStore } from '../lib/nap'
import { claimProfile, ProfileMissingError, rememberHandle, requireProfile } from '../lib/profileGate'
import { FinishProfileStep } from './FinishProfileStep'

/**
 * Logging in on a device that holds no key: open your backup, see whose
 * account it is, type the passphrase (#325).
 *
 * This replaced two screens that did the same job. The onboarding "Log in"
 * step asked for the raw key and a NEW passphrase, and `/restore` opened a
 * backup file or the Google Drive copy. Most people only ever made a backup,
 * so the backup is the way in, and pasting the key is a small secondary link.
 *
 * Three moments, in the order the customer needs them:
 *   1. where the backup is (Google Drive or a file, offered as equals);
 *   2. whose account it holds, by face, name and handle, with no key shown;
 *   3. the passphrase, then in.
 *
 * Nothing here is new crypto. `parseBackup` validates without writing,
 * `applyBackup` installs the key only if the passphrase opens it and rolls
 * back otherwise, and `listBackups` is the Drive read the Settings side writes.
 * Drive holds one file per account (#559), so Drive always asks which account
 * first, even when there is only one: the customer sees whose key comes back.
 * Choosing a backup touches nothing on the device: only a passphrase that
 * opens it does.
 */
export function BackupLogin({
  onUnlock,
  onBack,
  onUseKey,
}: {
  onUnlock: (privkeyHex: string) => Promise<void>
  onBack: () => void
  /** The paste-a-key path, for someone who only ever saved the key itself. */
  onUseKey: () => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<ParsedBackup | null>(null)
  const [source, setSource] = useState<'drive' | 'file' | null>(null)
  const [found, setFound] = useState<DriveBackup[] | null>(null)
  const [loading, setLoading] = useState<'drive' | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  // The key opened but its account has no profile: held only in memory, and
  // only until a handle is claimed or the customer goes back.
  const [missing, setMissing] = useState<string | null>(null)
  const navigate = useNavigate()

  const fromDrive = async () => {
    setLoading('drive')
    setProblem(null)
    try {
      const backups = await listBackups()
      if (backups.length === 0) {
        setProblem('That Google account has no wallet backup. Try another Google account, or a backup file.')
        return
      }
      setFound(backups)
    } catch (e) {
      setProblem(userMessage(e))
    } finally {
      setLoading(null)
    }
  }

  const fromFile = async (file: File | undefined) => {
    setProblem(null)
    if (!file) {
      // A change event with no file means the picker came back empty handed
      // (on Android, Capacitor reports a failed picker as no files). Say so
      // rather than leave the screen unchanged.
      setProblem('No file was opened. Try again, or choose another way in.')
      return
    }
    try {
      setParsed(parseBackup(await file.text()))
      setSource('file')
    } catch (e) {
      // parseBackup's own sentences ("That file is not a wallet backup.") are
      // already the plain answer, so they are shown as they are.
      setProblem(userMessage(e))
    } finally {
      // Let the same file be picked again after a fix, or after "Choose another".
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const pickDrive = (backup: DriveBackup) => {
    setProblem(null)
    try {
      setParsed(parseBackup(backup.text))
      setSource('drive')
    } catch (e) {
      setProblem(userMessage(e))
    }
  }

  const chooseAgain = () => {
    setParsed(null)
    setFound(null)
    setSource(null)
    setProblem(null)
    setMissing(null)
  }

  if (parsed && missing) {
    return (
      <FinishProfileStep
        onCancel={() => setMissing(null)}
        onClaim={async (handle, terms) => {
          // Another wallet on the device refuses BEFORE the handle is claimed
          // (#330): applyBackup below would refuse too, but only after the claim
          // had written this account's handle and profile.
          await refuseIfAnotherWallet(missing)
          // Claim first, write second: a taken handle leaves the device as it was.
          const profile = await claimProfile(missing, handle, parsed.profile, terms)
          // The passphrase already opened this envelope, so the proven key is
          // the unlock; the claimed profile replaces the backup's snapshot.
          const { privkeyHex } = await applyBackup({ ...parsed, profile }, async () => missing)
          recordRestoreSource(privkeyHex, source)
          await onUnlock(privkeyHex)
          navigate('/', { replace: true })
        }}
      />
    )
  }

  if (parsed) {
    return (
      <AccountStep
        backup={parsed}
        source={source}
        onChooseAgain={chooseAgain}
        onLogIn={async (passphrase) => {
          // applyBackup writes the key, opens it with this passphrase, and puts
          // the device back exactly as it was if the passphrase does not open it.
          // The profile check runs inside that same unlock, so an account with
          // no profile is rolled back too: nothing stays on the device.
          let nip05 = ''
          try {
            const { privkeyHex } = await applyBackup(parsed, async () => {
              const hex = await keyStore.loadKey(passphrase)
              nip05 = await requireProfile(hex, parsed.profile?.nip05)
              return hex
            })
            rememberHandle(privkeyHex, nip05)
            recordRestoreSource(privkeyHex, source)
            await onUnlock(privkeyHex)
            navigate('/', { replace: true })
          } catch (e) {
            if (e instanceof ProfileMissingError) {
              setMissing(e.privkeyHex)
              return
            }
            throw e
          }
        }}
      />
    )
  }

  if (found) {
    return (
      <div className="space-y-4">
        <div className="text-center">
          <h2 className="text-lg font-semibold text-mono-900 dark:text-mono-50">Which account?</h2>
          <p className="mt-0.5 text-sm text-mono-500">Your Google Drive holds these backups.</p>
        </div>
        <ul className="space-y-2" aria-label="Backups in Google Drive">
          {found.map((backup) => (
            <li key={backup.id}>
              <Choice
                icon={<CloudDownload className="h-5 w-5" aria-hidden />}
                title={accountLabel(backup)}
                caption={savedLabel(backup)}
                onClick={() => pickDrive(backup)}
              />
            </li>
          ))}
        </ul>
        {problem && <Alert>{problem}</Alert>}
        <Button variant="ghost" className="w-full" onClick={chooseAgain}>
          Back
        </Button>
      </div>
    )
  }

  const busy = loading !== null

  return (
    <div className="space-y-4">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-mono-900 dark:text-mono-50">Where is your backup?</h2>
        <p className="mt-0.5 text-sm text-mono-500">Open it to log in to your account.</p>
      </div>

      {/* Two equals, so neither is styled as the answer: which one is right
          depends only on where the customer saved it. */}
      <div className="space-y-2">
        <Choice
          icon={<CloudDownload className="h-5 w-5" aria-hidden />}
          title="Google Drive"
          caption={loading === 'drive' ? 'Checking Google Drive…' : 'Saved to your Google account'}
          busy={loading === 'drive'}
          disabled={busy}
          onClick={() => void fromDrive()}
        />
        <Choice
          icon={<FileText className="h-5 w-5" aria-hidden />}
          title="A backup file"
          caption="Downloaded from the wallet"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        />
        <input
          ref={fileInput}
          type="file"
          accept={backupFileAccept()}
          className="hidden"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => void fromFile(e.target.files?.[0])}
        />
      </div>

      {/* Shown above the same two choices, so the way back is the screen itself:
          try the other Google account, or the other kind of backup. */}
      {problem && <Alert>{problem}</Alert>}

      <Button variant="ghost" className="w-full" disabled={busy} onClick={onBack}>
        Back
      </Button>

      {/* Not a main path any more, and deliberately plain: it exists so someone
          who only ever wrote the key down is not locked out. */}
      <p className="text-center text-sm text-mono-500">
        <button
          type="button"
          disabled={busy}
          onClick={onUseKey}
          className="pressable underline hover:text-mono-900 disabled:opacity-50 dark:hover:text-mono-50"
        >
          Use your backup key instead
        </button>
      </p>
    </div>
  )
}

/** One of the two backup locations: a full-width row, icon, title, a line under it. */
function Choice({
  icon,
  title,
  caption,
  busy,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  caption: string
  busy?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-busy={busy || undefined}
      onClick={onClick}
      className="pressable flex w-full items-center gap-3 rounded-2xl border border-mono-200 bg-white p-4 text-left hover:bg-mono-100 disabled:pointer-events-none disabled:opacity-50 dark:border-mono-800 dark:bg-mono-900 dark:hover:bg-mono-800"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-mono-100 text-mono-900 dark:bg-mono-800 dark:text-mono-50">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-medium text-mono-900 dark:text-mono-50">{title}</span>
        <span className="block text-sm text-mono-500">{caption}</span>
      </span>
      {busy ? (
        <Loader2 className="h-4 w-4 shrink-0 text-mono-400 motion-safe:animate-spin" aria-hidden />
      ) : (
        <ChevronRight className="h-4 w-4 shrink-0 text-mono-400" aria-hidden />
      )}
    </button>
  )
}

/** A Drive backup named by its handle, else a short account code, never a full key. */
function accountLabel(backup: DriveBackup): string {
  if (backup.nip05) return `@${backup.nip05.split('@')[0]}`
  // The account code without its protocol prefix, shortened: enough to tell two apart.
  if (backup.npub) return `${backup.npub.slice(5, 11)}…${backup.npub.slice(-4)}`
  return 'Your account'
}

function savedLabel(backup: DriveBackup): string {
  const date = backup.modifiedTime ? new Date(backup.modifiedTime) : null
  const when =
    date && !Number.isNaN(date.getTime())
      ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : 'an unknown date'
  return backup.revisionId ? `Older backup, saved ${when}` : `Saved ${when}`
}

/** A restore proves a backup of that kind exists: remember it for the passphrase change. */
function recordRestoreSource(privkeyHex: string, source: 'drive' | 'file' | null) {
  if (source) recordBackup(getPublicKey(hexToBytes(privkeyHex)), source)
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

/** nap's own words for a passphrase that does not open the key. */
function isWrongPassphrase(e: unknown): boolean {
  return e instanceof Error && /invalid passphrase|decrypt/i.test(e.message)
}

/**
 * Whose account this is, then the passphrase.
 *
 * Named the way the app names a person everywhere else: avatar, display name,
 * handle, from the profile stored IN the backup so it works with no signal
 * (#323). A fresher answer replaces it when one lands. Not a link: leaving
 * would throw away the login in progress. No key here, not even behind a tap.
 */
function AccountStep({
  backup,
  source,
  onChooseAgain,
  onLogIn,
}: {
  backup: ParsedBackup
  source: 'drive' | 'file' | null
  onChooseAgain: () => void
  onLogIn: (passphrase: string) => Promise<void>
}) {
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pubkey = backupPubkey(backup)
  const stored = backup.profile

  const submit = async () => {
    if (!passphrase || busy) return
    setBusy(true)
    setError(null)
    try {
      await onLogIn(passphrase)
    } catch (e) {
      setError(
        isWrongPassphrase(e)
          ? 'That passphrase does not open this backup. Check it and try again.'
          : userMessage(e),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-mono-900 dark:text-mono-50">Welcome back</h2>
        <p className="mt-0.5 text-sm text-mono-500">
          {source === 'drive' ? 'Your Google Drive backup holds this account.' : 'This backup holds this account.'}
        </p>
      </div>

      {/* The one place on the flow that moves: the account arriving is the
          answer to the choice just made. `.expand-row` drops to nothing under
          reduced motion. */}
      <Panel className="expand-row bg-white p-4 dark:bg-mono-900">
        {pubkey ? (
          <IdentityInline
            pubkey={pubkey}
            size="md"
            linkToProfile={false}
            // The customer's OWN account: with nothing better known it is
            // "Your account", never a key fragment or a stranger's "Someone".
            fallbackName={stored?.displayName ?? (stored?.nip05 ? undefined : 'Your account')}
            fallbackHandle={stored?.nip05}
            fallbackPicture={stored?.picture}
          />
        ) : (
          // An older backup that names no key and carries no profile. It is the
          // customer's OWN account, so it is never "Unnamed" (owner rule): the
          // gate below gives it its profile before the wallet opens.
          <p className="font-medium text-mono-900 dark:text-mono-50">Your account</p>
        )}
      </Panel>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Input
          type="password"
          placeholder="Passphrase"
          aria-label="Passphrase"
          aria-invalid={error ? true : undefined}
          value={passphrase}
          onChange={(e) => {
            setPassphrase(e.target.value)
            if (error) setError(null)
          }}
          autoComplete="current-password"
          autoFocus
          disabled={busy}
        />

        {error && <Alert>{error}</Alert>}

        <Button type="submit" size="lg" className="w-full" disabled={busy || !passphrase}>
          {busy ? 'Logging in…' : 'Log in'}
        </Button>
      </form>

      <Button variant="ghost" className="w-full" disabled={busy} onClick={onChooseAgain}>
        Choose another backup
      </Button>
    </div>
  )
}
