import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, fromBase64Url, hexToBytes, toBase64Url, utf8 } from './bytes'
import {
  challengeMessage,
  decodeSummary,
  encodeAck,
  encodeSummary,
  evidenceDigest,
  fitMemo,
  makeSummary,
  paymentId as paymentIdOf,
  payerIdentified,
  presenterMessage,
  QR_BODY_LIMIT,
  QR_PREFIX,
  RAIL_CASHU,
  RAIL_LIGHTNING,
  requireHex32,
  TAG_ACK,
  TAG_CHALLENGE,
  TAG_PAYER,
  TAG_PRESENTER,
  xOnly,
  type ReceiptSummary,
} from './format'
import { verifyTagged, type ReceiptSigner } from './signer'
import { fieldHex, fieldUtf8, fieldVarint, readTlv, TlvWriter } from './tlv'

// ---------------------------------------------------------------- countersignature

/** The payee's signature over `encodeAck(summary, claimedAt)` (Java `Countersignature`). */
export interface Countersignature {
  claimedAt: number
  /** false for a bare-token payment: the signed ack then omits the payer. */
  namesPayer: boolean
  signature: string
}

export function withoutPayer(s: ReceiptSummary): ReceiptSummary {
  return { ...s, payer: null }
}

export function countersignatureBytes(cs: Pick<Countersignature, 'claimedAt' | 'namesPayer'>, s: ReceiptSummary): Uint8Array {
  return encodeAck(cs.namesPayer ? s : withoutPayer(s), cs.claimedAt)
}

export function verifyCountersignature(cs: Countersignature, s: ReceiptSummary): boolean {
  if (cs.namesPayer && !payerIdentified(s)) return false
  try {
    return verifyTagged(TAG_ACK, countersignatureBytes(cs, s), s.payee, cs.signature)
  } catch {
    return false
  }
}

export async function signCountersignature(s: ReceiptSummary, claimedAt: number, namesPayer: boolean, payee: ReceiptSigner): Promise<Countersignature> {
  if (xOnly(payee.publicKey) !== s.payee) throw new Error('only the payee named in the receipt can acknowledge it')
  const signature = await payee.sign(TAG_ACK, countersignatureBytes({ claimedAt, namesPayer }, s))
  return { claimedAt, namesPayer, signature }
}

// ---------------------------------------------------------------- signed receipt

/** Java `SignedReceipt`: the exact summary bytes as signed, never re-encoded (FR-052). */
export interface SignedReceipt {
  summaryBytes: Uint8Array
  payerSignature: string | null
  countersignature: Countersignature | null
}

export function receiptSummary(r: SignedReceipt): ReceiptSummary {
  return decodeSummary(r.summaryBytes)
}

export function payerSignatureValid(r: SignedReceipt): boolean {
  const s = receiptSummary(r)
  return payerIdentified(s) && verifyTagged(TAG_PAYER, r.summaryBytes, s.payer, r.payerSignature)
}

export async function signByPayer(s: ReceiptSummary, payer: ReceiptSigner): Promise<SignedReceipt> {
  if (!payerIdentified(s)) throw new Error('a payer-signed receipt names its payer')
  if (xOnly(payer.publicKey) !== s.payer) throw new Error('only the payer named in the receipt can sign it')
  const bytes = encodeSummary(s)
  return { summaryBytes: bytes, payerSignature: await payer.sign(TAG_PAYER, bytes), countersignature: null }
}

export function unsignedReceipt(s: ReceiptSummary): SignedReceipt {
  if (payerIdentified(s)) throw new Error('a receipt naming its payer must be payer-signed')
  return { summaryBytes: encodeSummary(s), payerSignature: null, countersignature: null }
}

const G_SUMMARY = 1, G_PAYER_SIG = 2, G_ACK_AT = 3, G_ACK_NAMES_PAYER = 4, G_ACK_SIG = 5

