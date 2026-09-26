import { finalizeEvent, nip17, nip44, verifyEvent, type Event, type EventTemplate } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'

import { TRANSFER_RECEIPT_KIND, TRANSFER_SIGNATURE_VERSION } from './attestationKind'
import { commitTo } from './audit'
import { loadMerchant } from './merchant'
import { getSigner } from './nap'
import { signedFetch } from './nip98'
import { publish } from './relay'
import { backUpTransferSignature, listTransactions, recordTransferSignature } from './wallet'
import { toTransaction } from './transactions'
import { withWebLock } from './webLock'

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
 * - Everything public is signed by per-transfer keys. Each is the party's
 *   identity key TWEAKED by a scalar derived from the secret nonce, so either
 *   party can predict the other's public key, only its owner can sign with it,
 *   and anyone later shown the nonce can check which identity it belongs to.
 * - The sender's public signature covers the receiver's per-transfer key and
 *   the commitment, so the receipt cannot be copied under another author or
 *   re-published with a shifted amount (version 2; see the ADR for why v1 was
 *   refused).
 * - The public tag mixes in the nonce, so a third party who has seen the
 *   coupon's id cannot find the receipt. The GATEWAY is a different matter:
 *   it can guess by timing, which the random publish delay below narrows but
 *   does not close. The ADR says so.
 * - Nothing here can block or reverse a transfer. Every exported side effect
 *   swallows its own failures, because by the time any of it runs the mint has
 *   already burnt the proofs.
 */

/** The `type` of the sender's gift-wrapped payload. */
export const TRANSFER_SIGNATURE_TYPE = 'imani_transfer_signature'

/** Domain separators. Versioned, so a future scheme cannot collide with this one. */
const TAG_DOMAIN = 'imani-transfer-v1'
const NONCE_DOMAIN = 'imani-transfer-nonce-v2'
const TWEAK_DOMAIN = 'imani-transfer-tweak-v2'
const BLIND_DOMAIN = 'imani-transfer-blind-v1'
const LINK_DOMAIN = 'imani-transfer-link-v2'
const DIGEST_DOMAIN = 'imani-transfer-signature'
const FIELD_SEPARATOR = '\u001f'
/** What the bare link signs in place of a commitment. */
const NO_COMMITMENT = 'none'

const HEX_64 = /^[0-9a-f]{64}$/
const HEX_66 = /^[0-9a-f]{66}$/
const HEX_128 = /^[0-9a-f]{128}$/
/** `sent_voucher_id` and `getTokenFingerprint`: sha256(token), first 32 hex. */
const HEX_32 = /^[0-9a-f]{32}$/
/**
 * The wallet's unit alphabet: ISO 4217 codes (EUR, XAF) and the non-ISO
 * aliases `format.ts` knows (SAT, SATS, MSAT, BTC, FCFA). Uppercase letters
 * only, so nothing can smuggle the digest's field separator or a `cashuB...`
 * string through this field.
 */
const UNIT = /^[A-Z]{3,5}$/
/** No currency this system handles has more. */
const MAX_DECIMALS = 8

const ORDER = schnorr.Point.Fn.ORDER
const G = schnorr.Point.BASE

/**
 * Anything larger is not an honest signature. It arrives from a counterparty
 * and is kept in local storage until its coupon turns up, so a size bound is
 * what stops it being a storage channel. A real one is about 1100 characters.
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
  /**
   * 32 bytes, hex. Never published. What keeps the public tag and both
   * per-transfer keys private. Derived by the sender from its own key (see
   * `transferNonce`), so the sender can recompute it after a device wipe.
   */
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
  /**
   * `transferKey`'s signature over the tag, the RECEIVER's per-transfer key,
   * and the commitment to `amount` in `unit`/`decimals`. Published on the
   * receipt when the receiver's credited value agrees.
   */
  transferSig: string
  /**
   * The same, over the tag and receiver key with the commitment replaced by
   * the literal "none". Published instead when the parties disagree on the
   * amount or the voucher did not verify. It asserts the link and nothing
   * about value, so it cannot contradict `transferSig`.
   */
  bareSig: string
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
 * The sender's nonce for one transfer: HMAC(identity key, transfer, recipient).
 *
 * Deterministic so the sender can recompute it, and with it the tag, both
 * per-transfer keys and the commitment blind, from nothing but their own key
 * and the `transferId` kept on their `sent` row. A keyed MAC rather than a hash
 * so nobody without the sender's key can: the gateway knows `transfer` and
 * both parties, and a hash of those would hand it the tag.
 */
export function transferNonce(identitySecret: Uint8Array, transfer: string, recipient: string): string {
  return bytesToHex(
    hmac(
      sha256,
      identitySecret,
      utf8ToBytes(`${NONCE_DOMAIN}:${transfer.toLowerCase()}:${recipient.toLowerCase()}`),
    ),
  )
}

/** A hash as a non-zero scalar. */
function scalarOf(bytes: Uint8Array): bigint {
  // Never zero: `(x mod (n-1)) + 1` lands in [1, n-1].
  return (BigInt(`0x${bytesToHex(bytes)}`) % (ORDER - 1n)) + 1n
}

/**
 * The public tweak for one party's per-transfer key.
 *
 * From the tag AND the nonce. The tag alone would be the obvious choice and
 * would be a leak: the tag is public, so anyone could compute the tweak and
 * subtract it from the published key to recover the identity it hides. The
 * nonce is what only the two parties hold, and disclosing it later is exactly
 * what lets an auditor check both identities.
 */
function tweakFor(role: 'sender' | 'receiver', tag: string, nonce: string): bigint {
  return scalarOf(sha256(utf8ToBytes(`${TWEAK_DOMAIN}:${role}:${tag}:${nonce}`)))
}

/** The even-y point behind an x-only (BIP-340) pubkey. */
function liftX(pubkeyHex: string) {
  return schnorr.utils.lift_x(BigInt(`0x${pubkeyHex}`))
}

/**
 * A party's per-transfer PUBLIC key: `lift_x(P) + t·G`, x-only.
 *
 * Anyone holding the nonce can compute it for either party, which is how the
 * sender predicts the receiver's key without being able to sign with it.
 */
export function transferPubkeyFor(
  identityPubkey: string,
  role: 'sender' | 'receiver',
  tag: string,
  nonce: string,
): string {
  const point = liftX(identityPubkey.toLowerCase()).add(G.multiply(tweakFor(role, tag, nonce)))
  return bytesToHex(schnorr.utils.pointToBytes(point))
}

/**
 * A party's per-transfer SECRET key: `d + t mod n`, where `d` is the identity
 * secret normalised to the even-y point BIP-340 uses for its x-only pubkey.
 *
 * Only the key holder can derive it. The result is zero only if `t` happens to
 * equal `-d`, a 2^-256 event; `schnorr.getPublicKey` would then throw, the
 * caller's catch turns that into a lost receipt, and nothing else is affected.
 */
