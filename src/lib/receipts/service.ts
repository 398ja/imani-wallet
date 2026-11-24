/**
 * Spec 049 receipts for the wallet: a port of Java `ReceiptService` (wl-receipts/wallet-core),
 * written against small ports so every rule is testable without a gateway, a mint or relays.
 *
 * The rules that matter, each from the Java service:
 *  - A receipt is BUILT only when every sent proof is SPENT at the mint (FR-003, `settle`). Until
 *    then the payment is a PENDING row holding the evidence, durable before the gateway erases its
 *    copy (`captureSendEvidence`).
 *  - A failure here never fails or delays a payment: every entry point used from pay.ts swallows.
 *  - An acknowledgement is attached only if it verifies against what this wallet sent (FR-019).
 *  - A payee acknowledges only when allowed: never unattended with a remote signer (FR-018),
 *    by default on a merchant wallet, only after the owner said yes on a personal one (FR-017).
 *  - Nothing secret is ever logged (FR-048): logs carry `paymentId.slice(0, 8)` at most.
 */
import {
  bytesToHex,
  decodeEvidence,
  decodeSummary,
  encodeEvidence,
  encodeQr,
  encodeSummary,
  evidenceDigest,
  evidenceFromSend,
  fromBase64Url,
  hashToCurveY,
  hexToBytes,
  makeSummary,
  newEvidenceKey,
  paymentId as paymentIdOf,
  PRESENTER_REFRESH_SECONDS,
  RAIL_CASHU,
  signByPayer,
  signCountersignature,
  signPresenterProof,
  toBase64Url,
  verifyCountersignature,
  verifySummary,
  withCountersignature,
  xOnly,
  encryptEvidence,
  type CashuProofEvidence,
  type Countersignature,
  type PaymentEvidence,
  type ReceiptSigner,
  type ReceiptSummary,
  type SendEvidence,
  type SignedReceipt,
  type StoredReceipt,
} from '@imani/receipts'
import type { PendingPaymentRow, PendingReason, ReceiptStore } from './store'
import { p2pkLock } from './verify'

// ---------------------------------------------------------------- ports

export type ProofState = 'UNSPENT' | 'SPENT' | 'PENDING' | 'UNKNOWN'

/** What the service needs from the outside world. Each is a seam a test replaces. */
export interface ReceiptPorts {
  store: ReceiptStore
  /** This wallet's x-only key. */
  publicKey: string
  /**
   * A signer that can sign 32-byte digests, or null when the wallet's signer cannot (a locked
   * wallet, or a NIP-07/NIP-46 signer that only signs events). Null keeps receipts pending with
   * `signer_unsupported`, never an error.
   */
  signer: () => ReceiptSigner | null
  /** Whether the signer may acknowledge with nobody present (FR-018). Local keys may. */
  mayAcknowledgeUnattended: () => boolean
  /** NUT-07: one state per Y (compressed hex), in order. Throws when the mint is unreachable. */
  checkState: (mintUrl: string, ys: string[]) => Promise<ProofState[]>
  /** Publish an encrypted evidence blob (kind 9740); returns its locator. Throws when no relay took it. */
  publishEvidence?: (blob: Uint8Array) => Promise<{ eventId: string; relayHint: string | null }>
  /** Fetch a blob by locator from the gateway nostrdb cache only; null when not there. */
  fetchEvidence?: (loc: { eventId: string; relayHint: string | null }) => Promise<Uint8Array | null>
  /** Save the receipt to the owner's backup (kind 30740). Throws when no relay took it. */
  backup?: (r: StoredReceipt) => Promise<void>
  /** Send the payee's acknowledgement DM. Throws when undelivered. */
  sendAck?: (recipient: string, envelope: AckEnvelope) => Promise<void>
  /** Closed-set telemetry count; never throws. */
  count: (event: string, outcome: string) => void
  /** Wallet kind, never inferred (FR-017). */
  walletKind: () => 'MERCHANT' | 'PERSONAL'
  /** The owner's answer to "acknowledge payments?", or null when never asked (FR-017). */
  acknowledgementSetting: () => boolean | null
  /** Epoch seconds. */
  now: () => number
  /** Fired after any write the UI shows. */
  changed: () => void
}

export interface AckEnvelope {
  t: 'imani-receipt/ack'
  v: 1
  paymentId: string
  ys: string[]
  ack: { at: number; namesPayer: boolean; sig: string }
  /** base64url of the exact summary bytes the payee signed over. */
  summary: string
}

const ref = (paymentId: string) => paymentId.slice(0, 8)
const NOT_ACKED = 'not acknowledged by the payee'
const WAITING_OWNER = "not acknowledged: waiting for the owner's answer"
const STALE_SECONDS = 24 * 3600

