import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { Lock, QrCode, Send, Settings } from 'lucide-react'

import { Alert, Button, Centered, Input, PageHeader, Panel, Screen, ListSection, BackLink } from '../components/ui'
import { fetchMerchantRecord, type MerchantProfile } from '../lib/merchant'
import { profileName, refreshProfile } from '../lib/profile'
import { forgetTerminal, storedTerminal } from '../lib/terminalEnrol'
import {
  lockTerminal,
  openTill,
  unlockTerminal,
  type UnlockOutcome,
} from '../lib/terminalUnlock'
import { canIssueNow, canRedeemNow, sessionState, type TerminalSession } from '../lib/terminalSession'
import { mayWarrantSale } from '../lib/warrantSigner'
import { fulfilmentOf, idleLockMs, startIdleLock, terminalMintApi } from '../lib/terminalTill'
import { decommissionTerminal, DECOMMISSION_COPY } from '../lib/terminalDecommission'
import type { TerminalActor } from '../lib/actor'
import { RedeemPage } from './RedeemPage'
import { NotTrading } from './MerchantHomePage'
import { LAPSE } from '../lib/terminalSession'

/**
 * The till, on a device enrolled as a terminal (#160 phase 3, spec 2.3 and 2.4).
 *
 * A sibling of `AuthedApp`, not a mode of it. `AuthedApp` exists for an account: a NAP session,
 * `canTrade`, a wallet, a DM poll, push and relay sync. A terminal has none of those and must
 * not start them (the till is a device in staff hands, and the stall's inbox and books are the
 * owner's). This tree needs only the unlocked signer, the session the credential opened, and the
 * stall's public profile.
 *
 * | Screen | Redemption only | Sell and redeem, FULL | Sell and redeem, REDUCED |
 * |---|---|---|---|
 * | Home, Redeem, Settings, Lock | yes | yes | yes |
 * | Sell | no | phase 5 | no |
 *
 * Everything else (profile, dashboard, vouchers, backup, terminals) has no route here at all, so
 * a typed URL lands on the home screen rather than on the owner's business.
 */

/** What the till needs to run. */
interface Till {
  devicePubkey: string
  actor: TerminalActor
  session: TerminalSession
}

