import { useEffect, useState } from 'react'

import { knownBranding, merchantBranding } from './branding'
import { handleLabel, shortPubkey } from './format'

/**
 * Who a pubkey is, in words a customer can read.
 *
 * Nostr identifiers are the wrong thing to put in front of someone buying
 * vegetables: `npub1…` and a 64-character hex key are both unreadable, and
 * neither tells you which merchant you are looking at. Everywhere a person is
 * named, the wallet shows their display name with their NIP-05 handle under it,
 * and falls back down that ladder only when a profile is missing.
 *
 * The source is the same kind-0 `merchantBranding` already fetches and caches
 * per pubkey — a name lookup adds no request. Nothing here is verified against
 * the handle's domain; see `MerchantBranding.nip05`.
 */
export interface Identity {
  name?: string
  nip05?: string
  /** kind-0 `picture`, already narrowed to https/data by `imageUrl`. */
  picture?: string
}

/**
 * The one line to show for someone, best available.
 *
 * Never empty: a pubkey with no profile at all still renders as a short key
 * rather than a blank, because "who is this coupon from" with no answer is
 * worse than an ugly answer.
 */
export function identityLabel(pubkey: string, identity: Identity | undefined): string {
  const nip05 = identity?.nip05
  return humanName(identity?.name) ?? (nip05 ? handleLabel(nip05) : undefined) ?? shortPubkey(pubkey)
}

/**
 * A name, unless it is a key wearing a name's clothes.
 *
 * `toMerchants` fills `name` with `merchantName || merchantId`, so an unbranded
 * merchant's "name" is a 64-character pubkey. Left alone it defeats the whole
 * point of this module and overflows every card it lands on.
 *
 * Exported because the same trap exists wherever a stored `merchantName` is
 * rendered directly rather than through `identityLabel` — the settlement
 * receipt on the transaction detail screen was printing 64 hex characters
 * beside the amount for exactly this reason. One rule, one place.
 */
export function humanName(name: string | undefined): string | undefined {
  if (!name) return undefined
  return /^[0-9a-f]{64}$/i.test(name.trim()) ? undefined : name
}

/**
 * The line UNDER the label, or nothing.
 *
 * Empty when the label is already the handle (nobody needs it twice) and when
 * there is no handle — deliberately NOT falling back to the hex key, which is
 * the noise this whole module exists to remove. The full key is still in the
 * record screens' raw-details drawer for anyone who needs it.
 */
export function identitySubLabel(identity: Identity | undefined): string | undefined {
  return humanName(identity?.name) && identity?.nip05 ? handleLabel(identity.nip05) : undefined
}

/**
 * The name to show for a counterparty, or nothing when we cannot name them.
 *
 * The difference from {@link identityLabel} is the whole point: that one ends
 * its fallback ladder at `shortPubkey`, which is right for a list row where a
 * stable per-row identifier beats an empty cell. It is wrong for a toast, where
 * a 64-bit hex fragment beside an amount reads as noise and names nobody.
 *
 * The settlement toast printed `b233db85…de1e` for exactly this reason: the
 * sending wallet had published no kind-0, so every rung of the ladder missed
 * and the key fell out of the bottom. Callers that would rather say nothing
 * than say a key use this and supply their own words.
 *
 * Returns undefined for an absent pubkey too, so "no sender" and "a sender we
 * cannot name" collapse to one case — they mean the same thing to a reader.
 */
export function nameOrNothing(
  pubkey: string | undefined,
  identity: Identity | undefined,
): string | undefined {
  if (!pubkey) return undefined
  // The same first two rungs as `identityLabel`, and deliberately not its
  // third. NOT `identitySubLabel`, which answers a different question — it is
  // the line UNDER a name and is empty when the name IS the handle, so reusing
  // it here dropped a handle-only profile to nothing.
  const nip05 = identity?.nip05
  return humanName(identity?.name) ?? (nip05 ? handleLabel(nip05) : undefined)
}

/**
 * A merchant's name, fetched, with the coupon's stored name as the floor.
 *
 * The send flow printed a hex key for every unbranded merchant, and this is
 * why: `Merchant.name` comes from `VoucherGrouper`, which fills it with
 * `merchant_metadata.merchant_name || merchantId`. The `|| merchantId` half is
 * a 64-character key wearing a name's clothes, so `humanName` rejected it and
 * `identityLabel` fell all the way to `shortPubkey` — on the picker, the
 * amount screen and the confirm screen alike. Nothing ever asked for the
 * kind-0 that was sitting on the relay the whole time.
 *
 * THE FETCHED NAME WINS over the stored one, which is the opposite of
 * `IdentityInline`'s `fallbackName` and deliberate. A coupon's copy of the name
 * was taken when it was ISSUED and never updates; kind-0 is what the merchant
 * currently calls themselves. A stall that renames itself should read as its
 * new name on a coupon minted under the old one.
 *
 * Costs no request: `merchantBranding` caches per pubkey, and the pass above
 * these screens has usually asked already.
 */