export function transferSecretFor(
  identitySecret: Uint8Array,
  role: 'sender' | 'receiver',
  tag: string,
  nonce: string,
): Uint8Array {
  const raw = BigInt(`0x${bytesToHex(identitySecret)}`)
  const oddY = G.multiply(raw).toAffine().y % 2n === 1n
  const d = oddY ? ORDER - raw : raw
  const sk = (d + tweakFor(role, tag, nonce)) % ORDER
  return hexToBytes(sk.toString(16).padStart(64, '0'))
}

/**
 * The commitment blind, derived from the NONCE.
 *
 * Not from either party's key, unlike a merchant's blind: this commitment has
 * two owners, and both must be able to open it for an auditor of their choice.
 * The nonce is the one secret they share and nobody else holds.
 */
export function transferBlind(nonce: string): bigint {
  return scalarOf(sha256(utf8ToBytes(`${BLIND_DOMAIN}:${nonce}`)))
}

/** What was committed to, when anything was. */
type Committed = { commitment: string; unit: string; decimals: number }

/**
 * What the sender's per-transfer key signs, and what a receipt verifier
 * rebuilds from the published event.
 *
 * The receiver's per-transfer key is IN the message, so the signature is valid
 * under exactly one 7378 author. The commitment, unit and decimals are in it
 * too, so neither can be swapped (a Pedersen commitment is additively
 * homomorphic: `C + k·G` opens to `amount + k` with the same blind).
 */
function linkMessage(tag: string, receiverKey: string, committed: Committed | null): Uint8Array {
  return sha256(
    utf8ToBytes(
      [
        LINK_DOMAIN,
        String(TRANSFER_SIGNATURE_VERSION),
        tag,
        receiverKey,
        committed ? committed.commitment : NO_COMMITMENT,
        committed ? committed.unit : '',
        committed ? String(committed.decimals) : '',
      ].join(FIELD_SEPARATOR),
    ),
  )
}

/** The commitment a payload's `transferSig` covers. */
function committedFor(p: Pick<TransferSignature, 'amount' | 'unit' | 'decimals' | 'nonce'>): Committed {
  return { commitment: commitTo(p.amount, transferBlind(p.nonce)), unit: p.unit, decimals: p.decimals }
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
        p.bareSig,
      ].join(FIELD_SEPARATOR),
    ),
  )
}

/**
 * Build and sign the sender's statement. Pure: the caller supplies the key.
 *
 * Throws on a unit outside the wallet's alphabet or a malformed amount; the
 * caller (`sendTransferSignature`) turns that into "not signed".
 */
export function signTransfer(
  identitySecret: Uint8Array,
  params: {
    transfer: string
    recipient: string
    amount: number
    unit: string
    decimals: number
  },
): TransferSignature {
  const transfer = params.transfer.toLowerCase()
  const recipient = params.recipient.toLowerCase()
  const unit = params.unit.trim().toUpperCase()
  if (!HEX_32.test(transfer) || !HEX_64.test(recipient)) throw new Error('malformed transfer')
  if (!UNIT.test(unit)) throw new Error(`unit outside the wallet alphabet: ${params.unit}`)
  if (!Number.isSafeInteger(params.amount) || params.amount < 0) throw new Error('bad amount')
  if (!Number.isSafeInteger(params.decimals) || params.decimals < 0 || params.decimals > MAX_DECIMALS) {
    throw new Error('bad decimals')
  }

  const nonce = transferNonce(identitySecret, transfer, recipient)
  const tag = transferTag(transfer, nonce)
  const receiverKey = transferPubkeyFor(recipient, 'receiver', tag, nonce)
  const committed = committedFor({ amount: params.amount, unit, decimals: params.decimals, nonce })
  const transferSk = transferSecretFor(identitySecret, 'sender', tag, nonce)
  try {
    const unsigned: Omit<TransferSignature, 'sig'> = {
      type: TRANSFER_SIGNATURE_TYPE,
      v: TRANSFER_SIGNATURE_VERSION,
      transfer,
      nonce,
      sender: bytesToHex(schnorr.getPublicKey(identitySecret)),
      recipient,
      amount: params.amount,
      unit,
      decimals: params.decimals,
      transferKey: bytesToHex(schnorr.getPublicKey(transferSk)),
      transferSig: bytesToHex(schnorr.sign(linkMessage(tag, receiverKey, committed), transferSk)),
      bareSig: bytesToHex(schnorr.sign(linkMessage(tag, receiverKey, null), transferSk)),
    }
    return { ...unsigned, sig: bytesToHex(schnorr.sign(signatureDigest(unsigned), identitySecret)) }
  } finally {
    transferSk.fill(0)
  }
}

/**
 * Read a sender's statement out of gift-wrap content. Undefined for anything
 * else, including a version this build does not know (v1 among them: its
 * public half did not bind the receipt, see the ADR).
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
    const bareSig = hex('bareSig', HEX_128)
    const sig = hex('sig', HEX_128)
    const { amount, unit, decimals } = p
    if (
      !transfer || !nonce || !sender || !recipient || !transferKey || !transferSig || !bareSig || !sig ||
      typeof unit !== 'string' || !UNIT.test(unit) ||
      !Number.isSafeInteger(amount) || (amount as number) < 0 ||
      !Number.isSafeInteger(decimals) || (decimals as number) < 0 || (decimals as number) > MAX_DECIMALS
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
      transferKey, transferSig, bareSig, sig,
    }
  } catch {
    return undefined
  }
}

/**
 * The receiver's check. Never throws.
 *
 * `authorPubkey` is the gift wrap's author, and `sender` the person who
 * actually sent the COUPON (the payload's `sender_pubkey`, set by the gateway
 * from the send row). Neither is authenticated by the payload alone: the
 * identity `sig` proves who signed, not that they are the person who paid.
 * Pairing with `sender` is what stops anyone who learns a coupon's fingerprint
 * from attaching their own signature to it.
 */
