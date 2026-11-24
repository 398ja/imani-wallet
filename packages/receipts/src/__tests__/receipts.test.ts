import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'
import vectors from './vectors/java-v1.json'
import {
  answerChallenge,
  buildPayerReceipt,
  bytesToHex,
  cashuEvidence,
  CHECK_ORDER,
  checkEvidenceOffline,
  checkPresenter,
  countersignatureBytes,
  decodeEvidence,
  decodeQr,
  decodeSummary,
  decryptEvidence,
  encodeAck,
  encodeEvidence,
  encodeQr,
  encodeSummary,
  encodeVarint,
  MAX_FIELD,
  encryptEvidence,
  evidenceDigest,
  fitMemo,
  fromBase64Url,
  hashToCurveY,
  hexToBytes,
  lightningPaymentId,
  makeLocator,
  makeSummary,
  paymentId,
  publicKeyOf,
  qrBody,
  readTlv,
  secretKeySigner,
  signByPayer,
  signCountersignature,
  signPresenterProof,
  tagged,
  TAG_PAYER,
  TlvWriter,
  toBase64Url,
  unsignedReceipt,
  verifyChallengeAnswer,
  verifyCountersignature,
  verifySummary,
  verifyTagged,
  withCountersignature,
  type CashuProofEvidence,
  type PresenterInput,
  type ReceiptSummary,
  type SendEvidence,
  type SignedReceipt,
} from '../index'

type JsonSummary = Omit<(typeof vectors.summaries)['full'], 'payer' | 'itemsCommitment' | 'refundOf'> & {
  payer: string | null
  itemsCommitment: string | null
  refundOf: string | null
}

const NOW = vectors.verifierNow
const payer = secretKeySigner(hexToBytes(vectors.keys.payerSecret))
const payee = secretKeySigner(hexToBytes(vectors.keys.payeeSecret))
const other = secretKeySigner(hexToBytes(vectors.keys.otherSecret))

function fromJson(j: JsonSummary): ReceiptSummary {
  return makeSummary({ ...j, rail: j.rail as 'cashu' | 'lightning' })
}

const proofs: CashuProofEvidence[] = vectors.evidence.proofs.map((p) => ({
  mint: p.mint,
  keysetId: p.id,
  amount: p.amount,
  secret: p.secret,
  c: p.C,
  dleqE: p.dleq?.e ?? null,
  dleqS: p.dleq?.s ?? null,
  dleqR: p.dleq?.r ?? null,
}))

describe('primitives match Java', () => {
  it('keys derive the same x-only public keys', () => {
    expect(publicKeyOf(hexToBytes(vectors.keys.payerSecret))).toBe(vectors.keys.payerPub)
    expect(payee.publicKey).toBe(vectors.keys.payeePub)
  })

  it('domain-tagged sha256', () => {
    for (const t of vectors.tagged) expect(bytesToHex(tagged(t.tag, hexToBytes(t.msgHex)))).toBe(t.digest)
  })

  it('varints, including a paidAt and 2^53-1', () => {
    for (const v of vectors.varints) {
      expect(bytesToHex(new TlvWriter().varint(1, BigInt(v.value)).toBytes())).toBe(v.fieldHex)
      expect(readTlv(hexToBytes(v.fieldHex))[0].tag).toBe(1)
    }
  })

  it('hash_to_curve Ys and the payment id', () => {
    for (const p of vectors.evidence.proofs) expect(hashToCurveY(p.secret)).toBe(p.Y)
    expect(paymentId(vectors.paymentId.ys)).toBe(vectors.paymentId.paymentId)
    expect(paymentId(vectors.paymentId.upperAndDuplicatedYs)).toBe(vectors.paymentId.paymentIdOfUpperAndDuplicated)
    expect(vectors.paymentId.paymentIdOfUpperAndDuplicated).toBe(vectors.paymentId.paymentId)
    expect(lightningPaymentId(vectors.lightningEvidence.paymentHash)).toBe(vectors.lightningEvidence.paymentId)
  })
})

