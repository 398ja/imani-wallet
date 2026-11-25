import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Alert, BackLink, PageHeader, Screen } from '../components/ui'
import { ScanRecipient } from '../components/ScanRecipient'
import { isReceiptQr } from '../lib/receipts/verify'
import { extractReceiptCode } from '../lib/receipts/shareText'

/**
 * The receipt scanner (spec 049): the customer shows the receipt on their phone, the stall points
 * the camera at it, and the check card says whether it was paid to this stall.
 *
 * Receipts only, on its own screen, so a receipt is never mistaken for the customer on Sell or a
 * payment on Scan. The owner reaches it from Transactions, where they look for "did this person
 * pay me?"; a till from its home (`receipt:read`). Anything else is refused here in one line rather
 * than routed somewhere this device may not go. The camera, paste and typing paths are
 * `ScanRecipient`'s, so a device without a camera can still paste.
 *
 * The QR text moves in router state, never the URL: it carries a payer signature and the key to its
 * evidence, and URLs end up in history.
 */
export function ReceiptScanPage({
  back = { to: '/', label: 'Till' },
  scanPath = '/receipts/scan',
}: {
  /** Where Back goes: the till's home, or the owner's Transactions. */
  back?: { to: string; label: string }
  /** This screen's own path, so the check's Back and Scan another return here. */
  scanPath?: string
} = {}) {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  return (
    <Screen>
      <BackLink to={back.to} label={back.label} />
      <PageHeader title="Check a receipt" subtitle="Scan the receipt on the customer’s phone, or paste one they sent" />
      {error ? (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      ) : null}
      <ScanRecipient
        onFound={() => undefined}
        manualLabel="Or paste the receipt they sent you"
        placeholder="imrc1:…"
        pasteSubmits
        onText={(text, source) => {
          // A shared receipt arrives inside a message; the code is dug out of it.
          const code = isReceiptQr(text) ? text.trim() : source === 'typed' ? extractReceiptCode(text) : null
          if (!code) {
            setError('That is not a receipt. Ask the customer to tap Show receipt on the payment.')
            return true
          }
          setError(null)
          navigate('/receipt/check', {
            state: { qr: code, from: scanPath, ...(source === 'typed' ? { via: 'text' } : {}) },
          })
          return true
        }}
      />
    </Screen>
  )
}
