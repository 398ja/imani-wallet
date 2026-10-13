import { useEffect, useState } from 'react'

import { accountRole } from './merchantVouchers'
import type { MerchantStatus } from './merchant'

/**
 * The prompt's question for the owner rule of 2026-10-13: is this account allowed to take a
 * voucher of `issuer`? Asked only when the issuer is ANOTHER stall (own vouchers and customers'
 * plain receives never wait on the relay).
 *
 * - `null`: nothing to ask (no account, no issuer yet, or the account's own stall);
 * - `'checking'`: asked, not answered yet;
 * - `'merchant' | 'customer' | 'unknown'`: the account's role.
 *
 * The answer is keyed by what was asked, so the render derives `checking` rather than an effect
 * setting it (react-hooks/set-state-in-effect); `retry` asks again.
 */
export function useForeignVoucherRole(
  pubkey: string | undefined,
  issuer: string | null | undefined,
): { role: MerchantStatus | 'checking' | null; retry: () => void } {
  const [attempt, setAttempt] = useState(0)
  const [answer, setAnswer] = useState<{ key: string; role: MerchantStatus } | null>(null)
  const foreign = !!pubkey && !!issuer && issuer.toLowerCase() !== pubkey.toLowerCase()
  const key = foreign ? `${pubkey}|${issuer}|${attempt}` : null

  useEffect(() => {
    if (!key || !pubkey) return
    let live = true
    void accountRole(pubkey).then(
      (role) => live && setAnswer({ key, role }),
      () => live && setAnswer({ key, role: 'unknown' }),
    )
    return () => {
      live = false
    }
  }, [key, pubkey])

  const role = key === null ? null : answer?.key === key ? answer.role : 'checking'
  return { role, retry: () => setAttempt((n) => n + 1) }
}
