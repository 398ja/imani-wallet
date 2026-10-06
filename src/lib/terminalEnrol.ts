import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import type { RequestSigner } from './nip98'
import {
  offerFromRumor,
  unwrapSealed,
  wrapMessage,
  type CredentialOffer,
  type ExpectedOffer,
  type OfferRefusal,
} from './terminalDelivery'

import { keyStore } from './nap'
import { sweepAppStorage } from './appStorage'
import { forgetResume } from './resume'
import { wipeWallet } from './wallet'
import { roleOf, type TerminalRole } from './terminalRole'
import { terminalActor, type TerminalActor, type TerminalCredential } from './actor'
import { credentialFromToken } from './terminalLogin'
import { parseTerminalMetadata } from './terminalCredential'

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

/** The minimum passphrase length for a terminal (decision 2 on #160). */
export const MIN_PASSPHRASE_LENGTH = 8

/**
 * Credentials sent to this device's pending key, checked (#160 phase 2).
 *
 * Unwrapped HERE, with the pending key, so the private half never leaves this module, which
 * is the promise at the top of the file. Each wrap is opened, its seal verified, and the
 * credential inside read from its own signed bytes (`offerFromRumor`). Refusals are returned
 * too, so a screen can say "a credential arrived for another device" rather than nothing.
 *
 * @param wraps gift wraps addressed to the pending key, as the gateway or relay returned them
 */