export function verifyTransferSignature(
  p: TransferSignature,
  expected: { recipient: string; transfer?: string; authorPubkey?: string; sender?: string },
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
    if (expected.sender !== undefined && expected.sender.toLowerCase() !== p.sender) {
      return { ok: false, reason: 'signed by someone other than the coupon sender' }
    }
    if (!UNIT.test(p.unit)) return { ok: false, reason: 'unit outside the wallet alphabet' }
    const { sig, ...unsigned } = p
    if (!schnorr.verify(hexToBytes(sig), signatureDigest(unsigned), hexToBytes(p.sender))) {
      return { ok: false, reason: 'sender signature did not verify' }
    }
    const tag = transferTag(p.transfer, p.nonce)
    // The per-transfer key must be the sender's identity, tweaked. Without
    // this, `sig` would bind the sender to a key they may not hold, and a
    // disclosed nonce would prove nothing about who signed the receipt.
    if (transferPubkeyFor(p.sender, 'sender', tag, p.nonce) !== p.transferKey) {
      return { ok: false, reason: 'per-transfer key is not the sender tweaked' }
    }
    const receiverKey = transferPubkeyFor(p.recipient, 'receiver', tag, p.nonce)
    const key = hexToBytes(p.transferKey)
    if (!schnorr.verify(hexToBytes(p.transferSig), linkMessage(tag, receiverKey, committedFor(p)), key)) {
      return { ok: false, reason: 'per-transfer signature did not verify' }
    }
    if (!schnorr.verify(hexToBytes(p.bareSig), linkMessage(tag, receiverKey, null), key)) {
      return { ok: false, reason: 'bare per-transfer signature did not verify' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: `unreadable: ${(e as Error).message}` }
  }
}

/**
 * The public receipt, signed by the receiver's per-transfer key.
 *
 * With `withCommitment`, it carries the commitment, unit and decimals the
 * sender signed, and `transferSig`. Without, it carries none of them and the
 * sender's `bareSig`, which signed the literal "none" in their place.
 *
 * `createdAt` is the caller's (jittered) timestamp, see `publishDue`.
 */
export function buildTransferReceipt(
  p: TransferSignature,
  receiverSk: Uint8Array,
  withCommitment: boolean,
  createdAt: number = Math.floor(Date.now() / 1000),
): Event {
  const tag = transferTag(p.transfer, p.nonce)
  const committed = withCommitment ? committedFor(p) : null
  const template: EventTemplate = {
    kind: TRANSFER_RECEIPT_KIND,
    created_at: createdAt,
    // `n` so a party holding the nonce (both, see the ADR) can find the
    // receipt with one filter, as `couponCheckFilter` does for redemptions.
    // Nothing else is indexed.
    tags: [
      ['n', tag],
      ['v', String(TRANSFER_SIGNATURE_VERSION)],
    ],
    content: JSON.stringify({
      v: TRANSFER_SIGNATURE_VERSION,
      tag,
      senderKey: p.transferKey,
      senderSig: committed ? p.transferSig : p.bareSig,
      ...(committed ?? {}),
    }),
  }
  return finalizeEvent(template, receiverSk)
}

type ReceiptContent = {
  v?: unknown
  tag?: unknown
  senderKey?: unknown
  senderSig?: unknown
  commitment?: unknown
  unit?: unknown
  decimals?: unknown
}

/** The receipt's content, shape-checked. Undefined for anything malformed. */
function readReceipt(event: Event): { tag: string; senderKey: string; senderSig: string; committed: Committed | null } | undefined {
  const c = JSON.parse(event.content) as ReceiptContent
  const n = event.tags.find((t) => t[0] === 'n')?.[1]
  if (c.v !== TRANSFER_SIGNATURE_VERSION) return undefined
  if (typeof c.tag !== 'string' || !HEX_64.test(c.tag) || c.tag !== n) return undefined
  if (typeof c.senderKey !== 'string' || !HEX_64.test(c.senderKey)) return undefined
  if (typeof c.senderSig !== 'string' || !HEX_128.test(c.senderSig)) return undefined
  const present = [c.commitment, c.unit, c.decimals].filter((x) => x !== undefined).length
  if (present === 0) return { tag: c.tag, senderKey: c.senderKey, senderSig: c.senderSig, committed: null }
  if (
    present !== 3 ||
    typeof c.commitment !== 'string' || !HEX_66.test(c.commitment) ||
    typeof c.unit !== 'string' || !UNIT.test(c.unit) ||
    !Number.isSafeInteger(c.decimals) || (c.decimals as number) < 0 || (c.decimals as number) > MAX_DECIMALS
  ) {
    return undefined
  }
  return {
    tag: c.tag,
    senderKey: c.senderKey,
    senderSig: c.senderSig,
    committed: { commitment: c.commitment, unit: c.unit, decimals: c.decimals as number },
  }
}

/**
 * Check a published receipt. Anyone can run this.
 *
 * Requires that the sender's per-transfer key signed THIS event's author (the
 * receiver's per-transfer key) and THIS commitment, unit and decimals, or the
 * "none" marker when there is no commitment. So a `{tag, senderKey, senderSig}`
 * copied under a new author fails, and so does a shifted commitment. It proves
 * both halves exist for one transfer, and says nothing about who either
 * party is.
 */
export function verifyTransferReceipt(event: Event): boolean {
  try {
    if (event.kind !== TRANSFER_RECEIPT_KIND || !verifyEvent(event)) return false
    const r = readReceipt(event)
    if (!r) return false
    return schnorr.verify(
      hexToBytes(r.senderSig),
      linkMessage(r.tag, event.pubkey, r.committed),
      hexToBytes(r.senderKey),
    )
  } catch {
    return false
  }
}

/**
 * Open a receipt against a disclosed payload: what an auditor runs when either
 * party hands them the payload (sender: recomputed from their key, receiver:
 * kept on their `received` row). Never throws.
 *
 * On success it has established that the receipt is genuine, that its two
 * per-transfer keys are `p.sender` and `p.recipient` tweaked by this nonce, and,
 * when the receipt carries a commitment, that it opens to `p.amount`.
 */
export function openTransferReceipt(
  event: Event,
  p: TransferSignature,
): { ok: true; amount?: number; unit?: string; decimals?: number } | { ok: false; reason: string } {
  try {
    if (!verifyTransferReceipt(event)) return { ok: false, reason: 'receipt does not verify' }
    const verdict = verifyTransferSignature(p, { recipient: p.recipient })
    if (!verdict.ok) return verdict
    const r = readReceipt(event)!
    const tag = transferTag(p.transfer, p.nonce)
    if (r.tag !== tag) return { ok: false, reason: 'a different transfer' }
    if (r.senderKey !== transferPubkeyFor(p.sender, 'sender', tag, p.nonce)) {
      return { ok: false, reason: 'not signed by this sender' }
    }
    if (event.pubkey !== transferPubkeyFor(p.recipient, 'receiver', tag, p.nonce)) {
      return { ok: false, reason: 'not published by this recipient' }
    }
    if (!r.committed) return { ok: true }
    if (r.committed.commitment !== commitTo(p.amount, transferBlind(p.nonce))) {
      return { ok: false, reason: 'commitment does not open to the disclosed amount' }
    }
    return { ok: true, amount: p.amount, unit: r.committed.unit, decimals: r.committed.decimals }
  } catch (e) {
    return { ok: false, reason: `unreadable: ${(e as Error).message}` }
  }
}

