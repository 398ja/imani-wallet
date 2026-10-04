import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Clock } from 'lucide-react'

import { Screen, BackLink, PageHeader, Panel, Button, Input, Alert } from '../components/ui'
import { ScanRecipient } from '../components/ScanRecipient'
import { ALL_TERMINAL_ROLES, TERMINAL_ROLE_LABELS, type TerminalRole } from '../lib/terminalRole'
import { checkEnrolment, prepareEnrolment } from '../lib/terminalIssue'
import { licenceStatus } from '../lib/licenceStatus'
import {
  WAITING_TTL_MS,
  enrolledCount,
  forgetTerminal,
  holdsLiveCredential,
  recordTerminal,
  updateTerminal,
  waitingTerminals,
} from '../lib/terminalRoster'
import {
  CredentialMintError,
  checkCode,
  formatCheckCode,
  mintTerminalCredential,
  ownerTransport,
  type MintTransport,
} from '../lib/terminalMint'
import { revokeCredential, type CredentialMintApi } from '../lib/credentialRevocation'
import { legacyApi } from '../lib/legacyBridge'
import { parseVoucherToken } from '../lib/voucherToken'
import { useOnline } from '../lib/useOnline'
import type { LicenceStatus } from '../lib/licenceStatus'

/**
 * Putting a device on the counter: name it, choose what it may do, scan it.
 *
 * Terminals ticket 05's screen. All the rules live in `terminalIssue.ts` and
 * are already tested there; this is the form, and it is deliberately thin —
 * anything it decided for itself would be a second place the rules live.
 *
 * ## The order is the owner's order
 *
 * Name, then role, then scan. Scanning is last because it is the only step that
 * needs the other device present and pointed at this screen: asking for it
 * first would make the owner hold two devices while typing.
 *
 * ## Nothing is issued until the owner confirms
 *
 * A scan fills in the key; it does not enrol. The QR is safe to observe, so a
 * camera that catches a code across a market must not thereby create authority
 * — the confirmation is what makes enrolling an act rather than an accident.
 *
 * ## Connectivity is stated before the attempt
 *
 * Enrolment is an online act with no degraded path, and the spec rules out
 * pre-issuing unassigned credentials, which would be bearer authorities to the
 * stall sitting in a drawer. So an offline owner is told plainly, up front,
 * rather than after filling in the form.
 */
/** The owner's spend client, the one `burn.ts` and decommissioning use. */
async function ownerSpendApi(): Promise<CredentialMintApi> {
  return (await legacyApi()) as unknown as CredentialMintApi
}

