import { generateSecretKey, getPublicKey } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils'

import { keyStore } from './nap'
import { roleOf, type TerminalRole } from './terminalRole'
import { terminalActor, type TerminalActor, type TerminalCredential } from './actor'

/**
 * Setting a device up as a terminal, from the device's side.
 *
 * Terminals ticket 04. The device generates its own key, shows the PUBLIC half
 * as an enrolment code, and accepts whatever the owner hands back.
 *
 * ## The private key never leaves, and that is the whole property
 *
 * Everything this module displays, stores or transmits is checked against that
 * in `terminalEnrol.test.ts`, as a negative over the actual emitted values
 * rather than as a promise in a comment. It is what makes the spec's claim
 * true — "setting up a till in a busy market is not a security event" — because
 * the code on screen is a public key and photographing it grants nothing.
 *
 * The credential coming back is equally safe to observe: it is locked to `K`,
 * and `terminalActor` refuses one whose lock is not this device's. So neither
 * QR in the exchange is a secret, which is the property the whole enrolment
 * design rests on.
 *
 * ## Ordering, which is the correctness argument
 *
 * `registration.ts` is the prior art and the rule is the same: nothing is
 * persisted and no session begins until enrolment actually completes. A device
 * that stored its key on `begin()` would leave a half-enrolled terminal holding
 * a key for a stall that never finished authorising it — indistinguishable, at
 * next launch, from a real one.
 *
 * So the key is minted in memory, and `completeEnrolment` is the only thing
 * that writes. It writes the credential ONLY after the credential has been
 * verified against the device's own key, so a credential for somebody else
 * cannot be stored even briefly.
 */

/** Where a completed enrolment is kept. One terminal per device. */
const ENROLMENT_KEY = 'imani-wallet:terminal'

/**
 * The key this device generated, held in memory until enrolment completes.
 *
 * Module-level and deliberately not exported, mirroring `registration.ts`'s
 * `pending`: a caller that could read this could log it, and the one thing this
 * module promises is that nothing outside it sees the private half.
 *
 * Reused across attempts so that a retry shows the SAME code — an owner who
 * scanned once and hit a network error should not have to rescan a new key.
 */
let pending: { privkeyHex: string; pubkey: string } | undefined

function mintKey(): { privkeyHex: string; pubkey: string } {
  if (!pending) {
    const sk = generateSecretKey()
    pending = { privkeyHex: bytesToHex(sk), pubkey: getPublicKey(sk) }
  }
  return pending
}

/** For tests, and for starting over after a completed enrolment. */
export function forgetPendingKey(): void {
  pending = undefined
}

/**
 * What the terminal shows the owner to scan.
 *
 * A public key and nothing else. Not a URI with parameters, not a payload with
 * a nonce: anything more would be something to keep in sync with a parser, and
 * the owner's side already knows it is scanning a terminal key because of the
 * screen it is on.
 */
export interface EnrolmentCode {
  /** The device's public key, hex. Safe to photograph. */
  terminalPubkey: string
  /** What the QR encodes. */
  uri: string
}

/**
 * Begin enrolment: mint a key and show its public half.
 *
 * Persists NOTHING. A device that got this far and then walked away is a device
 * that was never enrolled, and at next launch it is indistinguishable from one
 * that never started — which is the correct outcome.
 */
export function beginEnrolment(): EnrolmentCode {
  const { pubkey } = mintKey()
  return {
    terminalPubkey: pubkey,
    // The same `nostr:` convention the rest of the app's scanners already
    // tolerate, so the owner's scanner routes it without a new format.
    uri: `nostr:${pubkey}`,
  }
}

/** A terminal that has completed enrolment, as stored on the device. */
export interface StoredTerminal {
  /** The stall this terminal acts for. */
  stallPubkey: string
  role: TerminalRole
  /** This device's own public key. The private half is in the key store. */
  terminalPubkey: string
  permissions: readonly string[]
  /** What the owner named it, for the device to show its operator. */
  name?: string
  enrolledAt: number
  /**
   * The credential voucher itself, ticket 10.
   *
   * Kept because the credential IS the authority: login re-derives permissions
   * from its signed metadata rather than trusting the fields above, and
   * revocation is the act of spending this token. Without it the device would
   * hold a description of its authority and not the authority.
   *
   * Optional so a device enrolled before ticket 10 still reads back as
   * enrolled rather than as corrupt — it simply cannot do the credential-based
   * login until it is enrolled again.
   */
  token?: string
  /** The voucher's `merchant_metadata`, which login re-verifies. */
  merchantMetadata?: string
  /**
   * The voucher's `issuerId` — the STALL.
   *
   * Not `issuerPublicKey`, which is the gateway's signing key and identical on
   * every voucher it mints. Minting one for real is what surfaced the
   * difference; checking the stall against the wrong one refuses every genuine
   * credential.
   */
  issuerId?: string
}