/**
 * The SEAL author of a NIP-17 gift wrap. Undefined when the seal does not
 * verify or is not a kind 13.
 *
 * nostr-tools' `nip59.unwrapEvent` decrypts seal and rumor but checks neither
 * the seal's signature nor that `seal.pubkey === rumor.pubkey`, so the rumor's
 * `pubkey` alone is whatever the wrapper typed. dmCrypto compares the two for a
 * transfer signature. The payload's own identity `sig` is still what really
 * binds the sender; this only refuses a wrap whose envelope lies.
 */
export function sealAuthorOf(wrap: Event, recipientSecret: Uint8Array): string | undefined {
  try {
    const seal = JSON.parse(
      nip44.decrypt(wrap.content, nip44.getConversationKey(recipientSecret, wrap.pubkey)),
    ) as Event
    if (seal?.kind !== 13 || !verifyEvent(seal)) return undefined
    return seal.pubkey
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Sender side
// ---------------------------------------------------------------------------

/**
 * Sign a completed send and gift-wrap the signature to the recipient.
 * NEVER THROWS, and resolves to whether the relay OR the gateway took it.
 *
 * Runs after the saga has completed and the local row is written: the coupon
 * has already moved, so a locked wallet, an old gateway that returned no
 * `sent_voucher_id`, or a relay refusing the wrap costs the receipt and
 * nothing else.
 *
 * Nothing needs keeping here: the nonce is derived from this wallet's key and
 * the transfer id, and the `sent` row already carries the transfer id, so the
 * whole payload can be rebuilt after a wipe (`signTransfer` again).
 *
 * Wrapped by THIS wallet rather than the gateway, because the atomic-send API
 * has no field for it (see the ADR). Published to the wallet's relay AND
 * mirrored into the gateway's cache (`mirrorToGateway`, #98). The relay copy
 * alone was measured to be invisible to a recipient whose catch-up the gateway
 * answers from a warm cache; the mirrored copy is served from that cache. The
 * two run side by side and either one landing counts as delivered. The ADR's
 * "Delivery" section has the measurements.
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
    const [relayed, mirrored] = await Promise.all([
      publish(wrap).then(
        (result) => {
          if (result.ok === 0) console.warn('[transfer] no relay accepted the signature', result.errors)
          return result.ok > 0
        },
        (error: unknown) => {
          console.warn('[transfer] relay publish failed', error)
          return false
        },
      ),
      mirrorToGateway(wrap),
    ])
    return relayed || mirrored
  } catch (error) {
    console.warn('[transfer] send not signed', error)
    return false
  }
}

/** How long the mirror may take before it is given up on. */
const MIRROR_TIMEOUT_MS = 15_000

/**
 * Store the wrap in the gateway's nostrdb cache (#98). NEVER THROWS.
 *
 * `POST /api/v1/nostr/events` is NIP-98 authenticated, re-derives the id,
 * checks the signature and stores the event where the catch-up query reads.
 * It does not publish to the relay, which is why this runs beside `publish`
 * rather than instead of it. The wrap is signed by NIP-59's throwaway key and
 * its content is NIP-44 encrypted to the recipient, so the gateway learns
 * nothing it does not already know from the send itself.
 *
 * Same body shape as imani-apps' `shared/api.js` `_buildBackendMirrorPayload`:
 * camelCase `createdAt`, because that is what the gateway's DTO reads.
 */
export async function mirrorToGateway(wrap: Event): Promise<boolean> {
  // On timeout the request is aborted, not just stopped being waited for, so
  // a slow gateway does not keep a connection busy for a result nobody reads.
  // The race stays: it bounds the wait even where signing, not the fetch, is
  // what hangs.
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      signedFetch(
        '/api/v1/nostr/events',
        'POST',
        {
          id: wrap.id,
          pubkey: wrap.pubkey,
          createdAt: wrap.created_at,
          kind: wrap.kind,
          tags: wrap.tags,
          content: wrap.content,
          sig: wrap.sig,
        },
        undefined,
        { signal: controller.signal },
      ),
      new Promise<never>(
        (_, reject) =>
          (timer = setTimeout(() => {
            controller.abort()
            reject(new Error('mirror timed out'))
          }, MIRROR_TIMEOUT_MS)),
      ),
    ])
    if (!response.ok) {
      console.warn('[transfer] gateway refused the signature mirror', response.status)
      return false
    }
    return true
  } catch (error) {
    console.warn('[transfer] gateway mirror failed', error)
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Receiver side
// ---------------------------------------------------------------------------

/**
 * The two halves arrive in either order: the coupon's DM and the sender's
 * signature are separate gift wraps, published by different parties. Each is
 * held here until the other turns up, and a pair is then held until its
 * randomly delayed publish time comes round.
 *
 * localStorage, scoped by pubkey like every other `imani-wallet:` record, and
 * held in memory where there is none (tests, a locked-down browser). Losing it
 * loses a receipt, never money. What must outlive it (the payload, needed to
 * open or disclose the receipt) is written onto the received row, which is
 * backed up to the relay.
 */
type HeldSignature = { p: TransferSignature; at: number }
type Received = {
  /** Who sent the COUPON, off its envelope. Only a signature by them pairs. */
  sender?: string
  credited?: number
  unit?: string
  decimals?: number
  at: number
}
/**
 * A queued publish. `receipt` (the default, and all a v2 entry written before
 * phases existed can be) publishes the 7378. `backup` re-publishes the
 * received row with the payload on it, on a delay of its own: see
 * `publishDue`.
 */
type Due = { publishAt: number; attempts: number; phase?: 'receipt' | 'backup'; transfer?: string }
/**
 * A signature's gift wrap left UNPROCESSED at the relay until it pairs (#99).
 * Keyed by wrap id. `paired` is set once its receipt is queued, so the next
 * sight of the wrap releases it instead of holding it again.
 */
type HeldWrap = { transfer: string; sender: string; at: number; paired?: true }

/** Global cap per store. */
const MAX_HELD = 200
/**
 * Per-author cap on held signatures. Any npub can send validly self-signed
 * payloads addressed to anyone, so one key may hold at most this many.
 *
 * That alone does not stop a flood: keys are free, and 200 one-shot keys each
 * holding one entry are all under it. So on global overflow `pruneSignatures`
 * never evicts a signature that is already paired and queued, nor one whose
 * signer is someone this wallet has dealt with (a sender of a coupon waiting
 * here, or a counterparty in its history), while any other entry is left.
 * A flood of fresh keys can still evict a FIRST-TIME sender's entry here, but
 * this store is only a cache now: the wrap it came in is held unprocessed at
 * the relay until it pairs (`HeldWrap`), and is read again when its coupon
 * arrives. See the ADR.
 */
const MAX_PER_AUTHOR = 20
/**
 * How long either half waits for the other. A coupon from a stall, or from an
 * older build, never pairs, and should not sit in storage forever.
 */
const HELD_TTL_MS = 30 * 24 * 60 * 60 * 1000
/**
 * How long a signature wrap is held unprocessed at the relay. The poller's
 * fetch window (`recentDmsSince` in dmPoll), past which it would not be
 * fetched again anyway. Measured from the wrap's own `created_at`, which
 * NIP-59 only ever moves into the past, and from first sight, whichever is
 * earlier.
 */
export const WRAP_HOLD_TTL_MS = 7 * 24 * 60 * 60 * 1000
/**
 * Most signature wraps held at once. Each costs one entry of about 150 bytes
 * here and no decryption per catch-up (see `heldWrapDecision`). Past it a NEW
 * wrap is not held, so a flood cannot push out one already held, it can only
 * stop later ones being held (their signature still goes into the cache
 * above). 1000 is about 150 KB, the same order as dm-poll's processed set.
 */
export const MAX_HELD_WRAPS = 1000

/**
 * The random publish delay, uniform in [MIN, MAX], and the backward jitter on
 * `created_at`. Minutes to hours because nothing reads these for completeness,
 * so nothing needs them soon, while the redemption they follow is visible to
 * the gateway to the second. See the ADR's "Timing" section for what this
 * does and does not hide.
 */
export const RECEIPT_DELAY_MIN_MS = 10 * 60 * 1000
export const RECEIPT_DELAY_MAX_MS = 6 * 60 * 60 * 1000
export const RECEIPT_JITTER_MAX_S = 60 * 60
/** Publish attempts before a pair is dropped. Each retry is a fresh random delay. */
const MAX_ATTEMPTS = 3

const memory = new Map<string, string>()

function storeKey(kind: 'signatures' | 'received' | 'due' | 'wraps', pubkey: string) {
  return `imani-wallet:transfer-${kind}:${pubkey.toLowerCase()}`
}

/** A held signature's key: one slot per (transfer, signer), first writer wins. */
function heldKey(transfer: string, sender: string) {
  return `${transfer}:${sender}`
}

/**
 * Keys whose last write did not reach local storage (quota, private mode), so
 * memory is the only copy of the latest state.
 */
const memoryOnly = new Set<string>()

/**
 * Local storage when there is one, memory only where there is none or the last
 * write to it failed. An ABSENT key in a working store means empty: that is
 * what logout's sweep leaves, and falling back to memory there would read a
 * queue the user asked to erase straight back.
 */
function readHeld<T>(key: string): Record<string, T> {
  let raw: string | null | undefined
  const storage = globalThis.localStorage
  if (storage && !memoryOnly.has(key)) {
    try {
      raw = storage.getItem(key)
    } catch {
      raw = memory.get(key)
    }
  } else {
    raw = memory.get(key)
  }
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, T>) : {}
  } catch {
    return {}
  }
}

