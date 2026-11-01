import { useState } from 'react'

import { Switch } from './ui'
import { ClaimLinkPanel } from './CashbackClaimLink'
import { useIdentity } from '../lib/identity'
import type { MerchantProfile } from '../lib/merchant'
import { giftingPageUrl } from '../lib/giftingPage'

/**
 * Settings → Card payments → "Your gifting page" (#410): the link and QR, and the search-engine
 * indexing opt-in (G1), published as `giftingIndexable: true` in the stall record. Off by default;
 * only a literal true counts.
 */
export function GiftingPageSection({
  merchant,
  onToggleIndexing,
}: {
  merchant: MerchantProfile
  onToggleIndexing: (indexable: boolean) => Promise<void>
}) {
  const identity = useIdentity(merchant.pubkey)
  const url = giftingPageUrl(identity?.nip05)
  const [busy, setBusy] = useState(false)

  return (
    <section className="mb-6" aria-labelledby="gifting-page">
      <h2 id="gifting-page" className="mb-2 text-[17px] font-semibold tracking-[-0.01em]">
        Your gifting page
      </h2>
      <p className="mb-3 text-[15px] leading-relaxed text-mono-500">
        Anyone can buy your vouchers by card here, for themselves or as a gift, without installing the wallet.
      </p>
      {url ? (
        <>
          <p className="mb-3 break-all text-sm font-medium" data-testid="gifting-url">
            {url}
          </p>
          <ClaimLinkPanel link={url} qrAlt="QR code for your gifting page" />
        </>
      ) : (
        <p className="mb-3 text-sm text-mono-500">Add a handle to your profile to get a gifting page link.</p>
      )}
      <div className="mt-3">
        <Switch
          label="Show my gifting page in search engines"
          hint="Off by default. Imani never lists stalls in a directory."
          checked={merchant.giftingIndexable === true}
          disabled={busy}
          onChange={(next) => {
            setBusy(true)
            void onToggleIndexing(next).finally(() => setBusy(false))
          }}
        />
      </div>
    </section>
  )
}