describe('summary TLV', () => {
  for (const [name, j] of Object.entries(vectors.summaries)) {
    it(`${name}: encodes to Java's bytes and decodes back`, () => {
      const s = fromJson(j)
      expect(bytesToHex(encodeSummary(s))).toBe(j.tlvHex)
      const back = decodeSummary(hexToBytes(j.tlvHex))
      expect(back).toEqual(s)
      expect(bytesToHex(encodeSummary(back))).toBe(j.tlvHex)
    })
  }

  it('normalises a compressed payee key and sorts mints', () => {
    const j = vectors.summaries.full
    const s = makeSummary({ ...j, rail: 'cashu', payee: `02${j.payee}`, mints: [...j.mints].reverse() })
    expect(bytesToHex(encodeSummary(s))).toBe(j.tlvHex)
  })

  it('rejects what Java rejects', () => {
    const j = vectors.summaries.minimal
    expect(() => makeSummary({ ...j, rail: 'cashu', amount: 0 })).toThrow()
    expect(() => makeSummary({ ...j, rail: 'cashu', mints: [] })).toThrow()
    expect(() => encodeSummary(makeSummary({ ...j, rail: 'cashu', reference: 'x'.repeat(81) }))).toThrow()
    expect(() => encodeSummary(makeSummary({ ...j, rail: 'cashu', mints: ['a', 'b', 'c', 'd', 'e'] }))).toThrow()
    expect(() => decodeSummary(hexToBytes('0201ff010101'))).toThrow(/order/)
    expect(() => decodeSummary(hexToBytes('0101'))).toThrow()
  })

  it('tolerates an unknown trailing tag', () => {
    const bytes = new TlvWriter().raw(hexToBytes(vectors.summaries.minimal.tlvHex)).utf8(99, 'future').toBytes()
    expect(decodeSummary(bytes)).toEqual(fromJson(vectors.summaries.minimal))
  })
})

describe('acknowledgement bytes (A_*)', () => {
  const full = fromJson(vectors.summaries.full)
  const at = vectors.acks.claimedAt
  it('match Java with and without the payer', () => {
    expect(bytesToHex(encodeAck(full, at))).toBe(vectors.acks.fullNamesPayer)
    expect(bytesToHex(countersignatureBytes({ claimedAt: at, namesPayer: false }, full))).toBe(vectors.acks.fullWithoutPayer)
    expect(bytesToHex(countersignatureBytes({ claimedAt: at, namesPayer: false }, fromJson(vectors.summaries.bare)))).toBe(vectors.acks.bare)
  })
})

describe('Java signatures verify here', () => {
  const full = fromJson(vectors.summaries.full)
  const sig = vectors.signatures
  it('payer signature, countersignature, presenter proof, challenge', () => {
    expect(verifyTagged(TAG_PAYER, hexToBytes(vectors.summaries.full.tlvHex), full.payer, sig.payerSigFull)).toBe(true)
    expect(verifyCountersignature({ claimedAt: vectors.acks.claimedAt, namesPayer: true, signature: sig.ackSigFull }, full)).toBe(true)
    expect(checkPresenter(full, sig.presenterFresh, NOW)).toBe('PRESENTER_IS_PAYER')
    expect(verifyChallengeAnswer(full, sig.challenge.nonce, sig.challenge.signature)).toBe(true)
    expect(verifyChallengeAnswer(full, sig.challenge.nonce.replace(/^./, 'f'), sig.challenge.signature)).toBe(false)
  })

  it('a signature for one purpose never verifies as another', () => {
    expect(verifyTagged(TAG_PAYER, hexToBytes(vectors.summaries.full.tlvHex), full.payer, sig.presenterFresh.signature)).toBe(false)
  })
})

describe('presenter freshness', () => {
  const full = fromJson(vectors.summaries.full)
  it('accepts 60s old and 30s ahead, rejects beyond', async () => {
    const at = (t: number) => signPresenterProof(full.paymentId, t, payer)
    expect(checkPresenter(full, await at(NOW - 60), NOW)).toBe('PRESENTER_IS_PAYER')
    expect(checkPresenter(full, await at(NOW + 30), NOW)).toBe('PRESENTER_IS_PAYER')
    expect(checkPresenter(full, await at(NOW - 61), NOW)).toBe('PRESENTER_NOT_PROVEN')
    expect(checkPresenter(full, await at(NOW + 31), NOW)).toBe('PRESENTER_NOT_PROVEN')
    expect(checkPresenter(full, await signPresenterProof(full.paymentId, NOW, other), NOW)).toBe('PRESENTER_NOT_PROVEN')
    expect(checkPresenter(full, null, NOW)).toBe('NOT_CHECKED')
    expect(checkPresenter(fromJson(vectors.summaries.bare), await at(NOW), NOW)).toBe('PRESENTER_NOT_PROVEN')
  })
})