function writeHeld<T>(key: string, held: Record<string, T>, cap = MAX_HELD): void {
  // Oldest out first, so a flood of unmatched halves cannot grow this forever.
  const entries = Object.entries(held)
  const kept = Object.fromEntries(entries.slice(Math.max(0, entries.length - cap)))
  const raw = JSON.stringify(kept)
  memory.set(key, raw)
  try {
    const storage = globalThis.localStorage
    if (storage) {
      storage.setItem(key, raw)
      memoryOnly.delete(key)
    }
  } catch {
    // Memory still holds it for this session, and is read in preference.
    memoryOnly.add(key)
  }
}

/**
 * Drop expired entries, then enforce the per-author and global caps.
 *
 * `isProtected` marks entries the global cap evicts last: see
 * `MAX_PER_AUTHOR`. It is asked only when the store is actually over the cap.
 */
function pruneSignatures(
  held: Record<string, HeldSignature>,
  now: number,
  isProtected: (key: string, h: HeldSignature) => boolean = () => false,
): Record<string, HeldSignature> {
  let entries = Object.entries(held).filter(([, h]) => h && now - h.at < HELD_TTL_MS)
  const byAuthor = () => {
    const counts = new Map<string, number>()
    for (const [, h] of entries) counts.set(h.p.sender, (counts.get(h.p.sender) ?? 0) + 1)
    return counts
  }
  // Per author: keep that author's newest MAX_PER_AUTHOR.
  for (const [author, count] of byAuthor()) {
    if (count <= MAX_PER_AUTHOR) continue
    let excess = count - MAX_PER_AUTHOR
    entries = entries.filter(([, h]) => !(h.p.sender === author && excess-- > 0))
  }
  // Global: unprotected entries go first, the oldest of whoever holds the most,
  // one at a time. Only once none is left does a protected one go.
  while (entries.length > MAX_HELD) {
    const open = entries.filter(([key, h]) => !isProtected(key, h))
    const pool = open.length > 0 ? open : entries
    const counts = new Map<string, number>()
    for (const [, h] of pool) counts.set(h.p.sender, (counts.get(h.p.sender) ?? 0) + 1)
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const victim = pool.find(([, h]) => h.p.sender === top)!
    entries.splice(entries.indexOf(victim), 1)
  }
  return Object.fromEntries(entries)
}

function pruneReceived(held: Record<string, Received>, now: number): Record<string, Received> {
  return Object.fromEntries(Object.entries(held).filter(([, r]) => r && now - r.at < HELD_TTL_MS))
}

/** Uniform integer in [0, span], from the CSPRNG. */
function randomUpTo(span: number): number {
  const [x] = crypto.getRandomValues(new Uint32Array(1))
  return Math.floor((x / 0x1_0000_0000) * (span + 1))
}

function randomDelay(): number {
  return RECEIPT_DELAY_MIN_MS + randomUpTo(RECEIPT_DELAY_MAX_MS - RECEIPT_DELAY_MIN_MS)
}

/** A merchant never publishes a 7378: see `TRANSFER_RECEIPT_KIND`. */
function isMerchantWallet(me: string): boolean {
  return loadMerchant(me) !== null
}

/**
 * Which held signatures the global cap evicts last: one already paired and
 * queued, or one signed by a key this wallet has dealt with (the sender of a
 * coupon waiting here, or a counterparty anywhere in its history). A flood of
 * fresh keys is neither, and those keys cost an attacker nothing, so they go
 * first. Never throws: without history, only the local stores count.
 */
