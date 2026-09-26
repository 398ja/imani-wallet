import { finalizeEvent, nip17, verifyEvent, type Event, type EventTemplate } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'

import { TRANSFER_RECEIPT_KIND, TRANSFER_SIGNATURE_VERSION } from './attestationKind'
import { commitTo } from './audit'
import { getSigner } from './nap'
import { publish } from './relay'

/**
 * Both signatures over a customer-to-customer transfer (#91).
 *
 * The SENDER signs the transfer and sends that signature to the receiver in a
 * gift wrap of its own. The RECEIVER, once they have both redeemed the coupon
 * and checked the signature, publishes a kind-7378 receipt that carries the
 * sender's public half. Read `docs/adr/0014-a-customer-transfer-is-signed-by-both-parties.md`
 * before changing anything here: which key signs what, and what is left off the
 * relay, are the whole design.
 *
 * In short:
 *
 * - The identity signature (`sig`) never leaves the encrypted wrap.
 * - Everything public is signed by keys derived per transfer, so no two 7378s
 *   share a key and none names a person. The merchant ledger key in
 *   `attestation.ts` is the same construction scoped to a stall instead.
 * - The public tag mixes in a nonce that only the two parties hold, so the
 *   gateway, which relayed the coupon and knows its fingerprint, cannot find
 *   the receipt.
 * - Nothing here can block or reverse a transfer. Every exported side effect
 *   swallows its own failures, because by the time any of it runs the mint has
 *   already burnt the proofs.
 */

/** The `type` of the sender's gift-wrapped payload. */
export const TRANSFER_SIGNATURE_TYPE = 'imani_transfer_signature'

/** Domain separators. Versioned, so a future scheme cannot collide with this one. */
const TAG_DOMAIN = 'imani-transfer-v1'
const KEY_DOMAIN = 'imani-transfer-key-v1'
const BLIND_DOMAIN = 'imani-transfer-blind-v1'
const SENDER_LINK_DOMAIN = 'imani-transfer-sender-v1'
const DIGEST_DOMAIN = 'imani-transfer-signature'
const FIELD_SEPARATOR = '\u001f'

const HEX_64 = /^[0-9a-f]{64}$/
const HEX_128 = /^[0-9a-f]{128}$/
/** `sent_voucher_id` and `getTokenFingerprint`: sha256(token), first 32 hex. */
const HEX_32 = /^[0-9a-f]{32}$/

/**
 * Anything larger is not an honest signature. It arrives from a counterparty
 * and is kept in local storage until its coupon turns up, so a size bound is
 * what stops it being a storage channel. A real one is about 700 characters.
 */
const MAX_PAYLOAD_CHARS = 2048

/** The sender's signed statement, as it travels inside the gift wrap. */
export interface TransferSignature {
  type: typeof TRANSFER_SIGNATURE_TYPE
  /**
   * Payload version. A reader refuses one it does not know rather than
   * guessing, so a later version (#94's bundle manifest) can add fields
   * without an old reader signing off on half of them.
   */
  v: number
  /** `sent_voucher_id`: sha256(send token)[:32]. Both parties can compute it. */
  transfer: string
  /** 32 random bytes, hex. Never published. What keeps the public tag private. */
  nonce: string
  /** Sender identity pubkey. */
  sender: string
  /** Recipient identity pubkey. */
  recipient: string
  /** Minor units the sender says they sent. */
  amount: number
  unit: string
  decimals: number
  /** The sender's per-transfer pubkey: the only sender key the relay sees. */
  transferKey: string
  /** `transferKey`'s signature over the public tag. Published on the receipt. */
  transferSig: string
  /** The sender IDENTITY signature over every field above. Never published. */
  sig: string
}

/** What the receiver's pairing check concluded. */
export type TransferSignatureVerdict = { ok: true } | { ok: false; reason: string }

/** The public tag: `H(domain | transfer | nonce)`. */
export function transferTag(transfer: string, nonce: string): string {
  return bytesToHex(sha256(utf8ToBytes(`${TAG_DOMAIN}:${transfer}:${nonce}`)))
}