describe('evidence', () => {
  it('encodes to Java bytes and digest, whatever the input order', () => {
    const e = cashuEvidence([...proofs].reverse())
    expect(bytesToHex(encodeEvidence(e))).toBe(vectors.evidence.encodedHex)
    expect(evidenceDigest(encodeEvidence(e))).toBe(vectors.evidence.digest)
    expect(decodeEvidence(hexToBytes(vectors.evidence.encodedHex))).toEqual(cashuEvidence(proofs))
  })

  it('lightning evidence', () => {
    const l = vectors.lightningEvidence
    const e = { rail: 'lightning' as const, invoice: l.invoice, preimage: l.preimage }
    expect(bytesToHex(encodeEvidence(e))).toBe(l.encodedHex)
    expect(evidenceDigest(encodeEvidence(e))).toBe(l.digest)
    expect(decodeEvidence(hexToBytes(l.encodedHex))).toEqual(e)
  })

  it('offline digest and amount checks', () => {
    const full = fromJson(vectors.summaries.full)
    const e = cashuEvidence(proofs)
    expect(checkEvidenceOffline(full, e)).toEqual({ digest: { outcome: 'PASS', reason: null }, amount: { outcome: 'PASS', reason: null } })
    const tampered = cashuEvidence(proofs.map((p, i) => (i === 0 ? { ...p, amount: p.amount + 1 } : p)))
    const res = checkEvidenceOffline(full, tampered)
    expect(res.digest.outcome).toBe('FAIL')
    expect(res.amount.outcome).toBe('FAIL')
  })
})

describe('large evidence (MAX_FIELD 1 MiB, enforced both ways)', () => {
  const h = (s: string) => bytesToHex(sha256(new TextEncoder().encode(s)))
  it('~200 KB evidence matches Java and round trips', () => {
    const many: CashuProofEvidence[] = Array.from({ length: 1000 }, (_, i) => ({
      mint: 'https://mint-a.example', keysetId: '009a1f293253e41e', amount: 1,
      secret: `large-${String(i).padStart(4, '0')}`, c: `02${h(`c${i}`)}`,
      dleqE: h(`e${i}`), dleqS: h(`s${i}`), dleqR: h(`r${i}`),
    }))
    const bytes = encodeEvidence(cashuEvidence(many))
    expect(bytes.length).toBe(vectors.largeEvidence.byteLength)
    expect(bytes.length).toBeGreaterThan(64 * 1024)
    expect(evidenceDigest(bytes)).toBe(vectors.largeEvidence.digest)
    expect(decodeEvidence(bytes)).toEqual(cashuEvidence(many))
    // Stored as ONE field (StoredReceiptCodec R_EVIDENCE): over the old 64 KiB limit, under 1 MiB.
    const wrapped = new TlvWriter().bytes(4, bytes).toBytes()
    expect(readTlv(wrapped)[0].value).toEqual(bytes)
  })

  it('writer refuses and reader refuses a field over 1 MiB', () => {
    expect(MAX_FIELD).toBe(1024 * 1024)
    expect(() => new TlvWriter().bytes(1, new Uint8Array(MAX_FIELD + 1))).toThrow(/exceeds/)
    expect(new TlvWriter().bytes(1, new Uint8Array(MAX_FIELD)).toBytes().length).toBeGreaterThan(MAX_FIELD)
    const header = new TlvWriter().raw(Uint8Array.of(1)).raw(encodeVarint(MAX_FIELD + 1)).toBytes()
    const over = new Uint8Array(header.length + MAX_FIELD + 1)
    over.set(header)
    expect(() => readTlv(over)).toThrow('malformed field')
  })
})

describe('evidence cipher (AES-256-GCM via WebCrypto)', () => {
  const c = vectors.cipher
  const key = hexToBytes(c.key)
  it('fixed-nonce encrypt is byte-identical to Java', async () => {
    const blob = await encryptEvidence(key, hexToBytes(c.plaintextHex), c.aad, hexToBytes(c.fixedNonce))
    expect(bytesToHex(blob)).toBe(c.fixedNonceBlobHex)
  })

  it('decrypts the random-nonce blob Java produced', async () => {
    expect(bytesToHex(await decryptEvidence(key, hexToBytes(c.javaBlobHex), c.aad))).toBe(c.plaintextHex)
  })

  it('round trips, and fails without detail on a wrong key, AAD or tampered blob', async () => {
    const blob = await encryptEvidence(key, hexToBytes(c.plaintextHex), c.aad)
    expect(bytesToHex(await decryptEvidence(key, blob, c.aad))).toBe(c.plaintextHex)
    const wrong = Uint8Array.from(key)
    wrong[0] ^= 1
    await expect(decryptEvidence(wrong, blob, c.aad)).rejects.toThrow('evidence could not be decrypted')
    await expect(decryptEvidence(key, blob, vectors.summaries.full.paymentId)).rejects.toThrow('evidence could not be decrypted')
    const t = Uint8Array.from(blob)
    t[t.length - 1] ^= 1
    await expect(decryptEvidence(key, t, c.aad)).rejects.toThrow('evidence could not be decrypted')
    const v2 = Uint8Array.from(blob)
    v2[0] = 2
    await expect(decryptEvidence(key, v2, c.aad)).rejects.toThrow('malformed')
  })
})

