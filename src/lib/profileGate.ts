import { getPublicKey } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

import { gatewayConfig } from './config'
import { claimHandle } from './registration'
import { normaliseHandle } from './validate'
import type { RequestSigner } from './nip98'
import { buildProfileEvent, emptyProfile, loadProfile, saveProfile, type Profile } from './profile'
import { allEvents, publish } from './relay'
import { createWalletSigner } from './signer'
import { requireTermsAccepted, type TermsAcceptance } from './terms'

/**
 * No account without a profile (owner rule, 2026-10-18, #325).
 *
 * Every account on the service has a directory handle (bottin). A key brought
 * to a fresh device, from a backup or pasted, is only let in once that handle
 * is VERIFIED for its public key. The profile cached inside a backup file is
 * not enough: it is whatever the file says.
 *
 * How it is verified is standard NIP-05, and that choice is load-bearing. The
 * obvious shortcut, the gateway's reverse lookup `GET /api/v1/resolve/pubkey/
 * {hex}`, only knows gateway-core's own records: on staging it answers 404 for
 * a real bottin account (samson) whose forward lookup resolves fine. Using it
 * would have pushed every bottin user into "Finish your profile". So:
 *
 *   1. read the account's newest kind-0 (gateway cache AND relay, newest wins,
 *      as everywhere else in the app) and take its `nip05`;
 *   2. resolve that handle forwards (`GET /api/v1/resolve/{nip05}`, which reads
 *      the directory and the domain's nostr.json);
 *   3. it counts only if the handle resolves to THIS public key.
 *
 * A key that fails is not logged in as an anonymous account. The caller stops
 * before writing anything and asks for a handle, which `claimProfile` claims
 * exactly as registration does. Only then is the key installed.
 *
 * Fails closed ONLY when nothing could be asked at all. A store that does not
 * know the account is an answer ("no profile"), never an outage.
 */

/** Nothing could be asked. Never treated as "no profile". */
export class DirectoryUnavailableError extends Error {
  constructor() {
    super('Could not check your profile just now. Check your connection and try again.')
    this.name = 'DirectoryUnavailableError'
  }
}

/** The key opened, but its account has no verified profile. Nothing has been written. */
export class ProfileMissingError extends Error {
  constructor(readonly privkeyHex: string) {
    super('This account needs a profile before it can be used.')
    this.name = 'ProfileMissingError'
  }
}

/**
 * How long one directory question may take. A gateway that hangs must end in
 * "try again" (fail closed), not a Log in button spinning for ever.
 */
const DIRECTORY_TIMEOUT_MS = 15_000

interface Kind0 {
  content: string
  createdAt: number
}

/**
 * The newest kind-0 for a pubkey from BOTH stores, or null when neither holds
 * one.
 *
 * Throws DirectoryUnavailableError when the gateway could not be asked and the
 * relay found nothing. One store answering while the other is down is still an
 * answer when it holds a kind-0 (the gateway cache, for one, never sees a
 * kind-0 published straight to the relay).
 */