/** Java `StoredReceiptCodec.encodeSigned`. */
export function encodeSignedField(r: SignedReceipt): Uint8Array {
  const w = new TlvWriter().bytes(G_SUMMARY, r.summaryBytes).hex(G_PAYER_SIG, r.payerSignature)
  const cs = r.countersignature
  if (cs) w.varint(G_ACK_AT, cs.claimedAt).varint(G_ACK_NAMES_PAYER, cs.namesPayer ? 1 : 0).hex(G_ACK_SIG, cs.signature)
  return w.toBytes()
}

/** Java `StoredReceiptCodec.decodeSigned`. */
export function decodeSignedField(bytes: Uint8Array): SignedReceipt {
  let summary: Uint8Array | null = null
  let payerSig: string | null = null, ackSig: string | null = null
  let ackAt: number | null = null
  let namesPayer = true
  for (const f of readTlv(bytes)) {
    switch (f.tag) {
      case G_SUMMARY: summary = f.value; break
      case G_PAYER_SIG: payerSig = fieldHex(f); break
      case G_ACK_AT: ackAt = fieldVarint(f); break
      case G_ACK_NAMES_PAYER: namesPayer = fieldVarint(f) !== 0; break
      case G_ACK_SIG: ackSig = fieldHex(f); break
      default: break
    }
  }
  if (!summary) throw new Error('signed receipt has no summary')
  const cs = ackAt != null && ackSig != null && ackAt > 0 ? { claimedAt: ackAt, namesPayer, signature: ackSig } : null
  return { summaryBytes: summary, payerSignature: payerSig, countersignature: cs }
}

/** At most one countersignature is kept (FR-019): an existing one is never replaced. */
export function withCountersignature(r: SignedReceipt, cs: Countersignature): SignedReceipt {
  if (r.countersignature) return r
  if (!verifyCountersignature(cs, receiptSummary(r))) throw new Error('countersignature does not verify for this receipt')
  return { ...r, countersignature: cs }
}

// ---------------------------------------------------------------- presenter

export const PRESENTER_REFRESH_SECONDS = 30
export const PRESENTER_FRESHNESS_SECONDS = 60
export const PRESENTER_MAX_FUTURE_SKEW_SECONDS = 30
export const CHALLENGE_TTL_SECONDS = 60

export type PresenterResult = 'PRESENTER_IS_PAYER' | 'PRESENTER_NOT_PROVEN' | 'NOT_CHECKED'

export const PRESENTER_LABELS: Record<PresenterResult, string> = {
  PRESENTER_IS_PAYER: 'Presenter is payer',
  PRESENTER_NOT_PROVEN: 'Presenter not proven',
  NOT_CHECKED: 'Not checked',
}

export interface PresenterProof {
  signedAt: number
  signature: string
}

export async function signPresenterProof(paymentId: string, epochSeconds: number, payer: ReceiptSigner): Promise<PresenterProof> {
  return { signedAt: epochSeconds, signature: await payer.sign(TAG_PRESENTER, presenterMessage(paymentId, epochSeconds)) }
}

/** Java `Presenter.check`. `nowSeconds` is the verifier's clock. */
export function checkPresenter(s: ReceiptSummary, proof: PresenterProof | null | undefined, nowSeconds: number): PresenterResult {
  if (!proof) return 'NOT_CHECKED'
  if (!payerIdentified(s)) return 'PRESENTER_NOT_PROVEN'
  const age = nowSeconds - proof.signedAt
  if (age > PRESENTER_FRESHNESS_SECONDS || -age > PRESENTER_MAX_FUTURE_SKEW_SECONDS) return 'PRESENTER_NOT_PROVEN'
  return verifyTagged(TAG_PRESENTER, presenterMessage(s.paymentId, proof.signedAt), s.payer, proof.signature)
    ? 'PRESENTER_IS_PAYER'
    : 'PRESENTER_NOT_PROVEN'
}

export async function answerChallenge(paymentId: string, nonceHex: string, payer: ReceiptSigner): Promise<string> {
  return payer.sign(TAG_CHALLENGE, challengeMessage(paymentId, nonceHex))
}

