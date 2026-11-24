import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8 } from './bytes'
import { fieldHex, fieldUtf8, fieldVarint, readTlv, TlvWriter } from './tlv'

/**
 * The receipt wire format, version 1: a port of Java `ReceiptFormat` and `ReceiptSummary`
 * (wallet-core spec 049, FR-051 to FR-053). Signatures always cover the exact bytes carried.
 */

export const VERSION = 1
export const QR_PREFIX = 'imrc1:'
export const QR_BODY_LIMIT = 600
export const MAX_REFERENCE_BYTES = 80
/** The payer's own note on the payment (FR-002a), signed with the summary. Short: it rides in a QR. */
export const MAX_MEMO_BYTES = 64
export const MAX_MINTS = 4

export const TAG_PAYMENT_ID = 'imani-receipt/v1/payment-id'
export const TAG_PAYER = 'imani-receipt/v1/payer'
export const TAG_ACK = 'imani-receipt/v1/ack'
export const TAG_PRESENTER = 'imani-receipt/v1/presenter'
export const TAG_CHALLENGE = 'imani-receipt/v1/challenge'
export const TAG_EVIDENCE = 'imani-receipt/v1/evidence'

export const RAIL_CASHU = 'cashu'
export const RAIL_LIGHTNING = 'lightning'
export type Rail = typeof RAIL_CASHU | typeof RAIL_LIGHTNING

/** Summary tags (Java `S_*`). */
export const S = {
  VERSION: 1,
  PAYMENT_ID: 2,
  RAIL: 3,
  PAYER: 4,
  PAYEE: 5,
  AMOUNT: 6,
  UNIT: 7,
  MINT: 8,
  PAID_AT: 9,
  REFERENCE: 10,
  EVIDENCE_DIGEST: 11,
  ITEMS_COMMITMENT: 12,
  REFUND_OF: 13,
  /** FR-002a: the payer's memo. Added in v1: older readers skip it, signatures still cover it. */
  MEMO: 14,
} as const

/** Acknowledgement tags (Java `A_*`). */
export const A = {
  PAYMENT_ID: 1,
  PAYEE: 2,
  PAYER: 3,
  AMOUNT: 4,
  UNIT: 5,
  MINT: 6,
  REFERENCE: 7,
  EVIDENCE_DIGEST: 8,
  CLAIMED_AT: 9,
  PAID_AT: 10,
  ITEMS_COMMITMENT: 11,
  REFUND_OF: 12,
  VERSION: 13,
  RAIL: 14,
} as const

/**
 * What was paid and to whom. Keys are x-only lowercase hex. `reference` is `''` when absent.
 * Amounts and times are safe integers (a Java long beyond 2^53 is rejected on decode).
 */
export interface ReceiptSummary {
  version: number
  paymentId: string
  rail: Rail
  /** null when the payer was not identified (a bare token). */
  payer: string | null
  payee: string
  amount: number
  unit: string
  /** Sorted, distinct. Empty for Lightning. */
  mints: string[]
  paidAt: number
  reference: string
  evidenceDigest: string
  itemsCommitment: string | null
  refundOf: string | null
  /** The payer's memo, `''` when absent. Not in the acknowledgement: the payee signs the payment. */
  memo: string
}

export type ReceiptSummaryInput = Omit<ReceiptSummary, 'version' | 'reference' | 'itemsCommitment' | 'refundOf' | 'payer' | 'mints' | 'memo'> & {
  version?: number
  payer?: string | null
  mints?: string[] | null
  reference?: string | null
  itemsCommitment?: string | null
  refundOf?: string | null
  memo?: string | null
}

const HEX64 = /^[0-9a-f]{64}$/

function strip0x(s: string): string {
  const t = s.trim()
  return t.startsWith('0x') || t.startsWith('0X') ? t.slice(2) : t
}

/** Java `ReceiptKeys.xOnly`: accepts x-only or 33-byte compressed, returns x-only lowercase. */
export function xOnly(key: string): string {
  let k = strip0x(key).toLowerCase()
  if (k.length === 66 && (k.startsWith('02') || k.startsWith('03'))) k = k.slice(2)
  if (!HEX64.test(k)) throw new Error('not a secp256k1 public key')
  return k
}

/** Java `ReceiptKeys.requireHex32`. */
export function requireHex32(value: string | null | undefined, name: string): string {
  if (value == null) throw new Error(`${name} is required`)
  const v = value.toLowerCase()
  if (!HEX64.test(v)) throw new Error(`${name} must be 32 bytes of hex`)
  return v
}

function isSafePositive(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0
}

