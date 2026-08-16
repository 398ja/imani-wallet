import { nip19, type EventTemplate } from 'nostr-tools'

import { fetchNewestKind0, imageUrl, str } from './branding'

/**
 * The current user's own profile.
 *
 * Nostr keeps profile metadata in a kind-0 event on relays, which makes it
 * remote, eventually-consistent and occasionally unreachable — none of which a
 * header avatar can wait for. So a copy lives locally and the relay is the
 * source of truth we reconcile against on login.
 *
 * NOTHING SECRET GOES IN HERE. The key stays in nap's WebCrypto keystore
 * (PBKDF2 + AES-GCM), and RFC §1181 forbids plaintext key material at rest,
 * localStorage included. This record is public metadata — the same fields any
 * relay would hand a stranger — so it is stored in the clear on purpose.
 *
 * bottin's equivalent (`imani.identity.<npub>`) also carries the encrypted key
 * and a PBKDF2 password verifier. We keep neither: nap's keystore already owns
 * the key, and it already fails the decrypt on a wrong passphrase, so a separate
 * verifier would be a second implementation of an error path we get for free.
 */
export interface Profile {
  pubkey: string
  npub: string
  /** Verified handle, e.g. `alice@imani.local`. Set at registration, read-only after. */
  nip05?: string
  displayName?: string
  about?: string
  picture?: string
  banner?: string
  website?: string
  /** When this record was last written locally, ms. For display only. */
  updatedAt: number
  /**
   * `created_at` of the kind-0 this record's contents came from, in SECONDS.
   *
   * The ordering key for merges, and the reason it is stored rather than
   * derived: kind-0 is a replaceable event, so newest-created_at wins, and
   * `updatedAt` cannot stand in for it — a local save and a remote event have
   * unrelated clocks and meanings.
   */
  eventAt?: number
}

/** The user-editable subset. `nip05` is excluded — it is claimed, not typed. */
export type ProfileFields = Pick<
  Profile,
  'displayName' | 'about' | 'picture' | 'banner' | 'website'
>

/**
 * Accept a website only if it is http(s).
 *
 * This value is rendered as an `href`, and `javascript:` is a URL too. The
 * guard belongs HERE, on the read path, not only in the edit form: `website`
 * also arrives from a kind-0 event and from a restored backup file, neither of
 * which this app authored. `picture` and `banner` have had `imageUrl` for the
 * same reason; this closes the one field that did not.
 *
 * Parsed with `new URL(raw)` and **no base**, deliberately — supplying a base
 * resolves `//evil.test/x`, and even plain text, into an accepted absolute URL.
 */
function webUrl(value: unknown): string | undefined {
  const raw = str(value)
  if (!raw) return undefined
  try {
    const { protocol, href } = new URL(raw)
    return protocol === 'http:' || protocol === 'https:' ? href : undefined
  } catch {
    return undefined
  }
}

/** Strip anything unsafe from a profile that came from outside this app. */
export function sanitiseProfile(profile: Profile): Profile {
  return {
    ...profile,
    picture: imageUrl(profile.picture),
    banner: imageUrl(profile.banner),
    website: webUrl(profile.website),
  }
}

// Matches the `imani-wallet:` prefix dmPoll.ts already established. Keyed by
// pubkey so a device that has held two identities keeps them apart.
const key = (pubkey: string) => `imani-wallet:profile:${pubkey}`

export function loadProfile(pubkey: string): Profile | null {
  try {
    const raw = localStorage.getItem(key(pubkey))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Profile
    // A record written by an older build, or hand-edited, must not crash the
    // header on every render.
    return parsed && typeof parsed.pubkey === 'string' ? parsed : null
  } catch {
    return null
  }
}

export function saveProfile(profile: Profile): void {
  localStorage.setItem(key(profile.pubkey), JSON.stringify(profile))
}

export function clearProfile(pubkey: string): void {
  localStorage.removeItem(key(pubkey))
}

/** A profile for a pubkey we know nothing else about yet. */
export function emptyProfile(pubkey: string): Profile {
  return { pubkey, npub: nip19.npubEncode(pubkey), updatedAt: 0 }
}

/**
 * What to show when there is no display name.
 *
 * Falls back through the handle to a shortened npub, so the header and the login
 * card always have something to render — and `Avatar` always has something to
 * derive initials from.
 */
