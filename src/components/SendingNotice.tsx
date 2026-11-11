import type { SendProgress } from '../lib/pay'
import { sendingLine } from '../lib/sendingLine'

/** The line under a send or payment in flight (#552). See `sendingLine`. */
export function SendingNotice({ progress }: { progress: SendProgress | null }) {
  return (
    <p className="mt-3 text-center text-xs text-mono-400" role="status" aria-live="polite">
      {sendingLine(progress)}
    </p>
  )
}
