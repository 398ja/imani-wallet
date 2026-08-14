import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import { gatewayConfig } from './config'
import { signedFetch, type RequestSigner } from './nip98'
import { RELAY_URL, publish } from './relay'
import { buildProfileEvent, emptyProfile, saveProfile, type Profile } from './profile'
import {
  buildMerchantEvent,
  emptyMerchant,
  saveMerchant,
  type MerchantFields,
  type MerchantProfile,
} from './merchant'
import { keyStore } from './nap'
import { createWalletSigner } from './signer'
import { stashPendingBackup } from './onboardingHandoff'

/**
 * Creating an account: mint a key, claim a handle, then keep both.
 *
 * The ORDER is a correctness property. bottin's registration.js claims the
 * handle before persisting the key, so a browser can never hold an identity
 * asserting a NIP-05 that belongs to someone else. We keep that and go further:
 * the LOGIN is last too.
 *
 * bottin has to log in first because its own POST /api/v1/register reads the
 * pubkey from a NAP session cookie. The gateway's POST /api/v1/nip05 does not —
 * it is NIP-98 authenticated, so a signature over the request is the whole
 * credential and a signer built from the fresh key is enough.
 *
 * That matters because logging in flips the entire app from the public tree to
 * the authenticated one. Doing it first — as an earlier version of this file
 * did — remounts the app mid-registration: the backup screen never appears
 * (the nsec is stashed after the remount has already read for it) and the
 * header renders an empty profile, because the profile is saved later still.
 * Both were observed. With login last, a failed claim leaves NO session, NO
 * stored key and NO profile, and the user is still on the form with their
 * handle to correct.
 */

export class HandleTakenError extends Error {
  constructor(handle: string) {
    super(`${handle} is already taken.`)
    this.name = 'HandleTakenError'
  }
}

/**
 * The key minted for an in-flight registration.
 *
 * Held at module scope so that retrying after a failed claim reuses the same
 * key instead of burning a fresh one each attempt. bottin does the same, and the
 * reason is not tidiness: every abandoned key is one the user might already have
 * been shown and written down.
 */
interface Pending {
  privkeyHex: string
  pubkey: string
  /**
   * The handle this key has ALREADY claimed successfully, if any.
   *
   * Registration can still fail after the claim — the login is the last step —
   * and the user is then left on the form to try again. Without this, the retry
   * re-sends the claim, the gateway answers 409 because the handle is now taken
   * *by this very key*, and the form tells the user their own handle is taken
   * and to pick another. Which they would, claiming a second handle for one key.
   */
  claimedHandle?: string
}

let pending: Pending | undefined

function mintKey(): Pending {
  if (!pending) {
    const sk = generateSecretKey()
    pending = { privkeyHex: bytesToHex(sk), pubkey: getPublicKey(sk) }
  }
  return pending
}

/** Called once registration completes, so the next one starts fresh. */
function clearPending(): void {
  pending = undefined
}

export interface RegistrationOutcome {
  nsec: string
  profile: Profile
  /** Present only for a merchant signup. Its absence is what makes an account a customer. */
  merchant?: MerchantProfile
  /** How many relays accepted the initial kind-0. Zero is survivable. */
  published: number
  relayCount: number
}

/**
 * Advisory availability check.
 *
 * CAUTION: this cannot be trusted, and the UI must not gate submission on it.
 * `GET /api/v1/resolve/{nip05}` performs an EXTERNAL NIP-05 lookup — it fetches
 * `https://{domain}/.well-known/nostr.json` — rather than reading the directory
 * that `POST /api/v1/nip05` writes to. On a stack whose domain is not publicly
 * resolvable (imani.local), it answers 404 for every handle including ones that
 * exist, so it always says "available". Verified against a live record.
 *
 * The authoritative answer is the 409 from the claim itself.
 */
export async function isHandleAvailable(handle: string): Promise<boolean> {
  const { nip05Domain } = await gatewayConfig()
  const response = await fetch(`/api/v1/resolve/${encodeURIComponent(`${handle}@${nip05Domain}`)}`, {
    credentials: 'include',
  })

  if (response.status === 404) return true
  if (response.ok) return false

  // Anything else — 500, a proxy 502, an auth failure — says nothing about the
  // handle. Throwing sends the caller down its "probe failed" path, which shows
  // no verdict at all. Returning false here would paint "Already taken" under a
  // handle nobody has, on a gateway hiccup.
  throw new Error(`Could not check that handle (${response.status}).`)
}

/**
 * Claim the handle for the already-authenticated pubkey.
 *
 * The pubkey is sent in the body AND proven by the NIP-98 signature; the gateway
 * rejects a mismatch with 403. This is the non-custodial "raw pubkey" mode —
 * no bunker, no server-held key.
 */