export function offersFor(
  wraps: readonly Event[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
  /** The offer the owner's setup code names. Without it every offer is refused. */
  expected?: ExpectedOffer,
): Array<CredentialOffer | OfferRefusal> {
  if (!pending) return []
  const key = hexToBytes(pending.privkeyHex)
  try {
    return wraps.flatMap((wrap) => {
      const opened = unwrapSealed(wrap, key)
      if (!opened) return []
      const offer = offerFromRumor(opened.rumor, opened.sealer, pending!.pubkey, nowSeconds, expected)
      return offer === 'not-a-credential-dm' ? [] : [offer]
    })
  } finally {
    key.fill(0)
  }
}

/**
 * What `completeEnrolment` lends a caller, after storing and before the key is forgotten.
 *
 * Capabilities, not the key: wrap a message as this terminal, and sign a NIP-98 request as it.
 * Both are exactly what sending the enrolled DM needs, and neither returns the private half.
 */
export interface EnrolmentAnnouncer {
  wrap(recipient: string, content: string): Event
  signer: RequestSigner
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

/**
 * A terminal that has completed enrolment, as stored on the device.
 *
 * Since #160 phase 3 the `token` is the only authority here (spec section 6). Login reads the
 * stall, role and lock from the token's own signed bytes (`credentialFromToken`), so a record
 * edited to claim another role or stall changes nothing. The other fields are display hints.
 * `permissions`, `merchantMetadata` and `issuerId` are gone: they were read back as authority,
 * and anyone holding the device could edit them (IW-15). A record without a `token` reads as not
 * enrolled.
 */
export interface StoredTerminal {
  /** The stall this terminal acts for. A display hint: login reads it from the token. */
  stallPubkey: string
  /** A display hint: login reads the role from the token. */
  role: TerminalRole
  /** This device's own public key. The private half is in the key store. */
  terminalPubkey: string
  /** What the owner named it, for the device to show its operator. */
  name?: string
  enrolledAt: number
  /**
   * The credential voucher itself, and the only authority on this record.
   *
   * Login re-derives everything from its signed bytes, and revocation is the act of spending it.
   */
  token: string
  /** The credential's voucher id (#160 phase 2), which the enrolled DM names. */
  voucherId?: string
  /**
   * Minutes of no touch before the till locks itself (decision 2). `0` is off, missing is the
   * default. A display hint like the rest: the owner chose it, and nothing here grants.
   */
  idleLockMinutes?: number
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
   * The credential voucher, ticket 10. Required since #160 phase 3: the token is the only
   * authority a terminal holds, and login reads it from the token's signed bytes. A record
   * without one would read as not enrolled, so storing one is refused rather than written.
   */
  voucher?: { token: string },
  /**
   * #160 phase 2. `voucherId` and `idleLockMinutes` are stored with the record, and
   * `announce` runs once the record is stored and before the pending key is forgotten, so
   * the device can tell its stall it is in service. A failed announce does not undo the
   * enrolment: the device is set up either way, and the owner can see it at next use.
   */
  options: {
    voucherId?: string
    idleLockMinutes?: number
    announce?: (tools: EnrolmentAnnouncer) => Promise<void>
  } = {},
): Promise<TerminalActor> {
  if (!pending) {
    throw new Error('Start enrolment on this device before scanning a code.')
  }
  // #160 phase 0 (G11). The key store has ONE slot, and `keyStore.save` below
  // overwrites it. On a device that already holds a person's wallet key, that
  // write would destroy the key to their money with nothing to show for it but
  // a terminal. One account per device: setup refuses, and the person logs out
  // first, where they are shown the backup warning. Checked before anything
  // else that could write, and before the credential is even looked at.
  if (await keyStore.hasKey()) {
    throw new Error(
      'This device already holds a wallet. Log out of it first, keeping its backup key, ' +
        'then set the device up as a terminal.',
    )
  }
  if (!passphrase) {
    // Refused rather than defaulted. A blank passphrase is a key at rest in
    // clear, and the terminal would open for trade for whoever picked it up.
    throw new Error('A passphrase is needed to protect this terminal.')
  }
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    // Decision 2 on #160: at least 8 characters on a shared till.
    throw new Error(
      `Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters to protect this terminal.`,
    )
  }

  // Verified BEFORE anything is written, and against this device's own key, so
  // a credential meant for another terminal is refused rather than stored.
  const actor = terminalActor(credential, pending.pubkey)
  if (!actor) {
    throw new Error('That code is not a valid authority for this terminal.')
  }
  // And the token must say the same thing, from its own signed bytes, because the token is what
  // login will read (#160 phase 3). A token for another stall, role or device is refused here
  // rather than stored and refused at every unlock.
  const facts = voucher?.token ? credentialFromToken(voucher.token) : null
  const signed = facts ? parseTerminalMetadata(facts.merchantMetadata) : null
  if (
    !facts ||
    !signed ||
    signed.lock_key !== actor.terminalPubkey ||
    signed.stall_pubkey !== actor.stallPubkey ||
    facts.issuerId.toLowerCase() !== actor.stallPubkey ||
    signed.role !== actor.role
  ) {
    throw new Error('That code is not a valid authority for this terminal.')
  }
  const token = voucher!.token

  // Only now is the key worth keeping — `registration.ts`'s comment, and the
  // same reason.
  await keyStore.save(pending.privkeyHex, passphrase)

  const stored: StoredTerminal = {
    stallPubkey: actor.stallPubkey,
    role: actor.role,
    terminalPubkey: actor.terminalPubkey,
    name: name?.trim() || undefined,
    enrolledAt: Date.now(),
    token,
    ...(options.voucherId ? { voucherId: options.voucherId } : {}),
    ...(options.idleLockMinutes !== undefined ? { idleLockMinutes: options.idleLockMinutes } : {}),
  }
  localStorage.setItem(ENROLMENT_KEY, JSON.stringify(stored))

  if (options.announce) {
    const held = pending
    const announcer: EnrolmentAnnouncer = {
      wrap: (recipient, content) => {
        const key = hexToBytes(held.privkeyHex)
        try {
          return wrapMessage(key, recipient, content)
        } finally {
          key.fill(0)
        }
      },
      signer: {
        signEvent: async (template) => {
          const key = hexToBytes(held.privkeyHex)
          try {
            return finalizeEvent(template, key)
          } finally {
            key.fill(0)
          }
        },
      },
    }
    try {
      await options.announce(announcer)
    } catch {
      // The device is enrolled. Telling the stall is a courtesy that can fail
      // on a bad connection, and must not turn a stored enrolment into an error.
    }
  }

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
    // A record without a token reads as not enrolled (#160 phase 3, spec 6): the token is the
    // only authority, and a record that has none describes an authority it does not hold.
    // Validated rather than cast: a number where the token belongs is no credential.
    if (typeof parsed.token !== 'string' || !parsed.token) return null

    return {
      stallPubkey: parsed.stallPubkey,
      role,
      terminalPubkey: parsed.terminalPubkey,
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      enrolledAt: typeof parsed.enrolledAt === 'number' ? parsed.enrolledAt : 0,
      token: parsed.token,
      voucherId: typeof parsed.voucherId === 'string' ? parsed.voucherId : undefined,
      idleLockMinutes:
        typeof parsed.idleLockMinutes === 'number' && parsed.idleLockMinutes >= 0
          ? parsed.idleLockMinutes
          : undefined,
    }
  } catch {
    return null
  }
}

