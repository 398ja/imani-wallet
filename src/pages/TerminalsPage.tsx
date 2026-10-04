import { useCallback, useEffect, useState } from 'react'
import { Tablet, TriangleAlert } from 'lucide-react'

import { Screen, BackLink, PageHeader, Panel, ListSection, Button, EmptyRow, Alert } from '../components/ui'
import { Link } from 'react-router-dom'
import { licenceStatus, type LicenceStatus } from '../lib/licenceStatus'
import { mayServe } from '../lib/lapseService'
import { formatDate } from '../lib/format'
import { TERMINAL_ROLE_LABELS } from '../lib/terminalRole'
import {
  REVOCATION_DELAY_NOTE,
  allTerminals,
  isRevocable,
  revocationBitesAt,
  type TerminalRecord,
} from '../lib/terminalRoster'
import { cancelExpiredWaiting, revokeTerminalAtMint } from '../lib/terminalRevoke'
import type { CredentialMintApi } from '../lib/credentialRevocation'
import { legacyApi } from '../lib/legacyBridge'

/** The owner's spend client, the one `burn.ts` and decommissioning use. */
async function ownerSpendApi(): Promise<CredentialMintApi> {
  return (await legacyApi()) as unknown as CredentialMintApi
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
}: {
  stallPubkey: string
  /** Injected by tests. Spends a credential with the stall's key. */
  spendApi?: () => Promise<CredentialMintApi>
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
    })
    return () => {
      cancelled = true
    }
  }, [stallPubkey])

  const refresh = useCallback(() => setTerminals(allTerminals(stallPubkey)), [stallPubkey])

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

  // Waiting rows past their 24 hours are cancelled when this screen opens
  // (decision 4 on #160). Best effort: one that does not land stays waiting and
  // is tried again next time, and nothing here blocks the list from showing.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const n = await cancelExpiredWaiting(stallPubkey, await spendApi())
        if (n > 0 && !cancelled) refresh()
      } catch {
        // Offline, or the wallet is locked. The rows stay waiting.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [stallPubkey, spendApi, refresh])
  const live = terminals.filter((t) => t.revokedAt === undefined)
  const retired = terminals.filter((t) => t.revokedAt !== undefined)

  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader title="Terminals" subtitle="The devices trading for your stall" />

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
            />
          ))}
        </ListSection>
      )}

      {retired.length > 0 ? (
        // Kept, not hidden. Their movements are still in the stall's records,
        // and a name with nothing behind it is worse than a name marked
        // retired.
        <ListSection title="No longer in service">
          {retired.map((terminal) => (
            <TerminalRow key={terminal.terminalPubkey} terminal={terminal} />
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
}: {
  terminal: TerminalRecord
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
}) {
  const revoked = terminal.revokedAt !== undefined
  const waiting = terminal.status === 'waiting' && !revoked
  // Rows set up by hand before #160 hold no credential, so they cannot be
  // revoked from here. Offering Revoke would mark a row while the device kept
  // its authority, which is the lie this whole change removes.
  const revocable = isRevocable(terminal)
  const label = TERMINAL_ROLE_LABELS[terminal.role]
  const bitesAt = revocationBitesAt(terminal)

  return (
    // Not `press-row`: the row is not a link, and the grey press tint would
    // promise a screen behind it that does not exist.
    <div className={`p-4 ${revoked ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-3">
        <Tablet className="h-5 w-5 shrink-0 text-mono-400" aria-hidden />
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
            {terminal.status === 'waiting' && !revoked
              ? 'Waiting for the device'
              : terminal.lastUsedAt
                ? `Last used ${formatDate(terminal.lastUsedAt)}`
                : 'Never used'}
          </p>
        </div>
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

      {!revoked && !revocable ? (
        <p className="mt-2 text-sm text-mono-500">
          Set up before revocation existed: add it again to be able to revoke it.
        </p>
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