async function claimHandle(
  handle: string,
  pubkey: string,
  signer: RequestSigner,
): Promise<void> {
  const response = await signedFetch(
    '/api/v1/nip05',
    'POST',
    { username: handle, pubkey, relays: [RELAY_URL] },
    signer,
  )

  if (response.ok) return
  if (response.status === 409) throw new HandleTakenError(handle)

  // Surface the gateway's own message. Its failures here are specific and
  // actionable (DOMAIN_NOT_FOUND, DOMAIN_NOT_VERIFIED are stack-setup problems,
  // not user errors) and flattening them to "registration failed" has already
  // cost one debugging round.
  const detail = await response
    .json()
    .then((body: { error?: { message?: string } }) => body.error?.message)
    .catch(() => undefined)
  throw new Error(detail ?? `Could not claim ${handle} (${response.status}).`)
}

/**
 * Register a brand-new account.
 *
 * @param handle   the local part, already validated
 * @param passphrase encrypts the key at rest
 * @param login    performs the NAP handshake; supplied by the caller because
 *                 building a session needs React's nap callbacks
 * @param merchant when present, this account trades as a merchant: the extra
 *                 metadata is published as a kind-30078 record beside the
 *                 kind-0. Absent means a customer, which is the whole of the
 *                 role model — see lib/merchant.ts.
 */
export async function register(
  handle: string,
  passphrase: string,
  login: (privkeyHex: string) => Promise<void>,
  merchant?: MerchantFields,
): Promise<RegistrationOutcome> {
  const minted = mintKey()
  const { privkeyHex, pubkey } = minted
  const { nip05Domain } = await gatewayConfig()

  // A signer over the fresh key, independent of the session that does not exist
  // yet. NIP-98 needs nothing else.
  const signer = createWalletSigner(privkeyHex)

  // 1. Claim the handle. Throws on conflict, having persisted nothing.
  //    Skipped when this key already claimed this same handle on an earlier
  //    attempt that failed further down — re-sending would 409 against itself.
  if (minted.claimedHandle !== handle) {
    await claimHandle(handle, pubkey, signer)
    minted.claimedHandle = handle
  }

  // 2. Only now is the key worth keeping.
  await keyStore.save(privkeyHex, passphrase)

  const profile: Profile = {
    ...emptyProfile(pubkey),
    nip05: `${handle}@${nip05Domain}`,
    displayName: handle,
    updatedAt: Date.now(),
  }
  saveProfile(profile)

  // 3. Announce the profile. A relay that will not take it is not a failed
  //    registration — the handle is claimed and the key is safe — so this is
  //    reported, never thrown.
  let published = 0
  let relayCount = 0
  try {
    const signed = await signer.signEvent(buildProfileEvent(profile))
    // Stamp the record with what we published, so a later read of the gateway's
    // (possibly staler) nostrdb cache does not look newer than this.
    profile.eventAt = signed.created_at
    saveProfile(profile)

    const { ok, total } = await publish(signed)
    published = ok
    relayCount = total
  } catch {
    // Leaves published at 0, which the caller reports.
  }

  // 3b. And the merchant record, if this account is trading as one. Saved
  //     locally first for the same reason as the profile: the relay is the
  //     source of truth but the app must render before it answers.
  //
  //     Separately try/caught rather than folded into the block above, so a
  //     relay that rejects one event does not lose the other — and so a
  //     merchant whose kind-0 published but whose kind-30078 did not still has
  //     a local record to re-publish from /settings/merchant.
  let merchantRecord: MerchantProfile | undefined
  if (merchant) {
    merchantRecord = { ...emptyMerchant(pubkey), ...merchant, updatedAt: Date.now() }
    saveMerchant(merchantRecord)
    try {
      const signed = await signer.signEvent(buildMerchantEvent(merchantRecord))
      merchantRecord.eventAt = signed.created_at
      saveMerchant(merchantRecord)
      await publish(signed)
    } catch {
      // Same contract as the profile above: reported by absence, never thrown.
      // The handle is claimed and the key is saved; this is not a failed signup.
    }
  }

  const nsec = nip19.nsecEncode(hexToBytes(privkeyHex))

  // 4. Park the key for the backup screen BEFORE logging in. Logging in
  //    remounts the app into its authenticated tree, and that remount is what
  //    reads this — stashing afterwards means the screen never sees it.
  stashPendingBackup(pubkey, nsec)

  // 5. Last. Everything above is durable, so a session failure here is
  //    recoverable by unlocking normally.
  await login(privkeyHex)

  clearPending()
  return { nsec, profile, merchant: merchantRecord, published, relayCount }
}
