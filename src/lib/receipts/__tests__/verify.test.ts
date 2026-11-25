import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  bytesToHex,
  encodeEvidence,
  encodeQr,
  encryptEvidence,
  makeLocator,
  makeSummary,
  newEvidenceKey,
  paymentId,
  publicKeyOf,
  RAIL_CASHU,
  secretKeySigner,
  signByPayer,
  signCountersignature,
  signPresenterProof,
  evidenceDigest,
  withCountersignature,
  type CashuProofEvidence,
  type PaymentEvidence,
} from '@imani/receipts'
import { isPaidToMe, isReceiptQr, p2pkLock, verifyScannedWith, witnessSignedBy, type SpentState, type VerifyPorts } from '../verify'
import { extractReceiptCode, receiptShareText } from '../shareText'

const MINT = 'https://mint.test'
const payerSk = new Uint8Array(32).fill(1)
const payeeSk = new Uint8Array(32).fill(2)
const strangerSk = new Uint8Array(32).fill(3)
const payer = publicKeyOf(payerSk)
const payee = publicKeyOf(payeeSk)
const NOW = 1_800_000_000

/** Evidence with a structurally present DLEQ; the DLEQ maths is stubbed by keyset=null (unavailable) or covered live. */
function proof(i: number, amount: number, lockedTo?: string): CashuProofEvidence {
  const secret = lockedTo
    ? JSON.stringify(['P2PK', { nonce: `n${i}`, data: '02' + lockedTo, tags: [['sigflag', 'SIG_INPUTS']] }])
    : `secret-${i}`
  return { mint: MINT, keysetId: '00ab', amount, secret, c: '02' + '11'.repeat(32), dleqE: 'aa'.repeat(32), dleqS: 'bb'.repeat(32), dleqR: 'cc'.repeat(32) }
}

async function receipt(opts: { proofs: CashuProofEvidence[]; countersign?: boolean; amount?: number; presenterAt?: number; evidence?: 'ok' | 'missing' | 'swapped'; memo?: string }) {
  const evidence: PaymentEvidence = { rail: RAIL_CASHU, proofs: opts.proofs }
  const ev = encodeEvidence(evidence)
  const s = makeSummary({
    paymentId: paymentId(opts.proofs.map((_, i) => '02' + String(i).padStart(2, '0').repeat(32))),
    rail: RAIL_CASHU,
    payer,
    payee,
    amount: opts.amount ?? opts.proofs.reduce((n, p) => n + p.amount, 0),
    unit: 'sat',
    mints: [MINT],
    paidAt: NOW - 600,
    reference: 'order 7',
    evidenceDigest: evidenceDigest(ev),
    memo: opts.memo ?? null,
  })
  let r = await signByPayer(s, secretKeySigner(payerSk))
  if (opts.countersign) r = withCountersignature(r, await signCountersignature(s, NOW - 500, true, secretKeySigner(payeeSk)))
  const key = newEvidenceKey()
  const blob = await encryptEvidence(key, opts.evidence === 'swapped' ? encodeEvidence({ rail: RAIL_CASHU, proofs: [proof(99, 1)] }) : ev, s.evidenceDigest)
    .catch(() => new Uint8Array(0))
  const presenter = opts.presenterAt ? await signPresenterProof(s.paymentId, opts.presenterAt, secretKeySigner(payerSk)) : null
  const qr = encodeQr({ receipt: r, presenter, evidence: makeLocator('ee'.repeat(32), null), evidenceKey: key })
  return { qr, s, blob: opts.evidence === 'missing' ? null : blob }
}

function ports(over: Partial<VerifyPorts> & { blob?: Uint8Array | null; states?: SpentState[] | 'down'; me?: string } = {}): VerifyPorts & { counted: string[] } {
  const counted: string[] = []
  return {
    counted,
    publicKey: () => over.me ?? payee,
    // Keyset unobtainable by default: DLEQ maths is exercised in the live probe against a real mint.
    keyset: async () => null,
    checkState: async (_m, ys) => {
      if (over.states === 'down') throw new Error('down')
      return over.states ?? ys.map(() => ({ state: 'SPENT' as const, witness: null }))
    },
    fetchEvidence: async () => over.blob ?? null,
    ownRecord: async () => ({ face: { value: 250, unit: 'EUR', decimals: 2 } }),
    mintAllowed: () => true,
    count: (e, o) => void counted.push(`${e}:${o}`),
    now: () => NOW,
    ...over,
  }
}

