import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Clock } from 'lucide-react'

import { formatDate } from '../lib/format'
import { noticeFor, noticeText, NOTICE_URGENCY, type ExpiryNotice } from '../lib/expiryNotice'
import { licenceStatus } from '../lib/licenceStatus'
import { onWalletChanged } from '../lib/wallet'

/**
 * "Your subscription ends in 5 days" — at the till, where the owner is.
 *
 * ## Why this is a strip and not a toast, a modal or a dialog
 *
 * The ticket is explicit: "Neither blocks, modals over, or interrupts anything
 * in progress." That is a structural requirement, not a styling one, so this
 * renders as an ordinary block in the document flow with no portal, no overlay,
 * no focus trap and no dismiss control. There is nothing here that CAN capture a
 * tap meant for the Sell button, because there is no layer over anything.
 *
 * A toast was rejected for the same reason: toasts appear over content and
 * steal the tap that was already on its way to whatever they cover. A merchant
 * mid-sale must never lose a press to a billing message.
 *
 * ## Why it has no dismiss button
 *
 * Dismissing would hide the one warning before a lapse, and the person who
 * dismisses on day seven is precisely the one who needs it on day one. It
 * clears the only way that means anything: by the subscription being renewed.
 * `noticeFor` is derived from the signed expiry, so a renewal removes this on
 * the next render with nothing to reset.
 *
 * ## Why it is quiet
 *
 * Amber and small. This is information a week ahead of a consequence that does
 * not stop trade — the extra tills go, the stall keeps selling — so alarm
 * styling would misrepresent it and train the owner to ignore the next one.
 */
export function SubscriptionNotice({ pubkey }: { pubkey: string }) {
  const [notice, setNotice] = useState<ExpiryNotice | null>(null)

  useEffect(() => {
    let live = true

    const check = async () => {
      // Failures are swallowed to null. A banner is the least important thing
      // on this screen, and one that could throw would take the till down over
      // a billing reminder.
      try {
        const status = await licenceStatus({ pubkey })
        if (live) setNotice(noticeFor(status, Math.floor(Date.now() / 1000)))
      } catch {
        if (live) setNotice(null)
      }
    }

    void check()
    // A renewal arrives by DM into the same store, so this is how the banner
    // learns to disappear without anyone reloading.
    const stop = onWalletChanged(() => void check())
    return () => {
      live = false
      stop()
    }
  }, [pubkey])

  if (!notice) return null

  const lastDay = notice.urgency === NOTICE_URGENCY.LAST_DAY

  return (
    <Link
      to="/settings/subscription"
      // A link, not a button with a handler: the whole strip goes to the screen
      // that can explain it, and a plain navigation cannot swallow a gesture the
      // way an interactive overlay can.
      //
      // `pressable`, NOT `press-row`. The house press-row carries a press with a
      // grey tint, which is right for a divided list and wrong here: laid over
      // amber it reads as the banner going muddy rather than as a press. This
      // strip has its own colour and its own rounded edges with nothing to clip
      // against, so it takes the scale-and-dim feedback instead — which is also
      // the one that already answers `prefers-reduced-motion`.
      className={`pressable mb-4 flex items-center gap-3 rounded-xl p-3 text-sm ${
        lastDay
          ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
          : 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300'
      }`}
    >
      {/* Decorative: the sentence beside it already says everything, and a
          screen reader announcing "clock" first would only delay it. */}
      <Clock className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0">{noticeText(notice, formatDate(notice.expiresAt))}</span>
    </Link>
  )
}