async function protectedSigners(me: string): Promise<(key: string, h: HeldSignature) => boolean> {
  const due = readHeld<Due>(storeKey('due', me))
  const known = new Set<string>()
  for (const r of Object.values(readHeld<Received>(storeKey('received', me)))) {
    if (r?.sender) known.add(r.sender)
  }
  try {
    for (const row of await listTransactions()) {
      const tx = toTransaction(row)
      if (tx.counterparty) known.add(tx.counterparty.toLowerCase())
    }
  } catch {
    // A wallet not open yet, or a store that will not read. The local stores
    // above still protect a pair that has formed.
  }
  return (key, h) => key in due || known.has(h.p.sender)
}

let timer: ReturnType<typeof setTimeout> | undefined

/**
 * Forget everything held in memory and stop the timer. Called by `stopDmPoll`,
 * which runs on logout and on an account switch, and by tests.
 */
export function resetHeldTransfers(): void {
  memory.clear()
  memoryOnly.clear()
  wrapsCache = undefined
  stopTransferReceipts()
}

/** Stop the publish timer. Called when the poller stops; nothing held is lost. */
export function stopTransferReceipts(): void {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
}

/** (Re)arm the one timer for the earliest due receipt. */
function arm(me: string): void {
  stopTransferReceipts()
  const due = Object.values(readHeld<Due>(storeKey('due', me)))
  if (due.length === 0) return
  const next = Math.min(...due.map((d) => d.publishAt))
  timer = setTimeout(() => {
    timer = undefined
    void publishDue(me).catch((error) => console.warn('[transfer] receipt publish failed', error))
  }, Math.max(0, next - Date.now()))
}

/**
 * Publish every receipt whose time has come. Never throws.
 *
 * Exported so startup can drain what a closed tab left behind (via
 * `resumeTransferReceipts`) and tests can drive it.
 *
 * **Claim before publish.** Each due entry is removed from the store BEFORE
 * the relay round trip and put back only if the publish fails, and every read
 * and write around the await re-reads the store and touches only its own key.
 * Holding snapshots across the await used to write them back whole and drop
 * whatever `queueIfPaired` had queued in the meantime.
 *
 * **One tab at a time.** Every tab arms its own timer over the same storage,
 * so the pass runs under a per-account Web Lock. Where there is no Locks API
 * the claim above still makes a second tab find nothing due.
 */
export async function publishDue(me: string): Promise<number> {
  me = me.toLowerCase()
  try {
    return await withWebLock(`imani-transfer-receipts:${me}`, () => publishDueLocked(me))
  } catch (error) {
    console.warn('[transfer] receipts not published now', error)
    return 0
  }
}

async function publishDueLocked(me: string): Promise<number> {
  let published = 0
  try {
    const signer = getSigner()
    // A different account is open now. Its own resume will pick these up.
    if (signer.pubkey.toLowerCase() !== me) return 0
    if (isMerchantWallet(me)) return 0

    const now = Date.now()
    const dueKey = storeKey('due', me)
    const sigKey = storeKey('signatures', me)
    const recKey = storeKey('received', me)
    const forget = (key: string, transfer: string | undefined) => {
      const signatures = readHeld<HeldSignature>(sigKey)
      delete signatures[key]
      writeHeld(sigKey, signatures)
      if (transfer) {
        const received = readHeld<Received>(recKey)
        delete received[transfer]
        writeHeld(recKey, received)
      }
    }

    for (const key of Object.keys(readHeld<Due>(dueKey))) {
      // Claim: re-read, and take the entry out before any await.
      const due = readHeld<Due>(dueKey)
      const d = due[key]
      if (!d || d.publishAt > now) continue
      delete due[key]
      writeHeld(dueKey, due)

      if (d.phase === 'backup') {
        // The received row's backup, re-published with the payload on it.
        // Its own random delay, so it is next to neither the redemption nor
        // the 7378 in time. Best-effort: `backUpTransferSignature` never
        // throws, and the payload is already on the local row.
        if (d.transfer) await backUpTransferSignature(d.transfer)
        forget(key, d.transfer)
        continue
      }

      const held = readHeld<HeldSignature>(sigKey)[key]
      const r = held ? readHeld<Received>(recKey)[held.p.transfer] : undefined
      if (!held || !r) continue
      const p = held.p
      const withCommitment =
        r.credited !== undefined &&
        r.credited === p.amount &&
        (r.unit ?? '').toUpperCase() === p.unit &&
        r.decimals === p.decimals

      const tag = transferTag(p.transfer, p.nonce)
      // Jittered backward only, so a receipt is never dated in the future. It
      // can land on either side of the redemption it records, which is the
      // point: `created_at` alone no longer says which redemption that was.
      const createdAt = Math.floor(now / 1000) - randomUpTo(RECEIPT_JITTER_MAX_S)
      const event = signer.withPrivkey((sk0) => {
        const sk = transferSecretFor(sk0, 'receiver', tag, p.nonce)
        try {
          return buildTransferReceipt(p, sk, withCommitment, createdAt)
        } finally {
          sk.fill(0)
        }
      })

      let ok = false
      try {
        ok = (await publish(event)).ok > 0
      } catch (error) {
        console.warn('[transfer] receipt publish threw', error)
      }
      if (ok) {
        published += 1
        // Now the backup, later and on its own clock. The signature and the
        // received entry are no longer needed: the payload is on the row.
        const after = readHeld<Due>(dueKey)
        after[key] = { publishAt: Date.now() + randomDelay(), attempts: 0, phase: 'backup', transfer: p.transfer }
        writeHeld(dueKey, after)
        forget(key, p.transfer)
      } else if (d.attempts + 1 >= MAX_ATTEMPTS) {
        console.warn('[transfer] giving up on a receipt no relay would take')
        forget(key, p.transfer)
      } else {
        const after = readHeld<Due>(dueKey)
        after[key] = { publishAt: Date.now() + randomDelay(), attempts: d.attempts + 1 }
        writeHeld(dueKey, after)
      }
    }

    arm(me)
  } catch (error) {
    // Most likely a locked wallet. Everything stays queued for the next
    // `resumeTransferReceipts`, which runs when the poller starts again.
    console.warn('[transfer] receipts not published now', error)
  }
  return published
}

/** Where an overdue entry lands after a resume: uniform in [MIN, MAX] from now. */
export const RESUME_DELAY_MIN_MS = 60 * 1000
export const RESUME_DELAY_MAX_MS = 30 * 60 * 1000

/**
 * Pick up receipts a previous session queued. Called when the poller starts.
 * Never throws.
 *
 * Overdue ones do NOT go out on the next tick. The minimum delay is ten
 * minutes and mobile sessions are short, so most receipts come due while the
 * app is closed, and publishing them all at startup would put a burst of
 * 7378s in the same second as this login's NIP-98 traffic, from the same IP,
 * to the relay the gateway runs. Each overdue entry gets a fresh random delay
 * of one to thirty minutes instead. Entries not yet due keep their time.
 */