describe('isReceiptQr', () => {
  it('recognises the prefix, trimmed and in any case', () => {
    expect(isReceiptQr('  imrc1:abc')).toBe(true)
    expect(isReceiptQr('IMRC1:abc')).toBe(true)
    expect(isReceiptQr('vreqA...')).toBe(false)
  })
})

describe('p2pkLock (Java CashuReceiptAdapter.p2pkLock)', () => {
  const k = '02' + payee
  it('accepts P2PK and P2PK_VOUCHER single-key locks', () => {
    expect(p2pkLock(JSON.stringify(['P2PK', { nonce: 'x', data: k }]))).toBe(payee)
    expect(p2pkLock(JSON.stringify(['P2PK_VOUCHER', { nonce: 'x', data: k, tags: [['sigflag', 'SIG_INPUTS']] }]))).toBe(payee)
  })
  it('refuses multisig, malformed and plain secrets', () => {
    expect(p2pkLock(JSON.stringify(['P2PK', { data: k, tags: [['pubkeys', '02' + payer]] }]))).toBeNull()
    expect(p2pkLock(JSON.stringify(['P2PK', { data: k, tags: [['n_sigs', '2']] }]))).toBeNull()
    expect(p2pkLock(JSON.stringify(['HTLC', { data: k }]))).toBeNull()
    expect(p2pkLock('plain-secret')).toBeNull()
    expect(p2pkLock(JSON.stringify(['P2PK', { data: 'zz' }]))).toBeNull()
  })
})

describe('witnessSignedBy', () => {
  it('accepts only a signature by the named key over sha256(secret)', () => {
    const secret = 'some-secret'
    const sig = bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(secret)), payeeSk))
    const w = JSON.stringify({ signatures: [sig] })
    expect(witnessSignedBy(secret, w, payee)).toBe(true)
    expect(witnessSignedBy(secret, w, payer)).toBe(false)
    expect(witnessSignedBy('other', w, payee)).toBe(false)
    expect(witnessSignedBy(secret, 'not json', payee)).toBe(false)
    expect(witnessSignedBy(secret, null, payee)).toBe(false)
  })
})

