import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools'
import {
  bytesToHex,
  encodeEvidence,
  makeSummary,
  newEvidenceKey,
  paymentId,
  publicKeyOf,
  RAIL_CASHU,
  secretKeySigner,
  signByPayer,
  type CashuProofEvidence,
  type StoredReceipt,
} from '@imani/receipts'
import {
  backupAddress,
  BACKUP_KIND,
  CHUNK_BYTES,
  EVIDENCE_KIND,
  fetchEvidenceBlob,
  publishEvidenceBlob,
  restoreBackups,
  saveBackup,
  type NostrIo,
} from '../nostrPorts'
import { openReceiptStore } from '../store'
import * as service from '../service'
import { createReceiptTelemetry, isKnown } from '../telemetry'

/** An in-memory relay plus gateway cache: what `publish` stores, `query` answers. */
function memoryIo(opts: { refuse?: boolean } = {}): NostrIo & { events: Event[] } {
  const events: Event[] = []
  return {
    events,
    publish: async (e) => {
      if (opts.refuse) return 0
      events.push(e)
      return 1
    },
    query: async (f) =>
      events.filter(
        (e) =>
          (!f.ids || (f.ids as string[]).includes(e.id)) &&
          (!f.kinds || (f.kinds as number[]).includes(e.kind)) &&
          (!f.authors || (f.authors as string[]).includes(e.pubkey)),
      ),
  }
}

const rand = (n: number) => {
  const out = new Uint8Array(n)
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(out.subarray(o, Math.min(n, o + 65536)))
  return out
}

describe('evidence blobs (kind 9740, Java NostrEvidenceStore)', () => {
  it('round-trips an inline blob', async () => {
    const io = memoryIo()
    const blob = rand(1000)
    const loc = await publishEvidenceBlob(io, blob, null, 1_800_000_000)
    expect(io.events).toHaveLength(1)
    expect(io.events[0].kind).toBe(EVIDENCE_KIND)
    expect(await fetchEvidenceBlob(io, loc.eventId)).toEqual(blob)
  })

  it('round-trips a chunked blob and refuses a tampered chunk', async () => {
    const io = memoryIo()
    const blob = rand(CHUNK_BYTES * 2 + 17)
    const loc = await publishEvidenceBlob(io, blob, 'wss://r', 1_800_000_000)
    expect(io.events).toHaveLength(4)
    expect(loc.relayHint).toBe('wss://r')
    expect(await fetchEvidenceBlob(io, loc.eventId)).toEqual(blob)
    // Re-sign chunk 1 under another key: pubkey mismatch, so not intact.
    const chunk = io.events[1]
    const forged = finalizeEvent({ kind: chunk.kind, content: chunk.content, tags: chunk.tags, created_at: chunk.created_at }, generateSecretKey())
    io.events[1] = { ...forged, id: chunk.id }
    expect(await fetchEvidenceBlob(io, loc.eventId)).toBeNull()
  })

  it('is null when absent and throws when no relay takes it', async () => {
    expect(await fetchEvidenceBlob(memoryIo(), 'ab'.repeat(32))).toBeNull()
    await expect(publishEvidenceBlob(memoryIo({ refuse: true }), rand(10), null, 1)).rejects.toThrow()
  })
})

function proof(i: number, lockedTo?: string): CashuProofEvidence {
  const secret = lockedTo ? JSON.stringify(['P2PK', { nonce: `n${i}`, data: '02' + lockedTo, tags: [] }]) : `secret-${i}`
  return { mint: 'https://mint.test', keysetId: '00ab', amount: 4, secret, c: '02' + '11'.repeat(32), dleqE: 'aa'.repeat(32), dleqS: 'bb'.repeat(32), dleqR: 'cc'.repeat(32) }
}

async function aReceipt(sk: Uint8Array, payee: string, big = false): Promise<StoredReceipt> {
  const proofs = Array.from({ length: big ? 1500 : 2 }, (_, i) => ({ ...proof(i), secret: big ? bytesToHex(rand(32)) : `secret-${i}` }))
  const evidence = encodeEvidence({ rail: RAIL_CASHU, proofs })
  const { hashToCurveY, evidenceDigest } = await import('@imani/receipts')
  const s = makeSummary({
    paymentId: paymentId(proofs.map((p) => hashToCurveY(p.secret))),
    rail: RAIL_CASHU,
    payer: publicKeyOf(sk),
    payee,
    amount: proofs.length * 4,
    unit: 'sat',
    mints: ['https://mint.test'],
    paidAt: 1_800_000_000,
    evidenceDigest: evidenceDigest(evidence),
  })
  const receipt = await signByPayer(s, secretKeySigner(sk))
  return { role: 'PAYER', receipt, evidence, evidenceKey: newEvidenceKey(), locator: null, refunds: [], notes: [], showable: true }
}

