import { Link } from 'react-router-dom'

import { Avatar } from './Avatar'
import { useIsMerchant } from '../../hooks/useIsMerchant'
import { identityLabel, identitySubLabel, useIdentity } from '../../lib/identity'

/**
 * Who a pubkey is, on one line: avatar, display name, NIP-05 under it.
 *
 * The record screens printed the raw 64-character key, which names nobody —
 * least of all on the screen whose whole job is "who did this money go to".
 * The name comes from the same kind-0 `merchantBranding` already fetched and
 * cached for the pass above it, so this adds no request, and `identityLabel`
 * degrades to a short key rather than a blank when there is no profile.
 *
 * The fetch lives HERE rather than in each caller, which is what let Pay and
 * Sell drift into two hand-rolled copies of this block. Callers that need the
 * name in prose ("Sent to …") still hold their own `useIdentity` — same cached
 * answer, no second request.
 */
export function IdentityInline({
  pubkey,
  label,
  size = 'sm',
  fallbackName,
  fallbackHandle,
  linkToProfile = true,
}: {
  pubkey: string
  /** Kicker above the name — "To", "Customer". Omitted in the details drawer. */
  label?: string
  size?: 'sm' | 'md'
  /**
   * Whether a stall's row navigates to its profile. On by default, because
   * being unable to reach a stall from its own voucher is the bug this closes.
   *
   * Turn it OFF where leaving the screen would lose work in progress. Pay is
   * the case: it names the stall being paid, and a tap meant as "who is this?"
   * that abandons a half-finished payment is a worse answer than no link.
   */
  linkToProfile?: boolean
  /**
   * A name known without a fetch, used until kind-0 lands or forever if the
   * person published none. Pay knows the issuer from the coupon it is spending.
   */
  fallbackName?: string
  /**
   * A NIP-05 known without a fetch — the handle the person was reached
   * THROUGH. Send passes the address that was typed or scanned, which is the
   * only name the row will ever have for someone who published no kind-0.
   */
  fallbackHandle?: string
}) {
  const fetched = useIdentity(pubkey)
  const identity = {
    ...fetched,
    name: fetched?.name ?? fallbackName,
    nip05: fetched?.nip05 ?? fallbackHandle,
  }
  const name = identityLabel(pubkey, identity)
  const handle = identitySubLabel(identity)

  /*
    A stall's avatar and name go to THEIR PROFILE. Reported from the app: the
    picture is the obvious thing to tap and nothing happened — on a voucher, on
    a receipt, anywhere a stall is named.

    `/profile/{pubkey}`, NOT `/merchants/{pubkey}`. The second one exists and is
    a different question: it is my relationship with a stall — the coupons I
    hold from them, the transactions we have had, a Send button for spending
    what I have. Tapping someone's face and landing on my own holdings answers a
    question nobody asked. This goes to who they are and how to buy from them.

    ONLY for a merchant. A customer publishes no stall record, so their page
    would be blank — and more to the point, an ordinary person's kind-0 is not
    an invitation to a profile page inside someone else's wallet. Pay and Send
    name customers through this component, so this is not hypothetical. The page
    refuses a customer too; this just avoids offering the tap.

    Same hook the badge uses, so a row that shows the merchant badge is exactly
    a row that links, and the two cannot drift apart.
  */
  const merchant = useIsMerchant(pubkey) && linkToProfile
  const Row = merchant ? Link : 'span'
  const rowProps = merchant
    ? { to: `/profile/${pubkey}`, className: 'pressable -m-1 flex min-w-0 items-center gap-3 rounded-xl p-1 hover:opacity-90' }
    : { className: 'flex min-w-0 items-center gap-3' }

  return (
    <Row {...(rowProps as { to: string; className: string })}>
      <Avatar src={identity.picture} name={name} pubkey={pubkey} size={size} className="shrink-0" />
      <span className="min-w-0">
        {label ? (
          <span className="block text-xs uppercase tracking-wide text-mono-400">{label}</span>
        ) : null}
        <span className="block truncate text-sm text-mono-900 dark:text-mono-50">{name}</span>
        {handle ? <span className="block truncate text-xs text-mono-500">{handle}</span> : null}
      </span>
    </Row>
  )
}
