import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { Screen, BackLink, PageHeader, Button, Input, Alert, Panel } from '../components/ui'
import { LogoutBlockedDialog } from '../components/LogoutBlocked'
import { listTransactions } from '../lib/wallet'
import { toTransaction } from '../lib/transactions'
import { handleOf } from '../lib/format'
import { buildMerchantEvent, saveMerchant, type MerchantProfile } from '../lib/merchant'
import { getSigner } from '../lib/nap'
import { publish } from '../lib/relay'
import { userMessage } from '../lib/userMessage'
import {
  DELETE_COPY,
  REASON_COPY,
  DELETED_PENDING_COPY,
  handleDeleted,
  deleteAccount,
  liabilityBlock,
  liabilityMessage,
  type DeletionOutcome,
  type LiabilityBlock,
} from '../lib/accountDeletion'
import type { BlockedLogout } from '../lib/logoutBlockedCopy'

/**
 * Settings > Security > Delete my account (imani-wallet#558).
 *
 * A merchant with vouchers outstanding is refused and offered "Close my stall". Everyone else sees
 * what is deleted and what is not, types their name to confirm, and then the logout checks run
 * before anything is deleted.
 */
export function DeleteAccountPage({
  pubkey,
  nip05,
  merchant,
  onMerchantSaved,
  onDeleted,
  run = deleteAccount,
  historyReady = true,
}: {
  pubkey: string
  nip05?: string
  merchant: MerchantProfile | null
  onMerchantSaved: (m: MerchantProfile) => void
  onDeleted: () => void
  run?: typeof deleteAccount
  /**
   * The sealed history has been restored from the relay. Until then a fresh device holds no issued
   * rows and would see nothing outstanding, so a merchant's check waits.
   */
  historyReady?: boolean
}) {
  const [block, setBlock] = useState<LiabilityBlock | null | 'loading'>(merchant ? 'loading' : null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<BlockedLogout | null>(null)
  const [pending, setPending] = useState(() => handleDeleted(pubkey))

  useEffect(() => {
    if (!merchant || !historyReady) return
    let live = true
    listTransactions()
      .then((rows) => {
        if (live) setBlock(liabilityBlock(rows.map(toTransaction), merchant, pubkey, Date.now()))
      })
      // Unreadable history: refuse rather than guess there is nothing outstanding.
      .catch(() => live && setError('We could not read your sales, so your account can’t be deleted right now. Try again later.'))
    return () => {
      live = false
    }
  }, [merchant, pubkey, historyReady])

  const handle = handleOf(nip05)
  const matches = handle !== null && typed.trim().replace(/^@/, '').toLowerCase() === handle.toLowerCase()

  const go = async () => {
    setBusy(true)
    setError(null)
    let outcome: DeletionOutcome
    try {
      outcome = await run(pubkey, nip05)
    } catch {
      outcome = { status: 'failed', reason: 'network' }
    }
    setBusy(false)
    if (outcome.status === 'done') onDeleted()
    else if (outcome.status === 'deleted-logout-pending') setPending(true)
    else if (outcome.status === 'blocked') setBlocked(outcome.logout)
    else setError(DELETE_COPY[REASON_COPY[outcome.reason]])
  }

  if (pending) {
    return (
      <Screen>
        <PageHeader title="Delete my account" />
        <div data-testid="deleted-pending">
          <Panel>
            <p className="text-sm text-mono-700 dark:text-mono-200">{DELETED_PENDING_COPY}</p>
          </Panel>
        </div>
        <Button size="lg" className="mt-4 w-full" disabled={busy} onClick={go}>
          {busy ? 'Logging out…' : 'Finish'}
        </Button>
      </Screen>
    )
  }

  if (block === 'loading' && !error) {
    return (
      <Screen>
        <BackLink to="/settings/security" label="Security" />
        <PageHeader title="Delete my account" />
        <p className="text-sm text-mono-500">Checking your vouchers…</p>
      </Screen>
    )
  }

  if (merchant && (block !== null || error)) {
    return (
      <Screen>
        <BackLink to="/settings/security" label="Security" />
        <PageHeader title="Delete my account" />
        {error ? (
          <Alert>{error}</Alert>
        ) : (
          block &&
          block !== 'loading' && (
            <>
              <div data-testid="liability-refusal">
                <Alert>{liabilityMessage(block)}</Alert>
              </div>
              <CloseStall merchant={merchant} onSaved={onMerchantSaved} />
            </>
          )
        )}
      </Screen>
    )
  }

  return (
    <Screen>
      <BackLink to="/settings/security" label="Security" />
      <PageHeader title="Delete my account" />
      <Panel>
        <p className="text-sm font-medium text-mono-900 dark:text-mono-50">What we delete</p>
        <ul className="mt-2 list-disc pl-5 text-sm text-mono-600 dark:text-mono-300">
          <li>Your name{handle ? ` @${handle}` : ''}. Nobody can take it after you.</li>
          <li>Your notifications on this device.</li>
          <li>Everything this wallet holds for you on this device.</li>
        </ul>
        <p className="mt-4 text-sm font-medium text-mono-900 dark:text-mono-50">What we can’t delete</p>
        <ul className="mt-2 list-disc pl-5 text-sm text-mono-600 dark:text-mono-300">
          <li>Your backup key. It is yours, and with it or a backup your vouchers come back.</li>
          <li>Anyone you already paid keeps what they received.</li>
          <li>Backups you saved yourself, in a file or in your Google Drive.</li>
        </ul>
      </Panel>
      {handle ? (
        <div className="mt-4">
          <Input
            label={`Type ${handle} to confirm`}
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
          />
        </div>
      ) : null}
      <Button
        size="lg"
        className="mt-4 w-full !bg-red-600"
        disabled={busy || (handle !== null && !matches)}
        onClick={go}
      >
        {busy ? 'Deleting…' : 'Delete my account'}
      </Button>
      {error && (
        <div className="mt-3" data-testid="delete-error">
          <Alert>{error}</Alert>
          <Button variant="outline" className="mt-2 w-full" disabled={busy} onClick={go}>
            Try again
          </Button>
        </div>
      )}
      <Link to="/settings/security" className="mt-3 block text-center text-sm text-mono-500 underline">
        Keep my account
      </Link>
      {blocked && (
        <LogoutBlockedDialog outcome={blocked} busy={busy} onRetry={() => { setBlocked(null); void go() }} onClose={() => setBlocked(null)} />
      )}
    </Screen>
  )
}

/**
 * "Close my stall" (#558): selling stops now, redeeming and receiving go on.
 *
 * Sets `salesClosed` on the stall's public kind-30078 record, which also withdraws `acceptsCards`
 * from it. Distinct from the Open-for-business switch (#434), which pauses redeeming too.
 */
function CloseStall({ merchant, onSaved }: { merchant: MerchantProfile; onSaved: (m: MerchantProfile) => void }) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (merchant.salesClosed) {
    return (
      <p className="mt-4 text-sm text-mono-500" data-testid="stall-closed-status">
        Your stall is closed for selling. Keep redeeming your customers’ vouchers until the last one expires.
      </p>
    )
  }

  const close = async () => {
    setBusy(true)
    setError(null)
    const next: MerchantProfile = { ...merchant, salesClosed: true, updatedAt: Date.now() }
    saveMerchant(next)
    onSaved(next)
    try {
      const signed = await getSigner().signEvent(buildMerchantEvent(next))
      const published: MerchantProfile = { ...next, eventAt: signed.created_at }
      saveMerchant(published)
      onSaved(published)
      const { ok } = await publish(signed)
      setStatus(ok === 0 ? 'Closed on this device, but not sent yet. Customers may still see your stall as open for a while.' : 'Your stall is closed for selling.')
    } catch (e) {
      setError(userMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4">
      <Panel>
        <p className="text-sm text-mono-600 dark:text-mono-300">
          Close your stall to stop selling now, here, on your terminals and by card. You keep redeeming the vouchers
          your customers hold, and you can delete your account once the last one has expired.
        </p>
      </Panel>
      <Button size="lg" className="mt-4 w-full" disabled={busy} onClick={close}>
        {busy ? 'Closing…' : 'Close my stall'}
      </Button>
      {status && <p className="mt-3 text-center text-sm text-mono-500" role="status">{status}</p>}
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
    </div>
  )
}