async function newestKind0(pubkey: string): Promise<Kind0 | null> {
  const fromGateway = (async (): Promise<Kind0 | null> => {
    const response = await fetch('/api/v1/nostr/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ kinds: [0], authors: [pubkey], limit: 10 }),
      signal: AbortSignal.timeout(DIRECTORY_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`gateway ${response.status}`)
    const body = (await response.json()) as {
      events?: Array<{ pubkey?: string; content?: string; createdAt?: number; created_at?: number }>
    }
    let best: Kind0 | null = null
    for (const e of body.events ?? []) {
      if (e.pubkey !== undefined && e.pubkey !== pubkey) continue
      const at = e.createdAt ?? e.created_at ?? 0
      if (typeof e.content === 'string' && (!best || at > best.createdAt)) best = { content: e.content, createdAt: at }
    }
    return best
  })()

  const fromRelay = allEvents(pubkey, 0).then((events) => {
    const newest = events.filter((e) => e.pubkey === pubkey).sort((a, b) => b.created_at - a.created_at)[0]
    return newest ? { content: newest.content, createdAt: newest.created_at } : null
  })

  const [gateway, relay] = await Promise.allSettled([fromGateway, fromRelay])
  const a = gateway.status === 'fulfilled' ? gateway.value : null
  const b = relay.status === 'fulfilled' ? relay.value : null
  // The relay read cannot tell "unreachable" from "nothing here" (an
  // unreachable relay resolves empty), so only the gateway can say "no
  // profile". If it could not be asked and the relay found nothing, that is an
  // outage, not an answer.
  if (gateway.status === 'rejected' && !b) throw new DirectoryUnavailableError()
  if (!a) return b
  if (!b) return a
  return b.createdAt > a.createdAt ? b : a
}

function normaliseNip05(value: unknown): string | null {
  const nip05 = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(nip05) ? nip05 : null
}

function nip05Of(content: string): string | null {
  try {
    return normaliseNip05((JSON.parse(content) as { nip05?: unknown }).nip05)
  } catch {
    return null
  }
}

/**
 * The public key a handle resolves to, forwards, or null when it resolves to
 * nobody.
 *
 * @throws DirectoryUnavailableError when the directory could not be asked
 */
async function resolveForward(nip05: string): Promise<string | null> {
  let response: Response
  try {
    response = await fetch(`/api/v1/resolve/${encodeURIComponent(nip05)}`, {
      credentials: 'include',
      signal: AbortSignal.timeout(DIRECTORY_TIMEOUT_MS),
    })
  } catch {
    throw new DirectoryUnavailableError()
  }
  if (response.status === 404) return null
  // A 4xx is the directory's answer about this handle (malformed, refused):
  // the handle does not verify. Only a server or proxy failure is an outage.
  if (response.status >= 500) throw new DirectoryUnavailableError()
  if (!response.ok) return null
  const body = (await response.json().catch(() => null)) as { hex_pubkey?: unknown } | null
  const hex = typeof body?.hex_pubkey === 'string' ? body.hex_pubkey.toLowerCase() : ''
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null
}

/**
 * The account's verified handle, or null when it has none.
 *
 * @throws DirectoryUnavailableError when nothing could be asked
 */
export async function verifiedHandle(pubkey: string, alsoTry: Array<string | undefined> = []): Promise<string | null> {
  const key = pubkey.toLowerCase()
  // The kind-0 is asked first, but it is not the only place a handle can be
  // known. A claim whose kind-0 never reached the relay (the publish is
  // best-effort, as in registration) leaves a handle the directory holds and no
  // kind-0 names; the backup or this device may still know it. Every candidate
  // is verified FORWARDS, so a wrong or spoofed one simply fails.
  let kind0: Kind0 | null = null
  let outage: unknown = null
  try {
    kind0 = await newestKind0(key)
  } catch (e) {
    outage = e
  }
  const candidates = [kind0 ? nip05Of(kind0.content) : null, ...alsoTry.map(normaliseNip05)]
  const seen = new Set<string>()
  for (const nip05 of candidates) {
    if (!nip05 || seen.has(nip05)) continue
    seen.add(nip05)
    try {
      if ((await resolveForward(nip05)) === key) return nip05
    } catch (e) {
      outage = e
    }
  }
  // Nothing verified. If any question went unanswered, that is an outage, not
  // "no profile": failing closed keeps a reachable-later account out of
  // "Finish your profile".
  if (outage) throw outage
  return null
}

/**
 * Check a key that has just been opened. Writes nothing.
 *
 * @param knownHandle a handle believed to be this account's (the backup's
 *        stored profile): tried, and verified, when the kind-0 names none
 *
 * @returns the account's verified handle
 * @throws ProfileMissingError when it has none
 * @throws DirectoryUnavailableError when nothing could be asked
 */
export async function requireProfile(privkeyHex: string, knownHandle?: string): Promise<string> {
  const pubkey = getPublicKey(hexToBytes(privkeyHex))
  // Besides the kind-0: the handle a backup file names (passed in), and the one
  // this device already holds for the key. Both verified forwards like the rest.
  const nip05 = await verifiedHandle(pubkey, [knownHandle, loadProfile(pubkey)?.nip05])
  if (!nip05) throw new ProfileMissingError(privkeyHex)
  return nip05
}

/** Store the verified handle on the local profile, so the header has it at once. */
export function rememberHandle(privkeyHex: string, nip05: string): void {
  const pubkey = getPublicKey(hexToBytes(privkeyHex))
  const current = loadProfile(pubkey) ?? emptyProfile(pubkey)
  if (current.nip05 === nip05) return
  saveProfile({ ...current, nip05, displayName: current.displayName ?? nip05.split('@')[0] })
}

/**
 * Give an existing key the profile it is missing: claim the handle, then
 * announce the profile, in registration's order.
 *
 * The claim is NIP-98 signed by the key itself, so it needs no session. A
 * taken handle throws `HandleTakenError` having written nothing.
 *
 * @param base what is already known about the account (the backup's stored
 *        profile): its display name and picture are kept, else the handle
 *        becomes the display name, as a customer registration does
 * @param terms the Terms and Conditions acceptance (review of #358). REQUIRED:
 *        the first handle a key claims is what creates its account on the
 *        service, so this refuses, before the claim, exactly as `register` does
 * @throws TermsNotAcceptedError / TermsNotConfiguredError before anything is claimed
 */
export async function claimProfile(
  privkeyHex: string,
  handle: string,
  base: Profile | null | undefined,
  terms: TermsAcceptance,
): Promise<Profile> {
  return claimProfileWith(createWalletSigner(privkeyHex), handle, base, terms)
}

/**
 * `claimProfile` for a key that is already unlocked (#332): the logged-in
 * account finishing its profile from its own profile card. Same claim, same
 * order, same idempotent retry; only where the signer comes from differs.
 */
export async function claimProfileWith(
  signer: RequestSigner & { readonly pubkey: string },
  typed: string,
  base: Profile | null | undefined,
  terms: TermsAcceptance,
): Promise<Profile> {
  // First, before the handle is claimed (review of #358): a key with no handle has no account on
  // the service yet, and claiming one creates it. Same gate, same order as `register`.
  const termsAccepted = requireTermsAccepted(terms)
  const handle = normaliseHandle(typed)
  const pubkey = signer.pubkey
  const { nip05Domain } = await gatewayConfig()

  await claimHandle(handle, pubkey, signer)

  const current = loadProfile(pubkey) ?? (base?.pubkey === pubkey ? base : null) ?? emptyProfile(pubkey)
  const profile: Profile = {
    ...current,
    nip05: `${handle}@${nip05Domain}`,
    displayName: current.displayName?.trim() || handle,
    // Kept if this record already holds one (the original acceptance is never overwritten),
    // else the one just given. Travels with backups, as registration's does.
    termsAccepted: current.termsAccepted ?? termsAccepted,
    updatedAt: Date.now(),
  }
  // A relay that will not take the kind-0 is not a failed claim: the handle is
  // the profile's anchor and it is now held. Same contract as `register`.
  try {
    const signed = await signer.signEvent(buildProfileEvent(profile))
    profile.eventAt = signed.created_at
    await publish(signed)
  } catch {
    // Reported by absence, as registration does.
  }
  saveProfile(profile)
  return profile
}