// ---------------------------------------------------------------- capture (payer)

/** The `send_evidence` state a COMPLETED send answers with when it carries no evidence. */
export type SendEvidenceState = 'acknowledged' | 'expired' | 'unavailable' | 'no_dleq'

export interface CaptureInput {
  sendEvidence?: SendEvidence | null
  sendEvidenceState?: SendEvidenceState | string | null
  /** The payee: the recipient pubkey of the send (or the merchant for a payment request). */
  payeeKey: string
  reference?: string | null
  /** Epoch seconds the payer sent it. */
  paidAt: number
  txId?: string
  sendId?: string
}

export type CaptureOutcome = 'captured' | 'duplicate' | 'no_receipt' | 'skipped'

/** One lock reader for the app: verify.ts's port of Java `CashuReceiptAdapter.p2pkLock`. */
const lockOf = (secret: string): string | null => {
  const k = p2pkLock(secret)
  return k == null ? null : xOnly(k)
}

/**
 * Records the evidence of a COMPLETED send as a PENDING receipt, durably (FR-003, US1). The
 * caller acks the gateway ONLY after this resolves `captured`/`duplicate`. Never throws.
 */
export async function captureSendEvidence(ports: ReceiptPorts, input: CaptureInput): Promise<CaptureOutcome> {
  try {
    if (!input.sendEvidence) {
      // no_dleq is a payment that can never have a receipt; expired/unavailable are counted by
      // the gateway, not here (telemetry contract).
      if (input.sendEvidenceState === 'no_dleq') ports.count('payment', 'none')
      return input.sendEvidenceState === 'no_dleq' ? 'no_receipt' : 'skipped'
    }
    const send = input.sendEvidence
    if (!Array.isArray(send.proofs) || send.proofs.length === 0) return 'skipped'
    const payee = xOnly(input.payeeKey)
    const evidence = evidenceFromSend(send)
    if (evidence.rail !== RAIL_CASHU) return 'skipped'
    const id = paymentIdOf(evidence.proofs.map((p) => hashToCurveY(p.secret)))
    const locked = evidence.proofs.every((p) => lockOf(p.secret) === payee)
    const allDleq = evidence.proofs.every((p) => p.dleqE && p.dleqS && p.dleqR)
    const row: PendingPaymentRow = {
      paymentId: id,
      payeeKey: payee,
      unit: send.unit,
      reference: truncate(input.reference ?? ''),
      paidAt: input.paidAt,
      evidenceHex: bytesToHex(encodeEvidence(evidence)),
      lockedToPayee: locked,
      state: allDleq ? 'PENDING_SETTLEMENT' : 'NO_RECEIPT',
      reason: allDleq ? 'awaiting_spend' : 'other',
      notes: allDleq ? [] : ['no receipt available: the mint did not provide DLEQ proofs for this payment'],
      ...(input.txId ? { txId: input.txId } : {}),
      ...(input.sendId ? { sendId: input.sendId } : {}),
    }
    const inserted = await ports.store.addPendingIfAbsent(row)
    if (!inserted) return 'duplicate'
    ports.count('payment', `${locked ? 'locked_' : ''}${allDleq ? 'dleq' : 'none'}`)
    ports.changed()
    return allDleq ? 'captured' : 'no_receipt'
  } catch (error) {
    console.warn('[receipts] send evidence not captured', (error as Error)?.name ?? 'error')
    return 'skipped'
  }
}

/** Java `truncate`: the summary refuses references over 80 UTF-8 bytes. */
function truncate(reference: string): string {
  const enc = new TextEncoder()
  if (enc.encode(reference).length <= 80) return reference
  let out = ''
  for (const ch of reference) {
    if (enc.encode(out + ch).length > 80) break
    out += ch
  }
  return out
}

// ---------------------------------------------------------------- settle (payer)

export interface SettleResult {
  built: number
  waiting: number
}

/**
 * Builds receipts for pending payments whose every proof the mint reports SPENT (Java
 * `settlePending`). Retries backups that failed. Never throws.
 */