/** Validates and normalises like the Java `ReceiptSummary` record constructor. */
export function makeSummary(s: ReceiptSummaryInput): ReceiptSummary {
  const version = s.version ?? VERSION
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('version must be >= 1')
  if (s.rail !== RAIL_CASHU && s.rail !== RAIL_LIGHTNING) throw new Error('unknown rail')
  if (!isSafePositive(s.amount)) throw new Error('amount must be positive')
  if (s.unit == null || s.unit.trim() === '') throw new Error('unit must not be blank')
  // Java String natural order compares UTF-16 code units, as does the default JS sort.
  const mints = [...new Set(s.mints ?? [])].sort()
  if (s.rail === RAIL_CASHU && mints.length === 0) throw new Error('a cashu receipt names at least one mint')
  if (!isSafePositive(s.paidAt)) throw new Error('paidAt must be positive')
  return {
    version,
    paymentId: requireHex32(s.paymentId, 'paymentId'),
    rail: s.rail,
    payer: s.payer == null ? null : xOnly(s.payer),
    payee: xOnly(s.payee),
    amount: s.amount,
    unit: s.unit,
    mints,
    paidAt: s.paidAt,
    reference: s.reference ?? '',
    evidenceDigest: requireHex32(s.evidenceDigest, 'evidenceDigest'),
    itemsCommitment: s.itemsCommitment == null ? null : requireHex32(s.itemsCommitment, 'itemsCommitment'),
    refundOf: s.refundOf == null ? null : requireHex32(s.refundOf, 'refundOf'),
    memo: s.memo ?? '',
  }
}

export const payerIdentified = (s: ReceiptSummary): boolean => s.payer != null

/** First 8 hex characters of the payment id: the only part that may be logged (FR-048). */
export const logRef = (s: ReceiptSummary): string => s.paymentId.slice(0, 8)

/**
 * Bytes a QR body can spend on everything but the summary: payer signature (66), acknowledgement
 * (76), presenter proof (73), evidence id (34) and relay hint (66), and the summary field's own
 * header (3). A summary within `QR_BODY_LIMIT - QR_FIXED_OVERHEAD` always fits the QR.
 */
export const QR_FIXED_OVERHEAD = 320

/**
 * The memo that fits (FR-002a): at most `MAX_MEMO_BYTES`, cut on a code point and ended with an
 * ellipsis, then shortened again, or dropped, until the signed summary leaves room for the rest of
 * a QR. Applied before signing, so the receipt can always be shown.
 */
export function fitMemo(summary: ReceiptSummary, memo: string | null | undefined): string {
  let m = (memo ?? '').replace(/\s+/g, ' ').trim()
  if (m === '') return ''
  const budget = QR_BODY_LIMIT - QR_FIXED_OVERHEAD
  const fits = (x: string) => utf8(x).length <= MAX_MEMO_BYTES && encodeSummary({ ...summary, memo: x }).length <= budget
  if (fits(m)) return m
  const points = [...m]
  while (points.length > 0) {
    points.pop()
    m = points.join('').trimEnd() + '…'
    if (points.length > 0 && fits(m)) return m
  }
  return ''
}

export function encodeSummary(s: ReceiptSummary): Uint8Array {
  if (utf8(s.reference).length > MAX_REFERENCE_BYTES) {
    throw new Error(`reference longer than ${MAX_REFERENCE_BYTES} bytes`)
  }
  if (utf8(s.memo).length > MAX_MEMO_BYTES) throw new Error(`memo longer than ${MAX_MEMO_BYTES} bytes`)
  if (s.mints.length > MAX_MINTS) throw new Error(`a receipt names at most ${MAX_MINTS} mints`)
  const w = new TlvWriter()
    .varint(S.VERSION, s.version)
    .hex(S.PAYMENT_ID, s.paymentId)
    .utf8(S.RAIL, s.rail)
    .hex(S.PAYER, s.payer)
    .hex(S.PAYEE, s.payee)
    .varint(S.AMOUNT, s.amount)
    .utf8(S.UNIT, s.unit)
  for (const m of s.mints) w.utf8(S.MINT, m)
  w.varint(S.PAID_AT, s.paidAt)
  if (s.reference !== '') w.utf8(S.REFERENCE, s.reference)
  w.hex(S.EVIDENCE_DIGEST, s.evidenceDigest)
    .hex(S.ITEMS_COMMITMENT, s.itemsCommitment)
    .hex(S.REFUND_OF, s.refundOf)
  if (s.memo !== '') w.utf8(S.MEMO, s.memo)
  return w.toBytes()
}