export function TerminalEnrolPage({
  stallPubkey,
  transport = ownerTransport,
  spendApi = ownerSpendApi,
}: {
  stallPubkey: string
  /** Injected by tests. The owner's NIP-98 signer otherwise. */
  transport?: MintTransport
  /** Injected by tests. Spends a credential that came back wrong. */
  spendApi?: () => Promise<CredentialMintApi>
}) {
  const navigate = useNavigate()
  const online = useOnline()

  const [name, setName] = useState('')
  // No default role: "a terminal cannot go live without a role" is the ticket's
  // first criterion, and a default would be the app choosing for the owner.
  const [role, setRole] = useState<TerminalRole | null>(null)
  const [terminalPubkey, setTerminalPubkey] = useState<string | null>(null)
  const [licence, setLicence] = useState<LicenceStatus | null>(null)
  const [issued, setIssued] = useState<{ name: string; code: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // The gate is consulted with the real check, not a cached flag, so an owner
  // whose subscription lapsed while this screen was open is refused here rather
  // than at the mint.
  //
  // `cancelled` because the check is a promise and this screen is short-lived:
  // an owner who backs out mid-check would otherwise write state into an
  // unmounted component, and the same guard drops a stale answer if the stall
  // changes while one is in flight.
  useEffect(() => {
    let cancelled = false
    void licenceStatus({ pubkey: stallPubkey }).then((status) => {
      if (!cancelled) setLicence(status)
    })
    return () => {
      cancelled = true
    }
  }, [stallPubkey])

  const request = { name, role, terminalPubkey: terminalPubkey ?? '' }
  const context = licence
    ? {
        stallPubkey,
        licence,
        enrolledCount: enrolledCount(stallPubkey),
        waitingCount: waitingTerminals(stallPubkey).length,
        alreadyLive: terminalPubkey ? holdsLiveCredential(stallPubkey, terminalPubkey) : false,
        online,
      }
    : null
  const check = context ? checkEnrolment(request, context) : null

  /**
   * Mint the credential from this phone, check it, and keep it (#160 phase 1).
   *
   * One request to the gateway, signed by the stall's own key, then a check of
   * the token's own bytes. A credential that came back wrong is spent at once
   * and nothing is recorded. Only a credential that is right reaches the roster,
   * with its token, which is what revoking it later spends.
   */
  const enrol = async () => {
    if (!context || busy) return
    const credential = prepareEnrolment(request, context)
    setBusy(true)
    setFailure(null)
    const mintKey = crypto.randomUUID()
    const startedAt = Date.now()
    try {
      // Written BEFORE the request leaves this phone (#160 review). If the
      // gateway mints but its answer, or the token, never arrives, this row is
      // what lets the next open of Terminals finish the job or cancel it,
      // instead of a live credential nobody on this phone knows about.
      recordTerminal(stallPubkey, {
        terminalPubkey: credential.lockedTo,
        name: credential.name,
        role: credential.role,
        enrolledAt: startedAt,
        status: 'minting',
        mintKey,
        waitingUntil: startedAt + WAITING_TTL_MS,
      })
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Could not set up the terminal.')
      setBusy(false)
      return
    }
    try {
      const minted = await mintTerminalCredential(
        credential,
        async (token) => {
          const metadata = parseVoucherToken(token).voucher.merchantMetadata
          const out = await revokeCredential(token, metadata, await spendApi())
          return out.revoked || out.reason === 'already-revoked'
        },
        transport,
        {
          idempotencyKey: mintKey,
          onAccepted: (voucherId) =>
            updateTerminal(stallPubkey, credential.lockedTo, (row) => ({ ...row, voucherId })),
        },
      )
      const now = Date.now()
      // Recorded on the OWNER's device, with the token revocation spends. If
      // the token were only kept by the terminal, a lost device could never be
      // revoked, which is the case that matters most.
      updateTerminal(stallPubkey, credential.lockedTo, (row) => ({
        ...row,
        // Waiting, not in service: the device has not confirmed it, and it
        // cannot trade until it has (#160). Cancelled after 24 hours.
        status: 'waiting',
        token: minted.token,
        voucherId: minted.voucherId,
        enrolledAt: now,
        waitingUntil: now + WAITING_TTL_MS,
        mintKey: undefined,
      }))
      setIssued({
        name: credential.name,
        code: formatCheckCode(checkCode(minted.voucherId, stallPubkey, credential.lockedTo)),
      })
    } catch (e) {
      settleFailedMint(stallPubkey, credential.lockedTo, e)
      setFailure(e instanceof Error ? e.message : 'Could not set up the terminal.')
    } finally {
      setBusy(false)
    }
  }

  if (issued) {
    return (
      <Screen>
        <BackLink to="/settings/terminals" label="Terminals" />
        {/* What is true, and nothing more (#160 phase 0). This screen used to
            say the terminal "can now trade for your stall" when no call had
            been made and nothing had reached the device. It is on the owner's
            list, waiting for its device, and that is all. */}
        <PageHeader
          title="Waiting for the device"
          subtitle={`${issued.name}'s authority is ready`}
        />
        <Panel className="mb-6 p-4">
          <div className="flex items-start gap-3">
            <Clock className="h-6 w-6 shrink-0 text-amber-600" aria-hidden />
            <div className="text-sm text-mono-500">
              <p>
                Check code <span className="font-mono font-medium text-mono-900 dark:text-mono-50">{issued.code}</span>.
                The device will show the same code when it receives its authority.
              </p>
              <p className="mt-2">
                It cannot take payments yet. It needs to be finished on that device,
                with a passphrase set there, and that step is not available in this
                version. Its row says <span className="font-medium">Waiting for the device</span>{' '}
                until then, and is cancelled automatically after 24 hours.
              </p>
            </div>
          </div>
        </Panel>
        <Button onClick={() => navigate('/settings/terminals')}>Done</Button>
      </Screen>
    )
  }

  return (
    <Screen>
      <BackLink to="/settings/terminals" label="Terminals" />
      <PageHeader title="Add a terminal" subtitle="A device that takes payments for your stall" />

      {/* Up front, not after the form. Enrolment has no offline path, so an
          owner in a market with no signal should learn that before typing.

          Deliberately NOT an `Alert`: this is a standing condition present on
          arrival, not a response to something the owner did. `role="alert"` is
          assertive and would interrupt a screen-reader user mid-heading to
          announce a state they have not acted on yet. The refusal below the
          form, which IS a response, keeps the role. */}
      {!online ? (
        <p className="mb-6 rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
          Adding a terminal needs a connection. Set your terminals up before the
          market opens, while you still have signal.
        </p>
      ) : null}

      <div className="mb-6 space-y-6">
        <div>
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Front counter"
          />
          <p className="mt-1.5 text-xs text-mono-500">
            So you can tell your devices apart later.
          </p>
        </div>

        <RolePicker value={role} onChange={setRole} />

        <div>
          <span className="mb-2 block text-sm font-medium text-mono-700 dark:text-mono-300">
            Scan the code on the other device
          </span>
          {terminalPubkey ? (
            // Confirmed by sight, not by hex. The owner cannot verify 64
            // characters, so showing them would be theatre; what they can
            // verify is that a device was scanned and which one they meant.
            //
            // "Scan a different one" is not optional politeness. Two devices on
            // a counter showing similar codes is the ordinary case, and without
            // a way back the only remedy for the wrong scan would be to leave
            // the screen and start again — or worse, to shrug and enrol the
            // wrong device.
            <div className="expand-row flex items-center gap-3 rounded-xl bg-mono-100 p-3 dark:bg-mono-900">
              <Check className="h-5 w-5 shrink-0 text-green-600" aria-hidden />
              <p className="min-w-0 flex-1 text-sm text-mono-500">
                Device scanned. Check it is the one in your hand.
              </p>
              <Button variant="ghost" size="sm" onClick={() => setTerminalPubkey(null)}>
                Rescan
              </Button>
            </div>
          ) : (
            <ScanRecipient
              onFound={setTerminalPubkey}
              selfPubkey={stallPubkey}
              manualLabel="Or enter the device's key"
            />
          )}
        </div>
      </div>

      {/* The refusal, in the words the rules chose. Shown only once the owner
          has started, so an untouched form is not scolded for being empty. */}
      {check && !check.ready && (name || role || terminalPubkey) ? (
        <Alert>{check.message}</Alert>
      ) : null}
      {failure ? <Alert>{failure}</Alert> : null}

      <Button onClick={() => void enrol()} disabled={!check?.ready || busy}>
        {busy ? 'Setting up…' : 'Add terminal'}
      </Button>
    </Screen>
  )
}

/**
 * What the `minting` row becomes when the mint did not finish cleanly.
 *
 * - The gateway refused outright (any HTTP status), or the credential came back
 *   wrong and was spent: nothing is live, so the row is removed.
 * - The credential came back wrong and the spend did not land: the row keeps
 *   the token and the defect, so the next open retries the spend.
 * - Anything else (the request or the token poll did not answer): it may have
 *   been minted, so the row stays `minting` and is resumed on the next open.
 */
function settleFailedMint(stallPubkey: string, terminalPubkey: string, error: unknown): void {
  if (error instanceof CredentialMintError && error.unspentToken) {
    const token = error.unspentToken
    updateTerminal(stallPubkey, terminalPubkey, (row) => ({
      ...row,
      token,
      defect: error.defect,
    }))
    return
  }
  if (error instanceof CredentialMintError && (error.status !== undefined || error.defect)) {
    forgetTerminal(stallPubkey, terminalPubkey)
  }
}

/**
 * What this terminal is allowed to do.
 *
 * Cards rather than a select, because the choice is the security decision of
 * the whole flow and each option needs a sentence. A dropdown would hide the
 * hint behind a tap, which is how an owner ends up giving a door device the
 * ability to sell.
 *
 * The catalog is fixed and comes from `terminalRole.ts` — the roles and their
 * wording are tested there, so a role added later appears here automatically
 * rather than needing a second edit somebody forgets.
 */
function RolePicker({
  value,
  onChange,
}: {
  value: TerminalRole | null
  onChange: (role: TerminalRole) => void
}) {
  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-mono-700 dark:text-mono-300">
        What it can do
      </span>
      <div className="space-y-2">
        {ALL_TERMINAL_ROLES.map((role) => {
          const label = TERMINAL_ROLE_LABELS[role]
          const active = value === role
          return (
            <button
              key={role}
              type="button"
              onClick={() => onChange(role)}
              // `aria-pressed` rather than a visual-only selection: the border
              // and tint carry it for sighted users, and colour is never the
              // only thing saying which is chosen.
              aria-pressed={active}
              className={`pressable block w-full rounded-xl border p-3 text-left ${
                active
                  ? 'border-mono-900 bg-mono-100 dark:border-mono-50 dark:bg-mono-900'
                  : 'border-mono-200 hover:bg-mono-100 dark:border-mono-800 dark:hover:bg-mono-900'
              }`}
            >
              <span className="block font-medium text-mono-900 dark:text-mono-50">
                {label.name}
              </span>
              <span className="block text-sm text-mono-500">{label.hint}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
