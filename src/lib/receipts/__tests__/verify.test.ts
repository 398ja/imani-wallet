import { describe, expect, it } from 'vitest'
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
import { isReceiptQr, p2pkLock, verifyScannedWith, witnessSignedBy, type SpentState, type VerifyPorts } from '../verify'

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

async function receipt(opts: { proofs: CashuProofEvidence[]; countersign?: boolean; amount?: number; presenterAt?: number; evidence?: 'ok' | 'missing' | 'swapped' }) {
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