/** Decodes a summary, ignoring unknown tags (FR-052). Throws on anything Java rejects. */
export function decodeSummary(bytes: Uint8Array): ReceiptSummary {
  let version: number | undefined
  let amount: number | undefined
  let paidAt: number | undefined
  let paymentId: string | undefined
  let rail: string | undefined
  let payer: string | null = null
  let payee: string | undefined
  let unit: string | undefined
  let reference: string | null = null
  let evidenceDigest: string | undefined
  let items: string | null = null
  let refundOf: string | null = null
  let memo: string | null = null
  const mints: string[] = []
  let lastTag = 0
  for (const f of readTlv(bytes)) {
    if (f.tag < lastTag || (f.tag === lastTag && f.tag !== S.MINT)) {
      throw new Error('summary fields out of order or repeated')
    }
    lastTag = f.tag
    switch (f.tag) {
      case S.VERSION: version = fieldVarint(f); break
      case S.PAYMENT_ID: paymentId = fieldHex(f); break
      case S.RAIL: rail = fieldUtf8(f); break
      case S.PAYER: payer = fieldHex(f); break
      case S.PAYEE: payee = fieldHex(f); break
      case S.AMOUNT: amount = fieldVarint(f); break
      case S.UNIT: unit = fieldUtf8(f); break
      case S.MINT: mints.push(fieldUtf8(f)); break
      case S.PAID_AT: paidAt = fieldVarint(f); break
      case S.REFERENCE: reference = fieldUtf8(f); break
      case S.EVIDENCE_DIGEST: evidenceDigest = fieldHex(f); break
      case S.ITEMS_COMMITMENT: items = fieldHex(f); break
      case S.REFUND_OF: refundOf = fieldHex(f); break
      case S.MEMO: memo = fieldUtf8(f); break
      default: break // unknown: tolerated, still covered by the signatures
    }
  }
  if (version === undefined || amount === undefined || paidAt === undefined) {
    throw new Error('summary is missing a required field')
  }
  if (paymentId === undefined || rail === undefined || payee === undefined || unit === undefined || evidenceDigest === undefined) {
    throw new Error('summary is missing a required field')
  }
  return makeSummary({
    version, paymentId, rail: rail as Rail, payer, payee, amount, unit, mints, paidAt, reference,
    evidenceDigest, itemsCommitment: items, refundOf, memo,
  })
}

/** The bytes a payee signs to acknowledge `s` (Java `encodeAck`). */
export function encodeAck(s: ReceiptSummary, claimedAt: number): Uint8Array {
  if (!isSafePositive(claimedAt)) throw new Error('claimedAt must be positive')
  const w = new TlvWriter()
    .hex(A.PAYMENT_ID, s.paymentId)
    .hex(A.PAYEE, s.payee)
    .hex(A.PAYER, s.payer)
    .varint(A.AMOUNT, s.amount)
    .utf8(A.UNIT, s.unit)
  for (const m of s.mints) w.utf8(A.MINT, m)
  // Unlike the summary, the ack always carries A_REFERENCE, empty when there is none.
  return w
    .utf8(A.REFERENCE, s.reference)
    .hex(A.EVIDENCE_DIGEST, s.evidenceDigest)
    .varint(A.CLAIMED_AT, claimedAt)
    .varint(A.PAID_AT, s.paidAt)
    .hex(A.ITEMS_COMMITMENT, s.itemsCommitment)
    .hex(A.REFUND_OF, s.refundOf)
    .varint(A.VERSION, s.version)
    .utf8(A.RAIL, s.rail)
    .toBytes()
}

/** `sha256(utf8(tag) || 0x00 || bytes)`. */
export function tagged(tag: string, bytes: Uint8Array): Uint8Array {
  return sha256(concatBytes(utf8(tag), Uint8Array.of(0), bytes))
}

/** Payment identity from the compressed `Y = hash_to_curve(secret)` of every proof sent. */
export function paymentId(ys: string[]): string {
  if (!ys || ys.length === 0) throw new Error('a payment has at least one proof')
  const sorted = [...new Set(ys.map((y) => y.toLowerCase()))].sort()
  const w = new TlvWriter()
  for (const y of sorted) w.hex(1, y)
  return bytesToHex(tagged(TAG_PAYMENT_ID, w.toBytes()))
}

export function lightningPaymentId(paymentHashHex: string): string {
  return bytesToHex(tagged(TAG_PAYMENT_ID, hexToBytes(paymentHashHex)))
}

export function evidenceDigest(canonicalEvidence: Uint8Array): string {
  return bytesToHex(tagged(TAG_EVIDENCE, canonicalEvidence))
}

export function presenterMessage(paymentIdHex: string, epochSeconds: number): Uint8Array {
  return new TlvWriter().hex(1, paymentIdHex).varint(2, epochSeconds).toBytes()
}

export function challengeMessage(paymentIdHex: string, nonceHex: string): Uint8Array {
  return new TlvWriter().hex(1, paymentIdHex).hex(2, nonceHex).toBytes()
}
