import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Alert, BackLink, PageHeader, Screen } from '../components/ui'
import { ScanRecipient } from '../components/ScanRecipient'
import { isReceiptQr } from '../lib/receipts/verify'

/**
 * A terminal's receipt scanner (spec 049): the customer shows the receipt on their phone, staff
 * point the till at it, and the check card says whether it was paid to this stall.
 *
 * Receipts only. A till's other codes (vouchers to redeem) have their own screen, so anything else
 * is refused here in one line rather than routed somewhere a till may not go. The camera, paste and
 * typing paths are `ScanRecipient`'s, so a till without a camera can still paste.
 *
 * The QR text moves in router state, never the URL: it carries a payer signature and the key to its
 * evidence, and URLs end up in history.
 */
export function TerminalReceiptScanPage() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  return (
    <Screen>
      <BackLink to="/" label="Till" />
      <PageHeader title="Check a receipt" subtitle="Scan the receipt on the customer’s phone" />
      {error ? (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      ) : null}
      <ScanRecipient
        onFound={() => undefined}
        manualLabel="Or paste the receipt code"
        placeholder="imrc1:…"
        onText={(text) => {
          if (!isReceiptQr(text)) {
            setError('That is not a receipt. Ask the customer to tap Show receipt on the payment.')
            return true
          }
          navigate('/receipt/check', { state: { qr: text.trim() } })
          return true
        }}
      />
    </Screen>
  )
}