export async function settlePending(ports: ReceiptPorts): Promise<SettleResult> {
  let built = 0
  let pendingRows: PendingPaymentRow[] = []
  try {
    pendingRows = (await ports.store.allPending()).filter((p) => p.state === 'PENDING_SETTLEMENT')
  } catch {
    return { built: 0, waiting: 0 }
  }
  for (const p of pendingRows) {
    try {
      if (await settle(ports, p.paymentId, null)) built++
    } catch (error) {
      console.warn('[receipts] settle failed', ref(p.paymentId), (error as Error)?.name ?? 'error')
    }
  }
  // Stale: counted once per payment pending more than a day.
  const now = ports.now()
  for (const p of pendingRows) {
    if (!p.staleCounted && now - p.paidAt > STALE_SECONDS) {
      const still = await ports.store.getPending(p.paymentId).catch(() => null)
      if (still?.state === 'PENDING_SETTLEMENT') {
        ports.count('pending_stale', 'ok')
        await ports.store.updatePending(p.paymentId, (x) => ({ ...x, staleCounted: true })).catch(() => null)
      }
    }
  }
  await retryBackups(ports)
  const waiting = (await ports.store.allPending().catch(() => [])).filter((p) => p.state === 'PENDING_SETTLEMENT').length
  if (built > 0) ports.changed()
  return { built, waiting }
}

/**
 * Builds one payment's receipt if every proof is spent, attaching `ack` when given and valid.
 * Java `settle`. Returns the stored receipt, or null when it cannot be built yet.
 */
export async function settle(ports: ReceiptPorts, paymentId: string, ack: Countersignature | null): Promise<StoredReceipt | null> {
  const existing = await ports.store.get(paymentId)
  if (existing) return existing.receipt
  const p = await ports.store.getPending(paymentId)
  if (!p || p.state !== 'PENDING_SETTLEMENT') return null
  const all = decodeEvidence(hexToBytes(p.evidenceHex))
  if (all.rail !== RAIL_CASHU) return null

  const spentYs = new Set<string>()
  const ysOf = new Map(all.proofs.map((x) => [x.secret, hashToCurveY(x.secret)]))
  try {
    for (const mint of [...new Set(all.proofs.map((x) => x.mint))]) {
      const ofMint = all.proofs.filter((x) => x.mint === mint)
      const ys = ofMint.map((x) => ysOf.get(x.secret)!)
      const states = await ports.checkState(mint, ys)
      if (states.length !== ys.length) throw new Error('checkstate answered for a different set')
      states.forEach((s, i) => {
        if (s === 'SPENT') spentYs.add(ys[i])
      })
    }
  } catch {
    await setReason(ports, paymentId, 'mint_unreachable')
    ports.count('settle_deferred', 'ok')
    return null
  }
  const spent = all.proofs.filter((x) => spentYs.has(ysOf.get(x.secret)!))
  // An acknowledgement kept from before the receipt could be built counts as one here too.
  const ackIn = ack ?? p.heldAck ?? null
  if (spent.length !== all.proofs.length && (ackIn == null || spent.length === 0)) {
    // FR-003: never while any proof could still be spendable, unless the payee acknowledged a
    // partial claim, and then the receipt states the acknowledged amount, never more.
    await setReason(ports, paymentId, 'awaiting_spend')
    return null
  }

  const signer = ports.signer()
  if (!signer || xOnly(signer.publicKey) !== xOnly(ports.publicKey)) {
    await setReason(ports, paymentId, 'signer_unsupported')
    return null
  }

  const evidence: PaymentEvidence = { rail: RAIL_CASHU, proofs: spent }
  const evidenceBytes = encodeEvidence(evidence)
  const summary = makeSummary({
    paymentId,
    rail: RAIL_CASHU,
    payer: signer.publicKey,
    payee: p.payeeKey,
    amount: spent.reduce((n, x) => n + x.amount, 0),
    unit: p.unit,
    mints: spent.map((x) => x.mint),
    paidAt: p.paidAt,
    reference: p.reference,
    evidenceDigest: evidenceDigest(evidenceBytes),
  })
  let signed: SignedReceipt
  try {
    signed = await signByPayer(summary, signer)
  } catch {
    await setReason(ports, paymentId, 'signer_unsupported')
    return null
  }
  let acked = ackIn
  if (acked) {
    if (!verifyCountersignature(acked, summary)) {
      await ports.store.updatePending(paymentId, (x) => ({ ...x, notes: [...x.notes, 'acknowledgement rejected: does not match the payment'] }))
      acked = null
    } else {
      signed = withCountersignature(signed, acked)
    }
  }
  const stored: StoredReceipt = {
    role: 'PAYER',
    receipt: signed,
    evidence: evidenceBytes,
    evidenceKey: newEvidenceKey(),
    locator: null,
    refunds: [],
    notes: acked ? [] : [NOT_ACKED],
    showable: p.lockedToPayee || acked != null,
  }
  const kept = await ports.store.putIfAbsent(stored, p.txId ? { txId: p.txId } : undefined)
  await ports.store.updatePending(paymentId, (x) => ({ ...x, state: 'RECEIPTED', reason: undefined, heldAck: undefined }))
  ports.count('built', acked ? 'countersigned' : 'uncountersigned')
  console.info('[receipts] built', ref(paymentId), acked ? 'countersigned' : 'payer-only')
  await saveBackup(ports, paymentId, kept)
  ports.changed()
  return kept
}

