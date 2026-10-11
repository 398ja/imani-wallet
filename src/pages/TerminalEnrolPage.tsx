import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import { Check, Clock } from 'lucide-react'

import { Screen, BackLink, PageHeader, Panel, Button, Input, Alert } from '../components/ui'
import { ScanRecipient } from '../components/ScanRecipient'
import { ALL_TERMINAL_ROLES, TERMINAL_ROLE_LABELS, type TerminalRole } from '../lib/terminalRole'
import { TERMINAL_NAME_MAX_CHARS, checkEnrolment, prepareEnrolment } from '../lib/terminalIssue'
import { licenceStatus } from '../lib/licenceStatus'
import {
  WAITING_TTL_MS,
  enrolledCount,
  holdsLiveCredential,
  recordTerminal,
  updateTerminal,
  waitingTerminals,
} from '../lib/terminalRoster'
import {
  attestEnrolment,
  checkCode,
  formatCheckCode,
  mintTerminalCredential,
  ownerTransport,
  type MintTransport,
} from '../lib/terminalMint'
import { revokeCredential, type CredentialMintApi } from '../lib/credentialRevocation'
import { settleMintFailure } from '../lib/terminalRevoke'
import { legacyApi } from '../lib/legacyBridge'
import { parseVoucherToken } from '../lib/voucherToken'
import {
  DEFAULT_IDLE_LOCK_MINUTES,
  IDLE_LOCK_CHOICES,
  sendCredential,
  setupCode,
  type WrapPublisher,
} from '../lib/terminalDelivery'
import { ownerPublisher } from '../lib/terminalDeliveryNet'
import { getSigner } from '../lib/nap'
import type { StallSigner } from '../lib/ownerAttestation'
import { useOnline } from '../lib/useOnline'
import type { LicenceStatus } from '../lib/licenceStatus'
import { merchantStatus, type MerchantStatus } from '../lib/merchant'
import {
  ENROLMENT_CODE_MESSAGES,
  enrolmentProofHeader,
  readEnrolmentCode,
} from '../lib/terminalEnrolProof'
import { CredentialMintError } from '../lib/terminalMint'

/**
 * The gateway's refusals of the KEY, in the owner's words (inv-terminal-not-merchant). Everything
 * else keeps the message it already had.
 */
function ownerMessageFor(e: unknown): string {
  if (e instanceof CredentialMintError) {
    if (e.code === 'TERMINAL_KEY_NOT_A_TERMINAL') return ENROLMENT_CODE_MESSAGES['not-a-terminal-code']
    if (e.code === 'TERMINAL_KEY_IS_MERCHANT') return ENROLMENT_CODE_MESSAGES.merchant
  }
  return e instanceof Error ? e.message : 'Could not set up the terminal.'
}

