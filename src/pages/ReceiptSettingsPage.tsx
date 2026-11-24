import { useEffect, useState } from 'react'

import { Screen, BackLink, PageHeader, Switch } from '../components/ui'
import { onReceiptsChanged, receiptAcknowledgementState, setReceiptAcknowledgement } from '../lib/receipts'

/**
 * Settings, Receipts: the "confirm payments you receive" answer (spec 049 FR-017), changeable at
 * any time. On by default for a merchant wallet; a personal wallet is off until its owner says yes,
 * here or on the prompt at the first payment. Turning it on confirms what was waiting.
 */
export function ReceiptSettingsPage({
  state = receiptAcknowledgementState,
  answer = setReceiptAcknowledgement,
}: {
  /** Injected by tests. */
  state?: () => { on: boolean; answered: boolean }
  answer?: (allow: boolean) => Promise<void>
}) {
  const [on, setOn] = useState(() => state().on)
  const [busy, setBusy] = useState(false)

  useEffect(() => onReceiptsChanged(() => setOn(state().on)), [state])

  const toggle = async (next: boolean) => {
    setBusy(true)
    setOn(next)
    try {
      await answer(next)
    } finally {
      setOn(state().on)
      setBusy(false)
    }
  }

  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader title="Receipts" />
      <Switch
        label="Confirm payments you receive"
        hint="Signs the payer’s receipt, so they can prove they paid you. Nothing about the payment is shared beyond the payer."
        checked={on}
        disabled={busy}
        onChange={(next) => void toggle(next)}
      />
    </Screen>
  )
}