async function setReason(ports: ReceiptPorts, paymentId: string, reason: PendingReason): Promise<void> {
  await ports.store.updatePending(paymentId, (x) => (x.reason === reason ? x : { ...x, reason })).catch(() => null)
}

/** Cancel: the payer reclaimed or the send failed (FR-006). */
export async function cancelPending(ports: ReceiptPorts, paymentId: string): Promise<void> {
  const p = await ports.store.updatePending(paymentId, (x) => ({ ...x, state: 'CANCELLED', reason: 'other' })).catch(() => null)
  if (p) ports.count('payment_cancelled', 'ok')
}

// ---------------------------------------------------------------- backup

async function saveBackup(ports: ReceiptPorts, paymentId: string, r: StoredReceipt): Promise<void> {
  if (!ports.backup) return
  try {
    await ports.backup(r)
    await ports.store.update(paymentId, (x) => x, { backupPending: false })
    ports.count('backup', 'saved')
  } catch {
    // A failed save never fails the write: noted, retried by the next settle (FR-009).
    await ports.store.update(paymentId, (x) => x, { backupPending: true }).catch(() => null)
    ports.count('backup', 'deferred')
  }
}

async function retryBackups(ports: ReceiptPorts): Promise<void> {
  if (!ports.backup) return
  const all = await ports.store.all().catch(() => [])
  for (const { row, receipt } of all) {
    if (row.backupPending) await saveBackup(ports, row.paymentId, receipt)
  }
}

/** Java `StoredReceipt` merge on restore: never removes, adopts only verifying signatures. */
export function mergeRestored(mine: StoredReceipt, backup: StoredReceipt): StoredReceipt {
  let receipt = mine.receipt
  const s = decodeSummary(receipt.summaryBytes)
  if (!receipt.payerSignature && backup.receipt.payerSignature) {
    const candidate = { ...receipt, payerSignature: backup.receipt.payerSignature }
    if (verifySummary(candidate).checks.PAYER_SIGNATURE?.outcome === 'PASS') receipt = candidate
  }
  if (!receipt.countersignature && backup.receipt.countersignature && verifyCountersignature(backup.receipt.countersignature, s)) {
    receipt = { ...receipt, countersignature: backup.receipt.countersignature }
  }
  const refundKeys = new Set(mine.refunds.map((x) => bytesToHex(x.summaryBytes)))
  const refunds = [...mine.refunds, ...backup.refunds.filter((x) => !refundKeys.has(bytesToHex(x.summaryBytes)))]
  return {
    ...mine,
    receipt,
    locator: mine.locator ?? backup.locator,
    refunds,
    notes: [...new Set([...mine.notes, ...backup.notes])],
    showable: mine.showable || backup.showable || receipt.countersignature != null,
  }
}

/**
 * Brings backed-up receipts into this device (Java `restoreFromBackup`). A receipt arriving whole
 * is adopted only if its signatures verify (or it is a payee record whose own countersignature
 * does), and its bytes always match its own payment id. Never throws.
 */
export async function restoreReceipts(ports: ReceiptPorts, restored: StoredReceipt[], unreadable: number): Promise<{ added: number; merged: number }> {
  let added = 0
  let merged = 0
  for (let i = 0; i < unreadable; i++) ports.count('restore_unreadable', 'ok')
  for (const r of restored) {
    try {
      const s = decodeSummary(r.receipt.summaryBytes)
      const mine = await ports.store.get(s.paymentId)
      if (mine) {
        const next = mergeRestored(mine.receipt, r)
        await ports.store.update(s.paymentId, () => next)
        ports.count('restore_receipt', 'merged')
        merged++
        continue
      }
      if (!restorable(r, s, ports.publicKey)) continue
      await ports.store.putIfAbsent(r)
      // A pending row for it is settled now.
      await ports.store.updatePending(s.paymentId, (x) => ({ ...x, state: 'RECEIPTED', reason: undefined })).catch(() => null)
      ports.count('restore_receipt', 'added')
      added++
    } catch {
      ports.count('restore_unreadable', 'ok')
    }
  }
  ports.count('restore', 'ok')
  if (added + merged > 0) ports.changed()
  return { added, merged }
}

