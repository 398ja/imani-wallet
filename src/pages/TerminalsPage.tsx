import { useCallback, useEffect, useState } from 'react'
import { Store, Tablet, TriangleAlert } from 'lucide-react'

import { Screen, BackLink, PageHeader, Panel, ListSection, Button, EmptyRow, Alert } from '../components/ui'
import { Link } from 'react-router-dom'
import { licenceStatus, type LicenceStatus } from '../lib/licenceStatus'
import { reportLicence } from '../lib/licenceReport'
import { mayServe } from '../lib/lapseService'
import { formatDate } from '../lib/format'
import { TERMINAL_ROLE_LABELS } from '../lib/terminalRole'
import {
  REVOCATION_DELAY_NOTE,
  allTerminals,
  hasUnconfirmed,
  RENEW_TO_KEEP_SELLING,
  isRevocable,
  needsRenewalToSell,
  revocationBitesAt,
  type TerminalRecord,
} from '../lib/terminalRoster'
import {
  cancelExpiredWaiting,
  markSpentElsewhere,
  removeUnmintedWaiting,
  resumeMinting,
  revokeTerminalAtMint,
} from '../lib/terminalRevoke'
import { ownerTransport, type MintTransport } from '../lib/terminalMint'
import { collectEnrolled, ownerPublisher } from '../lib/terminalDeliveryNet'
import { confirmEnrolled, deliverWaiting, stallConfirm, type ConfirmCall } from '../lib/terminalConfirm'
import { setupCode } from '../lib/terminalDelivery'
import { getSigner } from '../lib/nap'
import type { CredentialMintApi } from '../lib/credentialRevocation'
import { syncRosterNow } from '../lib/terminalRosterSyncNet'
import {
  cancelLapsedRenewals,
  currentExpiry,
  isRenewable,
  lapsedRenewalMessage,
  renewalsQueued,
  resumeRenewal,
} from '../lib/terminalRenewOwner'
import { expiryBand, type ExpiryBand } from '../lib/terminalRenewal'
import { collectRenewRequests } from '../lib/terminalDeliveryNet'
import { onlineShopUnconfirmed, syncOnlineShop, type ProfilePublisher } from '../lib/onlineShopProfile'
import { shopHost } from '../lib/shopEnrol'
import { ownerProfilePublisher, ownerRenew, ownerSend, ownerSpendApi } from '../lib/terminalOwnerPorts'



/** How often the list looks for a device's "I have it" while something is waiting. */
const ENROLLED_POLL_MS = 5_000

/** The online_shop republish retries this often, this many times, while the list is open (#402). */
const ONLINE_SHOP_RETRY_MS = 5_000
const ONLINE_SHOP_RETRIES = 24

/** Sends a credential DM to every waiting device that has not had one, sealed by the stall. */
const ownerDeliver = (stallPubkey: string) =>
  deliverWaiting(stallPubkey, (borrow) => getSigner().withPrivkey(borrow), ownerPublisher)

/** A stable clock: a fresh arrow per render would re-run the effect that reads it, forever. */
const systemNow = () => Date.now()


/**
 * When the list opens: finish renewals that did not, cancel any the device never picked up in
 * 24 hours, and adopt renew requests from tills this list lost (Q3).
 */
async function ownerRenewals(stallPubkey: string, api: CredentialMintApi, transport: MintTransport) {
  const resumed = await resumeRenewal(stallPubkey, { transport, api, send: ownerSend }).catch(() => ({ completed: 0, cleared: 0, pending: 0 }))
  const lapsed = await cancelLapsedRenewals(stallPubkey, api).catch(() => [] as string[])
  const asked = await collectRenewRequests(stallPubkey, async () => api).catch(() => 0)
  return { changed: resumed.completed + resumed.cleared + lapsed.length + asked, lapsed }
}


