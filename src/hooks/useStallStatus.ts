import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchStallStatus, type StallStatus } from '../lib/merchantStatus'

/**
 * A stall's open-for-business status, kept current while the screen is up (imani-wallet#434).
 *
 * Polls every `intervalMs` (default 15 s, inside the 30 s propagation target) and on focus /
 * visibility, so a stall that closes while a Pay screen or till is open is seen without a reload.
 * `loading` until the first answer for THIS stall: callers treat it like `unknown` and offer
 * nothing.
 *
 * `recheck()` asks again NOW and returns the answer, for the moment just before money moves.
 */
export function useStallStatus(
  stallPubkey: string | undefined | null,
  intervalMs = 15_000,
): { status: StallStatus['status'] | 'loading'; sellsByCard: boolean; recheck: () => Promise<StallStatus> } {
  // Stamped with the stall it answers for, so a change of stall reads as loading, never as the
  // previous stall's answer.
  const [state, setState] = useState<{ key: string; answer: StallStatus } | null>(null)
  const keyRef = useRef(stallPubkey)
  useEffect(() => {
    keyRef.current = stallPubkey
  }, [stallPubkey])

  const recheck = useCallback(async (): Promise<StallStatus> => {
    const key = keyRef.current
    if (!key) return { status: 'unknown', sellsByCard: false }
    const answer = await fetchStallStatus(key)
    if (keyRef.current === key) setState({ key, answer })
    return answer
  }, [])

  useEffect(() => {
    if (!stallPubkey) return
    let live = true
    const tick = () => {
      void fetchStallStatus(stallPubkey).then((answer) => {
        if (live) setState({ key: stallPubkey, answer })
      })
    }
    tick()
    const timer = setInterval(tick, intervalMs)
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      live = false
      clearInterval(timer)
      window.removeEventListener('focus', tick)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [stallPubkey, intervalMs])

  const current = state && state.key === stallPubkey ? state.answer : null
  return { status: current?.status ?? 'loading', sellsByCard: current?.sellsByCard ?? false, recheck }
}