export function profileName(profile: Profile): string {
  return profile.displayName ?? profile.nip05 ?? `${profile.npub.slice(0, 10)}…`
}

/**
 * Merge a kind-0 payload over a stored record.
 *
 * Absent and empty fields leave the existing value alone rather than clearing
 * it. A relay that returns a sparse kind-0 — or one written by another client
 * that does not know about every field — must not silently wipe the user's
 * profile on login.
 *
 * Image URLs go through branding.ts' guard, which accepts only https: and data:.
 * These strings are attacker-controllable (anyone can publish a kind-0 claiming
 * to be you) and end up in an `src` attribute.
 */
export function mergeKind0(profile: Profile, content: string, createdAt = 0): Profile {
  // Older event, or one we have already taken: ignore it.
  //
  // This guard is what stops a stale read from undoing a fresh edit, and it is
  // not hypothetical — it was observed. The wallet PUBLISHES to the relay but
  // READS through the gateway's nostrdb cache, which is a different store and
  // lags. Without this, logging in after renaming yourself fetches the cached
  // pre-rename event and quietly reverts the name, with no error anywhere.
  if (createdAt > 0 && createdAt <= (profile.eventAt ?? 0)) return profile

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(content) as Record<string, unknown>
  } catch {
    return profile
  }

  return {
    ...profile,
    // `display_name` is the NIP-24 field, `name` the original. Prefer the
    // explicit one, as most clients write both.
    displayName: str(parsed.display_name) ?? str(parsed.name) ?? profile.displayName,
    about: str(parsed.about) ?? profile.about,
    picture: imageUrl(parsed.picture) ?? profile.picture,
    banner: imageUrl(parsed.banner) ?? profile.banner,
    website: webUrl(parsed.website) ?? profile.website,
    nip05: str(parsed.nip05) ?? profile.nip05,
    updatedAt: Date.now(),
    eventAt: createdAt > 0 ? createdAt : profile.eventAt,
  }
}

/**
 * Reconcile the stored record with the relay, as bottin does on every login.
 *
 * Never throws: an unreachable gateway means we show the copy we already have,
 * which is the entire reason a local copy exists.
 */
export async function refreshProfile(pubkey: string): Promise<Profile> {
  try {
    const newest = await fetchNewestKind0(pubkey)
    // The stored copy is READ AFTER THE FETCH, not before it.
    //
    // This runs concurrently with itself on every login: OnboardingPage awaits
    // one call, the app mounts and starts another, and React's StrictMode makes
    // that two in development. The fetch takes SECONDS (measured: 2.0s, 4.0s,
    // 4.1s for the three calls of one login), which is ample time for one of
    // them to finish and save while the others are still waiting.
    //
    // A snapshot taken before the await is a stale empty profile by the time it
    // is returned, and the caller — `App.tsx`, which puts the result straight
    // into state — then renders an anonymous header over a profile that has
    // already arrived. That was the "log back in and my name and avatar are
    // gone until I refresh" bug: the refresh worked because by then the winning
    // call's result was in localStorage.
    const current = loadProfile(pubkey) ?? emptyProfile(pubkey)
    if (newest === null) return current
    const merged = mergeKind0(current, newest.content, newest.createdAt)
    // Unchanged when the fetched event was not newer — no write, no churn.
    if (merged === current) return current
    saveProfile(merged)
    return merged
  } catch {
    return loadProfile(pubkey) ?? emptyProfile(pubkey)
  }
}

/**
 * The kind-0 event to publish.
 *
 * Empty fields are omitted rather than sent as "": a kind-0 replaces the
 * previous one wholesale, so an empty string is a positive assertion that the
 * field is blank, and other clients render it as such.
 *
 * Deliberately no `lud16`. This wallet does not use lightning addresses, and
 * writing an empty one would erase a value the user may have set elsewhere.
 */
export function buildProfileEvent(profile: Profile): EventTemplate {
  const content: Record<string, string> = {}
  const put = (k: string, v?: string) => {
    if (v !== undefined && v.trim() !== '') content[k] = v.trim()
  }

  // Both spellings, because clients are split on which they read.
  put('name', profile.displayName)
  put('display_name', profile.displayName)
  put('about', profile.about)
  put('picture', profile.picture)
  put('banner', profile.banner)
  put('website', profile.website)
  put('nip05', profile.nip05)

  return {
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(content),
  }
}
