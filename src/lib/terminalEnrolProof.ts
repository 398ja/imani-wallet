import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'

/**
 * The device's proof that its key K was created AS a terminal (inv-terminal-not-merchant, owner
 * decision 2026-10-11: a terminal is an identity created as a terminal, never a merchant and never
 * an existing customer account).
 *
 * `/terminal/setup` mints K and shows `imani-terminal-key:1:<K>:<created_at>:<sig>`, where `sig` is
 * BIP-340 by K over `sha256("imani-terminal-enrolment" US "1" US K US created_at)` (US = U+001F).
 * The owner's Add terminal scans that, refuses anything else (an npub, hex key or handle is a
 * personal account), and sends `1:<created_at>:<sig>` to gateway-customer as
 * `X-Imani-Terminal-Enrolment`, which checks it again. The gateway is the authority; this module
 * only lets both phones say the same thing, and lets the owner be told before the request is sent.
 *
 * Public, like K: the code is safe to photograph. It grants nothing; it only says "K is a terminal".
 */

export const ENROLMENT_CODE_PREFIX = 'imani-terminal-key:1:'
export const ENROLMENT_PROOF_HEADER = 'X-Imani-Terminal-Enrolment'
/** The gateway's window, mirrored so the owner hears "scan it again" before the request is sent. */
export const ENROLMENT_MAX_AGE_SECONDS = 24 * 3600
export const ENROLMENT_MAX_SKEW_SECONDS = 600

const TAG = 'imani-terminal-enrolment'
const US = '\u001f'
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

/** What a scanned enrolment code says, once checked. */
export interface EnrolmentProof {
  /** K, the terminal's key. */
  terminalPubkey: string
  createdAt: number
  sig: string
}

export function enrolmentDigest(terminalPubkey: string, createdAt: number): Uint8Array {
  return sha256(utf8ToBytes([TAG, '1', terminalPubkey.toLowerCase(), String(createdAt)].join(US)))
}

/** Sign K's enrolment code with K. Called only by the device, on `/terminal/setup`. */
export function signEnrolmentCode(privkey: Uint8Array, terminalPubkey: string, createdAt: number): string {
  const sig = bytesToHex(schnorr.sign(enrolmentDigest(terminalPubkey, createdAt), privkey))
  return `${ENROLMENT_CODE_PREFIX}${terminalPubkey.toLowerCase()}:${createdAt}:${sig}`
}

export type EnrolmentCodeRefusal =
  /** An npub, hex key, handle or anything else that is not a device's terminal setup code. */
  | 'not-a-terminal-code'
  /** It looks like one but the signature is not K's. */
  | 'bad-signature'
  /** Older than a day, or from the future: scan the device's screen again. */
  | 'expired'

/**
 * Read a scanned or typed device code. Accepts the code with or without a `nostr:` prefix.
 */
export function readEnrolmentCode(
  text: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): EnrolmentProof | EnrolmentCodeRefusal {
  let raw = text.trim()
  if (raw.toLowerCase().startsWith('nostr:')) raw = raw.slice('nostr:'.length)
  if (!raw.toLowerCase().startsWith(ENROLMENT_CODE_PREFIX)) return 'not-a-terminal-code'
  const parts = raw.slice(ENROLMENT_CODE_PREFIX.length).toLowerCase().split(':')
  if (parts.length !== 3) return 'not-a-terminal-code'
  const [key, at, sig] = parts
  if (!HEX64.test(key) || !/^\d{1,12}$/.test(at) || !HEX128.test(sig)) return 'not-a-terminal-code'
  const createdAt = Number(at)
  let valid = false
  try {
    valid = schnorr.verify(hexToBytes(sig), enrolmentDigest(key, createdAt), hexToBytes(key))
  } catch {
    valid = false
  }
  if (!valid) return 'bad-signature'
  if (createdAt < nowSeconds - ENROLMENT_MAX_AGE_SECONDS || createdAt > nowSeconds + ENROLMENT_MAX_SKEW_SECONDS) {
    return 'expired'
  }
  return { terminalPubkey: key, createdAt, sig }
}

/** The header value gateway-customer verifies: `1:<created_at>:<sig>`. */
export function enrolmentProofHeader(proof: Pick<EnrolmentProof, 'createdAt' | 'sig'>): string {
  return `1:${proof.createdAt}:${proof.sig}`
}

/** What the owner is told, in the owner's words (coordinator, 2026-10-11). */
export const ENROLMENT_CODE_MESSAGES: Record<EnrolmentCodeRefusal | 'merchant', string> = {
  'not-a-terminal-code':
    "That is a personal account, not a terminal. On the device, open Imani and choose 'Set this device up as a terminal'.",
  'bad-signature': 'That terminal code does not check out. Scan the code on the device again.',
  expired: 'That terminal code is out of date. Scan the code on the device again.',
  merchant: 'That device belongs to a merchant, so it cannot be a terminal for your stall.',
}

/**
 * gateway-customer could not check the key just now (503 TERMINAL_KEY_CHECK_UNAVAILABLE): not a
 * refusal, so the owner is told to try again, never that the device is wrong (rev-option-a R4).
 */
export const TERMINAL_KEY_CHECK_UNAVAILABLE_MESSAGE =
  'Could not check the terminal right now. Nothing was set up. Try again in a moment.'