function restorable(r: StoredReceipt, s: ReceiptSummary, me: string): boolean {
  const meX = xOnly(me)
  const report = verifySummary(r.receipt)
  if (report.verdict === 'INVALID') {
    // A payee's own record has no payer signature yet and may have no countersignature either.
    return r.role === 'PAYEE' && s.payee === meX && report.checks.PAYEE_COUNTERSIGNATURE?.outcome !== 'FAIL'
      && report.checks.PAYER_SIGNATURE?.outcome !== 'FAIL'
  }
  return r.role === 'PAYER' ? s.payer === meX : s.payee === meX
}

// ---------------------------------------------------------------- acknowledgements (payer)

export type AckOutcome = 'attached' | 'duplicate' | 'mismatch' | 'unknown_payment' | 'not_settled'

/**
 * An incoming acknowledgement DM (Java `onAcknowledgement`). Attached only if it verifies against
 * what this wallet sent (FR-019). `author` is the DM's authenticated signer.
 */
export async function onAcknowledgement(ports: ReceiptPorts, author: string, env: AckEnvelope, source: 'message' | 'scan' = 'message'): Promise<AckOutcome> {
  const outcome = await handleAck(ports, author, env).catch((): AckOutcome => 'mismatch')
  ports.count('acknowledgement', `${source}_${outcome}`)
  if (outcome === 'attached') ports.changed()
  return outcome
}

async function handleAck(ports: ReceiptPorts, author: string, env: AckEnvelope): Promise<AckOutcome> {
  const pid = env.paymentId
  const cs: Countersignature = { claimedAt: env.ack.at, namesPayer: env.ack.namesPayer, signature: env.ack.sig.toLowerCase() }
  const stored = await ports.store.get(pid)
  if (stored) {
    if (stored.receipt.receipt.countersignature) return 'duplicate'
    const s = decodeSummary(stored.receipt.receipt.summaryBytes)
    if (xOnly(author) !== s.payee) {
      console.warn('[receipts] ack rejected', ref(pid), 'author is not the payee')
      await ports.store.update(pid, (r) => ({ ...r, notes: [...r.notes, 'acknowledgement rejected'] }))
      return 'mismatch'
    }
    if (!verifyCountersignature(cs, s)) {
      // The payee dated the payment when it claimed it, the payer when it sent it: one payment,
      // two clocks. Adopt the payee's date (re-signing) when that is the ONLY difference and the
      // date is plausible, so both signatures cover one summary.
      const adopted = await adoptPayeeDate(ports, s, env, cs)
      if (!adopted) {
        console.warn('[receipts] ack rejected', ref(pid), 'does not match the payment')
        await ports.store.update(pid, (r) => ({ ...r, notes: [...r.notes, 'acknowledgement rejected'] }))
        return 'mismatch'
      }
      const next = await ports.store.update(pid, (r) => ({
        ...r,
        receipt: withCountersignature(adopted, cs),
        showable: true,
        notes: r.notes.filter((n) => n !== NOT_ACKED),
      }))
      if (next) await saveBackup(ports, pid, next)
      return 'attached'
    }
    const next = await ports.store.update(pid, (r) => ({
      ...r,
      receipt: withCountersignature(r.receipt, cs),
      showable: true,
      notes: r.notes.filter((n) => n !== NOT_ACKED),
    }))
    if (next) await saveBackup(ports, pid, next)
    return 'attached'
  }
  const p = await ports.store.getPending(pid)
  if (!p) return 'unknown_payment'
  let claimed: ReceiptSummary
  try {
    claimed = decodeSummary(fromBase64Url(env.summary))
  } catch {
    return 'mismatch'
  }
  const sent = decodeEvidence(hexToBytes(p.evidenceHex))
  const total = sent.rail === RAIL_CASHU ? sent.proofs.reduce((n, x) => n + x.amount, 0) : 0
  const problem =
    claimed.paymentId !== pid ? 'payment identity differs'
      : claimed.payee !== p.payeeKey || xOnly(author) !== p.payeeKey ? 'signed by a different payee'
        : claimed.unit !== p.unit ? 'unit differs'
          : claimed.reference !== p.reference ? 'reference differs'
            : claimed.payer != null && claimed.payer !== xOnly(ports.publicKey) ? 'names a different payer'
              : claimed.amount > total ? 'acknowledges more than was sent'
                : !verifyCountersignature(cs, claimed) ? 'signature invalid'
                  : null
  if (problem) {
    await ports.store.updatePending(pid, (x) => ({ ...x, notes: [...x.notes, `acknowledgement rejected: ${problem}`] }))
    console.warn('[receipts] ack rejected', ref(pid), problem)
    return 'mismatch'
  }
  // Built with the payee's date when it is a plausible claim time (see adoptPayeeDate).
  if (claimed.paidAt !== p.paidAt && plausibleClaimTime(claimed.paidAt, p.paidAt, ports.now())) {
    await ports.store.updatePending(pid, (x) => ({ ...x, paidAt: claimed.paidAt }))
  }
  const built = await settle(ports, pid, cs)
  if (!built) {
    // Verified above, but the receipt cannot be built yet (mint unreachable, or a proof not yet
    // seen spent). The DM that carried it is marked processed, so keep it: settlePending attaches
    // it, re-verified, when the receipt is built.
    await ports.store.updatePending(pid, (x) => ({ ...x, heldAck: cs }))
    return 'not_settled'
  }
  return built.receipt.countersignature ? 'attached' : 'mismatch'
}

