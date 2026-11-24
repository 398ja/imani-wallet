import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hashToCurve, pointFromHex } from '@cashu/crypto/modules/common'
import { verifyDLEQProof_reblind } from '@cashu/crypto/modules/client/NUT12'
import {
  CHECK_ORDER,
  QR_PREFIX,
  RAIL_CASHU,
  decodeEvidence,
  decodeQr,
  decryptEvidence,
  evidenceDigestOf,
  hexToBytes,
  verifySummary,
  xOnly,
  type Check,
  type CheckResult,
  type CashuProofEvidence,
  type PaymentEvidence,
  type PresenterResult,
  type QrPayload,
  type ReceiptSummary,
  type VerificationReport,
  type Verdict,
} from '@imani/receipts'
import { verifyVoucher, voucherOfSecret } from '../voucherToken'
import { allowedIssuerKeys } from '../issuerAllowlist'
import { repeatOutcome, type PriorCheck } from './checks'

/**
 * Verifying a scanned receipt (spec 049 US2 to US4): the TypeScript port of wallet-core
 * `ReceiptVerifier.verifyFull`, plus the merchant's "is this in my records" check (FR-030).
 *
 * Every check reports an outcome, never an exception (FR-044). Bad input is an `invalid`
 * verdict. The mint is reached only for keys (DLEQ) and spent state (NUT-07), evidence only
 * through the gateway's nostrdb cache, never a relay.
 *
 * Nothing here logs a proof, a secret, a key or the QR text.
 */

export type MintState = 'UNSPENT' | 'SPENT' | 'PENDING'

/** One proof state from NUT-07, with the spend witness when the mint gives it. */
export interface SpentState {
  state: MintState
  witness: string | null
}

/** Everything the verifier needs from outside. Each is a seam a test replaces. */
export interface VerifyPorts {
  /** This wallet's x-only key, to say whether the receipt is to or from us. */
  publicKey: () => string | null
  /** The keyset's amount-to-pubkey map and unit, or null when the mint has no such keyset. Throws when unreachable. */
  keyset: (mintUrl: string, keysetId: string) => Promise<{ unit: string; keys: Record<string, string> } | null>
  /** NUT-07, in order. Throws when the mint is unreachable. */
  checkState: (mintUrl: string, ys: string[]) => Promise<SpentState[]>
  /** The encrypted evidence blob by event id, from the gateway nostrdb cache only. Null when absent. Throws when unreachable. */
  fetchEvidence: (eventId: string) => Promise<Uint8Array | null>
  /**
   * The merchant's own record of this payment (FR-030), when this wallet is the payee. The face
   * value comes from the wallet's transaction row and is display only, never signed.
   */
  ownRecord: (paymentId: string) => Promise<{ face?: { value: number; unit: string; decimals: number }; memo?: string } | null | 'no_records'>
  /**
   * Spec 049 FR-027a-d: record this check of a payment paid to `payee` and return the earlier
   * ones. Optional: a verifier with no memory (tests, a third party) passes nothing.
   */
  remember?: (payee: string, paymentId: string, paidAt: number) => Promise<{ prior: PriorCheck[]; known: boolean; record: 'published' | 'deferred' | null }>
  /** Whether a mint URL may be contacted at all: only mints this build trusts. */
  mintAllowed: (mintUrl: string) => boolean
  /** Closed-set telemetry; never throws. */
  count: (event: string, outcome: string) => void
  /** Epoch seconds. */
  now: () => number
}

export type CheckOutcome = { check: Check; ok: boolean | null; detail?: string }

export interface VerifyResult {
  verdict: 'verified' | 'verified_offline' | 'verified_summary_only' | 'unacknowledged' | 'invalid'
  checks: CheckOutcome[]
  summary?: {
    amount: number
    unit: string
    payee: string
    payer?: string
    paidAt: number
    reference?: string
    mints: string[]
  }
  presenter: PresenterResult
  mint: 'confirmed' | 'not_valid' | 'unreachable' | 'not_checked'
  mine: 'payee' | 'payer' | 'neither'
  records?: 'found_in_records' | 'not_in_records'
  face?: { value: number; unit: string; decimals: number }
  /**
   * What the payment was for: the memo the payer signed into the receipt (FR-002a), shown on every
   * scanner, a till too; else the payee's own record's memo (FR-027f). Absent on an invalid receipt.
   */
  memo?: string
  /**
   * FR-027b: earlier checks of this payment by the payee's devices, oldest first. Absent when this
   * is not a payment to me, or when nothing could be known (offline, no history): never "first".
   */
  priorChecks?: PriorCheck[]
  /**
   * FR-027d: whether the earlier checks could be looked up. `unknown` (offline, or the history
   * could not be read whole) must never be shown as a first check. Absent when not paid to me.
   */
  history?: 'known' | 'unknown'
  warnings: string[]
}

