import { useEffect, useState } from 'react'
import { getSession } from './nap'
import { COUPON_ISSUE } from './merchant'
import {
  awaitMerchantSession,
  clearStallActivation,
  isStallActivationPending,
} from './stallActivation'

export type StallActivation = 'idle' | 'activating' | 'gave-up'

/**
 * Drives the post-onboarding re-handshake (#114) for a merchant who just
 * registered in this tab. Idle for everyone else, and idle as soon as the
 * session carries `coupon:issue`, whichever way it got there.
 */
export function useStallActivation(
  pubkey: string,
  isMerchantRecord: boolean,
  permissions: readonly string[],
): StallActivation {
  const hasIssue = permissions.includes(COUPON_ISSUE)
  const needed = isMerchantRecord && !hasIssue && isStallActivationPending(pubkey)
  // Only the loop's verdict is state. Everything else is derived, so a session
  // that gains `coupon:issue` by any route reads as idle on that same render.
  const [gaveUp, setGaveUp] = useState(false)

  useEffect(() => {
    if (hasIssue) {
      clearStallActivation()
      return
    }
    if (!needed) return
    let cancelled = false
    void awaitMerchantSession({
      login: async () => {
        const session = getSession()
        if (!session) throw new Error('No session')
        return session.login()
      },
      isCancelled: () => cancelled,
    }).then((result) => {
      if (cancelled || result === 'cancelled') return
      clearStallActivation()
      if (result === 'gave-up') setGaveUp(true)
    })
    return () => {
      cancelled = true
    }
  }, [needed, hasIssue])

  if (hasIssue) return 'idle'
  if (gaveUp) return 'gave-up'
  return needed ? 'activating' : 'idle'
}
