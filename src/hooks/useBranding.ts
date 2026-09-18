import { useEffect, useMemo, useState } from 'react'

import { knownBranding, merchantBranding } from '../lib/branding'
import type { MerchantBranding } from '../lib/pass'

/**
 * A stall's kind-0 branding, seeded from what this device already knows.
 *
 * The three pages that render a `Pass` each held their own
 * `merchantBranding(pubkey).then(setBranding)`, all starting at `undefined` —
 * which `toCouponPass` turns into `organizationName: issuer_id`, a 64-character
 * key that `Pass` then truncates for display. So a coupon deck opened cold
 * showed a wall of `ab12cd34…ef90` where the stall names go, for as long as the
 * lookup took.
 *
 * Seeding from the persisted cache is what removes the wait rather than merely
 * dressing it up: a stall whose coupons you are holding is, by definition, one
 * you have seen before, so the name is on disk and the card renders it on the
 * first frame. `loading` covers the genuinely-first sighting.
 *
 */
export function useBranding(pubkey: string | undefined): {
  branding: MerchantBranding | undefined
  /** Nothing to show yet AND an answer still coming. */
  loading: boolean
} {
  /*
    Memoised on the PUBKEY, not taken once at mount.

    Mount-only was wrong for the caller that needed it most: CouponPage learns
    the issuer from an IndexedDB read, so `pubkey` is undefined on the first
    render and the seed would be permanently empty — exactly the screen this was
    meant to fix. Keying on the pubkey also keeps a stall's name from surviving
    into a row that has moved on to a different stall.

    Memoised rather than read every render because it is a synchronous
    localStorage read and a deck of cards would otherwise do one per card per
    frame.
  */
  const known = useMemo(() => (pubkey ? knownBranding(pubkey) : undefined), [pubkey])
  // Stored WITH its pubkey and compared on the way out, the same guard
  // `useIdentity` carries: these components are reused across rows, and a name
  // left over from the previous stall is a claim about the wrong stall.
  const [fetched, setFetched] = useState<{ pubkey: string; branding: MerchantBranding }>()

  useEffect(() => {
    if (!pubkey) return
    let cancelled = false
    // Never rejects — an unbranded or unreachable stall resolves to empty fields.
    void merchantBranding(pubkey).then((branding) => {
      if (!cancelled) setFetched({ pubkey, branding })
    })
    return () => {
      cancelled = true
    }
  }, [pubkey])

  const resolved = fetched && fetched.pubkey === pubkey ? fetched.branding : undefined
  // The seed only stands in until THIS pubkey's fetch lands. `resolved` being
  // undefined while `fetched` holds another pubkey's answer is the row-reuse
  // case, and there the seed is the right thing to show — it was read for the
  // pubkey being rendered.
  const seed = resolved === undefined ? known : undefined
  const branding = resolved ?? seed

  return {
    branding,
    loading: Boolean(pubkey) && branding === undefined,
  }
}
