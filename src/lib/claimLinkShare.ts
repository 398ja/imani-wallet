/**
 * Sharing a claim link, and the words around it (claim links phase 2, spec 4.1). The link is
 * handed to the system share sheet or the clipboard and nothing else: never logged or stored.
 */
import { formatDate } from './format'

/** The note under the link (spec 4.1). */
export function bearerNote(expiresAt?: string | number): string {
  const date = expiresAt === undefined || expiresAt === '' ? '' : formatDate(expiresAt)
  return date
    ? `Anyone with this link or QR can claim it once. It works until ${date}.`
    : 'Anyone with this link or QR can claim it once.'
}

export function canShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function'
}

/**
 * Share through the system sheet where there is one, otherwise copy. The link is passed as
 * `url`, so the receiving app gets it whole; nothing here records it.
 */
export async function shareLink(link: string): Promise<'shared' | 'copied' | 'failed'> {
  if (canShare()) {
    try {
      await navigator.share({ url: link })
      return 'shared'
    } catch {
      // Dismissed, or refused. Nothing to do: the QR and the code are still on screen.
      return 'failed'
    }
  }
  try {
    await navigator.clipboard.writeText(link)
    return 'copied'
  } catch {
    return 'failed'
  }
}

export const CANCEL_QUESTION =
  'Cancel this cashback? The customer will no longer be able to claim it. The value is not returned to you.'