/** Verifies a challenge answer. Issuing, expiry and single use are the scanner's job. */
export function verifyChallengeAnswer(s: ReceiptSummary, nonceHex: string, signature: string): boolean {
  return payerIdentified(s) && verifyTagged(TAG_CHALLENGE, challengeMessage(s.paymentId, nonceHex), s.payer, signature)
}

// ---------------------------------------------------------------- evidence

export interface CashuProofEvidence {
  mint: string
  keysetId: string
  amount: number
  /** NUT-00 secret exactly as on the wire. */
  secret: string
  /** Unblinded signature, compressed point hex. */
  c: string
  dleqE?: string | null
  dleqS?: string | null
  dleqR?: string | null
}

export type PaymentEvidence =
  | { rail: typeof RAIL_CASHU; proofs: CashuProofEvidence[] }
  | { rail: typeof RAIL_LIGHTNING; invoice: string; preimage: string }

const E_RAIL = 1, E_PROOF = 2, E_INVOICE = 3, E_PREIMAGE = 4
const P_MINT = 1, P_KEYSET = 2, P_AMOUNT = 3, P_SECRET = 4, P_C = 5, P_DLEQ_E = 6, P_DLEQ_S = 7, P_DLEQ_R = 8

export const hasDleq = (p: CashuProofEvidence): boolean => p.dleqE != null && p.dleqS != null && p.dleqR != null

/** Sorted by secret (UTF-16 order, as Java `String.compareTo`), so the encoding is canonical. */
function sortedProofs(proofs: CashuProofEvidence[]): CashuProofEvidence[] {
  if (proofs.length === 0) throw new Error('evidence holds at least one proof')
  for (const p of proofs) {
    if (p.mint == null || p.keysetId == null || p.secret == null || p.c == null) throw new Error('proof is incomplete')
    if (!Number.isSafeInteger(p.amount) || p.amount <= 0) throw new Error('amount must be positive')
  }
  return [...proofs].sort((a, b) => (a.secret < b.secret ? -1 : a.secret > b.secret ? 1 : 0))
}

export function cashuEvidence(proofs: CashuProofEvidence[]): PaymentEvidence {
  return { rail: RAIL_CASHU, proofs: sortedProofs(proofs) }
}

export function encodeEvidence(e: PaymentEvidence): Uint8Array {
  if (e.rail === RAIL_LIGHTNING) {
    return new TlvWriter().utf8(E_RAIL, RAIL_LIGHTNING).utf8(E_INVOICE, e.invoice)
      .hex(E_PREIMAGE, requireHex32(e.preimage, 'preimage')).toBytes()
  }
  const w = new TlvWriter().utf8(E_RAIL, RAIL_CASHU)
  for (const p of sortedProofs(e.proofs)) {
    w.bytes(E_PROOF, new TlvWriter()
      .utf8(P_MINT, p.mint)
      .utf8(P_KEYSET, p.keysetId)
      .varint(P_AMOUNT, p.amount)
      .utf8(P_SECRET, p.secret)
      .hex(P_C, p.c)
      .hex(P_DLEQ_E, p.dleqE)
      .hex(P_DLEQ_S, p.dleqS)
      .hex(P_DLEQ_R, p.dleqR)
      .toBytes())
  }
  return w.toBytes()
}

export function decodeEvidence(bytes: Uint8Array): PaymentEvidence {
  let rail: string | undefined
  let invoice: string | undefined
  let preimage: string | undefined
  const proofs: CashuProofEvidence[] = []
  for (const f of readTlv(bytes)) {
    switch (f.tag) {
      case E_RAIL: rail = fieldUtf8(f); break
      case E_PROOF: proofs.push(decodeProof(f.value)); break
      case E_INVOICE: invoice = fieldUtf8(f); break
      case E_PREIMAGE: preimage = fieldHex(f); break
      default: break
    }
  }
  if (rail === RAIL_CASHU) return cashuEvidence(proofs)
  if (rail === RAIL_LIGHTNING) {
    if (invoice == null) throw new Error('invoice is required')
    return { rail: RAIL_LIGHTNING, invoice, preimage: requireHex32(preimage, 'preimage') }
  }
  throw new Error('unknown evidence rail')
}