export function TerminalApp() {
  // The till survives a remount (a route change, StrictMode) within this page load, because the
  // unlocked session lives in `terminalUnlock`, not in this component.
  const [till, setTill] = useState<Till | null>(() => openTill())
  const record = useMemo(() => storedTerminal(), [])
  const [stall, setStall] = useState<MerchantProfile | null>(null)
  // The stall's public name, from its kind-0 profile, as the setup screen showed it.
  const [stallName, setStallName] = useState<string | null>(null)
  const navigate = useNavigate()
  // One check function for the life of the till, so the Redeem screen's poll is not restarted on
  // every render. It signs with whichever terminal signer is installed when it runs.
  const fulfilment = useMemo(() => fulfilmentOf(), [])

  useEffect(() => {
    if (!record) return
    let live = true
    void fetchMerchantRecord(record.stallPubkey).then((m) => live && setStall(m))
    void publicStallName(record.stallPubkey).then((n) => live && setStallName(n))
    return () => {
      live = false
    }
  }, [record])

  // The owner's idle lock (decision 2). Locking drops the signer and returns to the unlock
  // screen; the twelve-hour session is kept, so unlocking needs only the passphrase.
  const lock = useCallback(() => {
    lockTerminal()
    setTill(null)
    navigate('/terminal/unlock', { replace: true })
  }, [navigate])
  useEffect(() => {
    if (!till) return
    return startIdleLock(idleLockMs(record?.idleLockMinutes), lock)
  }, [till, record, lock])

  if (!record) return <Navigate to="/onboarding" replace />

  if (!till) {
    return (
      <Routes>
        <Route
          path="/terminal/unlock"
          element={
            <TerminalUnlockPage
              name={record.name}
              terminalPubkey={record.terminalPubkey}
              stallName={stallName}
              onUnlocked={(t) => {
                setTill(t)
                navigate('/', { replace: true })
              }}
            />
          }
        />
        {/* Locked: every path asks for the passphrase first. */}
        <Route path="*" element={<Navigate to="/terminal/unlock" replace />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route
        path="/"
        element={
          <TerminalHome till={till} stall={stall} stallName={stallName} terminalName={record.name} onLock={lock} />
        }
      />
      <Route
        path="/redeem"
        element={
          !canRedeemNow(till.actor, till.session) ? (
            <Navigate to="/" replace />
          ) : stall ? (
            <RedeemPage
              pubkey={till.devicePubkey}
              merchant={stall}
              actor={till.actor}
              fulfilment={fulfilment}
            />
          ) : (
            // The request's currency comes from the stall's public record. Wait for it rather
            // than bouncing to the till, so a reload on this screen stays here.
            <Centered>Reading the stall…</Centered>
          )
        }
      />
      <Route path="/settings" element={<TerminalSettings />} />
      <Route
        path="/settings/security"
        element={
          <TerminalSecurity>
            <DecommissionButton devicePubkey={till.devicePubkey} />
          </TerminalSecurity>
        }
      />
      {/* No /sell: a terminal cannot sell until the terminal warrant ships (phase 5), and a
          redeem-only or REDUCED terminal never can. Every other path, including the owner's
          dashboard, vouchers, backup and terminals, lands on the till. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

/** The stall's public name from its profile, or null. Never throws. */
async function publicStallName(stallPubkey: string): Promise<string | null> {
  const profile = await refreshProfile(stallPubkey).catch(() => null)
  if (!profile || (!profile.displayName && !profile.nip05)) return null
  return profileName(profile)
}

/**
 * `/terminal/unlock`: the passphrase, and nothing else.
 *
 * No "use a different account" and no restore: a terminal holds no account, and the owner
 * replaces a device by adding it again.
 */
export function TerminalUnlockPage({
  name,
  terminalPubkey,
  stallName,
  onUnlocked,
  unlock = unlockTerminal,
}: {
  name?: string
  /** The record's device key, for the wallet wipe when a refused device is taken out of service. */
  terminalPubkey: string
  stallName: string | null
  onUnlocked: (till: Till) => void
  unlock?: (passphrase: string) => Promise<UnlockOutcome>
}) {
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const [notTerminal, setNotTerminal] = useState(false)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const out = await unlock(passphrase)
      if (out.unlocked) {
        setPassphrase('')
        onUnlocked({ devicePubkey: out.devicePubkey, actor: out.actor, session: out.session })
        return
      }
      if (out.reason === 'wrong-passphrase') setError(out.message)
      else if (out.reason === 'not-a-terminal-key') {
        setError(out.message)
        setNotTerminal(true)
      } else setRefused(out.message)
    } finally {
      setBusy(false)
    }
  }

  if (refused) {
    // Revoked, or a credential that is not this device's. The till says so and offers nothing:
    // retrying the passphrase cannot change the mint's answer.
    // Taking it out of service still works (phase 4): a revoked credential is already spent, so
    // nothing needs signing, and the device erases itself.
    return (
      <>
        <NotTrading message={refused} reason={LAPSE.REVOKED} />
        <div className="mx-auto max-w-sm px-6 pb-6">
          <DecommissionButton devicePubkey={terminalPubkey} />
        </div>
      </>
    )
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div className="text-center">
        <h1 className="text-xl font-semibold text-mono-900 dark:text-mono-50">{name ?? 'Terminal'}</h1>
        <p className="text-sm text-mono-500">{stallName ? `Till for ${stallName}` : 'Till'}</p>
      </div>
      <div className="space-y-3">
        <Input
          type="password"
          label="Passphrase"
          placeholder="Passphrase"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoComplete="current-password"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && passphrase && !busy) void submit()
          }}
        />
        <Button size="lg" className="w-full" disabled={busy || !passphrase} onClick={() => void submit()}>
          {busy ? 'Opening…' : 'Open the till'}
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
      {notTerminal && (
        // Only the stale terminal RECORD is forgotten: the key, the person's wallet, is kept.
        <Button
          variant="outline"
          className="w-full"
          onClick={() => {
            forgetTerminal()
            window.location.replace('/login')
          }}
        >
          Open the wallet
        </Button>
      )}
    </div>
  )
}

