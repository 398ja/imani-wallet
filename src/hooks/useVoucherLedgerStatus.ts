/**
 * What the public voucher ledger (v2, imani-gateway-customer#310) says about one voucher this
 * stall holds a record of.
 *
 * Any thrown error, `GatewayUnreachableError` included, is `unavailable`: an answer that cannot be
 * trusted must never read as "no record". Nothing here is logged, because the voucher id is the
 * key to the ledger entry.
 */
import { useEffect, useState } from 'react'
import { voucherLedgerV2Enabled } from '../lib/attestation'
import { readVoucherLedgerStatus } from '../lib/voucherLedgerV2Status'

export type VoucherLedgerState =
  | { kind: 'off' }
  | { kind: 'checking' }
  | { kind: 'issued' }
  | { kind: 'redeemed' }
  | { kind: 'revoked' }
  | { kind: 'none' }
  | { kind: 'unavailable' }

export function useVoucherLedgerStatus(stallPubkey: string | undefined, voucherId: string | undefined): VoucherLedgerState {
  // Without a stall key there is no ledger address to ask: nothing to show, not a failure.
  const key = voucherLedgerV2Enabled() && stallPubkey && voucherId ? `${stallPubkey}\u0000${voucherId}` : null
  // The answer is kept with the address it answers, so a changed voucher reads as checking
  // rather than showing the previous voucher's status.
  const [answer, setAnswer] = useState<{ key: string; state: VoucherLedgerState } | null>(null)

  useEffect(() => {
    if (key === null || !stallPubkey || !voucherId) return
    let cancelled = false
    const settle = (state: VoucherLedgerState) => {
      if (!cancelled) setAnswer({ key, state })
    }
    readVoucherLedgerStatus(stallPubkey, voucherId).then(
      (resolved) => {
        if (resolved === null) settle({ kind: 'none' })
        else if (resolved.status === 'REDEEMED') settle({ kind: 'redeemed' })
        else if (resolved.status === 'REVOKED') settle({ kind: 'revoked' })
        else settle({ kind: 'issued' })
      },
      () => settle({ kind: 'unavailable' }),
    )
    return () => {
      cancelled = true
    }
  }, [key, stallPubkey, voucherId])

  if (key === null) return { kind: 'off' }
  return answer?.key === key ? answer.state : { kind: 'checking' }
}