describe('verifyScannedWith', () => {
  it('never throws on garbage: invalid, counted', async () => {
    const p = ports()
    const res = await verifyScannedWith(p, 'imrc1:%%%not-base64')
    expect(res.verdict).toBe('invalid')
    expect(p.counted).toContain('verification:invalid')
    expect(await verifyScannedWith(p, 'hello')).toMatchObject({ verdict: 'invalid' })
  })

  it('countersigned, evidence found, spent, keyset offline: verified offline, paid to me, in my records', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 8), proof(2, 2)], countersign: true, presenterAt: NOW - 5 })
    const p = ports({ blob })
    const res = await verifyScannedWith(p, qr)
    expect(res.verdict).toBe('verified_offline')
    expect(res.mine).toBe('payee')
    expect(res.records).toBe('found_in_records')
    expect(res.face).toEqual({ value: 250, unit: 'EUR', decimals: 2 })
    expect(res.mint).toBe('confirmed')
    expect(res.presenter).toBe('PRESENTER_IS_PAYER')
    expect(res.summary).toMatchObject({ amount: 10, unit: 'sat', payee, payer, reference: 'order 7' })
    expect(res.checks.find((c) => c.check === 'EVIDENCE_DIGEST')?.ok).toBe(true)
    expect(res.checks.find((c) => c.check === 'SPENT_STATE')?.ok).toBe(true)
    expect(p.counted).toEqual(expect.arrayContaining(['verification:verified_offline', 'check:records_found_in_records', 'check:mint_confirmed_by_mint']))
  })

  it('a stale presenter proof is reported, not trusted', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true, presenterAt: NOW - 3600 })
    const res = await verifyScannedWith(ports({ blob }), qr)
    expect(res.presenter).toBe('PRESENTER_NOT_PROVEN')
  })

  it('unspent at the mint: invalid, with the spendable-value warning', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true })
    const res = await verifyScannedWith(ports({ blob, states: [{ state: 'UNSPENT', witness: null }] }), qr)
    expect(res.verdict).toBe('invalid')
    expect(res.mint).toBe('not_valid')
    expect(res.warnings.join(' ')).toMatch(/spendable value/)
  })

  it('mint down: verified offline, mint unreachable', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true })
    const res = await verifyScannedWith(ports({ blob, states: 'down' }), qr)
    expect(res.verdict).toBe('verified_offline')
    expect(res.mint).toBe('unreachable')
  })

  it('evidence gone: summary only (countersigned) or unacknowledged (payer only)', async () => {
    const a = await receipt({ proofs: [proof(1, 4)], countersign: true, evidence: 'missing' })
    expect((await verifyScannedWith(ports({ blob: null }), a.qr)).verdict).toBe('verified_summary_only')
    const b = await receipt({ proofs: [proof(1, 4)], evidence: 'missing' })
    expect((await verifyScannedWith(ports({ blob: null }), b.qr)).verdict).toBe('unacknowledged')
  })

  it('evidence swapped under the link fails the digest check: invalid', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true, evidence: 'swapped' })
    const res = await verifyScannedWith(ports({ blob }), qr)
    expect(res.verdict).toBe('invalid')
    expect(res.checks.find((c) => c.check === 'EVIDENCE_DIGEST')).toMatchObject({ ok: false })
  })

  it('a blob sealed with another key is not this receipt\'s evidence: summary only, warned', async () => {
    const { qr, s } = await receipt({ proofs: [proof(1, 4)], countersign: true })
    const other = await encryptEvidence(newEvidenceKey(), encodeEvidence({ rail: RAIL_CASHU, proofs: [proof(1, 4)] }), s.evidenceDigest)
    const res = await verifyScannedWith(ports({ blob: other }), qr)
    expect(res.verdict).toBe('verified_summary_only')
    expect(res.warnings.join(' ')).toMatch(/could not be decrypted/)
  })

  it('a missing DLEQ is a failure, not a skip (FR-040)', async () => {
    const bare = { ...proof(1, 4), dleqE: null, dleqS: null, dleqR: null }
    const { qr, blob } = await receipt({ proofs: [bare], countersign: true })
    const res = await verifyScannedWith(ports({ blob }), qr)
    expect(res.verdict).toBe('invalid')
    expect(res.checks.find((c) => c.check === 'MINT_SIGNATURE_DLEQ')).toMatchObject({ ok: false })
  })

  it('locked to the payee and spent by someone else: invalid', async () => {
    const locked = proof(1, 4, payee)
    const { qr, blob } = await receipt({ proofs: [locked] })
    const wrong = bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(locked.secret)), strangerSk))
    const res = await verifyScannedWith(ports({ blob, states: [{ state: 'SPENT', witness: JSON.stringify({ signatures: [wrong] }) }] }), qr)
    expect(res.verdict).toBe('invalid')
    expect(res.checks.find((c) => c.check === 'SPENT_STATE')?.detail).toMatch(/not spent by the payee/)
  })

  it("locked to the payee and spent with the payee's key: verified offline without a countersignature", async () => {
    const locked = proof(1, 4, payee)
    const { qr, blob } = await receipt({ proofs: [locked] })
    const good = bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(locked.secret)), payeeSk))
    const res = await verifyScannedWith(ports({ blob, states: [{ state: 'SPENT', witness: JSON.stringify({ signatures: [good] }) }] }), qr)
    expect(res.verdict).toBe('verified_offline')
    expect(res.checks.find((c) => c.check === 'PAYEE_LOCK')?.ok).toBe(true)
  })

  it('an untrusted mint is never contacted', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true })
    let contacted = false
    const res = await verifyScannedWith(ports({ blob, mintAllowed: () => false, checkState: async () => { contacted = true; return [] } }), qr)
    expect(contacted).toBe(false)
    expect(res.mint).toBe('unreachable')
    expect(res.checks.find((c) => c.check === 'SPENT_STATE')?.detail).toMatch(/not trusted/)
  })

  it('a receipt to someone else is "neither" and runs no records check', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true })
    const p = ports({ blob, me: publicKeyOf(strangerSk) })
    const res = await verifyScannedWith(p, qr)
    expect(res.mine).toBe('neither')
    expect(res.records).toBeUndefined()
    expect(p.counted.some((c) => c.startsWith('check:'))).toBe(false)
  })

  it('a receipt of my own payment is "payer"', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true })
    expect((await verifyScannedWith(ports({ blob, me: payer }), qr)).mine).toBe('payer')
  })

  it('an altered amount fails', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true, amount: 5 })
    const res = await verifyScannedWith(ports({ blob }), qr)
    expect(res.verdict).toBe('invalid')
    expect(res.checks.find((c) => c.check === 'AMOUNT')?.detail).toMatch(/amount altered/)
  })
})

