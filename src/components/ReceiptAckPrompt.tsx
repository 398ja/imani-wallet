import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { BadgeCheck } from 'lucide-react'

import { onReceiptsChanged, receiptsAwaitingAnswer, setReceiptAcknowledgement } from '../lib/receipts'

/**
 * "Confirm payments you receive?", asked once (spec 049 FR-017).
 *
 * A personal wallet asks its owner at the first payment it could acknowledge, and sends nothing for
 * that payment before the answer. So the card appears only once a received payment is waiting on
 * it, never speculatively, and either answer is kept as the setting under Settings, Receipts.
 * "Not now" is a no: the question is not asked again, and the switch there turns it on later.
 *
 * Home only, in the flow of the page like the profile reminder: the money screens stay free of it,
 * and it is never a dialog, because nothing is blocked while it waits.
 */
export function ReceiptAckPrompt({
  awaiting = receiptsAwaitingAnswer,
  answer = setReceiptAcknowledgement,
}: {
  /** Injected by tests. */
  awaiting?: () => Promise<number>
  answer?: (allow: boolean) => Promise<void>
}) {
  const { pathname } = useLocation()
  const [waiting, setWaiting] = useState(0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    const load = () => void awaiting().then((n) => live && setWaiting(n), () => undefined)
    load()
    const off = onReceiptsChanged(load)
    return () => {
      live = false
      off()
    }
  }, [awaiting])

  if (pathname !== '/' || waiting === 0) return null

  const reply = async (allow: boolean) => {
    setBusy(true)
    try {
      await answer(allow)
      setWaiting(0)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-labelledby="receipt-ack-title"
      className="mx-auto mt-2 max-w-md rounded-xl bg-mono-100 p-4 text-sm text-mono-700 dark:bg-mono-900 dark:text-mono-200"
    >
      <div className="flex items-start gap-3">
        <BadgeCheck className="mt-0.5 h-5 w-5 shrink-0 text-mono-500" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 id="receipt-ack-title" className="font-medium text-mono-900 dark:text-mono-50">
            Confirm payments you receive?
          </h2>
          <p className="mt-1 leading-snug">
            {waiting === 1 ? 'Someone paid you and is waiting' : `${waiting} payments are waiting`} for your confirmation.
            Confirming signs their receipt, so they can prove they paid. You can change this in Settings.
          </p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void reply(true)}
          className="pressable min-h-11 flex-1 rounded-xl bg-mono-900 font-medium text-mono-50 outline-none ring-mono-400 focus-visible:ring-2 disabled:opacity-50 dark:bg-mono-50 dark:text-mono-900"
        >
          Confirm
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void reply(false)}
          className="pressable min-h-11 flex-1 rounded-xl font-medium text-mono-700 outline-none ring-mono-400 focus-visible:ring-2 disabled:opacity-50 dark:text-mono-200"
        >
          Not now
        </button>
      </div>
    </section>
  )
}
