import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check } from 'lucide-react'

import { Screen, BackLink, PageHeader, Panel, Button, Input, Alert } from '../components/ui'
import { ScanRecipient } from '../components/ScanRecipient'
import { ALL_TERMINAL_ROLES, TERMINAL_ROLE_LABELS, type TerminalRole } from '../lib/terminalRole'
import { checkEnrolment, prepareEnrolment } from '../lib/terminalIssue'
import { licenceStatus } from '../lib/licenceStatus'
import { enrolledCount, recordTerminal } from '../lib/terminalRoster'
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
export function TerminalEnrolPage({ stallPubkey }: { stallPubkey: string }) {
  const navigate = useNavigate()
  const online = useOnline()

  const [name, setName] = useState('')
  // No default role: "a terminal cannot go live without a role" is the ticket's
  // first criterion, and a default would be the app choosing for the owner.
  const [role, setRole] = useState<TerminalRole | null>(null)
  const [terminalPubkey, setTerminalPubkey] = useState<string | null>(null)
  const [licence, setLicence] = useState<LicenceStatus | null>(null)
  const [issued, setIssued] = useState<string | null>(null)

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
  const check = licence
    ? checkEnrolment(request, {
        stallPubkey,
        licence,
        enrolledCount: enrolledCount(stallPubkey),
        online,
      })
    : null

  const enrol = () => {
    if (!licence) return
    const credential = prepareEnrolment(request, {
      stallPubkey,
      licence,
      enrolledCount: enrolledCount(stallPubkey),
      online,
    })

    // Recorded on the OWNER's device at the moment authority is created, with
    // what is needed to revoke it later. Ticket 06's third criterion depends on
    // this happening HERE: if the secret were only kept by the terminal, a lost
    // device could never be revoked, which is the case that matters most.
    recordTerminal(stallPubkey, {
      terminalPubkey: credential.lockedTo,
      name: credential.name,
      role: credential.role,
      enrolledAt: Date.now(),
    })

    setIssued(credential.name)
  }

  if (issued) {
    return (
      <Screen>
        <BackLink to="/settings/terminals" label="Terminals" />
        <PageHeader title="Terminal added" subtitle={`${issued} can now trade for your stall`} />
        <Panel className="mb-6 p-4">
          <div className="flex items-start gap-3">
            <Check className="h-6 w-6 shrink-0 text-green-600" aria-hidden />
            <p className="text-sm text-mono-500">
              Finish on the other device by entering a passphrase there. You can
              revoke this terminal at any time from your terminal list, even if
              the device is lost.
            </p>
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

      <Button onClick={enrol} disabled={!check?.ready}>
        Add terminal
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