export function resumeTransferReceipts(me: string): void {
  try {
    me = me.toLowerCase()
    const dueKey = storeKey('due', me)
    const due = readHeld<Due>(dueKey)
    const now = Date.now()
    let changed = false
    for (const [key, d] of Object.entries(due)) {
      if (d.publishAt > now) continue
      due[key] = { ...d, publishAt: now + RESUME_DELAY_MIN_MS + randomUpTo(RESUME_DELAY_MAX_MS - RESUME_DELAY_MIN_MS) }
      changed = true
    }
    if (changed) writeHeld(dueKey, due)
    arm(me)
  } catch (error) {
    console.warn('[transfer] could not resume receipts', error)
  }
}

/**
 * Queue the receipt if both halves are here. Never throws.
 *
 * Pairs only a signature by the coupon's actual sender. Merchants never queue
 * one, checked here as well as at both entry points so the rule does not
 * depend on call order.
 *
 * The receipt carries the commitment only when the receiver's VERIFIED
 * credited value, unit and decimals all equal what the sender signed. A
 * sender-written envelope figure is never committed to (the rule
 * `attestRedemption` follows), and where the two disagree the receipt goes out
 * with the sender's bare signature, which asserts the link and no amount.
 */
async function queueIfPaired(me: string, transfer: string): Promise<boolean> {
  if (isMerchantWallet(me)) return false
  const sigKey = storeKey('signatures', me)
  const recKey = storeKey('received', me)
  const dueKey = storeKey('due', me)
  const received = readHeld<Received>(recKey)
  const r = received[transfer]
  if (!r?.sender) return false
  const key = heldKey(transfer, r.sender)
  const signatures = readHeld<HeldSignature>(sigKey)
  const held = signatures[key]
  if (!held) return false

  const verdict = verifyTransferSignature(held.p, { recipient: me, transfer, sender: r.sender })
  if (!verdict.ok) {
    // Optional evidence that does not hold. Dropped, never escalated.
    console.warn('[transfer] ignoring a sender signature:', verdict.reason)
    delete signatures[key]
    writeHeld(sigKey, signatures)
    return false
  }

  const due = readHeld<Due>(dueKey)
  if (due[key]) {
    markWrapsPaired(me, transfer, r.sender)
    return true
  }
  due[key] = { publishAt: Date.now() + randomDelay(), attempts: 0 }
  writeHeld(dueKey, due)
  // Its wrap, if held at the relay, is released on the next catch-up.
  markWrapsPaired(me, transfer, r.sender)

  // The payload is what opens and discloses the receipt, and the only copy
  // otherwise is this store and a gift wrap about to be released. So it
  // goes on the received row now, LOCALLY. The row's relay backup is left to
  // `publishDue`, on a random delay of its own after the 7378: re-publishing
  // it here would put a visibly larger kind-7376 by this identity on the relay
  // at the moment of pairing, which says "a signed transfer just arrived".
  // Not awaited: a failure costs the disclosure, never the redemption.
  void recordTransferSignature(transfer, JSON.stringify(held.p), { backUp: false }).catch(() => {})

  arm(me)
  return true
}

/**
 * A sender's signature arrived in a gift wrap. Hold it, and queue the receipt
 * if its coupon has already been redeemed. Never throws, never awaited by the
 * unwrap path that calls it.
 *
 * Checked on arrival against the wrap's author (which dmCrypto has checked
 * against the seal) and our own key, so nothing forged or misaddressed is ever
 * stored. First writer per (transfer, signer): a later payload from the same
 * key cannot overwrite, and one from another key sits in its own slot, where
 * it never pairs unless that key sent the coupon.
 */
export async function offerTransferSignature(
  p: TransferSignature,
  authorPubkey: string,
): Promise<boolean> {
  return (await takeSignature(p, authorPubkey)) === 'paired'
}

/** `offerTransferSignature`, saying whether it was refused, held, or paired. */
async function takeSignature(
  p: TransferSignature,
  authorPubkey: string,
): Promise<'refused' | 'held' | 'paired'> {
  try {
    const me = getSigner().pubkey.toLowerCase()
    if (isMerchantWallet(me)) return 'refused'
    const verdict = verifyTransferSignature(p, { recipient: me, authorPubkey })
    if (!verdict.ok) {
      console.warn('[transfer] refusing a sender signature:', verdict.reason)
      return 'refused'
    }
    const sigKey = storeKey('signatures', me)
    const now = Date.now()
    const key = heldKey(p.transfer, p.sender)
    const before = readHeld<HeldSignature>(sigKey)
    if (!before[key]) before[key] = { p, at: now }
    // Only an overflowing store needs to know who is protected, and that
    // costs a history read, so it is asked for only then.
    const isProtected = Object.keys(before).length > MAX_HELD ? await protectedSigners(me) : undefined
    // Re-read after the await, so a signature another call stored meanwhile
    // is not written over.
    const held = readHeld<HeldSignature>(sigKey)
    if (!held[key]) held[key] = { p, at: now }
    writeHeld(sigKey, pruneSignatures(held, now, isProtected))
    return (await queueIfPaired(me, p.transfer)) ? 'paired' : 'held'
  } catch (error) {
    console.warn('[transfer] could not take a sender signature', error)
    return 'refused'
  }
}

// ---------------------------------------------------------------------------
// Signature wraps held at the relay (#99)
//
// The local store above is a cache with a cap, and keys are free, so a flood
// of validly self-signed payloads from fresh keys can push a first-time
// sender's signature out of it before their coupon arrives. The wrap it came
// in is still on the relay, though. So a signature that does not pair on
// arrival leaves its wrap UNPROCESSED (dm-poll's `UnwrappedDm.hold`), and the
// poller's next catch-up offers it again. Only the wrap id is remembered here,
// so a held wrap costs no decryption per catch-up: it is opened again only
// once its coupon has arrived from the same sender and the pair has not
// formed, which is exactly the flood case. A wrap is released (marked
// processed) once it pairs, once it expires, or when it is refused.

function markWrapsPaired(me: string, transfer: string, sender: string): void {
  const key = storeKey('wraps', me)
  const wraps = readHeld<HeldWrap>(key)
  let changed = false
  for (const w of Object.values(wraps)) {
    if (w && w.transfer === transfer && w.sender === sender && !w.paired) {
      w.paired = true
      changed = true
    }
  }
  if (changed) writeHeld(key, wraps, MAX_HELD_WRAPS)
}

function pruneWraps(wraps: Record<string, HeldWrap>, now: number): Record<string, HeldWrap> {
  return Object.fromEntries(Object.entries(wraps).filter(([, w]) => w && now - w.at < WRAP_HOLD_TTL_MS))
}