function TerminalHome({
  till,
  stall,
  stallName,
  terminalName,
  onLock,
}: {
  till: Till
  stall: MerchantProfile | null
  stallName: string | null
  terminalName?: string
  onLock: () => void
}) {
  const navigate = useNavigate()
  const lapse = sessionState(till.session)
  if (!lapse.live) return <NotTrading message={lapse.message} reason={lapse.reason} />

  // Sell needs the role, a FULL session and a warrant the customer's wallet accepts. The last is
  // the terminal warrant form, phase 5; until then a role that may sell is told so in one line.
  const roleMayIssue = canIssueNow(till.actor, till.session)
  const mayIssue = roleMayIssue && mayWarrantSale(till.actor)
  const mayRedeem = canRedeemNow(till.actor, till.session) && stall !== null

  return (
    <Screen>
      <div className="flex min-h-[calc(100svh-6rem)] flex-col justify-center">
        <div className="mb-8 text-center">
          <p className="text-lg font-semibold text-mono-900 dark:text-mono-50" data-testid="terminal-name">
            {terminalName ?? 'Terminal'}
          </p>
          <p className="text-sm text-mono-500" data-testid="stall-name">
            {stallName ?? (stall ? 'Your stall' : 'Reading the stall…')}
          </p>
        </div>
        <div className={`grid gap-3 ${mayIssue && mayRedeem ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {mayIssue ? (
            <Button size="lg" onClick={() => navigate('/sell')}>
              <Send className="mr-2 h-5 w-5" aria-hidden /> Sell
            </Button>
          ) : null}
          {mayRedeem ? (
            <Button size="lg" variant={mayIssue ? 'outline' : 'primary'} onClick={() => navigate('/redeem')}>
              <QrCode className="mr-2 h-5 w-5" aria-hidden /> Redeem
            </Button>
          ) : null}
        </div>
        {roleMayIssue && !mayIssue && (
          <p className="mt-4 text-center text-sm text-mono-500">
            Selling from a terminal is not available yet. Sell from the stall owner’s own device.
          </p>
        )}
        <div className="mt-10 flex justify-center gap-6 text-sm text-mono-500">
          <Link to="/settings" className="pressable inline-flex items-center gap-1 underline">
            <Settings className="h-4 w-4" aria-hidden /> Settings
          </Link>
          <button type="button" className="pressable inline-flex items-center gap-1 underline" onClick={onLock}>
            <Lock className="h-4 w-4" aria-hidden /> Lock
          </button>
        </div>
      </div>
    </Screen>
  )
}

function TerminalSettings() {
  return (
    <Screen>
      <BackLink to="/" label="Till" />
      <PageHeader title="Settings" />
      <ListSection title="This terminal">
        <Link to="/settings/security" className="block p-4 text-sm">
          Security
        </Link>
      </ListSection>
    </Screen>
  )
}

/** Settings → Security on a terminal: only "Take out of service" (ticket 08, spec 2.4). */
function TerminalSecurity({ children }: { children: React.ReactNode }) {
  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader title="Security" />
      <Panel className="p-4">{children}</Panel>
    </Screen>
  )
}

/**
 * Hand the credential back and erase the terminal (ticket 08), with the terminal's own words.
 *
 * Uses the terminal's mint client, not the owner's legacy one: the spend carries the witness the
 * unlocked terminal key signs. On a refused device no key is unlocked, which is fine for a
 * revoked credential (already spent, nothing to sign) and fails safe otherwise: the spend is
 * refused and nothing is erased.
 */
function DecommissionButton({ devicePubkey }: { devicePubkey: string }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div>
      <p className="mb-3 text-sm text-mono-500">{DECOMMISSION_COPY.body}</p>
      {error ? <Alert>{error}</Alert> : null}
      {asking ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm">{DECOMMISSION_COPY.confirmBody}</p>
          <Button variant="outline" size="sm" onClick={() => setAsking(false)} disabled={busy}>
            Keep it in service
          </Button>
          <Button
            size="sm"
            className="!bg-red-600 !text-white"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              // The signer stays installed: handing a live credential back needs the witness the
              // terminal key signs. On success the document reloads, which drops it.
              void decommissionTerminal(terminalMintApi(), devicePubkey).then((out) => {
                if (!out.done) {
                  setError(out.message)
                  setBusy(false)
                  setAsking(false)
                }
              })
            }}
          >
            {busy ? 'Handing back…' : DECOMMISSION_COPY.confirm}
          </Button>
        </div>
      ) : (
        <Button variant="outline" className="w-full !text-red-600" onClick={() => setAsking(true)}>
          {DECOMMISSION_COPY.title}
        </Button>
      )}
    </div>
  )
}

