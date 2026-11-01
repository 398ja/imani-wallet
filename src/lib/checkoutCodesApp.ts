/**
 * The checkout-code jobs the running app does (#402): handle a store notice from dm-poll, and the
 * fallback pass (resume, `GET /mine`, expiry). Loaded lazily, and only when the feature is on.
 */
import { appCheckoutPorts, checkoutCodesEnabled } from './checkoutCodePorts'
import { handleCheckoutNotice, parseCheckoutNotice, reconcileCheckoutCodes, type NoticeOutcome } from './checkoutCodeFlow'

/**
 * A DM's content, if it is a checkout-code notice: handled (or ignored) and true, so the caller
 * marks the wrap processed; null when it is not one; 'retry' to leave the wrap for the next poll.
 */
export async function onCheckoutNoticeDm(pubkey: string, content: string, sealer: string | undefined): Promise<NoticeOutcome | null> {
  const notice = parseCheckoutNotice(content)
  if (!notice) return null
  if (!checkoutCodesEnabled()) return 'ignored'
  try {
    return await handleCheckoutNotice(appCheckoutPorts(), pubkey, notice, sealer)
  } catch {
    return 'retry'
  }
}

let running: Promise<number> | null = null

/** One pass, never two at once. Never throws. A split a page left part way (#402) is finished first. */
export function reconcileCheckoutCodesNow(pubkey: string): Promise<number> {
  if (!checkoutCodesEnabled()) return Promise.resolve(0)
  running ??= (async () => {
    const ports = appCheckoutPorts()
    await import('./voucherSplit').then((m) => m.finishVoucherSplits(ports, pubkey)).catch(() => 0)
    return reconcileCheckoutCodes(ports, pubkey)
  })()
    .catch(() => 0)
    .finally(() => {
      running = null
    })
  return running
}
