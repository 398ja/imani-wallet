import { useEffect, useState } from 'react'

import { fetchClaimSummary, type ClaimSummary } from '../lib/cashback'
import { currencyDecimals, formatFace, handleLabel } from '../lib/format'
import type { GiftSummary } from '../lib/giftLink'
import { humanName, useIdentityState } from '../lib/identity'
import { hasExpiredPendingClaim, peekPendingClaim, prunePendingClaims } from '../lib/pendingClaim'
import { readGift } from '../lib/giftLinks'

/** An x-only public key, as the portal returns the issuer. */
const PUBKEY_HEX = /^[0-9a-f]{64}$/

/** The fallback headline when the summary cannot be fetched (spec 4.4). It never blocks registration. */
export const BANNER_FALLBACK = 'Create an account to redeem your voucher'

/**
 * The voucher banner on onboarding's start step and on Login (claim links phase 3, spec 2.5 step 3
 * and 4.4): what is waiting, from whom, and that nothing is claimed until it is added.
 *
 * It reads the parked claim with `peekPendingClaim`, which does not consume it, and fetches the
 * portal's PUBLIC metadata for its ref: non-destructive, and the same read the prompt makes. Only
 * the ref travels; the key stays in storage and is never rendered, logged or sent.
 *
 * The same words on Login as on onboarding: spec 5.2 sends a device with a stored key to `/login`
 * "with the same banner", and the copy is the spec's verbatim (4.4).
 */
export function ParkedClaimBanner() {
  // Read once: the banner describes the claim the visitor arrived with, not one parked later.
  const [parked] = useState(() => peekPendingClaim())
  const [expired] = useState(() => !parked && hasExpiredPendingClaim())
  const [summary, setSummary] = useState<ClaimSummary | null>(null)
  const [gift, setGift] = useState<GiftSummary | null>(null)

  // Read, then erase what has aged out: "Open your voucher link again" is said once, and an aged-out
  // key does not stay on disk (review of #245, F1). Live entries are untouched.
  useEffect(() => prunePendingClaims(), [])

  useEffect(() => {
    if (!parked) return
    let live = true
    if (parked.kind === 'gift') {
      // Read from the token itself, with the link key (spec 5.3 step 4). Never spends.
      if (typeof parked.x !== 'number') return
      void readGift(parked.key, parked.x).then(
        ({ verdict }) => live && verdict.kind === 'ok' && setGift(verdict.summary),
        () => {},
      )
    } else {
      void fetchClaimSummary(parked.ref).then(
        (s) => live && setSummary(s),
        () => live && setSummary({ kind: 'unreachable' }),
      )
    }
    return () => {
      live = false
    }
  }, [parked])

  const ok = summary?.kind === 'ok' ? summary : null
  const issuer = gift?.issuer ?? (ok?.issuerPubkey && PUBKEY_HEX.test(ok.issuerPubkey) ? ok.issuerPubkey : undefined)
  const { identity } = useIdentityState(issuer)
  const stall = humanName(identity?.name)
  const { identity: senderIdentity } = useIdentityState(gift?.senderPubkey)
  // A customer often publishes no name, only the handle they registered: that is who they are.
  const sender = humanName(senderIdentity?.name) ?? (senderIdentity?.nip05 ? handleLabel(senderIdentity.nip05) : undefined)

  if (expired) {
    return (
      <div role="status" data-testid="claim-banner" className="rounded-2xl bg-mono-100 p-4 text-sm text-mono-600 dark:bg-mono-800 dark:text-mono-300">
        Open your voucher link again to add it.
      </div>
    )
  }
  if (!parked) return null

  if (parked.kind === 'gift') {
    // Spec 5.3 step 4: "Bob sent you a voucher from Ana's Bakery. Create an account to add it to
    // your wallet." Falls back to the generic headline while it cannot be read.
    const headline = gift
      ? `${sender ?? 'Someone'} sent you a voucher${stall ? ` from ${stall}` : ''}. Create an account to add it to your wallet.`
      : BANNER_FALLBACK
    const giftFace = gift ? formatFace(gift.faceMinor, { unit: gift.unit, decimals: gift.decimals ?? currencyDecimals(gift.unit) }) : null
    return (
      <div role="status" data-testid="claim-banner" className="materialize rounded-2xl bg-mono-100 p-4 text-left dark:bg-mono-800">
        <p className="text-[15px] font-semibold text-mono-900 dark:text-mono-50">{headline}</p>
        {giftFace && <p className="mt-1 text-sm text-mono-700 dark:text-mono-200">{giftFace}.</p>}
        <p className="mt-1 text-sm text-mono-500">
          Nothing is claimed until you add it. You can do that in a minute, right here.
        </p>
      </div>
    )
  }

  const headline = stall ? `Create an account to redeem the voucher from ${stall}` : BANNER_FALLBACK
  const face = ok && ok.amountMinor !== null && ok.unit
    ? formatFace(ok.amountMinor, { unit: ok.unit, decimals: ok.decimals ?? currencyDecimals(ok.unit) })
    : null
  const claimBy = ok?.expiresAt ? formatDate(ok.expiresAt) : null
  const details = [face, claimBy ? `Claim by ${claimBy}` : null].filter(Boolean).join('. ')

  return (
    <div role="status" data-testid="claim-banner" className="materialize rounded-2xl bg-mono-100 p-4 text-left dark:bg-mono-800">
      <p className="text-[15px] font-semibold text-mono-900 dark:text-mono-50">{headline}</p>
      {details && <p className="mt-1 text-sm text-mono-700 dark:text-mono-200">{details}.</p>}
      <p className="mt-1 text-sm text-mono-500">
        Nothing is claimed until you add it. You can do that in a minute, right here.
      </p>
    </div>
  )
}

function formatDate(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
