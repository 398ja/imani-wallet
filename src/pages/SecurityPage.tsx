import { useState } from 'react'
import { nip19 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'
import { Copy, Check, Download } from 'lucide-react'

import { Screen, BackLink, PageHeader, ListSection, Button, Input, Alert, Panel, Switch } from '../components/ui'
import { keyStore, NO_PASSPHRASE } from '../lib/nap'
import { useDevicePassphrase } from '../lib/useDevicePassphrase'
import { legacyApi } from '../lib/legacyBridge'
import { decommissionTerminal, DECOMMISSION_COPY } from '../lib/terminalDecommission'
import type { CredentialMintApi } from '../lib/credentialRevocation'
import { downloadText } from '../lib/download'
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
          <ChangePassphrase />
          <RevealKey />
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
 * Change the passphrase — including to no passphrase, and back.
 *
 * Both directions, not just the middle one. A customer who set this device up
 * open and has since started taking real money should be able to close it
 * without re-importing their key, and one who has now escrowed to Drive should
 * be able to drop a passphrase they no longer need to remember.
 *
 * `protectedKey` is asked of the stored record rather than remembered, so this
 * screen shows a "current passphrase" field exactly when there is one to type.
 */
function ChangePassphrase() {
  const protectedKey = useDevicePassphrase()
  const [current, setCurrent] = useState('')
  const [wanted, setWanted] = useState(true)
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nextError = next === '' ? undefined : validatePassphrase(next)
  const confirmError = confirm === '' ? undefined : validateConfirmation(next, confirm)
  const complete =
    protectedKey !== undefined &&
    (!protectedKey || current !== '') &&
    // Turning protection off on a device that is already off is not a change.
    (wanted ? next !== '' && confirm !== '' && !nextError && !confirmError : protectedKey)

  const change = async () => {
    setBusy(true)
    setError(null)
    setDone(false)
    try {
      // Decrypt with the old, re-encrypt with the new. nap owns the crypto —
      // this is not a second key-handling implementation, it is two calls to the
      // one that already exists. A wrong current passphrase throws here, before
      // anything is overwritten.
      const hex = await keyStore.loadKey(protectedKey ? current : NO_PASSPHRASE)
      await keyStore.save(hex, wanted ? next : NO_PASSPHRASE)
      setDone(true)
      setCurrent('')
      setNext('')
      setConfirm('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ListSection title="Passphrase">
      <div className="space-y-3 p-4">
        {protectedKey && (
          <Input
            type="password"
            placeholder="Current passphrase"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
          />
        )}

        <Switch
          label="Protect this device with a passphrase"
          hint={
            wanted
              ? 'Asked for every time you open the wallet on this device.'
              : 'Anyone holding this phone can open your wallet.'
          }
          checked={wanted}
          disabled={busy}
          onChange={setWanted}
        />

        {wanted && (
          <>
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
          </>
        )}

        <Button className="w-full" disabled={busy || !complete} onClick={() => void change()}>
          {busy ? 'Saving…' : wanted ? 'Change passphrase' : 'Remove passphrase'}
        </Button>
        {done && (
          <p className="text-sm text-green-700 dark:text-green-500">
            {wanted ? 'Passphrase changed.' : 'Passphrase removed.'}
          </p>
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

/**
 * Show the nsec, behind the passphrase.
 *
 * Re-asking for the passphrase is not ceremony: an unlocked wallet left open on
 * a market stall would otherwise hand its key to anyone who opens this screen.
 */
function RevealKey() {
  const protectedKey = useDevicePassphrase()
  const [passphrase, setPassphrase] = useState('')
  const [nsec, setNsec] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reveal = async () => {
    setBusy(true)
    setError(null)
    try {
      const hex = await keyStore.loadKey(protectedKey ? passphrase : NO_PASSPHRASE)
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

  return (
    <ListSection title="Backup key">
      <div className="space-y-3 p-4">
        {nsec ? (
          <>
            <Panel className="break-all bg-mono-100 p-3 font-mono text-xs text-mono-900 dark:bg-mono-800 dark:text-mono-50">
              {nsec}
            </Panel>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={() => void copy()}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                <span className="ml-2">{copied ? 'Copied' : 'Copy'}</span>
              </Button>
              <Button
                variant="secondary"
                onClick={() => downloadText('imani-wallet-backup-key.txt', nsec)}
              >
                <Download className="h-4 w-4" />
                <span className="ml-2">Download</span>
              </Button>
            </div>
            <Button variant="ghost" className="w-full" onClick={() => setNsec(null)}>
              Hide
            </Button>
            {error && <Alert>{error}</Alert>}
          </>
        ) : (
          <>
            <p className="text-sm text-mono-500">
              Anyone with this key controls your account and your vouchers. Only show it somewhere
              private.
            </p>
            {protectedKey && (
              <Input
                type="password"
                placeholder="Passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="current-password"
              />
            )}
            <Button
              variant="secondary"
              className="w-full"
              disabled={busy || protectedKey === undefined || (protectedKey && !passphrase)}
              onClick={() => void reveal()}
            >
              {busy ? 'Checking…' : 'Show my backup key'}
            </Button>
            {error && <Alert>{error}</Alert>}
          </>
        )}
      </div>
    </ListSection>
  )
}