/**
 * Clock skew allowed between the two wallets when the payer adopts the payee's date. Five minutes,
 * the NIP-98 window: a phone clock further off than that fails NIP-98 already.
 */
const CLAIM_SKEW_SECONDS = 300

/**
 * A payee dates the payment when it claims it, which is after the payer sent it and not in the
 * future. Bounded on both sides so an acknowledgement cannot move the date anywhere it likes.
 */
export function plausibleClaimTime(claimedAt: number, sentAt: number, now: number): boolean {
  return Number.isSafeInteger(claimedAt) && claimedAt >= sentAt - CLAIM_SKEW_SECONDS && claimedAt <= now + CLAIM_SKEW_SECONDS
}

/**
 * The payer's receipt re-signed with the payee's date, or null. Only when the acknowledged summary
 * equals the payer's in every field but `paidAt`, that date is a plausible claim time, and the
 * countersignature verifies over it. The payer signs again, over exactly what the payee signed.
 */
async function adoptPayeeDate(ports: ReceiptPorts, mine: ReceiptSummary, env: AckEnvelope, cs: Countersignature): Promise<SignedReceipt | null> {
  let claimed: ReceiptSummary
  try {
    claimed = decodeSummary(fromBase64Url(env.summary))
  } catch {
    return null
  }
  const same = (k: keyof ReceiptSummary) => JSON.stringify(claimed[k]) === JSON.stringify(mine[k])
  const fields: Array<keyof ReceiptSummary> = ['version', 'paymentId', 'rail', 'payee', 'amount', 'unit', 'mints', 'reference', 'evidenceDigest']
  if (!fields.every(same)) return null
  // An acknowledgement that names no payer covers a summary without one; the payer's own names it.
  if (claimed.payer != null && claimed.payer !== mine.payer) return null
  if (!plausibleClaimTime(claimed.paidAt, mine.paidAt, ports.now())) return null
  const dated = makeSummary({ ...mine, paidAt: claimed.paidAt })
  if (!verifyCountersignature(cs, dated)) return null
  const signer = ports.signer()
  if (!signer || xOnly(signer.publicKey) !== xOnly(ports.publicKey)) return null
  try {
    return await signByPayer(dated, signer)
  } catch {
    return null
  }
}