/**
 * The terminals this stall has out, and taking one back.
 *
 * Terminals ticket 06. The list is the owner's own record — ADR 0005 keeps no
 * per-terminal state on the gateway — so this screen reads from the device and
 * needs nothing to be online. That matters at the moment it is most used: an
 * owner discovering a device is gone should not also discover they need signal.
 *
 * ## The delay is on the screen, before the decision
 *
 * Revocation bites when the terminal's session next expires, up to twelve
 * hours. The owner of a stolen device is really deciding "is twelve hours good
 * enough, or do I close the stall?", and they cannot decide that against a
 * number nobody showed them. So the note sits in the confirmation, at the point
 * of choosing, rather than in a help page or a toast afterwards.
 *
 * ## Revoked terminals stay on the list
 *
 * Greyed and labelled, not removed. Revoking withdraws authority and never
 * erases history: a movement from last month still points at the till that
 * handled it, and a list that deleted the row would make that record
 * unreadable. It also answers "did I already revoke that one?", which is the
 * first question an anxious owner asks.
 *
 * ## There is no pause
 *
 * One destructive action, named "Revoke". No suspend, no disable, no toggle
 * that could be read as either. Bringing a terminal back is enrolling it again,
 * and the empty state says so, so the absence reads as a design rather than as
 * a missing button.
 */