describe('QR payload', () => {
  it('a Java receipt with a memo: TS reads the memo Java signed, and the signature verifies', () => {
    const q = decodeQr(vectors.qr.withMemo.text)
    expect(decodeSummary(q.receipt.summaryBytes).memo).toBe(vectors.summaries.withMemo.memo)
    expect(verifySummary(q.receipt, undefined, { nowSeconds: NOW }).checks.PAYER_SIGNATURE?.outcome).toBe('PASS')
  })
  it('re-encodes Java QR text exactly', () => {
    for (const q of [vectors.qr.full, vectors.qr.exportNoKey, vectors.qr.withMemo]) {
      const decoded = decodeQr(q.text)
      expect(bytesToHex(qrBody(decoded))).toBe(q.bodyHex)
      expect(encodeQr(decoded)).toBe(q.text)
    }
  })

  it('carries the evidence key in the fragment, and the receipt verifies', () => {
    const q = decodeQr(vectors.qr.full.text)
    expect(bytesToHex(q.evidenceKey!)).toBe(vectors.cipher.key)
    expect(q.evidence).toEqual({ eventId: q.evidence!.eventId, relayHint: 'wss://relay.example' })
    const rep = verifySummary(q.receipt, { kind: 'qr', proof: q.presenter! }, { nowSeconds: NOW })
    expect(rep.verdict).toBe('VERIFIED_SUMMARY_ONLY')
    expect(rep.presenter).toBe('PRESENTER_IS_PAYER')
    expect(decodeQr(vectors.qr.exportNoKey.text).evidenceKey).toBeNull()
  })

  it('base64url matches Java (no padding, URL alphabet)', () => {
    for (let n = 0; n < 10; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 251) & 0xff)
      expect(Buffer.from(b).toString('base64url')).toBe(toBase64Url(b))
      expect(fromBase64Url(toBase64Url(b))).toEqual(b)
    }
    expect(() => fromBase64Url('a')).toThrow()
    expect(() => fromBase64Url('ab+/')).toThrow()
  })

  it('rejects non-receipts and bad payloads', () => {
    expect(() => decodeQr('cashuB...')).toThrow('not a receipt payload')
    expect(() => decodeQr('imrc1:***')).toThrow('base64url')
    expect(() => decodeQr(`imrc1:${toBase64Url(new TlvWriter().hex(2, '00').toBytes())}`)).toThrow('no summary')
    expect(() => makeLocator('00'.repeat(32), 'https://x')).toThrow()
    expect(makeLocator('00'.repeat(32), `wss://${'a'.repeat(64)}`).relayHint).toBeNull()
  })
})

describe('verifySummary mirrors ReceiptVerifier.verifySummary on every Java case', () => {
  for (const c of vectors.verifyCases) {
    it(c.name, () => {
      const receipt: SignedReceipt = {
        summaryBytes: hexToBytes(c.summaryHex),
        payerSignature: c.payerSignature ?? null,
        countersignature: 'countersignature' in c && c.countersignature ? c.countersignature : null,
      }
      const presenter: PresenterInput = 'presenter' in c && c.presenter ? { kind: 'qr', proof: c.presenter } : { kind: 'none' }
      const rep = verifySummary(receipt, presenter, { nowSeconds: NOW })
      expect(rep.verdict).toBe(c.verdict)
      expect(rep.presenter).toBe(c.presenterResult)
      const outcomes = Object.fromEntries(CHECK_ORDER.filter((k) => rep.checks[k]).map((k) => [k, rep.checks[k]!.outcome]))
      expect(outcomes).toEqual(c.checks)
      expect(rep.warnings).toEqual(c.warnings)
    })
  }
})