/** Parses a decrypted DM body into an ack envelope, or null. Never throws, never echoes content. */
export function parseAckEnvelope(content: string): AckEnvelope | null {
  if (typeof content !== 'string' || content.length > 64 * 1024 || !content.includes('"imani-receipt/ack"')) return null
  try {
    const n = JSON.parse(content) as Partial<AckEnvelope>
    if (n?.t !== 'imani-receipt/ack' || n.v !== 1) return null
    if (typeof n.paymentId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(n.paymentId)) return null
    if (!Array.isArray(n.ys) || !n.ys.every((y) => typeof y === 'string' && /^[0-9a-fA-F]{66}$/.test(y))) return null
    const a = n.ack
    if (!a || !Number.isSafeInteger(a.at) || a.at <= 0 || typeof a.namesPayer !== 'boolean') return null
    if (typeof a.sig !== 'string' || !/^[0-9a-fA-F]{128}$/.test(a.sig)) return null
    if (typeof n.summary !== 'string' || n.summary === '') return null
    return {
      t: 'imani-receipt/ack', v: 1, paymentId: n.paymentId.toLowerCase(), ys: n.ys.map((y) => y.toLowerCase()),
      ack: { at: a.at, namesPayer: a.namesPayer, sig: a.sig.toLowerCase() }, summary: n.summary,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- claim (payee)

export interface IncomingPayment {
  /** Every proof of the token as received (the payment id is over all of them). */
  proofs: Array<{ mint?: string; id: string; amount: number; secret: string; C: string; dleq?: { e: string; s: string; r?: string | null } | null }>
  mint: string
  unit: string
  /** Authenticated payer key, or null for a bare token. */
  payerKey: string | null
  reference?: string | null
  /** Epoch seconds, or 0 for now. */
  paidAt?: number
  /** Ys of the proofs actually claimed; defaults to all. */
  claimedYs?: string[]
  txId?: string
}

export type ClaimOutcome =
  | 'acknowledged_delivered'
  | 'acknowledged_undelivered'
  | 'acknowledged_payer_unknown'
  | 'not_acknowledged'
  | 'nothing_mine'
  | 'other'

/** Java `mayAcknowledge` (FR-017, FR-018). */
function mayAcknowledge(ports: ReceiptPorts): { allowed: boolean; why: string | null } {
  if (!ports.mayAcknowledgeUnattended()) {
    return { allowed: false, why: "not acknowledged: the remote signer's policy does not allow unattended acknowledgements" }
  }
  const setting = ports.acknowledgementSetting()
  if (setting !== null) return setting ? { allowed: true, why: null } : { allowed: false, why: 'not acknowledged: acknowledgements are turned off' }
  if (ports.walletKind() === 'MERCHANT') return { allowed: true, why: null }
  return { allowed: false, why: WAITING_OWNER }
}

/**
 * Records a payment this wallet claimed as payee, and acknowledges it when allowed (Java
 * `onClaimed`). Call after the receive succeeded. Never throws.
 */
export async function onClaimed(ports: ReceiptPorts, inc: IncomingPayment): Promise<ClaimOutcome> {
  let outcome: ClaimOutcome = 'other'
  try {
    outcome = await claim(ports, inc)
  } catch (error) {
    console.warn('[receipts] claim record failed', (error as Error)?.name ?? 'error')
  }
  ports.count('claim', outcome)
  return outcome
}

async function claim(ports: ReceiptPorts, inc: IncomingPayment): Promise<ClaimOutcome> {
  const me = xOnly(ports.publicKey)
  const all: CashuProofEvidence[] = inc.proofs.map((p) => ({
    mint: p.mint ?? inc.mint, keysetId: p.id, amount: p.amount, secret: p.secret, c: p.C,
    dleqE: p.dleq?.e ?? null, dleqS: p.dleq?.s ?? null, dleqR: p.dleq?.r ?? null,
  }))
  if (all.length === 0) return 'nothing_mine'
  const allYs = all.map((p) => hashToCurveY(p.secret))
  const pid = paymentIdOf(allYs)
  const claimedSet = new Set((inc.claimedYs ?? allYs).map((y) => y.toLowerCase()))
  const mine = all.filter((p, i) => {
    if (!claimedSet.has(allYs[i])) return false
    const lock = lockOf(p.secret)
    return lock == null || lock === me // FR-016
  })
  if (mine.length === 0) return 'nothing_mine'
  const evidence: PaymentEvidence = { rail: RAIL_CASHU, proofs: mine }
  const evidenceBytes = encodeEvidence(evidence)
  const payer = inc.payerKey ? xOnly(inc.payerKey) : null
  const summary = makeSummary({
    paymentId: pid,
    rail: RAIL_CASHU,
    payer,
    payee: me,
    amount: mine.reduce((n, p) => n + p.amount, 0),
    unit: inc.unit,
    mints: mine.map((p) => p.mint),
    paidAt: inc.paidAt && inc.paidAt > 0 ? inc.paidAt : ports.now(),
    reference: truncate(inc.reference ?? ''),
    evidenceDigest: evidenceDigest(evidenceBytes),
  })
  let record: SignedReceipt = { summaryBytes: encodeSummary(summary), payerSignature: null, countersignature: null }
  const lockedToMe = mine.every((p) => lockOf(p.secret) === me)
  const d = mayAcknowledge(ports)
  let cs: Countersignature | null = null
  const signer = d.allowed ? ports.signer() : null
  let why = d.why
  if (d.allowed && signer) {
    try {
      cs = await signCountersignature(summary, ports.now(), payer != null, signer)
      record = { ...record, countersignature: cs }
    } catch {
      cs = null
      why = 'not acknowledged: the signer cannot sign receipts'
    }
  } else if (d.allowed) {
    why = 'not acknowledged: the signer cannot sign receipts'
  }
  const stored = await ports.store.putIfAbsent(
    {
      role: 'PAYEE', receipt: record, evidence: evidenceBytes, evidenceKey: newEvidenceKey(), locator: null,
      refunds: [], notes: why ? [why] : [], showable: lockedToMe || cs != null,
    },
    inc.txId ? { txId: inc.txId } : undefined,
  )
  ports.changed()
  if (!cs) return 'not_acknowledged'
  await saveBackup(ports, pid, stored)
  if (!payer) return 'acknowledged_payer_unknown'
  if (!ports.sendAck) return 'acknowledged_undelivered'
  try {
    await ports.sendAck(payer, {
      t: 'imani-receipt/ack', v: 1, paymentId: pid,
      ys: mine.map((p) => hashToCurveY(p.secret)),
      ack: { at: cs.claimedAt, namesPayer: cs.namesPayer, sig: cs.signature },
      summary: toBase64Url(record.summaryBytes),
    })
    return 'acknowledged_delivered'
  } catch {
    await ports.store.update(pid, (r) => ({ ...r, notes: [...r.notes, 'acknowledgement not delivered'] })).catch(() => null)
    return 'acknowledged_undelivered'
  }
}

// ---------------------------------------------------------------- showing (payer or payee)

export class ReceiptNotReadyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReceiptNotReadyError'
  }
}

export type EvidenceOutcome = 'published' | 'already_reachable' | 'deferred' | 'none'

/**
 * The QR text for a stored receipt with a fresh presenter proof when this wallet is the payer,
 * after making the encrypted evidence reachable (Java `show`, FR-011, FR-013, FR-022). Only on
 * the user's request (FR-045).
 */
export async function presentReceipt(ports: ReceiptPorts, paymentId: string): Promise<{ qrText: string; refreshAt: number; evidence: EvidenceOutcome }> {
  const found = await ports.store.get(paymentId)
  if (!found) throw new ReceiptNotReadyError('no receipt for this payment yet')
  const r = found.receipt
  if (!r.showable) throw new ReceiptNotReadyError('the payee has not acknowledged this payment yet, and it was not locked to the payee')
  if (r.role === 'PAYER' && !r.receipt.payerSignature) throw new ReceiptNotReadyError('receipt is not signed')
  let loc = r.locator
  let evidence: EvidenceOutcome = 'none'
  if (ports.publishEvidence) {
    try {
      const digest = decodeSummary(r.receipt.summaryBytes).evidenceDigest
      const reachable = loc != null && ports.fetchEvidence != null && (await ports.fetchEvidence(loc)) != null
      if (reachable) evidence = 'already_reachable'
      else {
        const blob = await encryptEvidence(r.evidenceKey, r.evidence, digest)
        loc = await ports.publishEvidence(blob)
        const l = loc
        await ports.store.update(paymentId, (x) => ({ ...x, locator: l }))
        evidence = 'published'
      }
    } catch {
      evidence = 'deferred'
    }
  }
  ports.count('shown', evidence)
  let presenter = null
  if (r.role === 'PAYER') {
    const signer = ports.signer()
    if (!signer) throw new ReceiptNotReadyError('the wallet is locked')
    presenter = await signPresenterProof(paymentId, ports.now(), signer)
  }
  const qrText = encodeQr({ receipt: r.receipt, presenter, evidence: loc, evidenceKey: r.evidenceKey })
  return { qrText, refreshAt: (ports.now() + PRESENTER_REFRESH_SECONDS) * 1000, evidence }
}

// ---------------------------------------------------------------- the owner's answer (FR-017)

/** Acknowledge every payee record that was waiting for the owner's yes. */
export async function acknowledgeWaiting(ports: ReceiptPorts): Promise<number> {
  const signer = ports.signer()
  if (!signer) return 0
  let done = 0
  for (const { row, receipt } of await ports.store.all()) {
    if (receipt.role !== 'PAYEE' || receipt.receipt.countersignature || !receipt.notes.includes(WAITING_OWNER)) continue
    const s = decodeSummary(receipt.receipt.summaryBytes)
    try {
      const cs = await signCountersignature(s, ports.now(), s.payer != null, signer)
      await ports.store.update(row.paymentId, (x) => ({
        ...x, receipt: { ...x.receipt, countersignature: cs }, showable: true, notes: x.notes.filter((n) => n !== WAITING_OWNER),
      }))
      if (s.payer && ports.sendAck) {
        const ev = decodeEvidence(receipt.evidence)
        await ports.sendAck(s.payer, {
          t: 'imani-receipt/ack', v: 1, paymentId: s.paymentId,
          ys: ev.rail === RAIL_CASHU ? ev.proofs.map((p) => hashToCurveY(p.secret)) : [],
          ack: { at: cs.claimedAt, namesPayer: cs.namesPayer, sig: cs.signature },
          summary: toBase64Url(receipt.receipt.summaryBytes),
        }).catch(() => undefined)
      }
      done++
    } catch {
      // next one
    }
  }
  if (done) ports.changed()
  return done
}

export { truncate }