function decodeProof(bytes: Uint8Array): CashuProofEvidence {
  const p: Partial<CashuProofEvidence> = { amount: 0, dleqE: null, dleqS: null, dleqR: null }
  for (const f of readTlv(bytes)) {
    switch (f.tag) {
      case P_MINT: p.mint = fieldUtf8(f); break
      case P_KEYSET: p.keysetId = fieldUtf8(f); break
      case P_AMOUNT: p.amount = fieldVarint(f); break
      case P_SECRET: p.secret = fieldUtf8(f); break
      case P_C: p.c = fieldHex(f); break
      case P_DLEQ_E: p.dleqE = fieldHex(f); break
      case P_DLEQ_S: p.dleqS = fieldHex(f); break
      case P_DLEQ_R: p.dleqR = fieldHex(f); break
      default: break
    }
  }
  if (p.mint == null || p.keysetId == null || p.secret == null || p.c == null) throw new Error('proof is incomplete')
  if (!p.amount || p.amount <= 0) throw new Error('amount must be positive')
  return p as CashuProofEvidence
}

export const evidenceDigestOf = (e: PaymentEvidence): string => evidenceDigest(encodeEvidence(e))

// ---------------------------------------------------------------- evidence cipher

const BLOB_VERSION = 1
const NONCE = 12
const TAG_BYTES = 16

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error('WebCrypto is not available')
  return s
}

export function newEvidenceKey(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32))
}

function requireKey(key: Uint8Array): void {
  if (!key || key.length !== 32) throw new Error('evidence key must be 32 bytes')
}

/**
 * AES-256-GCM, blob `version(1) || nonce(12) || ciphertext+tag`, the evidence digest's 32 raw
 * bytes as associated data (Java `EvidenceCipher`). `nonce` is for test vectors only.
 */
export async function encryptEvidence(key: Uint8Array, evidence: Uint8Array, evidenceDigestHex: string, nonce?: Uint8Array): Promise<Uint8Array> {
  requireKey(key)
  const iv = nonce ?? globalThis.crypto.getRandomValues(new Uint8Array(NONCE))
  if (iv.length !== NONCE) throw new Error('nonce must be 12 bytes')
  const k = await subtle().importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(await subtle().encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: hexToBytes(evidenceDigestHex) as BufferSource, tagLength: 128 },
    k, evidence as BufferSource))
  return concatBytes(Uint8Array.of(BLOB_VERSION), iv, ct)
}

/** Throws a detail-free error on any failure, never echoing key material (FR-043, FR-048). */
export async function decryptEvidence(key: Uint8Array, blob: Uint8Array, evidenceDigestHex: string): Promise<Uint8Array> {
  requireKey(key)
  if (!blob || blob.length < 1 + NONCE + TAG_BYTES || blob[0] !== BLOB_VERSION) throw new Error('evidence blob is malformed')
  try {
    const k = await subtle().importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt'])
    return new Uint8Array(await subtle().decrypt(
      { name: 'AES-GCM', iv: blob.slice(1, 1 + NONCE), additionalData: hexToBytes(evidenceDigestHex) as BufferSource, tagLength: 128 },
      k, blob.slice(1 + NONCE)))
  } catch {
    throw new Error('evidence could not be decrypted')
  }
}

// ---------------------------------------------------------------- QR payload

export interface EvidenceLocator {
  eventId: string
  relayHint: string | null
}

export const MAX_RELAY_HINT = 64

export function makeLocator(eventId: string, relayHint?: string | null): EvidenceLocator {
  let hint = relayHint ?? null
  if (hint != null) {
    if (hint.trim() === '') hint = null
    else if (!hint.startsWith('wss://') && !hint.startsWith('ws://')) throw new Error('relayHint must be a websocket URL')
    else if (hint.length > MAX_RELAY_HINT) hint = null
  }
  return { eventId: requireHex32(eventId, 'eventId'), relayHint: hint }
}

