import { Avatar } from './Avatar'
import {
  humanName,
  identityLabel,
  identitySubLabel,
  nameOrNothing,
  useIdentity,
} from '../../lib/identity'

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

/**
 * The settlement counterpart: a coupon that has actually landed.
 *
 * Same face as the pending toast, deliberately — it is the same payment, one
 * step later, and giving it a different shape would read as a different event.
 * Three things differ, and each is the difference between the two states:
 *
 *   - the sub-line says the money is in the balance rather than on its way,
 *   - the sender is optional. The advance-notice envelope always names a sender;
 *     a redeemed voucher does not always carry `sender_pubkey`, and an arrival
 *     from an unknown sender is still worth announcing. Without a pubkey the
 *     avatar is dropped rather than rendered as a placeholder for nobody.
 *   - the sonner tick is NOT suppressed. On the pending toast it would lie; here
 *     it is exactly right.
 *
 * A sender with no kind-0 profile is treated as no sender at all, which is the
 * point of `named` below. `identityLabel` ends its ladder at `shortPubkey`, so
 * an unprofiled sender put `b233db85…de1e` where a name goes — the exact noise
 * the identity module exists to remove, and visible on staging because the
 * sending wallet had never published a kind-0. The pending toast never showed
 * this: its envelope carries a `displayName` to fall back on, and the DM
 * payload behind this one carries no such field. So rather than print a key,
 * this says "Payment received", the same words used when there is no pubkey —
 * both mean "we cannot name the sender", and they should not look different.
 *
 * The key is not lost: the transaction's raw-details drawer still has it, which
 * is where a hex pubkey belongs.
 */
export function ReceivedPaymentToast({
  pubkey,
  amount,
  memo,
}: {
  pubkey?: string
  amount: string
  memo?: string
}) {
  // Hooks cannot be called conditionally, so this runs for the anonymous case
  // too; `useIdentity` treats an empty pubkey as "nothing to look up".
  const fetched = useIdentity(pubkey ?? '')
  // NOT `identityLabel`, whose ladder ends at `shortPubkey`. See nameOrNothing.
  const named = nameOrNothing(pubkey, fetched)
  const name = named ?? 'Payment received'
  // Only when the LABEL is the name; otherwise the label is already the handle
  // and repeating it under itself says nothing.
  const handle = humanName(fetched?.name) ? identitySubLabel(fetched) : undefined

  return (
    <span className="flex min-w-0 items-start gap-3">
      {/* Dropped along with the name: an avatar beside "Payment received" is a
          face for someone the wallet cannot identify. */}
      {named && pubkey ? (
        <Avatar src={fetched?.picture} name={name} pubkey={pubkey} size="md" className="shrink-0" />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate">{name}</span>
          <span className="shrink-0">{amount}</span>
        </span>
        {handle ? (
          <span className="block truncate text-[13px] font-normal leading-snug tracking-normal text-mono-600 dark:text-mono-300">
            {handle}
          </span>
        ) : null}
        {memo ? (
          <span className="mt-0.5 block truncate text-[13px] font-normal leading-snug tracking-normal text-mono-600 dark:text-mono-300">
            {memo}
          </span>
        ) : null}
        <span className="mt-0.5 block text-[13px] font-normal leading-snug tracking-normal text-mono-600 dark:text-mono-300">
          Received — it is in your balance.
        </span>
      </span>
    </span>
  )
}