/**
 * A locked voucher secret issued by `issuerSk`, signed over the canonical bytes the reader rebuilds
 * (as canonicalNumericTags.test.ts does), so `verifyVoucher` accepts it.
 */
function voucherSecret(issuerSk: Uint8Array, i: number, opts: { voucherId?: string; face?: number; ratio?: string } = {}): string {
  const pub = bytesToHex(schnorr.getPublicKey(issuerSk))
  const nonce = String(i).padStart(64, '0')
  const lockKey = '02' + payee
  const tags: [string, string][] = [
    ['voucher_id', opts.voucherId ?? '1d4410af-70f5-4c14-8606-519404684ea7'],
    ['issuer', pub],
    ['unit', 'GBP'],
    ['face_value', String(opts.face ?? 500)],
    ['face_decimals', '2'],
    ['issuance_ratio', opts.ratio ?? '0.5'],
  ]
  const numeric = ['face_value', 'expires_at', 'face_decimals', 'issuance_ratio']
  const render = (v: string, k: string) => (numeric.includes(k) ? String(Number(v)) : `"${v}"`)
  const canonical = new TextEncoder().encode(
    `["P2PK_VOUCHER","${lockKey}","${nonce}",[${tags.map(([k, v]) => `["${k}",${render(v, k)}]`).join(',')}]]`,
  )
  const sig = bytesToHex(schnorr.sign(sha256(canonical), issuerSk))
  return JSON.stringify(['P2PK_VOUCHER', { nonce, data: lockKey, tags: [...tags, ['issuer_sig', sig], ['issuer_pubkey', pub]] }])
}

function voucherProof(i: number, amount: number, secret: string): CashuProofEvidence {
  return { ...proof(i, amount), secret }
}

