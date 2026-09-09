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
}) {
  const fetched = useIdentity(pubkey)
  const identity = { ...fetched, name: fetched?.name ?? fallbackName }
  const name = identityLabel(pubkey, identity)
  const handle = identitySubLabel(identity)

  /*
    A stall's avatar and name go to its profile. Reported from the app: the
    picture is the obvious thing to tap and nothing happened — on a voucher, on
    a receipt, anywhere a stall is named. The route existed the whole time;
    nothing pointed at it unless you had arrived from there and could go back.

    ONLY for a merchant. `/merchants/{pubkey}` renders for any key, so linking a
    customer would open an empty stall page for someone who has none — a worse
    outcome than no link, because it looks like a broken merchant rather than a
    person who is not one. Pay and Send show customers through this component,
    so this is not hypothetical.

    Same hook the badge uses, so a row that shows the merchant badge is exactly
    a row that links, and the two cannot drift apart.
  */
  const merchant = useIsMerchant(pubkey) && linkToProfile
  const Row = merchant ? Link : 'span'
  const rowProps = merchant
    ? { to: `/merchants/${pubkey}`, className: 'pressable -m-1 flex min-w-0 items-center gap-3 rounded-xl p-1 hover:opacity-90' }
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