/**
 * What to do with a gift wrap seen before, WITHOUT opening it. Never throws.
 *
 * - `undefined`: not a held signature wrap. Unwrap it as usual.
 * - `hold`: still waiting for its coupon. Leave it unprocessed, unopened.
 * - `release`: paired, expired, or no longer wanted. Mark it processed.
 * - `reread`: its coupon has arrived from the same sender and no receipt is
 *   queued, so the cached signature was evicted. Open it and offer it again.
 */
export function heldWrapDecision(wrapId: string): 'hold' | 'release' | 'reread' | undefined {
  try {
    const me = getSigner().pubkey.toLowerCase()
    const key = storeKey('wraps', me)
    // Asked once per held wrap on every catch-up, so the common answer comes
    // from a parse cached against the stored string, not a fresh parse.
    const w = readWrapsCached(key)[wrapId]
    if (!w) return undefined
    const expired = Date.now() - w.at >= WRAP_HOLD_TTL_MS
    if (w.paired || expired || isMerchantWallet(me)) {
      const wraps = readHeld<HeldWrap>(key)
      delete wraps[wrapId]
      writeHeld(key, wraps, MAX_HELD_WRAPS)
      return 'release'
    }
    const r = readHeld<Received>(storeKey('received', me))[w.transfer]
    return r?.sender === w.sender ? 'reread' : 'hold'
  } catch {
    return undefined
  }
}

let wrapsCache: { key: string; raw: string | null | undefined; value: Readonly<Record<string, HeldWrap>> } | undefined

/** A read-only view of the wraps store, re-parsed only when it changed. */
function readWrapsCached(key: string): Readonly<Record<string, HeldWrap>> {
  let raw: string | null | undefined
  const storage = globalThis.localStorage
  try {
    raw = storage && !memoryOnly.has(key) ? storage.getItem(key) : memory.get(key)
  } catch {
    raw = memory.get(key)
  }
  if (wrapsCache && wrapsCache.key === key && wrapsCache.raw === raw) return wrapsCache.value
  const value = readHeld<HeldWrap>(key)
  wrapsCache = { key, raw, value }
  return value
}

/**
 * Whether a signature wrap for this coupon is held at the relay, unpaired. The
 * redemption path asks after `noteTransferReceived` did not pair, and runs a
 * catch-up if so, which re-reads the wrap now rather than on the next poll.
 */
export function awaitsHeldWrap(token: string): boolean {
  try {
    const me = getSigner().pubkey.toLowerCase()
    const transfer = transferIdFor(token)
    return Object.values(readHeld<HeldWrap>(storeKey('wraps', me))).some(
      (w) => w?.transfer === transfer && !w.paired,
    )
  } catch {
    return false
  }
}

/**
 * A sender's signature arrived in gift wrap `wrap`. Offer it, and say whether
 * the wrap should be held unprocessed at the relay (`true`) or released. Never
 * throws.
 *
 * Held only when the signature was taken and did not pair, and only while
 * fewer than `MAX_HELD_WRAPS` are held: past that a new wrap is released, so
 * a flood cannot displace a wrap already held. `at` is the earlier of now and
 * the wrap's `created_at`, so the hold ends within the poller's fetch window.
 */
export async function holdTransferSignatureWrap(
  p: TransferSignature,
  authorPubkey: string,
  wrap: { id: string; created_at: number },
): Promise<boolean> {
  try {
    const outcome = await takeSignature(p, authorPubkey)
    const me = getSigner().pubkey.toLowerCase()
    const key = storeKey('wraps', me)
    const now = Date.now()
    const wraps = pruneWraps(readHeld<HeldWrap>(key), now)
    // Its coupon is already here and it still did not pair, so it never will:
    // the coupon came from another key, or the pairing check refused it.
    // Holding it would only re-open it on every catch-up until it expired.
    const couponHere = Boolean(readHeld<Received>(storeKey('received', me))[p.transfer])
    if (outcome !== 'held' || couponHere) {
      delete wraps[wrap.id]
      writeHeld(key, wraps, MAX_HELD_WRAPS)
      return false
    }
    if (!wraps[wrap.id]) {
      if (Object.keys(wraps).length >= MAX_HELD_WRAPS) {
        writeHeld(key, wraps, MAX_HELD_WRAPS)
        return false
      }
      const createdMs = Number.isFinite(wrap.created_at) ? wrap.created_at * 1000 : now
      wraps[wrap.id] = { transfer: p.transfer, sender: p.sender, at: Math.min(now, createdMs) }
    }
    const held = now - wraps[wrap.id]!.at < WRAP_HOLD_TTL_MS
    if (!held) delete wraps[wrap.id]
    writeHeld(key, wraps, MAX_HELD_WRAPS)
    return held
  } catch (error) {
    console.warn('[transfer] could not hold a signature wrap', error)
    return false
  }
}

/** sha256(token)[:32], the same fingerprint the gateway calls `sent_voucher_id`. */
export function transferIdFor(token: string): string {
  return bytesToHex(sha256(utf8ToBytes(token))).slice(0, 32)
}

/**
 * A CUSTOMER redeemed a coupon. Hold the fact, and queue the receipt if the
 * sender's signature is already here. Never throws.
 *
 * Only a customer's wallet gets this far: a stall attests with a 7377 and must
 * not also publish a 7378 (see the call site in `dmPoll`, and the check
 * below). Nothing is published without a sender signature, and nothing is held
 * without a known sender, so a coupon with no `sender_pubkey` leaves no trace.
 */
export async function noteTransferReceived(params: {
  token: string
  /** Who sent the coupon: the envelope's `sender_pubkey`, else the wrap author. */
  sender?: string
  /** The VERIFIED credited value, or undefined when the voucher did not verify. */
  credited?: number
  unit?: string
  decimals?: number
}): Promise<boolean> {
  try {
    const me = getSigner().pubkey.toLowerCase()
    if (isMerchantWallet(me)) return false
    const sender = params.sender?.toLowerCase()
    if (!sender || !HEX_64.test(sender)) return false
    const transfer = transferIdFor(params.token)
    const key = storeKey('received', me)
    const now = Date.now()
    const held = pruneReceived(readHeld<Received>(key), now)
    held[transfer] = {
      sender,
      ...(Number.isSafeInteger(params.credited) ? { credited: params.credited } : {}),
      ...(params.unit ? { unit: params.unit.toUpperCase() } : {}),
      ...(Number.isSafeInteger(params.decimals) ? { decimals: params.decimals } : {}),
      at: now,
    }
    writeHeld(key, held)
    return await queueIfPaired(me, transfer)
  } catch (error) {
    console.warn('[transfer] receipt not attested', error)
    return false
  }
}