describe('a terminal checking for its stall (receipt:read)', () => {
  // The face fixtures sign with the payee's key; the build trusts that signing key here, so the
  // tests do not depend on whatever `.env.local` sets.
  beforeEach(() => vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', bytesToHex(schnorr.getPublicKey(payeeSk))))
  afterEach(() => vi.unstubAllEnvs())

  it('shows no value when the build trusts no issuer key at all', async () => {
    vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', '')
    const { qr, blob } = await receipt({ proofs: [voucherProof(1, 512, voucherSecret(payeeSk, 1))], countersign: true })
    expect((await verifyScannedWith(ports({ blob, ownRecord: async () => 'no_records' }), qr)).face).toBeUndefined()
  })
  it('keeps no records: paid to the stall on the mint\'s word, no records claim either way', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 8)], countersign: true })
    const p = ports({ blob, ownRecord: async () => 'no_records' })
    const res = await verifyScannedWith(p, qr)
    expect(res.mine).toBe('payee')
    expect(res.mint).toBe('confirmed')
    expect(res.records).toBeUndefined()
    expect(p.counted.some((c) => c.startsWith('check:records_'))).toBe(false)
  })

  it('reads the voucher value from the payment itself when it has no record', async () => {
    const secrets = [voucherSecret(payeeSk, 1), voucherSecret(payeeSk, 2)]
    const { qr, blob } = await receipt({ proofs: [voucherProof(1, 512, secrets[0]), voucherProof(2, 256, secrets[1])], countersign: true })
    const res = await verifyScannedWith(ports({ blob, ownRecord: async () => 'no_records' }), qr)
    // 768 sats x 0.5 = 384, under the signed face value of 500.
    expect(res.face).toEqual({ value: 384, unit: 'GBP', decimals: 2 })
  })

  it('caps the value at the signed face value', async () => {
    const { qr, blob } = await receipt({ proofs: [voucherProof(1, 4096, voucherSecret(payeeSk, 1))], countersign: true })
    const res = await verifyScannedWith(ports({ blob, ownRecord: async () => 'no_records' }), qr)
    expect(res.face?.value).toBe(500)
  })

  it('shows no value for vouchers another stall issued, or a mix of vouchers', async () => {
    const other = await receipt({ proofs: [voucherProof(1, 512, voucherSecret(strangerSk, 1))], countersign: true })
    expect((await verifyScannedWith(ports({ blob: other.blob, ownRecord: async () => 'no_records' }), other.qr)).face).toBeUndefined()
    const mixed = await receipt({
      proofs: [voucherProof(1, 512, voucherSecret(payeeSk, 1)), voucherProof(2, 512, voucherSecret(payeeSk, 2, { voucherId: 'other' }))],
      countersign: true,
    })
    expect((await verifyScannedWith(ports({ blob: mixed.blob, ownRecord: async () => 'no_records' }), mixed.qr)).face).toBeUndefined()
  })

  it('shows no value for a voucher whose issuer signature does not verify', async () => {
    const forged = voucherSecret(payeeSk, 1).replace(/"issuer_sig","[0-9a-f]{128}"/, `"issuer_sig","${'00'.repeat(64)}"`)
    const { qr, blob } = await receipt({ proofs: [voucherProof(1, 512, forged)], countersign: true })
    expect((await verifyScannedWith(ports({ blob, ownRecord: async () => 'no_records' }), qr)).face).toBeUndefined()
  })

  /**
   * Regression (review of 72de4e6c): the issuer signature is checked against the key the voucher
   * itself carries, so a voucher naming the stall can be signed by anyone at any face value. The
   * build's issuer allowlist (as dmCrypto applies it) decides whose signing key counts.
   */
  it('shows no value for a voucher signed by a key outside the issuer allowlist', async () => {
    const service = new Uint8Array(32).fill(9)
    vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', bytesToHex(schnorr.getPublicKey(service)))
    const forged = voucherSecretSignedBy(strangerSk, payee, 1)
    const { qr, blob } = await receipt({ proofs: [voucherProof(1, 512, forged)], countersign: true })
    expect((await verifyScannedWith(ports({ blob, ownRecord: async () => 'no_records' }), qr)).face).toBeUndefined()
    const genuine = voucherSecretSignedBy(service, payee, 2)
    const ok = await receipt({ proofs: [voucherProof(2, 512, genuine)], countersign: true })
    expect((await verifyScannedWith(ports({ blob: ok.blob, ownRecord: async () => 'no_records' }), ok.qr)).face).toEqual({
      value: 256, unit: 'GBP', decimals: 2,
    })
  })

  it('an unacknowledged receipt of unlocked, spent proofs is not mint-confirmed as paid', async () => {
    // The payer could have spent these proofs anywhere: only a countersignature or a payee lock
    // ties the spend to the payee.
    const { qr, blob } = await receipt({ proofs: [proof(1, 8)], countersign: false })
    const res = await verifyScannedWith(ports({ blob, ownRecord: async () => 'no_records' }), qr)
    expect(res.verdict).toBe('unacknowledged')
    expect(res.mine).toBe('payee')
  })
})

/** A voucher naming `issuerId` as the stall, signed by `signerSk` (the issuing service's key). */
function voucherSecretSignedBy(signerSk: Uint8Array, issuerId: string, i: number): string {
  const pub = bytesToHex(schnorr.getPublicKey(signerSk))
  const nonce = String(i).padStart(64, '0')
  const lockKey = '02' + payee
  const tags: [string, string][] = [
    ['voucher_id', '1d4410af-70f5-4c14-8606-519404684ea7'],
    ['issuer', issuerId],
    ['unit', 'GBP'],
    ['face_value', '500'],
    ['face_decimals', '2'],
    ['issuance_ratio', '0.5'],
  ]
  const numeric = ['face_value', 'expires_at', 'face_decimals', 'issuance_ratio']
  const render = (v: string, k: string) => (numeric.includes(k) ? String(Number(v)) : `"${v}"`)
  const canonical = new TextEncoder().encode(
    `["P2PK_VOUCHER","${lockKey}","${nonce}",[${tags.map(([k, v]) => `["${k}",${render(v, k)}]`).join(',')}]]`,
  )
  const sig = bytesToHex(schnorr.sign(sha256(canonical), signerSk))
  return JSON.stringify(['P2PK_VOUCHER', { nonce, data: lockKey, tags: [...tags, ['issuer_sig', sig], ['issuer_pubkey', pub]] }])
}

