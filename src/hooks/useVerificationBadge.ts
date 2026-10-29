import { useEffect, useState } from 'react'

import { badgeAt, nextBadgeChange, type Badge, type BadgeWindow } from '../lib/verificationBadge'
import { badgeWindows, VERIFICATION_CHANGED_EVENT } from '../lib/verificationReader'

/**
 * The verification badge this key wears right now (#418): bronze, silver, gold, or null.
 *
 * Driven only by a valid subscription and its window. Re-renders when a window opens or closes, so a
 * badge does not outlive its `valid_to` on a screen left open, and when a licence arrives or the
 * attestation changes (`VERIFICATION_CHANGED_EVENT`).
 *
 * The pubkey is stored WITH the answer and compared on the way out, as `useIsMerchant` does: rows
 * are reused, and a badge left over from the previous person is a claim about the wrong person.
 */
export function useVerificationBadge(pubkey: string | undefined): Badge | null {
  const [resolved, setResolved] = useState<{ pubkey: string; windows: BadgeWindow[] }>()
  const [version, setVersion] = useState(0)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    if (!pubkey) return
    let live = true
    void badgeWindows(pubkey).then((windows) => {
      if (live) {
        setResolved({ pubkey, windows })
        setNow(Math.floor(Date.now() / 1000))
      }
    })
    return () => {
      live = false
    }
  }, [pubkey, version])

  // Ask again when a licence lands or the attestation changes. An event naming one account only
  // re-asks for that account, so a wallet write does not re-read every face on screen.
  useEffect(() => {
    if (!pubkey) return
    const onChange = (e: Event) => {
      const target = (e as CustomEvent<{ pubkey?: string } | undefined>).detail?.pubkey
      if (target && target !== pubkey.toLowerCase()) return
      setVersion((v) => v + 1)
    }
    window.addEventListener(VERIFICATION_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(VERIFICATION_CHANGED_EVENT, onChange)
  }, [pubkey])

  // Wake at the next window edge. Capped so a far-off date does not overflow setTimeout.
  const windows = resolved && resolved.pubkey === pubkey ? resolved.windows : undefined
  useEffect(() => {
    if (!windows) return
    const next = nextBadgeChange(windows, now)
    if (next === undefined) return
    const ms = Math.min((next - now) * 1000 + 250, 2 ** 31 - 1)
    const id = setTimeout(() => setNow(Math.floor(Date.now() / 1000)), ms)
    return () => clearTimeout(id)
  }, [windows, now])

  return windows ? badgeAt(windows, now) : null
}