/**
 * A per-transfer secret key, derived from an identity key.
 *
 * Deterministic, so either party can reproduce theirs from their own key and
 * the tag after a device wipe. `role` keeps a wallet that is both sender and
 * receiver of one transfer (a send to oneself is refused, but defence in depth)
 * from ever using one key for both halves.
 *
 * Hashes the key's BYTES, for the reason `ledgerKeyFrom` gives: a hex string
 * would bind the derivation to an encoding rather than a key.
 */
export function transferKeyFrom(
  identitySecret: Uint8Array,
  role: 'sender' | 'receiver',
  tag: string,
): Uint8Array {
  const prefix = utf8ToBytes(`${KEY_DOMAIN}:${role}:`)
  const suffix = utf8ToBytes(`:${tag}`)
  const input = new Uint8Array(prefix.length + identitySecret.length + suffix.length)
  input.set(prefix)
  input.set(identitySecret, prefix.length)
  input.set(suffix, prefix.length + identitySecret.length)
  const sk = sha256(input)
  input.fill(0)
  return sk
}

/** What `transferKey` signs: the public tag, domain separated. */
function senderLinkMessage(tag: string): Uint8Array {
  return sha256(utf8ToBytes(`${SENDER_LINK_DOMAIN}:${tag}`))
}

/**
 * The commitment blind, derived from the NONCE.
 *
 * Not from either party's key, unlike a merchant's blind: this commitment has
 * two owners, and both must be able to open it for an auditor of their choice.
 * The nonce is the one secret they share and nobody else holds.
 */
export function transferBlind(nonce: string): bigint {
  const order = schnorr.Point.Fn.ORDER
  const raw = BigInt(`0x${bytesToHex(sha256(utf8ToBytes(`${BLIND_DOMAIN}:${nonce}`)))}`)
  // Never zero, for the reason `blindFor` gives.
  return (raw % (order - 1n)) + 1n
}

/** The identity signature's digest. Every field, separated, in a fixed order. */
function signatureDigest(p: Omit<TransferSignature, 'sig'>): Uint8Array {
  return sha256(
    utf8ToBytes(
      [
        DIGEST_DOMAIN,
        String(p.v),
        p.transfer,
        p.nonce,
        p.sender,
        p.recipient,
        String(p.amount),
        p.unit,
        String(p.decimals),
        p.transferKey,
        p.transferSig,
      ].join(FIELD_SEPARATOR),
    ),
  )
}

/**
 * Build and sign the sender's statement. Pure: the caller supplies the key.
 *
 * `nonce` is injectable for tests only. In the wallet it is always random.
 */
export function signTransfer(
  identitySecret: Uint8Array,
  params: {
    transfer: string
    recipient: string
    amount: number
    unit: string
    decimals: number
    nonce?: string
  },
): TransferSignature {
  const nonce = params.nonce ?? bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  const tag = transferTag(params.transfer, nonce)
  const transferSk = transferKeyFrom(identitySecret, 'sender', tag)
  const unsigned: Omit<TransferSignature, 'sig'> = {
    type: TRANSFER_SIGNATURE_TYPE,
    v: TRANSFER_SIGNATURE_VERSION,
    transfer: params.transfer.toLowerCase(),
    nonce,
    sender: bytesToHex(schnorr.getPublicKey(identitySecret)),
    recipient: params.recipient.toLowerCase(),
    amount: params.amount,
    unit: params.unit,
    decimals: params.decimals,
    transferKey: bytesToHex(schnorr.getPublicKey(transferSk)),
    transferSig: bytesToHex(schnorr.sign(senderLinkMessage(tag), transferSk)),
  }
  transferSk.fill(0)
  return { ...unsigned, sig: bytesToHex(schnorr.sign(signatureDigest(unsigned), identitySecret)) }
}

/**
 * Read a sender's statement out of gift-wrap content. Undefined for anything
 * else, including a version this build does not know.
 */