/**
 * Spec 049 FR-027a-f: a check paid to me is remembered and earlier checks come back with the
 * verdict, and my own record's memo shows beside it. Only when the card will say "paid": a check
 * of a receipt that is not mine, or not proven mine, is never recorded.
 */
describe('remembered checks and the memo (FR-027a-f)', () => {
  const PRIOR = [{ at: NOW - 3600, by: { kind: 'another_till' as const } }]

  it('paid to me: remembers the check, returns the earlier ones, counts a repeat', async () => {
    const { qr, s, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true })
    const remembered: string[] = []
    const p = ports({
      blob,
      remember: async (payeeKey, id) => (remembered.push(`${payeeKey}:${id}`), { prior: PRIOR, known: true, record: 'published' }),
    })
    const res = await verifyScannedWith(p, qr)
    expect(remembered).toEqual([`${payee}:${s.paymentId}`])
    expect(res.priorChecks).toEqual(PRIOR)
    expect(p.counted).toEqual(expect.arrayContaining(['check_repeat:repeat_other_device', 'check_record:published']))
  })

  it('a first check: an empty list, counted as first', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true })
    const p = ports({ blob, remember: async () => ({ prior: [], known: true, record: 'deferred' }) })
    const res = await verifyScannedWith(p, qr)
    expect(res.priorChecks).toEqual([])
    expect(p.counted).toEqual(expect.arrayContaining(['check_repeat:first', 'check_record:deferred']))
  })

  it('history unknown (offline): no list, history "unknown", counted as unknown and never as first', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true })
    const p = ports({ blob, remember: async () => ({ prior: [], known: false, record: 'deferred' }) })
    const res = await verifyScannedWith(p, qr)
    expect(res.priorChecks).toBeUndefined()
    expect(res.history).toBe('unknown')
    expect(p.counted).toContain('check_repeat:unknown')
    expect(p.counted).not.toContain('check_repeat:first')
  })

  it('passes the payment date so backdated checks can be refused (M6)', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true })
    const dates: number[] = []
    await verifyScannedWith(ports({ blob, remember: async (_p, _i, paidAt) => (dates.push(paidAt), { prior: [], known: true, record: 'published' }) }), qr)
    expect(dates).toHaveLength(1)
    expect(Number.isInteger(dates[0])).toBe(true)
  })

  it('a failing remember: history unknown, never presented as a first check', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true })
    const res = await verifyScannedWith(ports({ blob, remember: async () => { throw new Error('flooded') } }), qr)
    expect(res.history).toBe('unknown')
  })

  it('offline but this device checked before: shows that one', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true })
    const mine = [{ at: NOW - 60, by: { kind: 'this_device' as const } }]
    const res = await verifyScannedWith(ports({ blob, remember: async () => ({ prior: mine, known: false, record: null }) }), qr)
    expect(res.priorChecks).toEqual(mine)
  })

  it('a repeat never changes the verdict', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true })
    const first = await verifyScannedWith(ports({ blob }), qr)
    const again = await verifyScannedWith(ports({ blob, remember: async () => ({ prior: PRIOR, known: true, record: null }) }), qr)
    expect({ ...again, priorChecks: undefined, history: undefined }).toEqual({ ...first, priorChecks: undefined, history: undefined })
  })

  it('not mine: never remembered', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true })
    const remember = vi.fn()
    await verifyScannedWith(ports({ blob, me: publicKeyOf(strangerSk), remember }), qr)
    expect(remember).not.toHaveBeenCalled()
  })

  it('mine on paper but not proven (unacknowledged, unlocked, not in records): never remembered', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)] })
    const remember = vi.fn()
    const res = await verifyScannedWith(ports({ blob, remember, ownRecord: async () => 'no_records' }), qr)
    expect(res.verdict).toBe('unacknowledged')
    expect(remember).not.toHaveBeenCalled()
  })

  it('unspent at the mint: never remembered', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true })
    const remember = vi.fn()
    await verifyScannedWith(ports({ blob, remember, states: [{ state: 'UNSPENT', witness: null }] }), qr)
    expect(remember).not.toHaveBeenCalled()
  })

  it('a failing remember leaves the verdict standing', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true })
    const res = await verifyScannedWith(ports({ blob, remember: async () => { throw new Error('boom') } }), qr)
    expect(res.verdict).toBe('verified_offline')
    expect(res.priorChecks).toBeUndefined()
  })

  it('a receipt without a signed memo: my own record’s memo comes back; a terminal has none', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true })
    const owner = await verifyScannedWith(ports({ blob, ownRecord: async () => ({ memo: 'Two coffees' }) }), qr)
    expect(owner.memo).toBe('Two coffees')
    const till = await verifyScannedWith(ports({ blob, ownRecord: async () => 'no_records' }), qr)
    expect(till.memo).toBeUndefined()
  })

  it('the memo the payer signed is shown on every scanner, a till too, and wins over my record (FR-002a)', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true, memo: 'Table 4, two flat whites' })
    const till = await verifyScannedWith(ports({ blob, ownRecord: async () => 'no_records' }), qr)
    expect(till.memo).toBe('Table 4, two flat whites')
    const owner = await verifyScannedWith(ports({ blob, ownRecord: async () => ({ memo: 'Received' }) }), qr)
    expect(owner.memo).toBe('Table 4, two flat whites')
    // A third party (neither payer nor payee) sees it too: it is part of what the payer signed.
    const stranger = await verifyScannedWith(ports({ blob, me: 'dd'.repeat(32) }), qr)
    expect(stranger.memo).toBe('Table 4, two flat whites')
  })

  it('an invalid receipt shows no memo', async () => {
    const { qr, blob } = await receipt({ proofs: [proof(1, 4)], countersign: true, memo: 'Paid in full', amount: 999 })
    const res = await verifyScannedWith(ports({ blob }), qr)
    expect(res.verdict).toBe('invalid')
    expect(res.memo).toBeUndefined()
  })

  it('isPaidToMe matches the card: records, or the mint on a bound verdict', () => {
    const base = { verdict: 'verified', mine: 'payee', mint: 'not_checked', checks: [], presenter: 'NOT_CHECKED', warnings: [] } as const
    expect(isPaidToMe({ ...base, records: 'found_in_records' })).toBe(true)
    expect(isPaidToMe({ ...base, mint: 'confirmed' })).toBe(true)
    expect(isPaidToMe({ ...base, verdict: 'unacknowledged', mint: 'confirmed' })).toBe(false)
    expect(isPaidToMe({ ...base, mine: 'neither', records: 'found_in_records' })).toBe(false)
    expect(isPaidToMe({ ...base, verdict: 'invalid', records: 'found_in_records' })).toBe(false)
    expect(isPaidToMe({ ...base, mint: 'not_valid', records: 'found_in_records' })).toBe(false)
  })
})

describe('a receipt sent as text (Share on the receipt dialog)', () => {
  it('pasted out of the shared message, verifies exactly as the scanned code does', async () => {
    // Arrange
    const { qr, blob } = await receipt({ proofs: [proof(1, 8), proof(2, 2)], countersign: true, presenterAt: NOW - 5 })
    const message = `Forwarded: ${receiptShareText(qr)}\nthanks!`

    // Act
    const pasted = extractReceiptCode(message)
    const viaText = await verifyScannedWith(ports({ blob }), pasted ?? '')
    const viaScan = await verifyScannedWith(ports({ blob }), qr)

    // Assert
    expect(pasted).toBe(qr)
    expect(viaText.verdict).toBe('verified_offline')
    expect({ ...viaText, priorChecks: undefined }).toEqual({ ...viaScan, priorChecks: undefined })
  })
})
