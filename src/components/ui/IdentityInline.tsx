import { Avatar } from './Avatar'
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
}: {
  pubkey: string
  /** Kicker above the name — "To", "Customer". Omitted in the details drawer. */
  label?: string
  size?: 'sm' | 'md'
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

  return (
    <span className="flex min-w-0 items-center gap-3">
      <Avatar src={identity.picture} name={name} pubkey={pubkey} size={size} className="shrink-0" />
      <span className="min-w-0">
        {label ? (
          <span className="block text-xs uppercase tracking-wide text-mono-400">{label}</span>
        ) : null}
        <span className="block truncate text-sm text-mono-900 dark:text-mono-50">{name}</span>
        {handle ? <span className="block truncate text-xs text-mono-500">{handle}</span> : null}
      </span>
    </span>
  )
}