/**
 * Finish enrolment: verify what the owner returned, then store.
 *
 * The ORDER is the ticket's fifth criterion. Every check happens before any
 * write, so a credential that does not check out leaves the device exactly as
 * it was — no key in the store, no terminal record, no session.
 *
 * `terminalActor` is what does the verifying, and it is the same function the
 * app uses at every later login. Re-implementing the checks here would be two
 * definitions of "is this credential ours", which is how one of them drifts
 * into being weaker.
 *
 * The passphrase is required and encrypts `K` at rest, entered when the
 * terminal opens for trade. A terminal with no passphrase would be a device
 * that trades for a stall the moment it is switched on, which is the fourth
 * user story's whole objection.
 */
export async function completeEnrolment(
  credential: TerminalCredential,
  passphrase: string,
  name?: string,
  /**
   * The credential voucher, ticket 10.
   *
   * Optional so ticket 04's stand-in enrolment still works, but a terminal
   * enrolled without it cannot do credential-based login — the authority it
   * holds would be a description rather than the thing itself.
   */
  voucher?: { token: string; merchantMetadata: string; issuerId: string },
): Promise<TerminalActor> {
  if (!pending) {
    throw new Error('Start enrolment on this device before scanning a code.')
  }
  if (!passphrase) {
    // Refused rather than defaulted. A blank passphrase is a key at rest in
    // clear, and the terminal would open for trade for whoever picked it up.
    throw new Error('A passphrase is needed to protect this terminal.')
  }

  // Verified BEFORE anything is written, and against this device's own key, so
  // a credential meant for another terminal is refused rather than stored.
  const actor = terminalActor(credential, pending.pubkey)
  if (!actor) {
    throw new Error('That code is not a valid authority for this terminal.')
  }

  // Only now is the key worth keeping — `registration.ts`'s comment, and the
  // same reason.
  await keyStore.save(pending.privkeyHex, passphrase)

  const stored: StoredTerminal = {
    stallPubkey: actor.stallPubkey,
    role: actor.role,
    terminalPubkey: actor.terminalPubkey,
    permissions: [...actor.permissions],
    name: name?.trim() || undefined,
    enrolledAt: Date.now(),
    ...(voucher
      ? {
          token: voucher.token,
          merchantMetadata: voucher.merchantMetadata,
          issuerId: voucher.issuerId,
        }
      : {}),
  }
  localStorage.setItem(ENROLMENT_KEY, JSON.stringify(stored))

  // The pending key has been persisted; a further enrolment starts fresh.
  forgetPendingKey()
  return actor
}

/**
 * The terminal this device was enrolled as, or null.
 *
 * Read on launch so the device logs itself in "without a person present" — the
 * fourth acceptance criterion. Anything unreadable or structurally wrong reads
 * as NOT ENROLLED rather than throwing: a corrupted record must send the device
 * back to enrolment, not into a state where it believes it has an authority it
 * cannot describe.
 */
export function storedTerminal(): StoredTerminal | null {
  try {
    const raw = localStorage.getItem(ENROLMENT_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<StoredTerminal>
    const role = roleOf(parsed.role)
    if (!role) return null
    if (typeof parsed.stallPubkey !== 'string' || typeof parsed.terminalPubkey !== 'string') {
      return null
    }
    if (!Array.isArray(parsed.permissions)) return null

    return {
      stallPubkey: parsed.stallPubkey,
      role,
      terminalPubkey: parsed.terminalPubkey,
      permissions: parsed.permissions.filter((p): p is string => typeof p === 'string'),
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      enrolledAt: typeof parsed.enrolledAt === 'number' ? parsed.enrolledAt : 0,
      // Validated like everything else here rather than cast: a record edited
      // to carry a number where the token belongs must read as "no credential"
      // and send the device back to enrolment, not into a login that throws.
      token: typeof parsed.token === 'string' ? parsed.token : undefined,
      merchantMetadata:
        typeof parsed.merchantMetadata === 'string' ? parsed.merchantMetadata : undefined,
      issuerId: typeof parsed.issuerId === 'string' ? parsed.issuerId : undefined,
    }
  } catch {
    return null
  }
}

/**
 * The actor this device logs in as, re-verified from what was stored.
 *
 * NOT simply the stored record cast to an actor. The record is on disk, where
 * anything could have edited it, so it goes back through `terminalActor` —
 * which re-checks that the permissions match the role for that stall. A device
 * whose storage was tampered with to add issuance is refused here, at launch,
 * rather than discovering it at the API.
 */
export function enrolledActor(): TerminalActor | null {
  const stored = storedTerminal()
  if (!stored) return null

  return terminalActor(
    {
      stallPubkey: stored.stallPubkey,
      role: stored.role,
      // The record names the device it was written for; if that is not this
      // device's key, the check fails, which is what we want.
      lockedTo: stored.terminalPubkey,
      permissions: stored.permissions,
    },
    stored.terminalPubkey,
  )
}

/** Erase the terminal record. The wipe half of decommissioning (ticket 08). */
export function forgetTerminal(): void {
  try {
    localStorage.removeItem(ENROLMENT_KEY)
  } catch {
    // Nothing to do: the caller is clearing state that may not exist.
  }
}