describe('signing here, verifying here (round trips and tampering)', () => {
  it('payer signs, payee countersigns, then any changed byte is Invalid', async () => {
    const s = fromJson(vectors.summaries.full)
    let r = await signByPayer(s, payer)
    expect(verifySummary(r, undefined, { nowSeconds: NOW }).verdict).toBe('UNACKNOWLEDGED')
    r = withCountersignature(r, await signCountersignature(s, NOW, true, payee))
    expect(verifySummary(r, undefined, { nowSeconds: NOW }).verdict).toBe('VERIFIED_SUMMARY_ONLY')
    // At most one countersignature is kept.
    expect(withCountersignature(r, await signCountersignature(s, NOW + 5, true, payee))).toBe(r)
    for (let i = 0; i < r.summaryBytes.length; i += 7) {
      const b = Uint8Array.from(r.summaryBytes)
      b[i] ^= 0x01
      expect(verifySummary({ ...r, summaryBytes: b }, undefined, { nowSeconds: NOW }).verdict).toBe('INVALID')
    }
  })

  it('refuses to sign for a key the summary does not name', async () => {
    const s = fromJson(vectors.summaries.full)
    await expect(signByPayer(s, other)).rejects.toThrow()
    await expect(signCountersignature(s, NOW, true, other)).rejects.toThrow()
    expect(() => unsignedReceipt(s)).toThrow()
  })

  it('challenge answers round trip', async () => {
    const s = fromJson(vectors.summaries.full)
    const nonce = 'ab'.repeat(32)
    expect(verifyChallengeAnswer(s, nonce, await answerChallenge(s.paymentId, nonce, payer))).toBe(true)
    expect(verifyChallengeAnswer(s, nonce, await answerChallenge(s.paymentId, nonce, other))).toBe(false)
  })
})

describe('buildPayerReceipt', () => {
  const send: SendEvidence = {
    mint: 'https://mint-a.example',
    unit: 'sat',
    proofs: vectors.evidence.proofs.map((p) => ({ mint: p.mint, id: p.id, amount: p.amount, secret: p.secret, C: p.C, dleq: p.dleq ?? null })),
  }

  it('reproduces the Java evidence, digest and payment id, and payer-signs', async () => {
    const built = await buildPayerReceipt(send, vectors.keys.payeePub, null, vectors.summaries.minimal.paidAt, payer)
    expect(bytesToHex(built.evidenceBytes)).toBe(vectors.evidence.encodedHex)
    expect(built.summary.paymentId).toBe(vectors.paymentId.paymentId)
    expect(built.summary.amount).toBe(42)
    expect(bytesToHex(built.receipt.summaryBytes)).toBe(vectors.summaries.minimal.tlvHex)
    const rep = verifySummary(built.receipt, undefined, { nowSeconds: NOW })
    expect(rep.checks.PAYER_SIGNATURE?.outcome).toBe('PASS')
    expect(rep.verdict).toBe('UNACKNOWLEDGED')
    const qr = encodeQr({ receipt: built.receipt, presenter: await signPresenterProof(built.summary.paymentId, NOW, payer), evidence: null, evidenceKey: null })
    expect(decodeQr(qr).receipt.payerSignature).toBe(built.receipt.payerSignature)
  })

  it('falls back to the top-level mint when a proof has none', async () => {
    const one: SendEvidence = { mint: 'https://m.example', unit: 'sat', proofs: [{ id: '00aa', amount: 4, secret: 's', C: `02${'11'.repeat(32)}` }] }
    const built = await buildPayerReceipt(one, vectors.keys.payeePub, 'order 7', NOW, payer)
    expect(built.summary.mints).toEqual(['https://m.example'])
    expect(built.summary.reference).toBe('order 7')
  })
})

/**
 * FR-002a: the payer's memo travels in the signed summary (tag 14), so any scanner, a till too,
 * shows what the payment was for. Older readers skip the tag; the payee's acknowledgement does not
 * cover it; and it is fitted before signing so the receipt always fits a QR.
 */