/** The stall's key, lent for one wrap, as `signer.withPrivkey` lends it everywhere else. */
const stallSeal = <T,>(borrow: (key: Uint8Array) => T): T => getSigner().withPrivkey(borrow)

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
  publisher = ownerPublisher,
  seal = stallSeal,
  stallSigner = getSigner,
  merchantCheck = merchantStatus,
}: {
  stallPubkey: string
  /** Injected by tests. The owner's NIP-98 signer otherwise. */
  transport?: MintTransport
  /** Injected by tests. Spends a credential that came back wrong. */
  spendApi?: () => Promise<CredentialMintApi>
  /** Injected by tests. Relay plus gateway mirror otherwise. */
  publisher?: WrapPublisher
  /** Injected by tests. Lends the stall's key for sealing the credential DM. */
  seal?: <T>(borrow: (key: Uint8Array) => T) => T
  /** The stall's signer, which attests the till (#160 decision 5). Injected for tests. */
  stallSigner?: () => StallSigner
  /** Best-effort "is this key a merchant" (a stall-record lookup). Injected for tests. */
  merchantCheck?: (pubkey: string) => Promise<MerchantStatus>
}) {
  const navigate = useNavigate()
  const online = useOnline()

  const [name, setName] = useState('')
  // No default role: "a terminal cannot go live without a role" is the ticket's
  // first criterion, and a default would be the app choosing for the owner.
  const [role, setRole] = useState<TerminalRole | null>(null)
  const [terminalPubkey, setTerminalPubkey] = useState<string | null>(null)
  // The device's proof that the scanned key was created as a terminal (inv-terminal-not-merchant).
  const [enrolmentProof, setEnrolmentProof] = useState<string | null>(null)
  // Why the last scan was refused, in the owner's words.
  const [scanRefusal, setScanRefusal] = useState<string | null>(null)
  const lastScanned = useRef<string | null>(null)
  const [licence, setLicence] = useState<LicenceStatus | null>(null)
  const [issued, setIssued] = useState<
    { name: string; code: string; sent: boolean; setup: string } | null
  >(null)
  const [setupQr, setSetupQr] = useState<string | null>(null)

  // The setup code the device scans, as a QR (#160 review). It names this stall and this
  // credential, so the device accepts only the offer this phone sent.
  useEffect(() => {
    if (!issued) return
    let cancelled = false
    void QRCode.toDataURL(issued.setup, { width: 512, margin: 1 }).then(
      (url) => !cancelled && setSetupQr(url),
      () => !cancelled && setSetupQr(null),
    )
    return () => {
      cancelled = true
    }
  }, [issued])
  // Decision 2 on #160: the owner chooses the idle lock, 10 minutes by default,
  // and may switch it off. It travels to the device in the credential DM.
  const [idleLock, setIdleLock] = useState<number>(DEFAULT_IDLE_LOCK_MINUTES)
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

  /**
   * A scanned or typed code (inv-terminal-not-merchant). Only a device's terminal setup code, signed
   * by the key it names, is accepted: an npub, hex key or handle is somebody's account, and making
   * an account a till is exactly what the owner ruled out. Then, best effort, a key that already
   * trades as a merchant is refused here, so the owner is told before anything is signed. The
   * gateway checks both again and is the authority.
   */
  const onScanned = (text: string): boolean => {
    // The camera reports the same code on every frame: one lookup per code.
    if (text === lastScanned.current) return true
    lastScanned.current = text
    setScanRefusal(null)
    const read = readEnrolmentCode(text)
    if (typeof read === 'string') {
      setScanRefusal(ENROLMENT_CODE_MESSAGES[read])
      return true
    }
    if (read.terminalPubkey === stallPubkey.toLowerCase()) {
      setScanRefusal('That is your own stall. Scan the code on the other device.')
      return true
    }
    const key = read.terminalPubkey
    void merchantCheck(key).then((status) => {
      if (status === 'merchant') {
        setScanRefusal(ENROLMENT_CODE_MESSAGES.merchant)
        return
      }
      setTerminalPubkey(key)
      setEnrolmentProof(enrolmentProofHeader(read))
    })
    return true
  }

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
    const prepared = {
      ...prepareEnrolment(request, context),
      idleLockMinutes: idleLock,
      ...(enrolmentProof ? { enrolmentProof } : {}),
    }
    setBusy(true)
    setFailure(null)
    const mintKey = crypto.randomUUID()
    const startedAt = Date.now()
    let credential: typeof prepared
    try {
      // The stall's own consent to this till (#160 decision 5): signed here, once, with the key
      // that signs `merchant` warrants, before anything is sent. Every customer's wallet checks
      // it, so a till minted without it could never sell.
      credential = { ...prepared, attestation: attestEnrolment(prepared, stallSigner(), startedAt) }
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
        // With the key, so a resumed mint re-sends this exact body (spec 4.6.2).
        attestation: credential.attestation,
        ...(credential.enrolmentProof ? { enrolmentProof: credential.enrolmentProof } : {}),
        idleLockMinutes: idleLock,
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
        idleLockMinutes: idleLock,
      }))
      // Phase 2: hand it to the device by NIP-17 DM, sealed by the stall. A DM
      // that did not land leaves the row waiting, and the screen says so: the
      // owner can cancel it and add the device again.
      const sent = await sendCredential(
        {
          voucherId: minted.voucherId,
          token: minted.token,
          stallPubkey,
          name: credential.name,
          idleLockMinutes: idleLock,
        },
        credential.lockedTo,
        seal,
        publisher,
      ).catch(() => false)
      // Remembered, so the Terminals list re-sends a DM that did not land (#160 round 2).
      updateTerminal(stallPubkey, credential.lockedTo, (row) => ({ ...row, delivered: sent }))
      setIssued({
        name: credential.name,
        code: formatCheckCode(checkCode(minted.voucherId, stallPubkey, credential.lockedTo)),
        sent,
        setup: setupCode(stallPubkey, minted.voucherId),
      })
    } catch (e) {
      // Shared with resumeMinting: only a definitive 4xx forgets the row (#160 round 2).
      await settleMintFailure(stallPubkey, credential.lockedTo, e)
      setFailure(ownerMessageFor(e))
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
          subtitle={issued.sent ? `Sent to ${issued.name}` : `${issued.name}'s authority is ready`}
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
                {issued.sent
                  ? 'Finish on that device: scan the setup code below with it, check it shows the ' +
                    'same check code, and set a passphrase. '
                  : 'It could not be sent to the device. Cancel it from your terminal list and add the device again. '}
                It cannot take payments until then. Its row says{' '}
                <span className="font-medium">Waiting for the device</span> and is cancelled
                automatically after 24 hours.
              </p>
            </div>
          </div>
        </Panel>
        {issued.sent ? (
          <Panel className="mb-6 p-4">
            <p className="mb-3 text-sm text-mono-500">
              Setup code. The device only accepts the authority this code names, so nobody else
              can slip in their own.
            </p>
            {setupQr ? (
              <div className="mb-3 flex justify-center">
                <img src={setupQr} alt="Terminal setup code" className="w-full max-w-xs rounded-2xl bg-white p-4" />
              </div>
            ) : null}
            <p className="break-all text-center font-mono text-xs text-mono-500" data-testid="setup-code">
              {issued.setup}
            </p>
          </Panel>
        ) : null}
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
            // Capped (review rw1): the name rides in every warrant this till builds.
            maxLength={TERMINAL_NAME_MAX_CHARS}
            onChange={(e) => setName(e.target.value)}
            placeholder="Front counter"
          />
          <p className="mt-1.5 text-xs text-mono-500">
            So you can tell your devices apart later.
          </p>
        </div>

        <RolePicker value={role} onChange={setRole} />

        {/* Decision 2 on #160. On top of the 12-hour session: an unattended till
            locks itself after this long with no touch. */}
        <div>
          <label
            htmlFor="idle-lock"
            className="mb-2 block text-sm font-medium text-mono-700 dark:text-mono-300"
          >
            Lock when idle
          </label>
          <select
            id="idle-lock"
            value={idleLock}
            onChange={(e) => setIdleLock(Number(e.target.value))}
            className="w-full rounded-xl border border-mono-200 bg-transparent p-3 text-mono-900 dark:border-mono-800 dark:text-mono-50"
          >
            {IDLE_LOCK_CHOICES.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? 'Never' : `After ${m} minutes`}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-mono-500">
            The terminal asks for its passphrase again after this long untouched.
          </p>
        </div>

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
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setTerminalPubkey(null)
                  setEnrolmentProof(null)
                  lastScanned.current = null
                }}
              >
                Rescan
              </Button>
            </div>
          ) : (
            <>
              <ScanRecipient
                onFound={() => {}}
                onText={onScanned}
                selfPubkey={stallPubkey}
                manualLabel="Or enter the device's code"
              />
              {scanRefusal ? (
                <div className="mt-3">
                  <Alert>{scanRefusal}</Alert>
                </div>
              ) : null}
            </>
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