export interface QrPayload {
  receipt: SignedReceipt
  presenter: PresenterProof | null
  evidence: EvidenceLocator | null
  /** 32 bytes, carried after `#` so it never reaches a server. */
  evidenceKey: Uint8Array | null
}

const Q_SUMMARY = 1, Q_PAYER_SIG = 2, Q_ACK_AT = 3, Q_ACK_NAMES_PAYER = 4, Q_ACK_SIG = 5
const Q_PRESENTER_AT = 6, Q_PRESENTER_SIG = 7, Q_EVIDENCE_ID = 8, Q_EVIDENCE_RELAY = 9

export function qrBody(q: QrPayload): Uint8Array {
  const w = new TlvWriter().bytes(Q_SUMMARY, q.receipt.summaryBytes).hex(Q_PAYER_SIG, q.receipt.payerSignature)
  const cs = q.receipt.countersignature
  if (cs) w.varint(Q_ACK_AT, cs.claimedAt).varint(Q_ACK_NAMES_PAYER, cs.namesPayer ? 1 : 0).hex(Q_ACK_SIG, cs.signature)
  if (q.presenter) w.varint(Q_PRESENTER_AT, q.presenter.signedAt).hex(Q_PRESENTER_SIG, q.presenter.signature)
  if (q.evidence) w.hex(Q_EVIDENCE_ID, q.evidence.eventId).utf8(Q_EVIDENCE_RELAY, q.evidence.relayHint)
  const body = w.toBytes()
  if (body.length > QR_BODY_LIMIT) throw new Error(`receipt QR body exceeds ${QR_BODY_LIMIT} bytes`)
  return body
}

export function encodeQr(q: QrPayload): string {
  if (q.evidenceKey && q.evidenceKey.length !== 32) throw new Error('evidence key must be 32 bytes')
  const text = QR_PREFIX + toBase64Url(qrBody(q))
  return q.evidenceKey ? `${text}#${toBase64Url(q.evidenceKey)}` : text
}

/** Parses QR text. Unknown body tags are ignored (FR-052). */
export function decodeQr(text: string): QrPayload {
  let t = text.trim()
  if (!t.startsWith(QR_PREFIX)) throw new Error('not a receipt payload')
  t = t.slice(QR_PREFIX.length)
  let key: Uint8Array | null = null
  const hash = t.indexOf('#')
  if (hash >= 0) {
    const k = t.slice(hash + 1)
    t = t.slice(0, hash)
    if (k !== '') key = fromBase64Url(k)
  }
  if (key && key.length !== 32) throw new Error('evidence key must be 32 bytes')
  let body: Uint8Array
  try {
    body = fromBase64Url(t)
  } catch {
    throw new Error('receipt payload is not valid base64url')
  }
  if (body.length > QR_BODY_LIMIT * 4) throw new Error('receipt payload too large')
  let summary: Uint8Array | null = null
  let payerSig: string | null = null, ackSig: string | null = null, presSig: string | null = null
  let evId: string | null = null, evRelay: string | null = null
  let ackAt: number | null = null, presAt: number | null = null
  let namesPayer = true
  for (const f of readTlv(body)) {
    switch (f.tag) {
      case Q_SUMMARY: summary = f.value; break
      case Q_PAYER_SIG: payerSig = fieldHex(f); break
      case Q_ACK_AT: ackAt = fieldVarint(f); break
      case Q_ACK_NAMES_PAYER: namesPayer = fieldVarint(f) !== 0; break
      case Q_ACK_SIG: ackSig = fieldHex(f); break
      case Q_PRESENTER_AT: presAt = fieldVarint(f); break
      case Q_PRESENTER_SIG: presSig = fieldHex(f); break
      case Q_EVIDENCE_ID: evId = fieldHex(f); break
      case Q_EVIDENCE_RELAY: evRelay = fieldUtf8(f); break
      default: break
    }
  }
  if (!summary) throw new Error('receipt payload has no summary')
  if (ackAt != null && ackAt <= 0) throw new Error('claimedAt must be positive')
  const cs = ackAt != null && ackSig != null ? { claimedAt: ackAt, namesPayer, signature: ackSig } : null
  const presenter = presAt != null && presSig != null ? { signedAt: presAt, signature: presSig } : null
  const evidence = evId != null ? makeLocator(evId, evRelay) : null
  return { receipt: { summaryBytes: summary, payerSignature: payerSig, countersignature: cs }, presenter, evidence, evidenceKey: key }
}

