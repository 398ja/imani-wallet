import { Avatar } from './Avatar'
import { identityLabel, identitySubLabel, useIdentity } from '../../lib/identity'

/**
 * The body of the "payment on its way" toast: who is paying, how much, and that
 * the money has not landed yet.
 *
 * The toast used to print a truncated `npub1qq…f4a2`, which names nobody — the
 * one thing a person needs from an incoming-payment banner is whether they
 * recognise the sender. So this wears the same face the rest of the wallet
 * wears: avatar, display name, NIP-05 under it, from the kind-0 profile
 * `useIdentity` already caches per pubkey.
 *
 * The envelope's own `displayName` / `picture` seed the first paint so the
 * toast is never anonymous while kind-0 is in flight — they are sender-authored
 * and unverified, which is fine for a label and is why nothing else here is
 * taken from them. The fetched profile replaces them the moment it lands.
 *
 * The avatar sits in the message rather than sonner's icon slot, and the
 * success tick is suppressed with it: the tick claims the money arrived, and
 * this toast fires before it has.
 */
export function IncomingPaymentToast({
  pubkey,
  amount,
  fallbackName,
  fallbackPicture,
}: {
  pubkey: string
  /** Already formatted by the gateway, in the sender's own unit. */
  amount: string
  fallbackName?: string
  fallbackPicture?: string
}) {
  const fetched = useIdentity(pubkey)
  const identity = {
    ...fetched,
    name: fetched?.name ?? fallbackName,
    picture: fetched?.picture ?? fallbackPicture,
  }
  const name = identityLabel(pubkey, identity)
  const handle = identitySubLabel(identity)

  return (
    <span className="flex min-w-0 items-start gap-3">
      <Avatar src={identity.picture} name={name} pubkey={pubkey} size="md" className="shrink-0" />
      <span className="min-w-0 flex-1">
        {/* Name truncates, amount never does — same rule the record rows follow,
            because a clipped name is still recognisable and a clipped amount is
            a different number. */}
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate">{name}</span>
          <span className="shrink-0">{amount}</span>
        </span>
        {/* Both secondary lines take the toast's own description treatment:
            over a blurred material, flat mid-grey goes illegible, and the
            title's negative tracking is wrong once the type gets this small. */}
        {handle ? (
          <span className="block truncate text-[13px] font-normal leading-snug tracking-normal text-mono-600 dark:text-mono-300">
            {handle}
          </span>
        ) : null}
        <span className="mt-0.5 block text-[13px] font-normal leading-snug tracking-normal text-mono-600 dark:text-mono-300">
          On its way — not in your balance yet.
        </span>
      </span>
    </span>
  )
}
