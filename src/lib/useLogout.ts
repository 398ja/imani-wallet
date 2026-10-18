import { useCallback, useState } from 'react'

import { attemptLogout } from './logout'
import type { BlockedLogout } from './logoutBlockedCopy'

/**
 * Logout for a screen (review of #326). Runs `attemptLogout`, which refuses
 * until every held voucher is read back from its backup, and holds the
 * refusal for `LogoutBlockedDialog` to show.
 *
 * `checking` is true from the press until the answer (a bounded read-back
 * over the network), so the button is never a dead press and never a double
 * one.
 */
export function useLogout(
  pubkey: string | undefined,
  onLoggedOut: () => void,
  run: typeof attemptLogout = attemptLogout,
): { logout: () => void; checking: boolean; blocked: BlockedLogout | null; dismiss: () => void } {
  const [checking, setChecking] = useState(false)
  const [blocked, setBlocked] = useState<BlockedLogout | null>(null)

  const logout = useCallback(() => {
    if (!pubkey || checking) return
    setChecking(true)
    void run(pubkey)
      .then((outcome) => {
        if (outcome.status === 'done') onLoggedOut()
        setBlocked(outcome.status === 'blocked' ? outcome : null)
      })
      .catch(() => setBlocked({ status: 'blocked', reason: 'store-unreadable', unconfirmed: [] }))
      .finally(() => setChecking(false))
  }, [pubkey, checking, run, onLoggedOut])

  const dismiss = useCallback(() => setBlocked(null), [])
  return { logout, checking, blocked, dismiss }
}