export function parseTransferSignature(content: string): TransferSignature | undefined {
  if (!content || content.length > MAX_PAYLOAD_CHARS) return undefined
  try {
    const p = JSON.parse(content) as Record<string, unknown>
    if (p?.type !== TRANSFER_SIGNATURE_TYPE) return undefined
    if (p.v !== TRANSFER_SIGNATURE_VERSION) return undefined
    const hex = (k: string, re: RegExp) =>
      typeof p[k] === 'string' && re.test(p[k] as string) ? (p[k] as string) : undefined
    const transfer = hex('transfer', HEX_32)
    const nonce = hex('nonce', HEX_64)
    const sender = hex('sender', HEX_64)
    const recipient = hex('recipient', HEX_64)
    const transferKey = hex('transferKey', HEX_64)
    const transferSig = hex('transferSig', HEX_128)
    const sig = hex('sig', HEX_128)
    const { amount, unit, decimals } = p
    if (
      !transfer || !nonce || !sender || !recipient || !transferKey || !transferSig || !sig ||
      typeof unit !== 'string' || unit.length > 16 ||
      !Number.isSafeInteger(amount) || (amount as number) < 0 ||
      !Number.isSafeInteger(decimals) || (decimals as number) < 0
    ) {
      return undefined
    }
    return {
      type: TRANSFER_SIGNATURE_TYPE,
      v: TRANSFER_SIGNATURE_VERSION,
      transfer, nonce, sender, recipient,
      amount: amount as number,
      unit,
      decimals: decimals as number,
      transferKey, transferSig, sig,
    }
  } catch {
    return undefined
  }
}

/**
 * The receiver's check. Never throws.
 *
 * `authorPubkey` is the gift wrap's rumor author, so a signature relayed by
 * anyone other than its own signer is refused: the payload says who signed,
 * and the wrap has to agree.
 */