// ---------------------------------------------------------------- offline verification

export type Check =
  | 'PAYER_SIGNATURE' | 'PAYEE_COUNTERSIGNATURE' | 'EVIDENCE_DIGEST' | 'MINT_SIGNATURE_DLEQ' | 'PAYEE_LOCK'
  | 'AMOUNT' | 'SPENT_STATE' | 'LIGHTNING_INVOICE' | 'LIGHTNING_PREIMAGE' | 'TIMESTAMP'

/** Java enum order, which is the order a report lists its checks in. */
export const CHECK_ORDER: Check[] = [
  'PAYER_SIGNATURE', 'PAYEE_COUNTERSIGNATURE', 'EVIDENCE_DIGEST', 'MINT_SIGNATURE_DLEQ', 'PAYEE_LOCK',
  'AMOUNT', 'SPENT_STATE', 'LIGHTNING_INVOICE', 'LIGHTNING_PREIMAGE', 'TIMESTAMP',
]

export type Outcome = 'PASS' | 'FAIL' | 'UNAVAILABLE' | 'ABSENT' | 'NOT_CHECKED' | 'PENDING' | 'SELF_ASSERTED' | 'ANCHORED'
export type Verdict = 'VERIFIED' | 'VERIFIED_OFFLINE' | 'VERIFIED_SUMMARY_ONLY' | 'UNACKNOWLEDGED' | 'INVALID'

export const VERDICT_LABELS: Record<Verdict, string> = {
  VERIFIED: 'Verified',
  VERIFIED_OFFLINE: 'Verified offline',
  VERIFIED_SUMMARY_ONLY: 'Verified (summary only)',
  UNACKNOWLEDGED: 'Unacknowledged',
  INVALID: 'Invalid',
}

export interface CheckResult {
  outcome: Outcome
  reason: string | null
}

export interface VerificationReport {
  checks: Partial<Record<Check, CheckResult>>
  verdict: Verdict
  warnings: string[]
  presenter: PresenterResult
  summary: ReceiptSummary | null
}

/** How the presenter is judged (Java `ReceiptVerifier.PresenterInput`). */
export type PresenterInput =
  | { kind: 'none' }
  | { kind: 'qr'; proof: PresenterProof }
  | { kind: 'signedDelivery'; authorKey: string }
  | { kind: 'challenged'; result: PresenterResult }

export interface TimestampAnchor {
  status: 'ANCHORED' | 'PENDING' | 'NONE'
  provenBy?: number | null
}

export interface VerifyOptions {
  /** Verifier's clock, epoch seconds. Defaults to now. */
  nowSeconds?: number
  /** Timestamp anchor lookup; defaults to none, so TIMESTAMP is SELF_ASSERTED. */
  anchor?: (paymentId: string) => TimestampAnchor
}

const r = (outcome: Outcome, reason: string | null = null): CheckResult => ({ outcome, reason })

function presenterOutcome(s: ReceiptSummary, input: PresenterInput | null | undefined, now: number): PresenterResult {
  if (!input || input.kind === 'none') return 'NOT_CHECKED'
  if (input.kind === 'qr') return checkPresenter(s, input.proof, now)
  if (input.kind === 'signedDelivery') {
    try {
      return payerIdentified(s) && input.authorKey != null && xOnly(input.authorKey) === s.payer
        ? 'PRESENTER_IS_PAYER' : 'PRESENTER_NOT_PROVEN'
    } catch {
      return 'PRESENTER_NOT_PROVEN'
    }
  }
  return input.result
}

