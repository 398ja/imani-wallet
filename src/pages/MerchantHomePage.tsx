import { useNavigate } from 'react-router-dom'
import { Clock, QrCode, Send, ShieldOff } from 'lucide-react'

import { Button, Screen } from '../components/ui'
import type { Actor } from '../lib/actor'
import {
  LAPSE,
  type LapseReason,
  canIssueNow,
  canRedeemNow,
  sessionState,
  type TerminalSession,
} from '../lib/terminalSession'

/**
 * Home, for a merchant: the till.
 *
 * Two buttons and nothing else. It used to open on the balance panel, three
 * recent movements and anything expiring — which is a fair summary of the
 * business and exactly the wrong thing to have on screen while a customer is
 * standing in front of you. A till is held facing outward: whoever is being
 * served can read what the merchant is holding, what they owe, and what they
 * last took in, from across the counter. All of it moved to the Dashboard,
 * which is a menu tap away and opened on purpose.
 *
 * Centred rather than top-aligned for the same reason a card reader is: the two
 * things you press all day should be under the thumb, not under the header.
 *
 * Nothing here reads the wallet any more, so there is no `onWalletChanged`
 * subscription either — the screens that show money keep their own.
 *
 * ## What a terminal sees (ticket 07)
 *
 * A redemption-only terminal has no Sell. The hiding is the COURTESY: the same
 * request made around this screen is refused by `issueAndDeliver`, which asks
 * `canIssueNow` — the identical question this screen asks. Two different
 * questions would make the button the only thing standing between a lapsed
 * terminal and minting money.
 *
 * An owner passes no actor and sees exactly what they always saw. That is the
 * ticket's fifth criterion, and it holds because the owner path never acquires
 * a session that could lapse.
 *
 * ## A REFUSED terminal is not an owner
 *
 * `refusal` exists because "no actor" was doing two jobs and they are opposite
 * ones. A device with no credential is the stall's own and gets the full till;
 * a device whose credential was REJECTED — revoked, or locked to another
 * device — also had no actor, and so was handed the same full till. A revoked
 * terminal could sell.
 *
 * Passing the refusal makes that impossible to express: the message is the
 * only thing rendered, and the buttons are never reached.
 */
export function MerchantHomePage({
  actor,
  session,
  refusal,
}: {
  /** The terminal acting for this stall. Absent on the owner's own device. */
  actor?: Actor
  session?: TerminalSession | null
  /**
   * Why this device was refused, if it holds a credential that did not check
   * out. Never set on the owner's own device, which holds no credential.
   */
  refusal?: string | null
} = {}) {
  const navigate = useNavigate()

  if (refusal) {
    // Before anything else, and returning early so no code path below can
    // reach the buttons. A refused terminal is told why and offered nothing.
    return <NotTrading message={refusal} reason={LAPSE.REVOKED} />
  }

  // No actor is the owner's own device, which is the overwhelmingly common
  // case and must behave exactly as before.
  const lapse = actor?.kind === 'terminal' ? sessionState(session ?? null) : null

  if (lapse && !lapse.live) {
    /**
     * Said ONCE, and then nothing is offered.
     *
     * The alternative — leaving the buttons up and failing on each press — is
     * what the ticket rules out, because it leaves staff guessing whether to
     * retry while a customer waits. A terminal that cannot serve should look
     * like a terminal that cannot serve.
     */
    return <NotTrading message={lapse.message} reason={lapse.reason} />
  }

  const mayIssue = actor ? canIssueNow(actor, session ?? null) : true
  const mayRedeem = actor ? canRedeemNow(actor, session ?? null) : true

  return (
    <Screen>
      {/* Minus the header and the page padding, so the buttons sit on the
          middle of what is actually visible. svh, not vh: on a phone browser
          vh is the chrome-less height and the pair would sit low. */}
      <div className="flex min-h-[calc(100svh-9rem)] flex-col justify-center">
        {/* One button goes full width rather than leaving a gap where the other
            was. A redemption terminal is not a broken till with a missing half;
            it is a device whose whole job is the one button it has. */}
        <div className={`grid gap-3 ${mayIssue && mayRedeem ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {mayIssue ? (
            <Button size="lg" onClick={() => navigate('/sell')}>
              <Send className="mr-2 h-5 w-5" aria-hidden /> Sell
            </Button>
          ) : null}
          {mayRedeem ? (
            <Button
              size="lg"
              // Outline only when it sits beside Sell. Alone it is the primary
              // action of the screen and should look like one.
              variant={mayIssue ? 'outline' : 'primary'}
              onClick={() => navigate('/redeem')}
            >
              <QrCode className="mr-2 h-5 w-5" aria-hidden /> Redeem
            </Button>
          ) : null}
        </div>
      </div>
    </Screen>
  )
}

/**
 * The screen a terminal that cannot serve shows, and nothing else.
 *
 * One component for both ways a terminal stops — a session that lapsed, and a
 * credential that was refused — because they look identical to whoever is
 * holding the device: it will not serve, and the owner is the answer. Two
 * screens would drift, and the one seen less often would drift further.
 */
function NotTrading({ message, reason }: { message: string; reason: LapseReason }) {
  return (
    <Screen>
      <div className="flex min-h-[calc(100svh-9rem)] flex-col justify-center">
        {/* `aria-live="polite"` alongside the role, matching RedeemPage and
            SendPage. Polite, not assertive: staff may be looking at the
            customer when the day rolls over, and this should reach them at the
            next pause rather than cutting across what they are hearing.

            Amber, not red. A terminal whose day has ended is the most routine
            event in the system — it happens to every device every day — and
            dressing it as an error would teach staff to ignore the colour. */}
        {/* `p-6`, not `p-4`: this panel is the entire screen rather than a
            strip within one, and a bigger surface reads as thicker. Same amber
            as the expiry notice and the owner's lapse marker, so all three
            read as one system saying the same kind of thing. */}
        <div
          role="status"
          aria-live="polite"
          className="rounded-2xl bg-amber-50 p-6 text-center text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
        >
          {/* The mark matches the REASON. A clock for the day rolling over,
              which is routine and fixes itself; a struck-through shield for a
              terminal that has lost its authority, which does not. One icon for
              both would make the routine case look permanent and the permanent
              case look like something to wait out. */}
          {reason === LAPSE.EXPIRED ? (
            <Clock className="mx-auto mb-3 h-7 w-7" aria-hidden />
          ) : (
            <ShieldOff className="mx-auto mb-3 h-7 w-7" aria-hidden />
          )}
          {/* `text-balance` so the heading and the sentence break evenly rather
              than leaving one word alone on the last line. This is the only
              thing on the screen, so its typesetting is the whole screen. */}
          <p className="text-balance text-lg font-medium">Not trading</p>
          <p className="mx-auto mt-1.5 max-w-xs text-pretty text-sm leading-relaxed">
            {message}
          </p>
        </div>
      </div>
    </Screen>
  )
}