describe('the payer memo (tag 14)', () => {
  const base = fromJson(vectors.summaries.full)

  it('round-trips, after every other tag, and is absent when empty', () => {
    const s = { ...base, memo: 'Two coffees, table 4 café' }
    const bytes = encodeSummary(s)
    const tags = readTlv(bytes).map((f) => f.tag)
    expect(tags[tags.length - 1]).toBe(14)
    expect(decodeSummary(bytes)).toEqual(s)
    expect(bytesToHex(encodeSummary({ ...base, memo: '' }))).toBe(vectors.summaries.full.tlvHex)
    expect(decodeSummary(hexToBytes(vectors.summaries.full.tlvHex)).memo).toBe('')
  })

  it('a reader that does not know tag 14 still decodes the rest, and the signature covers it', async () => {
    const s = { ...base, memo: 'Order 7' }
    const signed = await signByPayer(s, payer)
    expect(verifySummary(signed, undefined, { nowSeconds: NOW }).checks.PAYER_SIGNATURE?.outcome).toBe('PASS')
    // Change the memo bytes after signing: the payer signature no longer verifies.
    const tampered = { ...signed, summaryBytes: encodeSummary({ ...s, memo: 'Order 8' }) }
    expect(verifySummary(tampered, undefined, { nowSeconds: NOW }).checks.PAYER_SIGNATURE?.outcome).toBe('FAIL')
  })

  it('the acknowledgement does not cover it: the same countersignature verifies with or without', async () => {
    const at = vectors.acks.claimedAt
    expect(bytesToHex(encodeAck({ ...base, memo: 'anything' }, at))).toBe(vectors.acks.fullNamesPayer)
    const cs = await signCountersignature(base, at, true, payee)
    expect(verifyCountersignature(cs, { ...base, memo: 'Two coffees' })).toBe(true)
  })

  it('refuses an oversized memo on encode', () => {
    expect(() => encodeSummary({ ...base, memo: 'x'.repeat(65) })).toThrow(/memo/)
  })

  it('buildPayerReceipt signs the fitted memo', async () => {
    const send: SendEvidence = {
      mint: 'https://mint-a.example',
      unit: 'sat',
      proofs: vectors.evidence.proofs.map((p) => ({ mint: p.mint, id: p.id, amount: p.amount, secret: p.secret, C: p.C, dleq: p.dleq ?? null })),
    }
    const built = await buildPayerReceipt(send, vectors.keys.payeePub, null, NOW, payer, '  Two   coffees ')
    expect(built.summary.memo).toBe('Two coffees')
    expect(decodeSummary(built.receipt.summaryBytes).memo).toBe('Two coffees')
  })
})

describe('fitMemo: the receipt always fits a QR', () => {
  // Near the limit without a memo: two long mints and a full request id, no items or refund.
  const wide = makeSummary({
    ...vectors.summaries.full,
    rail: 'cashu',
    itemsCommitment: null,
    refundOf: null,
    reference: 'a1b2c3d4e5f60718',
    mints: ['https://mint-one.example.org', 'https://mint-two.example.org'],
  })

  it('keeps a short memo as written, whitespace tidied', () => {
    expect(fitMemo(base(), ' Two\n coffees ')).toBe('Two coffees')
    expect(fitMemo(base(), '   ')).toBe('')
    expect(fitMemo(base(), null)).toBe('')
  })

  it('cuts a long memo on a code point, within 64 bytes, ending in an ellipsis', () => {
    const m = fitMemo(base(), 'é'.repeat(100))
    expect(new TextEncoder().encode(m).length).toBeLessThanOrEqual(64)
    expect(m.endsWith('…')).toBe(true)
    expect(m).toMatch(/^é+…$/)
  })

  it('with a wide summary, the longest memo is cut so a full QR still fits the limit', async () => {
    const memo = fitMemo(wide, '🍕'.repeat(40))
    expect(memo).not.toBe('')
    expect(memo.endsWith('…')).toBe(true)
    const s = { ...wide, memo }
    const signed = withCountersignature(await signByPayer(s, payer), await signCountersignature(s, NOW, true, payee))
    const qr = encodeQr({
      receipt: signed,
      presenter: await signPresenterProof(s.paymentId, NOW, payer),
      evidence: makeLocator('ab'.repeat(32), 'wss://' + 'r'.repeat(58)),
      evidenceKey: new Uint8Array(32),
    })
    expect(decodeQr(qr).receipt.summaryBytes).toEqual(signed.summaryBytes)
  })

  it('a summary with no room left drops the memo rather than make a receipt that cannot be shown', () => {
    const full = makeSummary({ ...vectors.summaries.full, rail: 'cashu', reference: 'r'.repeat(80), mints: ['https://a.example.org/' + 'x'.repeat(40), 'https://b.example.org/' + 'x'.repeat(40)] })
    expect(fitMemo(full, 'Two coffees')).toBe('')
  })

  function base() {
    return fromJson(vectors.summaries.minimal)
  }
})