describe('receipt backup (kind 30740, Java NostrReceiptBackup)', () => {
  const sk = generateSecretKey()
  const me = getPublicKey(sk)
  const withKey = <T,>(use: (k: Uint8Array) => T) => use(sk)

  it('saves and restores, single and multipart, and hides the payment id', async () => {
    const io = memoryIo()
    const small = await aReceipt(sk, 'ee'.repeat(32))
    const big = await aReceipt(sk, 'ee'.repeat(32), true)
    await saveBackup(io, withKey, small, 1_800_000_000)
    await saveBackup(io, withKey, big, 1_800_000_000)
    expect(io.events.every((e) => e.kind === BACKUP_KIND)).toBe(true)
    expect(io.events.length).toBeGreaterThan(2)
    const { decodeSummary } = await import('@imani/receipts')
    const id = decodeSummary(small.receipt.summaryBytes).paymentId
    expect(JSON.stringify(io.events)).not.toContain(id)
    expect(io.events[0].tags[0]).toEqual(['d', backupAddress(sk, id)])
    const { restored, unreadable } = await restoreBackups(io, withKey, me)
    expect(unreadable).toBe(0)
    const ids = restored.map((r) => decodeSummary(r.receipt.summaryBytes).paymentId).sort()
    expect(ids).toEqual([id, decodeSummary(big.receipt.summaryBytes).paymentId].sort())
    expect(restored.find((r) => bytesToHex(r.evidence) === bytesToHex(big.evidence))).toBeTruthy()
  })

  it('counts a part it cannot read as unreadable', async () => {
    const io = memoryIo()
    io.events.push(finalizeEvent({ kind: BACKUP_KIND, content: 'garbage', tags: [['d', 'x']], created_at: 1 }, sk))
    expect((await restoreBackups(io, withKey, me)).unreadable).toBe(1)
  })
})

describe('service against the IndexedDB store', () => {
  const payerSk = generateSecretKey()
  const payeeSk = generateSecretKey()
  const payee = getPublicKey(payeeSk)

  function ports(store: Awaited<ReturnType<typeof openReceiptStore>>, states: () => service.ProofState[], counted: string[]): service.ReceiptPorts {
    return {
      store,
      publicKey: getPublicKey(payerSk),
      signer: () => secretKeySigner(payerSk),
      mayAcknowledgeUnattended: () => true,
      checkState: async (_m, ys) => ys.map((_, i) => states()[i] ?? 'UNSPENT'),
      count: (e, o) => counted.push(`${e}:${o}`),
      walletKind: () => 'PERSONAL',
      acknowledgementSetting: () => null,
      now: () => 1_800_000_100,
      changed: () => undefined,
    }
  }

  const send = (lock?: string) => ({
    mint: 'https://mint.test',
    unit: 'sat',
    proofs: [0, 1].map((i) => {
      const p = proof(i, lock)
      return { id: p.keysetId, amount: p.amount, secret: p.secret, C: p.c, dleq: { e: p.dleqE!, s: p.dleqS!, r: p.dleqR! } }
    }),
  })

  it('captures once, waits for SPENT, then builds a signed receipt', async () => {
    const store = await openReceiptStore(`t-${Math.random()}`)
    const counted: string[] = []
    let state: service.ProofState = 'UNSPENT'
    const p = ports(store, () => [state, state], counted)
    const input = { sendEvidence: send(payee), payeeKey: payee, paidAt: 1_800_000_000, txId: 'sent:x' }
    expect(await service.captureSendEvidence(p, input)).toBe('captured')
    expect(await service.captureSendEvidence(p, input)).toBe('duplicate')
    expect(counted).toEqual(['payment:locked_dleq'])
    expect((await service.settlePending(p)).built).toBe(0)
    expect((await store.allPending())[0].state).toBe('PENDING_SETTLEMENT')
    state = 'SPENT'
    expect((await service.settlePending(p)).built).toBe(1)
    const r = await store.byTx('sent:x')
    expect(r?.receipt.role).toBe('PAYER')
    expect(r?.receipt.receipt.payerSignature).toBeTruthy()
    expect(r?.receipt.showable).toBe(true)
  })

  it('records no_dleq as payment:none and skips expired', async () => {
    const store = await openReceiptStore(`t-${Math.random()}`)
    const counted: string[] = []
    const p = ports(store, () => [], counted)
    expect(await service.captureSendEvidence(p, { sendEvidenceState: 'no_dleq', payeeKey: payee, paidAt: 1 })).toBe('no_receipt')
    expect(await service.captureSendEvidence(p, { sendEvidenceState: 'expired', payeeKey: payee, paidAt: 1 })).toBe('skipped')
    expect(counted).toEqual(['payment:none'])
  })

  it('keeps a receipt pending as signer_unsupported when locked', async () => {
    const store = await openReceiptStore(`t-${Math.random()}`)
    const p = { ...ports(store, () => ['SPENT', 'SPENT'], []), signer: () => null }
    await service.captureSendEvidence(p, { sendEvidence: send(), payeeKey: payee, paidAt: 1 })
    expect((await service.settlePending(p)).built).toBe(0)
    expect((await store.allPending())[0].reason).toBe('signer_unsupported')
  })
})

describe('telemetry vocabulary', () => {
  it('drops unknown pairs and aggregates known ones', async () => {
    const sent: unknown[] = []
    const t = createReceiptTelemetry({ send: async (ev) => (sent.push(ev), 'ok'), doc: null })
    t.count('payment', 'none')
    t.count('payment', 'none')
    t.count('bogus', 'x')
    await t.flush()
    expect(isKnown('bogus', 'x')).toBe(false)
    expect(JSON.stringify(sent)).toContain('payment')
    expect(JSON.stringify(sent)).not.toContain('bogus')
  })
})