export function verifyTransferSignature(
  p: TransferSignature,
  expected: { recipient: string; transfer?: string; authorPubkey?: string },
): TransferSignatureVerdict {
  try {
    if (p.v !== TRANSFER_SIGNATURE_VERSION) return { ok: false, reason: 'unknown version' }
    if (p.recipient !== expected.recipient.toLowerCase()) {
      return { ok: false, reason: 'addressed to someone else' }
    }
    if (expected.transfer && p.transfer !== expected.transfer.toLowerCase()) {
      return { ok: false, reason: 'for a different transfer' }
    }
    if (expected.authorPubkey && expected.authorPubkey.toLowerCase() !== p.sender) {
      return { ok: false, reason: 'wrapped by someone other than the signer' }
    }
    const { sig, ...unsigned } = p
    if (!schnorr.verify(hexToBytes(sig), signatureDigest(unsigned), hexToBytes(p.sender))) {
      return { ok: false, reason: 'sender signature did not verify' }
    }
    const tag = transferTag(p.transfer, p.nonce)
    if (!schnorr.verify(hexToBytes(p.transferSig), senderLinkMessage(tag), hexToBytes(p.transferKey))) {
      return { ok: false, reason: 'per-transfer signature did not verify' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: `unreadable: ${(e as Error).message}` }
  }
}

/**
 * The public receipt, signed by the receiver's per-transfer key.
 *
 * Carries the tag, the sender's per-transfer key and its signature over the
 * tag, which is the link between the two parties and names neither. The
 * commitment and unit are optional; see `publishIfPaired`.
 */
export function buildTransferReceipt(
  p: TransferSignature,
  receiverSk: Uint8Array,
  commitment?: { commitment: string; unit: string },
): Event {
  const tag = transferTag(p.transfer, p.nonce)
  const template: EventTemplate = {
    kind: TRANSFER_RECEIPT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    // `n` so either party can find the receipt with one filter, as
    // `couponCheckFilter` does for redemptions. Nothing else is indexed.
    tags: [
      ['n', tag],
      ['v', String(TRANSFER_SIGNATURE_VERSION)],
    ],
    content: JSON.stringify({
      v: TRANSFER_SIGNATURE_VERSION,
      tag,
      senderKey: p.transferKey,
      senderSig: p.transferSig,
      ...(commitment ? commitment : {}),
    }),
  }
  return finalizeEvent(template, receiverSk)
}

/**
 * Check a published receipt: the event is genuine, and the sender's
 * per-transfer key signed its tag. Anyone can run this. It proves both halves
 * exist for one transfer, and says nothing about who either party is.
 */
export function verifyTransferReceipt(event: Event): boolean {
  try {
    if (event.kind !== TRANSFER_RECEIPT_KIND || !verifyEvent(event)) return false
    const c = JSON.parse(event.content) as { tag?: string; senderKey?: string; senderSig?: string }
    const n = event.tags.find((t) => t[0] === 'n')?.[1]
    if (!c.tag || c.tag !== n || !c.senderKey || !c.senderSig) return false
    return schnorr.verify(hexToBytes(c.senderSig), senderLinkMessage(c.tag), hexToBytes(c.senderKey))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Sender side
// ---------------------------------------------------------------------------

/**
 * Sign a completed send and gift-wrap the signature to the recipient.
 * NEVER THROWS, and resolves to whether a relay took it.
 *
 * Runs after the saga has completed and the local row is written: the coupon
 * has already moved, so a locked wallet, an old gateway that returned no
 * `sent_voucher_id`, or a relay refusing the wrap costs the receipt and
 * nothing else.
 *
 * Wrapped by THIS wallet rather than the gateway, because the atomic-send API
 * has no field for it (see the ADR). The gateway's relay ingest picks up any
 * kind-1059 on the relay, so it reaches the recipient the same way a coupon
 * does.
 */
export async function sendTransferSignature(params: {
  transfer: string | undefined
  recipient: string
  amount: number
  unit: string
  decimals: number
}): Promise<boolean> {
  try {
    const transfer = params.transfer?.toLowerCase()
    if (!transfer || !HEX_32.test(transfer)) return false
    if (!HEX_64.test(params.recipient.toLowerCase())) return false

    const signer = getSigner()
    const wrap = signer.withPrivkey((key) => {
      const payload = signTransfer(key, { ...params, transfer })
      return nip17.wrapEvent(key, { publicKey: payload.recipient }, JSON.stringify(payload))
    })
    const result = await publish(wrap)
    if (result.ok === 0) {
      console.warn('[transfer] no relay accepted the signature', result.errors)
      return false
    }
    return true
  } catch (error) {
    console.warn('[transfer] send not signed', error)
    return false
  }
}

// ---------------------------------------------------------------------------
// Receiver side
// ---------------------------------------------------------------------------

/**
 * The two halves arrive in either order: the coupon's DM and the sender's
 * signature are separate gift wraps, published by different parties. Each is
 * held here until the other turns up.
 *
 * localStorage, scoped by pubkey like every other `imani-wallet:` record, and
 * held in memory where there is none (tests, a locked-down browser). Losing
 * it loses a receipt, never money.
 */
type Received = { credited?: number; unit?: string; at: number }
const MAX_HELD = 200
const memory = new Map<string, string>()

function storeKey(kind: 'signatures' | 'received', pubkey: string) {
  return `imani-wallet:transfer-${kind}:${pubkey.toLowerCase()}`
}

function readHeld<T>(key: string): Record<string, T> {
  let raw: string | null | undefined
  try {
    raw = globalThis.localStorage?.getItem(key)
  } catch {
    raw = undefined
  }
  raw ??= memory.get(key)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, T>) : {}
  } catch {
    return {}
  }
}

function writeHeld<T>(key: string, held: Record<string, T>): void {
  // Oldest out first, so a flood of unmatched halves cannot grow this forever.
  const entries = Object.entries(held)
  const kept = Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_HELD)))
  const raw = JSON.stringify(kept)
  memory.set(key, raw)
  try {
    globalThis.localStorage?.setItem(key, raw)
  } catch {
    // Memory still holds it for this session.
  }
}

/** Test seam: forget everything held. */
export function resetHeldTransfers(): void {
  memory.clear()
}

/**
 * Publish the receipt if both halves are here. Never throws.
 *
 * The commitment is included only when the receiver's VERIFIED credited value
 * equals what the sender signed, in the same unit. A sender-written envelope
 * figure is never committed to (the rule `attestRedemption` follows), and
 * where the two parties disagree the receipt goes out without an amount rather
 * than with either one's number.
 */