/**
 * Whether the card says "paid to you / this stall". One predicate for the card and the check
 * record (FR-027a), so a receipt is remembered exactly when it was accepted as paid.
 */
export function isPaidToMe(r: Pick<VerifyResult, 'verdict' | 'mine' | 'mint' | 'records'>): boolean {
  if (r.verdict === 'invalid' || r.mine !== 'payee' || r.mint === 'not_valid') return false
  if (r.records === 'found_in_records') return true
  // The mint saying "spent" ties the spend to the payee only with a countersignature or a payee lock.
  return r.mint === 'confirmed' && (r.verdict === 'verified' || r.verdict === 'verified_offline')
}

/** `imrc1:` prefix, case-insensitive, after trimming. */
export function isReceiptQr(text: string): boolean {
  return typeof text === 'string' && text.trim().toLowerCase().startsWith(QR_PREFIX)
}

const r = (outcome: CheckResult['outcome'], reason: string | null = null): CheckResult => ({ outcome, reason })

const VERDICT: Record<Verdict, VerifyResult['verdict']> = {
  VERIFIED: 'verified',
  VERIFIED_OFFLINE: 'verified_offline',
  VERIFIED_SUMMARY_ONLY: 'verified_summary_only',
  UNACKNOWLEDGED: 'unacknowledged',
  INVALID: 'invalid',
}

/**
 * NUT-11 P2PK lock of a secret: the x-only data key, or null when the secret is not locked to
 * exactly one key. Java `CashuReceiptAdapter.p2pkLock`: `P2PK_VOUCHER` is locked exactly like
 * `P2PK` (the mint runs the NUT-11 condition on its data key). A multisig lock (extra `pubkeys`, or
 * `n_sigs` above 1) does not bind the payment to the payee alone, so it is not a payee lock.
 */
export function p2pkLock(secret: string): string | null {
  if (typeof secret !== 'string' || !secret.trim().startsWith('[')) return null
  try {
    const parsed = JSON.parse(secret) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const kind = String(parsed[0])
    if (kind !== 'P2PK' && kind !== 'P2PK_VOUCHER') return null
    const body = parsed[1] as { data?: unknown; tags?: unknown } | null
    if (!body || typeof body !== 'object' || typeof body.data !== 'string') return null
    const data = body.data.toLowerCase()
    if (!/^(0[23][0-9a-f]{64}|[0-9a-f]{64})$/.test(data)) return null
    if (body.tags !== undefined && body.tags !== null) {
      if (!Array.isArray(body.tags)) return null
      for (const tag of body.tags) {
        if (!Array.isArray(tag) || tag.length === 0) return null
        const name = String(tag[0])
        if (name === 'pubkeys' && tag.length > 1) return null
        if (name === 'n_sigs') {
          if (tag.length < 2) return null
          const n = Number.parseInt(String(tag[1]).trim(), 10)
          if (!Number.isFinite(n) || n > 1) return null
        }
      }
    }
    return xOnly(data)
  } catch {
    return null
  }
}