export function useMerchantLabel(merchant: { pubkey: string; name?: string }): string {
  const fetched = useIdentity(merchant.pubkey)
  // `humanName` on the stored name too, so the hex placeholder never becomes
  // the answer — it must fall through to `shortPubkey` like any other unnamed
  // key rather than printing 64 characters into a row.
  const identity: Identity = {
    ...fetched,
    name: fetched?.name ?? humanName(merchant.name),
  }
  return identityLabel(merchant.pubkey, identity)
}

/**
 * The handle to show UNDER a merchant's name, or nothing.
 *
 * Same question as `identitySubLabel` and same answer, but it takes the
 * merchant rather than a resolved identity so a caller with only a `Merchant`
 * does not have to hold its own `useIdentity` to ask.
 */
export function useMerchantHandle(merchant: { pubkey: string; name?: string }): string | undefined {
  const fetched = useIdentity(merchant.pubkey)
  return identitySubLabel({ ...fetched, name: fetched?.name ?? humanName(merchant.name) })
}

/**
 * Resolve a `name@domain` handle to the hex pubkey it points at.
 *
 * `GET /api/v1/resolve/{nip05}` is unauthenticated and lives on both gateways,
 * so the same-origin `/api` rule reaches it with no new proxy entry.
 *
 * **It only resolves PUBLICLY served domains.** The endpoint answers by fetching
 * the domain's own `.well-known/nostr.json`, so on staging every registered
 * `…@staging.398ja.xyz` resolves, and in local dev NOTHING does — `imani.local`
 * is served by nobody, and a real staging handle fails there too (probed: 404
 * `NIP05_001` for every input, including handles that exist). That is why
 * `toRecipientPubkey` keeps accepting npub and hex: on a dev machine they are
 * the only forms that work.
 *
 * Returns null rather than throwing — a scanner feeds this whatever the camera
 * saw, and most of that is not a handle.
 */
export async function resolveNip05(address: string): Promise<string | null> {
  try {
    const response = await fetch(`/api/v1/resolve/${encodeURIComponent(address)}`, {
      credentials: 'include',
    })
    if (!response.ok) return null
    const body = (await response.json()) as { hex_pubkey?: unknown }
    const hex = typeof body.hex_pubkey === 'string' ? body.hex_pubkey.toLowerCase() : ''
    // Validated, not trusted: this string is about to be the address money is
    // sent to, and it arrives from a document the handle's own domain serves.
    return /^[0-9a-f]{64}$/.test(hex) ? hex : null
  } catch {
    return null
  }
}

/**
 * Someone's name and handle, fetched once per pubkey.
 *
 * Returns `undefined` until it arrives, so callers render `identityLabel`'s
 * short-key fallback for a moment rather than an empty gap. Matches the
 * `merchantBranding(pubkey).then(setState)` pattern the merchant pages already
 * use; `pubkey` may be empty, for the screens that name a counterparty which
 * some rows do not have.
 */
export function useIdentity(pubkey: string | undefined): Identity | undefined {
  // The pubkey is stored WITH the answer, and compared on the way out. Without
  // that, a row whose pubkey changes under it — or a hook that starts with none
  // — keeps rendering the previous person's name until the new fetch lands,
  // which on a merchant's list is the wrong customer against a real amount.
  // Clearing it in the effect instead would be a synchronous setState there.
  const [resolved, setResolved] = useState<{ pubkey: string; identity: Identity }>()

  useEffect(() => {
    if (!pubkey) return
    let cancelled = false
    void merchantBranding(pubkey).then((branding) => {
      if (!cancelled) {
        setResolved({
          pubkey,
          identity: {
            name: branding.organizationName,
            nip05: branding.nip05,
            picture: branding.logoUrl,
          },
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [pubkey])

  return resolved && resolved.pubkey === pubkey ? resolved.identity : undefined
}

/**
 * The same lookup, but it says whether it is still WAITING.
 *
 * `useIdentity` cannot distinguish "no profile exists" from "the profile has not
 * arrived yet" — both are `undefined` — so every caller rendered
 * `identityLabel`'s hex fallback during the fetch, and a name that landed two
 * seconds later replaced a key the user had already started reading. That flash
 * is the bug: a key is not a worse name, it is not a name at all, and showing
 * one as a placeholder tells the reader something false about who they are
 * looking at.
 *
 * `known` is the answer we already had on disk, available on the FIRST render —
 * which is why the persisted cache exists. When there is one there is no loading
 * state at all: the row draws the name it drew last time and corrects itself if
 * the fetch disagrees.
 */
export function useIdentityState(pubkey: string | undefined): {
  identity: Identity | undefined
  /** True only while there is nothing to show AND an answer is still coming. */
  loading: boolean
} {
  const fetched = useIdentity(pubkey)
  // Read once per render rather than held in state: it is a synchronous
  // localStorage read, and putting it in state would need an effect to keep it
  // in step with `pubkey` — the cascading-render pattern `Avatar` avoids.
  const known = pubkey && !fetched ? knownBranding(pubkey) : undefined
  const identity: Identity | undefined =
    fetched ??
    (known
      ? { name: known.organizationName, nip05: known.nip05, picture: known.logoUrl }
      : undefined)

  return {
    identity,
    // An absent pubkey is not pending — there is nobody to wait for.
    loading: Boolean(pubkey) && identity === undefined,
  }
}
