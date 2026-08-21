import { useEffect, useState } from 'react'

import { merchantBranding } from './branding'
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
 */
function humanName(name: string | undefined): string | undefined {
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