/** Java `CashuReceiptAdapter.witnessSignedBy`: a NUT-11 witness signature by `key` over sha256(secret). */
export function witnessSignedBy(secret: string, witnessJson: string | null, key: string): boolean {
  if (!witnessJson) return false
  try {
    const sigs = (JSON.parse(witnessJson) as { signatures?: unknown }).signatures
    if (!Array.isArray(sigs)) return false
    const digest = sha256(new TextEncoder().encode(secret))
    const pub = hexToBytes(xOnly(key))
    return sigs.some((s) => {
      if (typeof s !== 'string') return false
      try {
        const sig = hexToBytes(s)
        return sig.length === 64 && schnorr.verify(sig, digest, pub)
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

/** NUT-12 DLEQ with the blinding factor (`r`), against the keyset's key for this amount. */
export function dleqValid(p: CashuProofEvidence, mintKey: string): boolean {
  if (!p.dleqE || !p.dleqS || !p.dleqR) return false
  try {
    return verifyDLEQProof_reblind(
      new TextEncoder().encode(p.secret),
      { e: hexToBytes(p.dleqE), s: hexToBytes(p.dleqS), r: BigInt('0x' + p.dleqR) },
      pointFromHex(p.c),
      pointFromHex(mintKey),
    )
  } catch {
    return false
  }
}

const yOf = (secret: string): string => hashToCurve(new TextEncoder().encode(secret)).toHex(true)

async function fetchEvidence(ports: VerifyPorts, q: QrPayload, warnings: string[]): Promise<PaymentEvidence | null> {
  if (!q.evidence || !q.evidenceKey) {
    warnings.push('the code carries no evidence link')
    return null
  }
  let blob: Uint8Array | null
  try {
    blob = await ports.fetchEvidence(q.evidence.eventId)
  } catch {
    warnings.push('evidence store unreachable')
    return null
  }
  if (!blob) {
    warnings.push('evidence is no longer obtainable; ask the payer to show the receipt again')
    return null
  }
  try {
    const s = decodeQrSummary(q)
    const plain = await decryptEvidence(q.evidenceKey, blob, s.evidenceDigest)
    return decodeEvidence(plain)
  } catch {
    warnings.push("evidence could not be decrypted with this code's key")
    return null
  }
}

function decodeQrSummary(q: QrPayload): ReceiptSummary {
  const report = verifySummary(q.receipt)
  if (!report.summary) throw new Error('summary is malformed')
  return report.summary
}

/** Java `checkCashu`: amount, mint membership, payee lock, DLEQ, spent state. Returns whether every proof is locked to the payee. */
async function checkCashu(
  ports: VerifyPorts,
  s: ReceiptSummary,
  proofs: CashuProofEvidence[],
  checks: Partial<Record<Check, CheckResult>>,
  warnings: string[],
): Promise<boolean> {
  let total = 0
  for (const p of proofs) total += p.amount
  let amountProblem: string | null =
    total !== s.amount ? `amount altered: evidence sums to ${total}, receipt states ${s.amount}` : null
  for (const p of proofs) if (!s.mints.includes(p.mint)) amountProblem = 'evidence names a mint the receipt does not'

  let lockedToPayee = 0
  let lockedElsewhere = false
  for (const p of proofs) {
    const lock = p2pkLock(p.secret)
    if (lock == null) continue
    if (lock === s.payee) lockedToPayee++
    else lockedElsewhere = true
  }
  const allLocked = lockedToPayee === proofs.length
  if (lockedElsewhere) checks.PAYEE_LOCK = r('FAIL', 'paid to a different payee')
  else if (allLocked) checks.PAYEE_LOCK = r('PASS')
  else if (lockedToPayee > 0) checks.PAYEE_LOCK = r('FAIL', 'only some proofs are locked to the payee')
  else checks.PAYEE_LOCK = r('ABSENT', 'payment not locked to the payee')

  // A receipt naming a mint this build does not trust is never contacted: its "spent" answer
  // would be the issuer vouching for itself.
  const untrusted = proofs.some((p) => !ports.mintAllowed(p.mint))

  // DLEQ: always runs (FR-040). Missing DLEQ is a failure, not a skip.
  const keysets = new Map<string, { unit: string; keys: Record<string, string> } | null>()
  let dleqUnavailable = false
  let dleqFailure: string | null = null
  for (const p of proofs) {
    if (!p.dleqE || !p.dleqS || !p.dleqR) {
      dleqFailure = 'a proof carries no DLEQ proof'
      break
    }
    if (untrusted) {
      dleqUnavailable = true
      continue
    }
    const k = `${p.mint}|${p.keysetId}`
    if (!keysets.has(k)) {
      try {
        keysets.set(k, await ports.keyset(p.mint, p.keysetId))
      } catch {
        keysets.set(k, null)
      }
    }
    const ks = keysets.get(k)
    if (!ks) {
      dleqUnavailable = true
      continue
    }
    if (ks.unit !== s.unit) amountProblem = `unit altered: evidence is in ${ks.unit}, receipt states ${s.unit}`
    const key = ks.keys[String(p.amount)]
    if (!key) {
      dleqFailure = "a proof's amount is not a denomination of its keyset"
      break
    }
    if (!dleqValid(p, key)) {
      dleqFailure = 'mint signature (DLEQ) invalid'
      break
    }
  }
  if (dleqFailure) checks.MINT_SIGNATURE_DLEQ = r('FAIL', dleqFailure)
  else if (dleqUnavailable) checks.MINT_SIGNATURE_DLEQ = r('UNAVAILABLE', untrusted ? 'mint not trusted by this wallet' : 'keyset not obtainable from the mint')
  else checks.MINT_SIGNATURE_DLEQ = r('PASS')
  checks.AMOUNT = amountProblem ? r('FAIL', amountProblem) : r('PASS')

  // Spent state, per mint.
  const byMint = new Map<string, CashuProofEvidence[]>()
  for (const p of proofs) byMint.set(p.mint, [...(byMint.get(p.mint) ?? []), p])
  let unavailable = untrusted
  let pending = false
  let spentFailure: string | null = null
  if (!untrusted) {
    for (const [mint, group] of byMint) {
      let states: SpentState[]
      try {
        states = await ports.checkState(mint, group.map((p) => yOf(p.secret)))
      } catch {
        unavailable = true
        continue
      }
      if (states.length !== group.length) {
        unavailable = true
        continue
      }
      states.forEach((st, i) => {
        const p = group[i]
        if (st.state === 'UNSPENT') spentFailure = 'the mint reports a proof unspent'
        else if (st.state === 'PENDING') pending = true
        else if (allLocked && st.witness != null && !witnessSignedBy(p.secret, st.witness, s.payee)) {
          spentFailure = spentFailure ?? "the proofs were not spent by the payee's key"
        }
      })
    }
  }
  if (spentFailure) {
    checks.SPENT_STATE = r('FAIL', spentFailure)
    if ((spentFailure as string).includes('unspent')) {
      warnings.push('this receipt exposes spendable value: anyone holding it can spend the unspent proofs')
    }
  } else if (unavailable) checks.SPENT_STATE = r('UNAVAILABLE', untrusted ? 'mint not trusted by this wallet' : 'mint unreachable')
  else if (pending) checks.SPENT_STATE = r('PENDING', 'the mint reports a spend in progress')
  else checks.SPENT_STATE = r('PASS')
  return allLocked
}

const isUnavailable = (c?: CheckResult) => c != null && (c.outcome === 'UNAVAILABLE' || c.outcome === 'PENDING')

/** Java `ReceiptVerifier.verdict`. */
function verdictOf(checks: Partial<Record<Check, CheckResult>>, evidenceChecked: boolean, countersigned: boolean, payeeBound: boolean): Verdict {
  if (Object.values(checks).some((c) => c?.outcome === 'FAIL')) return 'INVALID'
  const payerSigned = checks.PAYER_SIGNATURE?.outcome === 'PASS'
  if (!payerSigned && !countersigned) return 'INVALID'
  if (!evidenceChecked) return payerSigned && countersigned ? 'VERIFIED_SUMMARY_ONLY' : 'UNACKNOWLEDGED'
  if (!countersigned && !payeeBound) return 'UNACKNOWLEDGED'
  const offline = isUnavailable(checks.SPENT_STATE) || isUnavailable(checks.MINT_SIGNATURE_DLEQ)
  return offline ? 'VERIFIED_OFFLINE' : 'VERIFIED'
}

/** Full verification of a parsed payload (Java `verifyFull`). */
export async function verifyPayload(ports: VerifyPorts, q: QrPayload): Promise<VerificationReport & { evidence?: PaymentEvidence }> {
  const now = ports.now()
  // Offline part first: summary, signatures, presenter, timestamp.
  const base = verifySummary(q.receipt, q.presenter ? { kind: 'qr', proof: q.presenter } : { kind: 'none' }, { nowSeconds: now })
  const s = base.summary
  if (!s) return base
  const warnings = base.warnings.filter((w) => w !== 'not acknowledged by the payee')
  const checks = { ...base.checks }
  const countersigned = checks.PAYEE_COUNTERSIGNATURE?.outcome === 'PASS'

  const evidence = await fetchEvidence(ports, q, warnings)
  let payeeBound = false
  if (evidence) {
    checks.EVIDENCE_DIGEST = evidenceDigestOf(evidence) === s.evidenceDigest
      ? r('PASS') : r('FAIL', 'evidence does not match the signed digest')
    if (evidence.rail === RAIL_CASHU && s.rail === RAIL_CASHU) {
      payeeBound = await checkCashu(ports, s, evidence.proofs, checks, warnings)
    } else if (evidence.rail !== s.rail) {
      checks.EVIDENCE_DIGEST = r('FAIL', 'evidence is for a different payment rail')
    } else {
      // Lightning: no invoice decoder in the wallet yet (US10 is P3).
      checks.LIGHTNING_INVOICE = r('UNAVAILABLE', 'no invoice decoder configured')
      checks.LIGHTNING_PREIMAGE = r('UNAVAILABLE', 'no invoice decoder configured')
      checks.AMOUNT = r('UNAVAILABLE', 'no invoice decoder configured')
    }
  }
  const verdict = verdictOf(checks, evidence != null, countersigned, payeeBound)
  if (verdict !== 'INVALID' && !countersigned) warnings.push('not acknowledged by the payee')
  if (evidence && !payeeBound && countersigned && s.rail === RAIL_CASHU) {
    warnings.push('the payment was not locked to the payee; the payee binding rests on the countersignature')
  }
  return { checks, verdict, warnings, presenter: base.presenter, summary: s, ...(evidence ? { evidence } : {}) }
}

/**
 * The voucher value of a payment, from its evidence: display only, never signed by the receipt.
 *
 * For a device with no record of the payment (a terminal checking for its stall). Every proof must
 * carry the same voucher, issued by the payee, with a valid issuer signature from a signing key
 * this build trusts; anything else is undefined rather than a guess. Value = sats x signed issuance
 * ratio, capped at the signed face value, the same rule `creditableFaceValue` applies at redemption.
 *
 * The allowlist is required, not optional as in `checkIssuer`: the issuer signature is verified
 * against the key the voucher itself carries, and a mint blind-signs whatever secret a wallet
 * chooses, so without it any payer could print the face value of their choice. A pre-fix
 * (legacy canonical) voucher is refused too, because its ratio is not signed.
 */
export function faceOfEvidence(
  evidence: PaymentEvidence | undefined,
  payee: string,
): { value: number; unit: string; decimals: number } | undefined {
  if (!evidence || evidence.rail !== RAIL_CASHU || evidence.proofs.length === 0) return undefined
  const trusted = allowedIssuerKeys()
  if (trusted.length === 0) return undefined
  let first: ReturnType<typeof voucherOfSecret> = null
  let sats = 0
  for (const p of evidence.proofs) {
    const v = voucherOfSecret(p.secret)
    if (!v) return undefined
    const checked = verifyVoucher(v)
    if (!checked.signatureValid || checked.legacyCanonical) return undefined
    if (!trusted.includes(v.issuerPublicKey.toLowerCase())) return undefined
    if (xOnly(v.issuerId) !== xOnly(payee)) return undefined
    if (first && v.voucherId !== first.voucherId) return undefined
    first = first ?? v
    sats += p.amount
  }
  if (!first || !(first.issuanceRatio > 0)) return undefined
  const derived = Math.round(sats * first.issuanceRatio)
  const value = first.faceValue > 0 ? Math.min(derived, first.faceValue) : derived
  return { value, unit: first.unit.toUpperCase(), decimals: first.faceDecimals }
}

function toOk(c: CheckResult | undefined): boolean | null {
  if (!c) return null
  if (c.outcome === 'PASS' || c.outcome === 'ANCHORED') return true
  if (c.outcome === 'FAIL') return false
  return null
}

const INVALID: VerifyResult = {
  verdict: 'invalid',
  checks: CHECK_ORDER.map((check) => ({ check, ok: check === 'PAYER_SIGNATURE' ? false : null })),
  presenter: 'NOT_CHECKED',
  mint: 'not_checked',
  mine: 'neither',
  warnings: ['not a readable receipt'],
}

/**
 * Verifies scanned QR text end to end and says what it means to this wallet. Never throws:
 * anything unreadable is an `invalid` verdict. Counts `verification`, and for the payee the
 * `check` outcome (records or mint), in the closed telemetry vocabulary.
 */
export async function verifyScannedWith(ports: VerifyPorts, qrText: string): Promise<VerifyResult> {
  let q: QrPayload
  try {
    q = decodeQr(qrText.trim())
  } catch {
    ports.count('verification', 'invalid')
    return INVALID
  }
  let report: VerificationReport & { evidence?: PaymentEvidence }
  try {
    report = await verifyPayload(ports, q)
  } catch {
    ports.count('verification', 'invalid')
    return INVALID
  }
  const s = report.summary
  let me: string | null = null
  try {
    const k = ports.publicKey()
    me = k ? xOnly(k) : null
  } catch {
    me = null
  }
  const mine: VerifyResult['mine'] = s && me ? (s.payee === me ? 'payee' : s.payer === me ? 'payer' : 'neither') : 'neither'

  const spent = report.checks.SPENT_STATE
  const mint: VerifyResult['mint'] =
    spent?.outcome === 'PASS' ? 'confirmed'
      : spent?.outcome === 'FAIL' ? 'not_valid'
        : spent?.outcome === 'UNAVAILABLE' || spent?.outcome === 'PENDING' ? 'unreachable'
          : 'not_checked'

  let records: VerifyResult['records']
  let face: VerifyResult['face']
  // FR-002a: the memo the payer signed into the receipt, so every scanner (a till too) sees what the
  // payment was for. Shown only on a receipt that is not invalid: the signature is what makes it
  // the payer's words. The payee's own record fills in when the receipt carries none (FR-027f).
  let memo: string | undefined = s && report.verdict !== 'INVALID' ? s.memo.trim() || undefined : undefined
  if (s && mine === 'payee' && report.verdict !== 'INVALID') {
    try {
      const own = await ports.ownRecord(s.paymentId)
      // 'no_records': this device keeps none (a terminal); the mint alone answers.
      if (own !== 'no_records') {
        records = own ? 'found_in_records' : 'not_in_records'
        face = own?.face
        memo ??= own?.memo || undefined
      }
    } catch {
      records = undefined
    }
    if (records) ports.count('check', `records_${records}`)
    if (mint === 'confirmed') ports.count('check', 'mint_confirmed_by_mint')
    else if (mint === 'not_valid') ports.count('check', 'mint_not_valid')
    // No record here (a terminal has none), or a record without a face value: read it from the
    // vouchers the payment was made with.
    face = face ?? faceOfEvidence(report.evidence, s.payee)
  }

  const verdict = VERDICT[report.verdict]
  ports.count('verification', verdict)

  // FR-027a-d: remembered only when the card will say "paid", so a receipt that is not mine, or
  // not proven mine, never leaves a trace. A failure here never touches the verdict.
  let priorChecks: PriorCheck[] | undefined
  let history: VerifyResult['history']
  if (s && ports.remember && isPaidToMe({ verdict, mine, mint, records })) {
    history = 'unknown'
    try {
      const m = await ports.remember(s.payee, s.paymentId, s.paidAt)
      // Once per check: a re-render within seconds (record null) is the same check, not counted again.
      if (m.record) {
        ports.count('check_record', m.record)
        ports.count('check_repeat', repeatOutcome(m.prior, m.known))
      }
      history = m.known ? 'known' : 'unknown'
      // Unknown history: only what this device itself remembers, never an implied "first".
      if (m.known || m.prior.length > 0) priorChecks = m.prior
    } catch {
      priorChecks = undefined
    }
  }

  return {
    verdict,
    checks: CHECK_ORDER.filter((c) => report.checks[c] !== undefined).map((check) => {
      const c = report.checks[check]
      const ok = toOk(c)
      return { check, ok, ...(c?.reason && ok !== true ? { detail: c.reason } : {}) }
    }),
    ...(s
      ? {
          summary: {
            amount: s.amount,
            unit: s.unit,
            payee: s.payee,
            ...(s.payer ? { payer: s.payer } : {}),
            paidAt: s.paidAt,
            ...(s.reference ? { reference: s.reference } : {}),
            mints: s.mints,
          },
        }
      : {}),
    presenter: report.presenter,
    mint,
    mine,
    ...(records ? { records } : {}),
    ...(face ? { face } : {}),
    ...(memo ? { memo } : {}),
    ...(priorChecks ? { priorChecks } : {}),
    ...(history ? { history } : {}),
    warnings: report.warnings,
  }
}