export function TerminalsPage({
  stallPubkey,
  spendApi = ownerSpendApi,
  transport = ownerTransport,
  collect = collectEnrolled,
  confirm = stallConfirm,
  deliver = ownerDeliver,
  sync = syncRosterNow,
  renew = ownerRenew,
  renewals = ownerRenewals,
  now = systemNow,
  profile = ownerProfilePublisher,
}: {
  stallPubkey: string
  /** Injected by tests. Spends a credential with the stall's key. */
  spendApi?: () => Promise<CredentialMintApi>
  /** Injected by tests. The owner's NIP-98 signer otherwise. */
  transport?: MintTransport
  /** Injected by tests. Promotes waiting rows whose device confirmed. */
  collect?: (stallPubkey: string) => Promise<number>
  /** Injected by tests. The stall's `/confirm` call (#160 round 2). */
  confirm?: ConfirmCall
  /** Injected by tests. Sends the credential DM to waiting devices that never got one. */
  deliver?: (stallPubkey: string) => Promise<number>
  /** Injected by tests. Merges the roster the owner's other devices published (#160 phase 6). */
  sync?: (stallPubkey: string) => Promise<boolean>
  /** Injected by tests. Renews one terminal (#160 phase 6). */
  renew?: (stallPubkey: string, terminalPubkey: string, api: CredentialMintApi) => Promise<{ started: boolean; message?: string }>
  /** Injected by tests. Resumes, cancels and adopts renewals when the list opens (#160 phase 6). */
  renewals?: (stallPubkey: string, api: CredentialMintApi, transport: MintTransport) => Promise<{ changed: number; lapsed: string[] }>
  /** Injected by tests (E7 moves the clock). */
  now?: () => number
  /** Injected by tests. Signs and publishes the stall's profile when its online shop changes (#402). */
  profile?: ProfilePublisher
}) {
  // Read lazily rather than in an effect. The roster is local storage, so it is
  // available on the first render — going through an effect would paint an
  // empty list for a frame and, worse, imply this screen needs to fetch
  // something. It does not, which is what makes it work with no signal.
  const [terminals, setTerminals] = useState<TerminalRecord[]>(() => allTerminals(stallPubkey))
  // Which row is asking "sure?". Revocation cannot be undone from here — the
  // way back is a whole enrolment — so it does not happen on a single tap.
  const [confirming, setConfirming] = useState<string | null>(null)

  /**
   * What the licence check believes, for the lapse markers below.
   *
   * Read here rather than per-row so every row is judged against ONE answer:
   * rows resolving separately could render a list where the same subscription
   * appears live on one line and lapsed on the next.
   *
   * Null while it loads, and rows show no marker until it arrives — briefly
   * flashing "stopped" at an owner whose subscription is fine would be worse
   * than showing nothing for a moment.
   */
  const [licence, setLicence] = useState<LicenceStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    void licenceStatus({ pubkey: stallPubkey }).then((status) => {
      if (!cancelled) setLicence(status)
      // imani-wallet#197: the owner looking at their tills is a good moment to make sure the server
      // knows the stall is licensed. Fire and forget, at most once per interval per licence.
      if (status.decision.granted) void reportLicence({ pubkey: stallPubkey }).catch(() => undefined)
    })
    return () => {
      cancelled = true
    }
  }, [stallPubkey])

  const refresh = useCallback(() => setTerminals(allTerminals(stallPubkey)), [stallPubkey])

  // #402 §0: the profile's `online_shop` follows the roster. A shop that turned In service is
  // advertised, a revoked one is withdrawn, from whichever path changed the row. The record is
  // saved locally first; the publish is retried every ONLINE_SHOP_RETRY_MS while this list is open
  // until the relay takes it. It lands in the burst of relay connections right after enrolment,
  // and a connect timeout there was never retried (staging 2026-10-31: "connection timed out").
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = async (left: number) => {
      const out = await syncOnlineShop(stallPubkey, terminals, profile).catch(() => ({ changed: true, published: false }))
      // `changed || published` false means nothing was pending (already confirmed): stop.
      const failed = !out.published && (out.changed || onlineShopUnconfirmed(stallPubkey))
      if (!stopped && failed && left > 0) timer = setTimeout(() => void attempt(left - 1), ONLINE_SHOP_RETRY_MS)
    }
    void attempt(ONLINE_SHOP_RETRIES)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [stallPubkey, terminals, profile])


  /** Which row is being revoked right now, and what went wrong last time. */
  const [revoking, setRevoking] = useState<string | null>(null)
  const [revokeError, setRevokeError] = useState<{ terminal: string; message: string } | null>(null)

  /**
   * Spend the credential, then mark the row (#160 phase 1, spec 2.6).
   *
   * The row changes only if the spend landed. Otherwise it stays live and the
   * screen says the revocation did not reach the mint, with Revoke to retry.
   */
  const revoke = useCallback(
    async (terminalPubkey: string) => {
      setRevoking(terminalPubkey)
      setRevokeError(null)
      try {
        const out = await revokeTerminalAtMint(stallPubkey, terminalPubkey, await spendApi())
        if (!out.revoked) setRevokeError({ terminal: terminalPubkey, message: out.message })
      } catch {
        setRevokeError({
          terminal: terminalPubkey,
          message: 'The revocation did not reach the mint, so the terminal is still in service.',
        })
      } finally {
        setRevoking(null)
        setConfirming(null)
        refresh()
      }
    },
    [stallPubkey, spendApi, refresh],
  )

  /** Renewing, and what went wrong or lapsed (#160 phase 6). */
  const [renewing, setRenewing] = useState<string | null>(null)
  const [renewNotice, setRenewNotice] = useState<{ terminal: string; message: string } | null>(null)
  const [lapsed, setLapsed] = useState<string[]>([])

  const renewOne = useCallback(
    async (terminalPubkey: string) => {
      setRenewing(terminalPubkey)
      setRenewNotice(null)
      try {
        const out = await renew(stallPubkey, terminalPubkey, await spendApi())
        if (!out.started && out.message) setRenewNotice({ terminal: terminalPubkey, message: out.message })
      } catch {
        setRenewNotice({ terminal: terminalPubkey, message: 'The renewal did not reach the gateway. Try again.' })
      } finally {
        setRenewing(null)
        refresh()
      }
    },
    [stallPubkey, spendApi, renew, refresh],
  )

  // Phase 2: while a row waits, look for its device's enrolled DM, so the row
  // turns In service without a reload (spec 2.1 step 4).
  // Round 2: and while a row is in service by the device's word but not yet confirmed at the
  // gateway, confirm it as the stall, with backoff, so a lost device confirm cannot leave a
  // till the list calls in service and the gateway refuses.
  const hasWaiting = terminals.some(
    (t) => (t.status === 'waiting' || t.renewal !== undefined) && t.revokedAt === undefined,
  )
  const needsConfirm = hasUnconfirmed(stallPubkey) || terminals.some((t) => t.gatewayState === 'unconfirmed')
  useEffect(() => {
    if (!hasWaiting && !needsConfirm) return
    let stopped = false
    const tick = async () => {
      try {
        await collect(stallPubkey)
      } catch {
        // Offline or locked. Try again on the next tick.
      }
      // Show the promotion now, not after the confirm below answers.
      if (!stopped) refresh()
      try {
        await confirmEnrolled(stallPubkey, confirm)
      } catch {
        // Retried on the next tick, after its backoff.
      }
      // Re-read the roster whatever the count said. Under StrictMode the first
      // effect's poll can promote the row after it was torn down, and the
      // second then reports nothing changed: trusting the count left the row
      // showing Waiting for good.
      if (!stopped) refresh()
    }
    void tick()
    const timer = setInterval(() => void tick(), ENROLLED_POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [hasWaiting, needsConfirm, stallPubkey, collect, confirm, refresh])

  // Waiting rows past their 24 hours are cancelled when this screen opens
  // (decision 4 on #160). Best effort: one that does not land stays waiting and
  // is tried again next time, and nothing here blocks the list from showing.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // The list from the owner's other devices first (#160 phase 6), merged into this one,
        // so a terminal added or revoked on another phone shows here.
        if (await sync(stallPubkey).catch(() => false)) {
          if (!cancelled) refresh()
        }
        const api = await spendApi()
        // Settle any credential request that did not finish (#160 review)
        // before expiring waiting rows, so a request that is resumed now and
        // turns out to be past its 24 hours is cancelled in the same pass.
        const resumed = await resumeMinting(stallPubkey, api, transport)
        const n = await cancelExpiredWaiting(stallPubkey, api)
        // Renewals (#160 phase 6): finish any that did not, cancel any the device never picked up
        // in 24 hours, and adopt renew requests from tills this list lost (Q3).
        const { changed, lapsed: gone } = await renewals(stallPubkey, api, transport).catch(() => ({ changed: 0, lapsed: [] as string[] }))
        if (gone.length > 0 && !cancelled) setLapsed(gone)
        if (changed > 0 && !cancelled) refresh()
        // A credential spent somewhere else (the device took itself out of service, or another
        // of the owner's phones revoked it) reads as revoked here too (#160 phase 4).
        const elsewhere = await markSpentElsewhere(stallPubkey, api).catch(() => 0)
        // A row resumeMinting finished, or whose DM did not land, gets its DM now, the same
        // one the enrol screen sends (#160 round 2). Its setup code is on the row below.
        const sent = await deliver(stallPubkey).catch(() => 0)
        if ((n > 0 || elsewhere > 0 || sent > 0 || resumed.completed > 0 || resumed.cleared > 0) && !cancelled) refresh()
      } catch {
        // Offline, or the wallet is locked. The rows stay waiting.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [stallPubkey, spendApi, transport, deliver, sync, renewals, refresh])
  // Read once per render, from state set in an effect: render stays pure (react-hooks/purity).
  const [nowMs, setNowMs] = useState(() => now())
  useEffect(() => {
    setNowMs(now())
    const timer = setInterval(() => setNowMs(now()), 60_000)
    return () => clearInterval(timer)
  }, [now])
  const queued = renewalsQueued(stallPubkey, nowMs)
  // A live online shop is managed from Settings › Online shop, which connects, renews and
  // disconnects it; here it is one line pointing there. Retired shops stay below, as history.
  const liveShop = terminals.find((t) => t.shop && t.revokedAt === undefined)
  const live = terminals.filter((t) => t.revokedAt === undefined && !t.shop)
  const retired = terminals.filter((t) => t.revokedAt !== undefined)

  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader title="Terminals" subtitle="The devices trading for your stall" />

      {lapsed.map((name) => (
        <div key={name} className="mb-4" data-testid="renewal-lapsed">
          <Alert>{lapsedRenewalMessage(name)}</Alert>
        </div>
      ))}
      {queued > 0 ? (
        <p className="mb-4 text-sm text-mono-500" data-testid="renewals-queued">
          {queued} more to renew. Two can wait for their device at a time;
          renew the next once one has picked up its renewal.
        </p>
      ) : null}

      {live.length === 0 ? (
        <Panel className="mb-6">
          <EmptyRow>
            No terminals yet. Add one from a device to let it take payments for
            your stall.
          </EmptyRow>
        </Panel>
      ) : (
        <ListSection title="In service">
          {live.map((terminal) => (
            <TerminalRow
              key={terminal.terminalPubkey}
              terminal={terminal}
              // Undefined until the check answers, so the row shows no marker
              // rather than briefly accusing a healthy subscription.
              stopped={licence ? !mayServe(licence, terminals, terminal.terminalPubkey).serving : undefined}
              confirming={confirming === terminal.terminalPubkey}
              busy={revoking === terminal.terminalPubkey}
              error={revokeError?.terminal === terminal.terminalPubkey ? revokeError.message : null}
              onAskRevoke={() => setConfirming(terminal.terminalPubkey)}
              onCancel={() => setConfirming(null)}
              onRevoke={() => void revoke(terminal.terminalPubkey)}
              onRemove={() => {
                removeUnmintedWaiting(stallPubkey, terminal.terminalPubkey)
                refresh()
              }}
              now={nowMs}
              renewing={renewing === terminal.terminalPubkey}
              renewError={renewNotice?.terminal === terminal.terminalPubkey ? renewNotice.message : null}
              onRenew={() => void renewOne(terminal.terminalPubkey)}
              setup={
                terminal.status === 'waiting' && terminal.voucherId && terminal.token
                  ? setupCode(stallPubkey, terminal.voucherId)
                  : undefined
              }
            />
          ))}
        </ListSection>
      )}

      {liveShop?.shop ? (
        <Link to="/settings/online-shop" className="mb-6 block" data-testid="online-shop-pointer">
          <Panel className="flex items-center gap-3 p-4 press-row">
            <Store className="h-5 w-5 shrink-0 text-mono-400" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-mono-900 dark:text-mono-50">Online shop: {shopHost(liveShop.shop.url)}</p>
              <p className="text-sm text-mono-500">Managed in Settings › Online shop</p>
            </div>
          </Panel>
        </Link>
      ) : null}

      {retired.length > 0 ? (
        // Kept, not hidden. Their movements are still in the stall's records,
        // and a name with nothing behind it is worse than a name marked
        // retired.
        <ListSection title="No longer in service">
          {retired.map((terminal) => (
            <TerminalRow key={terminal.terminalPubkey} terminal={terminal} now={nowMs} />
          ))}
        </ListSection>
      ) : null}

      {/* The way in, present whether or not the list is empty: an owner adding
          a second till should not have to find a different route than the one
          they used for the first. */}
      <Link to="/settings/terminals/add" className="mt-2 block">
        <Button className="w-full">Add a terminal</Button>
      </Link>

      {/* Says what to do, rather than implying a resume exists somewhere. */}
      <p className="mt-4 text-sm text-mono-500">
        To bring a terminal back, add it again from the device.
      </p>
    </Screen>
  )
}