async function publishIfPaired(me: string, transfer: string): Promise<boolean> {
  const sigKey = storeKey('signatures', me)
  const recKey = storeKey('received', me)
  const signatures = readHeld<TransferSignature>(sigKey)
  const received = readHeld<Received>(recKey)
  const p = signatures[transfer]
  const r = received[transfer]
  if (!p || !r) return false

  const verdict = verifyTransferSignature(p, { recipient: me, transfer })
  if (!verdict.ok) {
    // Optional evidence that does not hold. Dropped, never escalated.
    console.warn('[transfer] ignoring a sender signature:', verdict.reason)
    delete signatures[transfer]
    writeHeld(sigKey, signatures)
    return false
  }

  const commitment =
    r.credited !== undefined &&
    r.credited === p.amount &&
    (r.unit ?? '').toUpperCase() === p.unit.toUpperCase()
      ? { commitment: commitTo(p.amount, transferBlind(p.nonce)), unit: p.unit.toUpperCase() }
      : undefined

  const tag = transferTag(p.transfer, p.nonce)
  const event = getSigner().withPrivkey((key) => {
    const sk = transferKeyFrom(key, 'receiver', tag)
    try {
      return buildTransferReceipt(p, sk, commitment)
    } finally {
      sk.fill(0)
    }
  })

  const result = await publish(event)
  if (result.ok === 0) {
    // Not retried: nothing reads these for completeness yet (see the ADR).
    console.warn('[transfer] no relay accepted the receipt', result.errors)
    return false
  }
  delete signatures[transfer]
  delete received[transfer]
  writeHeld(sigKey, signatures)
  writeHeld(recKey, received)
  return true
}

/**
 * A sender's signature arrived in a gift wrap. Hold it, and publish if its
 * coupon has already been redeemed. Never throws, never awaited by the
 * unwrap path that calls it.
 *
 * Checked on arrival against the wrap's author and our own key, so nothing
 * forged or misaddressed is ever stored.
 */
export async function offerTransferSignature(
  p: TransferSignature,
  authorPubkey: string,
): Promise<boolean> {
  try {
    const me = getSigner().pubkey.toLowerCase()
    const verdict = verifyTransferSignature(p, { recipient: me, authorPubkey })
    if (!verdict.ok) {
      console.warn('[transfer] refusing a sender signature:', verdict.reason)
      return false
    }
    const key = storeKey('signatures', me)
    const held = readHeld<TransferSignature>(key)
    held[p.transfer] = p
    writeHeld(key, held)
    return await publishIfPaired(me, p.transfer)
  } catch (error) {
    console.warn('[transfer] could not take a sender signature', error)
    return false
  }
}

/** sha256(token)[:32], the same fingerprint the gateway calls `sent_voucher_id`. */
export function transferIdFor(token: string): string {
  return bytesToHex(sha256(utf8ToBytes(token))).slice(0, 32)
}

/**
 * A CUSTOMER redeemed a coupon. Hold the fact, and publish if the sender's
 * signature is already here. Never throws.
 *
 * Only a customer's wallet calls this: a stall attests with a 7377 and must
 * not also publish a 7378 (see the call site in `dmPoll`). And nothing is
 * published without a sender signature, so a coupon from an older build or
 * straight from a stall leaves no public trace.
 */
export async function noteTransferReceived(params: {
  token: string
  /** The VERIFIED credited value, or undefined when the voucher did not verify. */
  credited?: number
  unit?: string
}): Promise<boolean> {
  try {
    const me = getSigner().pubkey.toLowerCase()
    const transfer = transferIdFor(params.token)
    const key = storeKey('received', me)
    const held = readHeld<Received>(key)
    held[transfer] = {
      ...(Number.isSafeInteger(params.credited) ? { credited: params.credited } : {}),
      ...(params.unit ? { unit: params.unit } : {}),
      at: Date.now(),
    }
    writeHeld(key, held)
    return await publishIfPaired(me, transfer)
  } catch (error) {
    console.warn('[transfer] receipt not attested', error)
    return false
  }
}
