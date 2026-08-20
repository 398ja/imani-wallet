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
 */
export function IdentityInline({ pubkey }: { pubkey: string }) {
  const identity = useIdentity(pubkey)
  const label = identityLabel(pubkey, identity)
  const sub = identitySubLabel(identity)

  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar src={identity?.picture} name={label} pubkey={pubkey} size="sm" className="shrink-0" />
      <span className="min-w-0">
        <span className="block truncate text-sm text-mono-900 dark:text-mono-50">{label}</span>
        {sub ? <span className="block truncate text-xs text-mono-500">{sub}</span> : null}
      </span>
    </span>
  )
}
