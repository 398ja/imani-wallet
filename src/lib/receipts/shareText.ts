import { QR_PREFIX } from '@imani/receipts'

/**
 * A receipt sent as text instead of shown as a QR code.
 *
 * The text is the same `imrc1:` code the QR carries, wrapped in a line that tells the stall
 * what to do with it. Messaging apps add their own words around it, so the stall side digs
 * the code back out rather than expecting the bare code.
 */
export function receiptShareText(code: string): string {
  return `My Imani payment receipt. To check it, open Check a receipt and paste this code:\n\n${code}`
}

// base64url body, then an optional `#` and base64url evidence key.
const CODE = new RegExp(`${QR_PREFIX}[A-Za-z0-9_-]+(?:#[A-Za-z0-9_-]+)?`, 'i')

/**
 * The receipt code inside pasted text, or null when there is none.
 *
 * The code is one unbroken run of base64url, so it is matched as written: words a chat app
 * put before or after it are left behind. The prefix is case-insensitive, as it is for a scan.
 */
export function extractReceiptCode(text: string): string | null {
  if (typeof text !== 'string') return null
  const found = CODE.exec(text)
  return found ? found[0] : null
}