function timestampCheck(s: ReceiptSummary, anchor?: VerifyOptions['anchor']): CheckResult {
  let a: TimestampAnchor
  try {
    a = anchor ? anchor(s.paymentId) : { status: 'NONE' }
  } catch {
    return r('UNAVAILABLE', 'timestamp service unreachable')
  }
  if (a.status === 'ANCHORED') return r('ANCHORED', `existed no later than ${a.provenBy}`)
  if (a.status === 'PENDING') return r('PENDING', "anchor not yet confirmed; date is the parties' claim")
  return r('SELF_ASSERTED', "date is the parties' claim")
}

/** Offline: the summary and signatures only (Java `ReceiptVerifier.verifySummary`, FR-014). */
export function verifySummary(receipt: SignedReceipt, presenter: PresenterInput = { kind: 'none' }, opts: VerifyOptions = {}): VerificationReport {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  const checks: Partial<Record<Check, CheckResult>> = {}
  const warnings: string[] = []
  let s: ReceiptSummary
  try {
    s = receiptSummary(receipt)
  } catch {
    checks.PAYER_SIGNATURE = r('FAIL', 'summary is malformed')
    return { checks, verdict: 'INVALID', warnings, presenter: 'NOT_CHECKED', summary: null }
  }

  if (!payerIdentified(s)) checks.PAYER_SIGNATURE = r('ABSENT', 'payer was not identified')
  else if (receipt.payerSignature == null) checks.PAYER_SIGNATURE = r('FAIL', 'payer signature missing')
  else checks.PAYER_SIGNATURE = payerSignatureValid(receipt) ? r('PASS') : r('FAIL', 'signature invalid')

  const cs = receipt.countersignature
  let countersigned = false
  if (!cs) {
    checks.PAYEE_COUNTERSIGNATURE = r('ABSENT', 'not acknowledged by the payee')
  } else if (verifyCountersignature(cs, s)) {
    countersigned = true
    checks.PAYEE_COUNTERSIGNATURE = r('PASS')
    if (!cs.namesPayer && payerIdentified(s)) warnings.push('the payee acknowledged the payment without identifying the payer')
  } else {
    checks.PAYEE_COUNTERSIGNATURE = r('FAIL', 'countersignature invalid')
  }

  for (const c of ['EVIDENCE_DIGEST', 'MINT_SIGNATURE_DLEQ', 'PAYEE_LOCK', 'AMOUNT', 'SPENT_STATE'] as const) {
    checks[c] = r('NOT_CHECKED')
  }
  checks.TIMESTAMP = timestampCheck(s, opts.anchor)

  let verdict: Verdict
  if (Object.values(checks).some((c) => c?.outcome === 'FAIL')) verdict = 'INVALID'
  else {
    const payerSigned = checks.PAYER_SIGNATURE?.outcome === 'PASS'
    if (!payerSigned && !countersigned) verdict = 'INVALID'
    else verdict = payerSigned && countersigned ? 'VERIFIED_SUMMARY_ONLY' : 'UNACKNOWLEDGED'
  }
  if (verdict !== 'INVALID' && !countersigned) warnings.push('not acknowledged by the payee')
  return { checks, verdict, warnings, presenter: presenterOutcome(s, presenter, now), summary: s }
}

/** Offline check of a scanned QR payload, using its own presenter proof. */
export function verifyQrSummary(q: QrPayload, opts: VerifyOptions = {}): VerificationReport {
  return verifySummary(q.receipt, q.presenter ? { kind: 'qr', proof: q.presenter } : { kind: 'none' }, opts)
}

/**
 * Offline checks on evidence already in hand: the digest, amount and mint membership. The
 * mint-backed checks (DLEQ, spent state, payee lock) need a Cashu port and are not ported here.
 */