function TerminalRow({
  terminal,
  stopped,
  confirming = false,
  busy = false,
  error = null,
  onAskRevoke,
  onCancel,
  onRevoke,
  onRemove,
  setup,
  now,
  renewing = false,
  renewError = null,
  onRenew,
}: {
  terminal: TerminalRecord
  /** The clock the expiry badge reads (#160 phase 6). The list passes its own. */
  now: number
  renewing?: boolean
  renewError?: string | null
  onRenew?: () => void
  /** The setup code for a waiting row, so it can be finished after the enrol screen closed. */
  setup?: string
  /** Enrolled and unrevoked, but a lapse has stopped it. Undefined = unknown. */
  stopped?: boolean
  confirming?: boolean
  /** The spend is in flight. */
  busy?: boolean
  /** Why the last revoke did not land, if it did not. */
  error?: string | null
  onAskRevoke?: () => void
  onCancel?: () => void
  onRevoke?: () => void
  /** Removes a phase 0 waiting row, which has nothing minted behind it. */
  onRemove?: () => void
}) {
  const revoked = terminal.revokedAt !== undefined
  const waiting = terminal.status === 'waiting' && !revoked
  const minting = terminal.status === 'minting' && !revoked
  // Rows set up by hand before #160 hold no credential, so they cannot be
  // revoked from here. Offering Revoke would mark a row while the device kept
  // its authority, which is the lie this whole change removes.
  const revocable = isRevocable(terminal) && !minting
  // Phase 0 wrote waiting rows without minting anything. They have no token,
  // nothing to cancel at the mint, and can simply be removed (#160 review).
  const unminted = waiting && !isRevocable(terminal)
  const label = TERMINAL_ROLE_LABELS[terminal.role]
  const bitesAt = revocationBitesAt(terminal)
  // Decision 1 (#160 phase 6): amber within 30 days, red within 7, and past it.
  const expiresAt = !revoked ? currentExpiry(terminal) : undefined
  const band: ExpiryBand = !revoked && (terminal.status === undefined || terminal.status === 'in-service') ? expiryBand(expiresAt, now) : 'ok'
  const legacySeller = needsRenewalToSell(terminal)
  const renewable = isRenewable(terminal) && !terminal.renewal && !!onRenew
  const highlight = band !== 'ok' || legacySeller || terminal.renewRequest !== undefined

  return (
    // Not `press-row`: the row is not a link, and the grey press tint would
    // promise a screen behind it that does not exist.
    <div className={`p-4 ${revoked ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-3">
        {terminal.shop ? (
          <Store className="h-5 w-5 shrink-0 text-mono-400" aria-hidden />
        ) : (
          <Tablet className="h-5 w-5 shrink-0 text-mono-400" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-mono-900 dark:text-mono-50">{terminal.name}</p>
          <p className="text-sm text-mono-500">
            {/* Role, then last use. A terminal that has never traded says so
                rather than showing a blank where a date should be — "never
                used" is the useful answer when an owner is deciding which of
                two devices they have forgotten about. */}
            {label.name} ·{' '}
            {/* A waiting row has never reached its device, so "Never used"
                would read as a till that is ready and idle (#160). */}
            {/* Round 2: the gateway's answer, not just the device's word. A till the
                gateway has not confirmed cannot sell, so it must not read as ready. */}
            {minting
              ? 'Still being set up'
              : terminal.status === 'waiting' && !revoked
              ? 'Waiting for the device'
              : !revoked && terminal.gatewayState === 'unconfirmed'
              ? 'Confirming with the gateway'
              : !revoked && terminal.gatewayState === 'lapsed'
              ? 'Lapsed before it was confirmed'
              : terminal.lastUsedAt
                ? `Last used ${formatDate(terminal.lastUsedAt)}`
                : 'Never used'}
          </p>
          {terminal.shop ? (
            <p className="text-sm text-mono-500" data-testid="shop-line">
              Online shop at {terminal.shop.url}
            </p>
          ) : null}
        </div>
        {renewable && !confirming ? (
          <Button
            variant={highlight ? 'primary' : 'outline'}
            size="sm"
            onClick={onRenew}
            disabled={renewing}
            aria-label={`Renew ${terminal.name}`}
            data-testid={band === 'ok' ? 'renew' : `renew-${band}`}
            className={band === 'red' || band === 'expired' ? '!bg-red-600 !text-white' : band === 'amber' ? '!bg-amber-500 !text-white' : ''}
          >
            {renewing ? 'Renewing…' : 'Renew'}
          </Button>
        ) : null}
        {!revoked && revocable && onAskRevoke && !confirming ? (
          // `size="sm"`: a secondary action beside a name, not the point of the
          // row. Red on the outline rather than a filled red button — the
          // filled one is reserved for the confirmed tap, so the two cannot be
          // mistaken for each other.
          <Button
            variant="outline"
            size="sm"
            onClick={onAskRevoke}
            disabled={busy}
            className="!text-red-600 dark:!text-red-400"
          >
            {/* A waiting row is cancelled, which is the same spend (spec 2.1). */}
            {waiting ? 'Cancel' : 'Revoke'}
          </Button>
        ) : null}
      </div>

      {minting ? (
        <p className="mt-2 text-sm text-mono-500">
          {terminal.defect
            ? 'Its authority came back wrong and could not be cancelled yet. It is cancelled ' +
              'the next time you open this screen with a connection.'
            : 'The gateway has not confirmed it yet. It is finished, or cleared, the next time ' +
              'you open this screen with a connection.'}
        </p>
      ) : unminted ? (
        <div className="mt-2 flex items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-mono-500">
            Nothing was ever sent to this device, so there is nothing to cancel.
          </p>
          {onRemove ? (
            <Button variant="outline" size="sm" onClick={onRemove}>
              Remove
            </Button>
          ) : null}
        </div>
      ) : !revoked && !revocable ? (
        <p className="mt-2 text-sm text-mono-500">
          Set up before revocation existed: add it again to be able to revoke it.
        </p>
      ) : null}

      {band !== 'ok' && expiresAt !== undefined ? (
        <p
          className={`mt-2 text-sm ${band === 'amber' ? 'text-amber-700 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}
          data-testid="expiry-line"
        >
          {band === 'expired'
            ? `${terminal.name} stopped selling on ${formatDate(expiresAt * 1000)}. Renew it.`
            : `${terminal.name} stops on ${formatDate(expiresAt * 1000)}. Renew it.`}
        </p>
      ) : null}
      {terminal.renewal && !revoked ? (
        <p className="mt-2 text-sm text-mono-500" data-testid="renewal-waiting">
          {terminal.renewal.token
            ? `Renewal sent. ${terminal.name} picks it up the next time it is opened.`
            : 'Renewing…'}
        </p>
      ) : null}
      {terminal.renewRequest && !terminal.renewal && !revoked ? (
        <p className="mt-2 text-sm text-amber-700 dark:text-amber-400" data-testid="renew-request">
          {terminal.name} asked to be renewed.
        </p>
      ) : null}
      {renewError ? (
        <div className="mt-2">
          <Alert>{renewError}</Alert>
        </div>
      ) : null}

      {legacySeller ? (
        <p className="mt-2 text-sm text-amber-700 dark:text-amber-400" data-testid="renew-to-sell">
          {RENEW_TO_KEEP_SELLING}
        </p>
      ) : null}

      {!revoked && terminal.gatewayState === 'lapsed' ? (
        <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
          The gateway never confirmed this terminal within 24 hours, so it cannot sell. Revoke it
          and add the device again.
        </p>
      ) : null}

      {waiting && setup ? (
        <details className="mt-2 text-sm text-mono-500">
          <summary className="cursor-pointer">Show the setup code</summary>
          <p className="mt-2 break-all font-mono text-xs" data-testid="row-setup-code">
            {setup}
          </p>
        </details>
      ) : null}

      {error ? (
        <div className="mt-2">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      {revoked && bitesAt !== null ? (
        <p className="mt-2 text-sm text-mono-500">
          Revoked {formatDate(terminal.revokedAt!)} · stops trading by {formatDate(bitesAt)}
        </p>
      ) : null}

      {/* Stopped by a lapse, not revoked — and the wording has to keep those
          apart, because one is the owner's own decision and the other is a
          bill. "Paused" would be wrong twice over: there is no pause in this
          system, and this needs no action on the terminal to undo. */}
      {!revoked && stopped ? (
        <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
          Not trading while your subscription is inactive. Renewing starts it again
          straight away — nothing needs setting up on the device.
        </p>
      ) : null}

      {confirming ? (
        // The warning is here, at the decision, not after it. Amber rather than
        // red: this is a consequence to read, not an error that has happened.
        // `expand-row` rather than `materialize`: this panel is part of the
        // list, so it slides out of the row it belongs to instead of scaling in
        // like a popover floating above the page. Scaling would shrink its text
        // away from the terminal it is asking about. Reduced motion drops it
        // via the shared rule in index.css.
        <div className="expand-row mt-3 rounded-xl bg-amber-50 p-3 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
          <div className="flex gap-2">
            {/* Inherits the panel's amber rather than picking its own, and is
                decorative: the sentence beside it says everything, so a screen
                reader announcing "triangle alert" first would only delay it.
                Same treatment, same colours as the expiry notice — two warnings
                in one app that looked different would read as two systems. */}
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p className="text-sm">{REVOCATION_DELAY_NOTE}</p>
          </div>
          <div className="mt-3 flex gap-2">
            {/* Keeping it comes FIRST and is the plain button. The destructive
                option should never be the one a thumb lands on by habit, and an
                owner who opened this by accident should find the way out where
                they are already looking. */}
            <Button variant="outline" size="sm" onClick={onCancel}>
              Keep it
            </Button>
            {/* Named with the terminal in it, so the last thing read before the
                irreversible tap is WHICH device is being given up. */}
            <Button
              onClick={onRevoke}
              size="sm"
              disabled={busy}
              className="!bg-red-600 !text-white hover:!bg-red-700"
            >
              {busy ? 'Revoking…' : `${waiting ? 'Cancel' : 'Revoke'} ${terminal.name}`}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