/**
 * Whether this device was enrolled as a terminal, token or not (#160 review, LOW).
 *
 * `storedTerminal()` reads a record without a token as not enrolled, which is right for its
 * question ("what authority does this device hold?") and wrong for routing: Entry used it, sent
 * such a device to /login, and its terminal key opened a NAP session as a customer, which spec
 * 2.3 forbids. Any record that names a device key makes this a terminal device. It is then
 * routed to the till's unlock screen, which refuses the missing credential and offers to remove
 * the terminal from the device.
 */
export function isTerminalDevice(): boolean {
  return storedTerminalPubkey() !== null
}

/** Erase the terminal record. The wipe half of decommissioning (ticket 08). */
export function forgetTerminal(): void {
  try {
    localStorage.removeItem(ENROLMENT_KEY)
  } catch {
    // Nothing to do: the caller is clearing state that may not exist.
  }
}

/**
 * Take this device out of terminal service, locally (#160 review).
 *
 * The escape hatch for a device enrolled in phase 2, before phase 3 can open its till: it
 * erases the encrypted terminal key and the terminal record, so the device can be set up
 * again or used as an ordinary wallet. Since #160 round 2 it clears everything logout clears
 * (see `RemovedFromDevice`). It does NOT revoke the credential at the mint. Only
 * the owner can do that, from their terminal list, and the screen says so.
 */
export async function removeTerminalFromDevice(): Promise<RemovedFromDevice> {
  // Read before the sweep erases it: the terminal's own IndexedDB store is named by its key.
  const terminalPubkey = storedTerminalPubkey()
  // Every step runs even if an earlier one fails, so a keyStore fault cannot leave the record
  // (or anything else) behind. The fault is reported afterwards.
  let keyError: unknown
  try {
    await keyStore.clear()
  } catch (e) {
    keyError = e
  }
  // The same state logout clears (#160 round 2): every `imani-wallet:*` entry (the terminal
  // record included), the tab's resume cache, and any wallet database under this device's
  // key. Phase 3 adds terminal state, and this keeps it covered without a second list.
  const storage = sweepAppStorage()
  forgetTerminal()
  forgetPendingKey()
  forgetResume()
  if (terminalPubkey) await wipeWallet(terminalPubkey).catch(() => undefined)
  if (keyError !== undefined) {
    throw keyError instanceof Error ? keyError : new Error('Could not erase the terminal key.')
  }
  return { keyStore: true, pendingKey: true, resume: true, storage, walletDb: terminalPubkey }
}

/** What `removeTerminalFromDevice` cleared, for its test and its caller. */
export interface RemovedFromDevice {
  /** The encrypted key at rest (`keyStore`, IndexedDB). */
  keyStore: true
  /** The in-memory pending enrolment key. */
  pendingKey: true
  /** The tab's resume cache (sessionStorage and its IndexedDB wrap key). */
  resume: true
  /** Every `imani-wallet:*` localStorage key removed, including the terminal record. */
  storage: string[]
  /** The terminal key whose wallet database was deleted, if one was enrolled. */
  walletDb: string | null
}

export function storedTerminalPubkey(): string | null {
  try {
    const raw = localStorage.getItem(ENROLMENT_KEY)
    const pk = raw ? (JSON.parse(raw) as { terminalPubkey?: unknown }).terminalPubkey : null
    return typeof pk === 'string' && /^[0-9a-f]{64}$/i.test(pk) ? pk.toLowerCase() : null
  } catch {
    return null
  }
}
