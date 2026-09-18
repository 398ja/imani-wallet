import { useEffect, useMemo, useState } from 'react'

import { knownBranding, merchantBranding, onBrandingChanged } from '../lib/branding'
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
    const take = (branding: MerchantBranding) => {
      if (!cancelled) setFetched({ pubkey, branding })
    }
    // Never rejects — an unbranded or unreachable stall resolves to empty fields.
    void merchantBranding(pubkey).then(take)
    /*
      And the LATE CORRECTION from whichever store lost the race in
      `fetchNewestKind0`. Without this a coupon card keeps the name the faster
      store had until it remounts — which on the screen showing that stall's
      coupons is exactly the "I renamed my stall and customers still see the old
      name" failure that reading both stores exists to prevent.
    */
    const unsubscribe = onBrandingChanged(pubkey, take)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [pubkey])

  const resolved = fetched && fetched.pubkey === pubkey ? fetched.branding : undefined
  /*
    The seed stands in until THIS pubkey's fetch lands — and ALSO when that
    fetch came back with nothing.

    That second case is not a detail. A lookup resolves to empty fields when
    both stores were briefly unreachable, which on a phone is ordinary, and
    `resolved ?? known` would then hand the card a blank name in preference to
    the one sitting on disk. `toMerchantPass` turns a blank name into the issuer
    id, which `Pass` truncates — so a moment of bad signal would put back the
    exact hex key this change exists to remove, over a stall the user has seen
    a hundred times.

    `resolved` being undefined while `fetched` holds ANOTHER pubkey's answer is
    the row-reuse case, and there the seed is right too: it was read for the
    pubkey being rendered.
  */
  const gotSomething = resolved?.organizationName ?? resolved?.nip05 ?? resolved?.logoUrl
  const branding = gotSomething ? resolved : (known ?? resolved)

  return {
    branding,
    loading: Boolean(pubkey) && branding === undefined,
  }
}