export function checkEvidenceOffline(s: ReceiptSummary, e: PaymentEvidence): { digest: CheckResult; amount: CheckResult } {
  const digest = evidenceDigestOf(e) === s.evidenceDigest ? r('PASS') : r('FAIL', 'evidence does not match the signed digest')
  if (e.rail !== s.rail) return { digest: r('FAIL', 'evidence is for a different payment rail'), amount: r('NOT_CHECKED') }
  if (e.rail !== RAIL_CASHU) return { digest, amount: r('UNAVAILABLE', 'no invoice decoder configured') }
  const total = e.proofs.reduce((n, p) => n + p.amount, 0)
  let problem: string | null = null
  if (!Number.isSafeInteger(total) || total !== s.amount) {
    problem = `amount altered: evidence sums to ${Number.isSafeInteger(total) ? total : -1}, receipt states ${s.amount}`
  }
  for (const p of e.proofs) if (!s.mints.includes(p.mint)) problem = 'evidence names a mint the receipt does not'
  return { digest, amount: problem ? r('FAIL', problem) : r('PASS') }
}

// ---------------------------------------------------------------- building a payer receipt

/** A proof as gateway-core returns it in `send_evidence`. */
export interface GatewayProof {
  mint?: string
  id: string
  amount: number
  secret: string
  C: string
  dleq?: { e: string; s: string; r?: string | null } | null
}

/** gateway-core `send_evidence`: the proofs a payment sent. */
export interface SendEvidence {
  mint: string
  unit: string
  proofs: GatewayProof[]
}

const DOMAIN_SEPARATOR = utf8('Secp256k1_HashToCurve_Cashu_')

/** NUT-00 `hash_to_curve` of a secret string, compressed hex: the `Y` a mint checks state by. */
export function hashToCurveY(secret: string): string {
  const msgHash = sha256(concatBytes(DOMAIN_SEPARATOR, utf8(secret)))
  const counter = new Uint8Array(4)
  for (let i = 0; i < 2 ** 16; i++) {
    new DataView(counter.buffer).setUint32(0, i, true)
    const candidate = concatBytes(Uint8Array.of(0x02), sha256(concatBytes(msgHash, counter)))
    try {
      return secp256k1.Point.fromHex(bytesToHex(candidate)).toHex(true)
    } catch {
      // not on the curve: next counter
    }
  }
  throw new Error('no valid point found')
}

export function evidenceFromSend(send: SendEvidence): PaymentEvidence {
  return cashuEvidence(send.proofs.map((p) => ({
    mint: p.mint ?? send.mint,
    keysetId: p.id,
    amount: p.amount,
    secret: p.secret,
    c: p.C,
    dleqE: p.dleq?.e ?? null,
    dleqS: p.dleq?.s ?? null,
    dleqR: p.dleq?.r ?? null,
  })))
}

export interface PayerReceipt {
  summary: ReceiptSummary
  receipt: SignedReceipt
  evidence: PaymentEvidence
  evidenceBytes: Uint8Array
}

/**
 * Builds and payer-signs the receipt for a Cashu payment the wallet just sent. The payment id is
 * derived from the Ys of every proof sent, so payer and payee agree on it with no extra message.
 */
export async function buildPayerReceipt(
  send: SendEvidence,
  payeeKey: string,
  reference: string | null | undefined,
  paidAt: number,
  signer: ReceiptSigner,
  memo?: string | null,
): Promise<PayerReceipt> {
  if (!send.proofs?.length) throw new Error('a payment has at least one proof')
  const evidence = evidenceFromSend(send)
  if (evidence.rail !== RAIL_CASHU) throw new Error('unreachable')
  const evidenceBytes = encodeEvidence(evidence)
  const bare = makeSummary({
    paymentId: paymentIdOf(evidence.proofs.map((p) => hashToCurveY(p.secret))),
    rail: RAIL_CASHU,
    payer: signer.publicKey,
    payee: payeeKey,
    amount: evidence.proofs.reduce((n, p) => n + p.amount, 0),
    unit: send.unit,
    mints: evidence.proofs.map((p) => p.mint),
    paidAt,
    reference,
    evidenceDigest: evidenceDigest(evidenceBytes),
  })
  const summary = { ...bare, memo: fitMemo(bare, memo) }
  return { summary, receipt: await signByPayer(summary, signer), evidence, evidenceBytes }
}
