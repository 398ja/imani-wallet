/**
 * @vitest-environment jsdom
 */
/**
 * A till's sale reaches the stall's own history (#160 phase 6, wallet#202, plan 2.1).
 *
 * The till holds no NAP wallet, so its sale row went nowhere: `getWallet()` threw, and
 * `recordSale` swallowed it. Now the till sends the row to the stall as a NIP-17 gift wrap
 * sealed by its own key K, and the owner's app files it only if:
 *
 * - the seal is K, and K is the `lock_key` of the credential inside the row's warrant;
 * - the warrant verifies for THIS stall (`verifyIssuanceWarrant` → `verified`), which checks the
 *   service signature, K's sale signature, and the stall's own attestation of that till.
 *
 * So nobody the stall did not attest can write into its books.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import type { Event } from 'nostr-tools'

import {
  SALE_DM_TYPE,
  WRAP_BLUR_SECONDS,
  collectTillSales,
  flushSaleOutbox,
  pendingTillSales,
  saleMessageJson,
  saleRowsFromRumor,
  sendTillSale,
} from '../tillSales'
import { unwrapSealed, wrapMessage, type Rumor } from '../terminalDelivery'
import { NOTE_MAX_CHARS } from '../note'
import { toContent } from '../txRecords'
import { buildCashbackTransaction, buildIssueTransaction, toTransaction } from '../transactions'
import { warrantSaleDigest } from '../issuanceWarrant'
import { parseCredentialSecret } from '../terminalWarrant'
import { signOwnerAttestation } from '../ownerAttestation'
import { recordTerminal } from '../terminalRoster'
import type { TransactionRow } from '@imani/wallet-storage'

const SERVICE_SK = '11'.repeat(32)
const SERVICE = bytesToHex(schnorr.getPublicKey(hexToBytes(SERVICE_SK)))
const STALL_SK = '22'.repeat(32)
const STALL = bytesToHex(schnorr.getPublicKey(hexToBytes(STALL_SK)))
const TILL_SK = '33'.repeat(32)
const TILL = bytesToHex(schnorr.getPublicKey(hexToBytes(TILL_SK)))
const STRANGER_SK = '44'.repeat(32)
const STRANGER = bytesToHex(schnorr.getPublicKey(hexToBytes(STRANGER_SK)))
const OTHER_STALL_SK = '55'.repeat(32)
const OTHER_STALL = bytesToHex(schnorr.getPublicKey(hexToBytes(OTHER_STALL_SK)))

/** A credential the service minted to `lock` for `stall`, attested by the stall unless told not to. */
function credentialSecret(o: { stall?: string; stallSk?: string; lock?: string; attested?: boolean; name?: string } = {}): string {
  const stall = o.stall ?? STALL
  const lock = o.lock ?? TILL
  const signer = { pubkey: stall, withPrivkey: <T,>(f: (k: Uint8Array) => T) => f(hexToBytes(o.stallSk ?? STALL_SK)) }
  const owner_attestation = signOwnerAttestation(
    { stallPubkey: stall, lockKey: lock, role: 'issue-and-redeem', expiresAt: 4_000_000_000 },
    signer,
  )
  const metadata = JSON.stringify({
    terminal: true,
    stall_pubkey: stall,
    role: 'issue-and-redeem',
    lock_key: lock,
    ...(o.name ? { name: o.name } : {}),
    ...(o.attested === false ? {} : { owner_attestation }),
  })
  const tags = [
    ['voucher_id', 'cred-1'], ['issuer', stall], ['unit', 'sat'], ['face_value', '1'],
    ['expires_at', '4000000000'], ['merchant_metadata', metadata],
  ]
  const body = { nonce: 'ab', data: '02' + lock, tags }
  const signed = parseCredentialSecret(JSON.stringify(['P2PK_VOUCHER', body]))!.signed
  const sig = bytesToHex(schnorr.sign(sha256(signed), hexToBytes(SERVICE_SK)))
  body.tags = [...tags, ['issuer_sig', sig], ['issuer_pubkey', SERVICE]]
  return JSON.stringify(['P2PK_VOUCHER', body])
}

function terminalWarrant(o: { total?: number; signerSk?: string; secret?: string; stall?: string } = {}): string {
  const total = o.total ?? 400
  const nonce = 'n-' + Math.random().toString(16).slice(2)
  const digest = warrantSaleDigest(o.stall ?? STALL, total, 2, 'EUR', nonce)
  return JSON.stringify({
    form: 'terminal', sale_total: total, face_decimals: 2, unit: 'EUR', nonce,
    signature: bytesToHex(schnorr.sign(digest, hexToBytes(o.signerSk ?? TILL_SK))),
    credential: o.secret ?? credentialSecret(),
  })
}

function saleRow(warrant = terminalWarrant(), voucherId = 'v-1', amount = 400): TransactionRow {
  return buildIssueTransaction({
    voucherId, amount, unit: 'EUR', decimals: 2, recipientPubkey: 'cc'.repeat(32), at: 1_786_891_362_412,
    terminalPubkey: TILL, issuanceWarrant: warrant, merchantId: STALL,
  })
}

/** What the owner sees: the wrap the till sealed with `sealSk`, unwrapped with the stall key. */
function received(content: string, sealSk = TILL_SK): { rumor: Rumor; sealer: string } {
  const opened = unwrapSealed(wrapMessage(hexToBytes(sealSk), STALL, content), hexToBytes(STALL_SK))
  if (!opened) throw new Error('did not open')
  return opened
}

const opts = { trustedServiceKeys: [SERVICE] }

describe('the owner files a till sale only when the stall attested that till', () => {
  it('accepts a genuine sale, attributed to the sealer, under the id the till would have used', () => {
    const { rumor, sealer } = received(saleMessageJson([saleRow()], 'cred-1'))
    const out = saleRowsFromRumor(rumor, sealer, STALL, opts)
    expect(out).not.toBeNull()
    expect(out!.refused).toEqual([])
    expect(out!.rows).toHaveLength(1)
    const tx = toTransaction(out!.rows[0])
    expect(out!.rows[0].id).toBe('issued:v-1')
    expect(tx.terminalPubkey).toBe(TILL)
    expect(tx.merchantId).toBe(STALL)
    expect(tx.amount).toBe(400)
    expect(tx.type).toBe('issued')
  })

  it('attributes to the key that sealed it, whatever till the row claims, and files it as this stall', () => {
    const lying = { ...saleRow(), terminalPubkey: STRANGER, merchantId: OTHER_STALL } as unknown as TransactionRow
    const { rumor, sealer } = received(saleMessageJson([lying], 'cred-1'))
    const out = saleRowsFromRumor(rumor, sealer, STALL, opts)!
    expect(toTransaction(out.rows[0]).terminalPubkey).toBe(TILL)
    expect(toTransaction(out.rows[0]).merchantId).toBe(STALL)
  })

  it('accepts a cashback issued on the till, under its cashback id', () => {
    const cashback = buildCashbackTransaction({
      cashbackId: 'cb-9', claimCode: 'WXYZ', amount: 150, unit: 'EUR', decimals: 2, at: 1,
      issuanceWarrant: terminalWarrant({ total: 150 }), merchantId: STALL, terminalPubkey: TILL,
    })
    const { rumor, sealer } = received(saleMessageJson([cashback], 'cred-1'))
    const out = saleRowsFromRumor(rumor, sealer, STALL, opts)!
    expect(out.rows.map((r) => r.id)).toEqual(['cashback:cb-9'])
    expect(toTransaction(out.rows[0]).claimCode).toBe('WXYZ')
    expect(toTransaction(out.rows[0]).terminalPubkey).toBe(TILL)
  })

  it('refuses a wrap sealed by anyone other than the credential lock (mutant: drop the sealer check)', () => {
    // The stranger replays a real till's row: the warrant verifies, but the stranger is not K.
    const { rumor, sealer } = received(saleMessageJson([saleRow()], 'cred-1'), STRANGER_SK)
    expect(sealer).toBe(STRANGER)
    const out = saleRowsFromRumor(rumor, sealer, STALL, opts)!
    expect(out.rows).toEqual([])
    expect(out.refused).toEqual([{ id: 'issued:v-1', reason: 'sealer-not-lock' }])
  })

  it('refuses a warrant that fails for this stall (mutant: drop the warrant check)', () => {
    // A self-made till: credential for K, but the stall never attested it.
    const unattested = terminalWarrant({ secret: credentialSecret({ attested: false }) })
    const forged = terminalWarrant({ signerSk: STRANGER_SK })
    const otherStalls = terminalWarrant({
      stall: OTHER_STALL, secret: credentialSecret({ stall: OTHER_STALL, stallSk: OTHER_STALL_SK }),
    })
    const { rumor, sealer } = received(
      saleMessageJson([saleRow(unattested, 'v-a'), saleRow(forged, 'v-b'), saleRow(otherStalls, 'v-c')], 'cred-1'),
    )
    const out = saleRowsFromRumor(rumor, sealer, STALL, opts)!
    expect(out.rows).toEqual([])
    expect(out.refused.map((r) => r.reason)).toEqual(['warrant-unwarranted', 'warrant-failed', 'warrant-failed'])
  })

  it('refuses a row with no terminal warrant, and one claiming more than its warrant', () => {
    const none = buildIssueTransaction({ voucherId: 'v-n', amount: 1, unit: 'EUR', decimals: 2, recipientPubkey: 'c', at: 1 })
    const { rumor, sealer } = received(saleMessageJson([none, saleRow(terminalWarrant({ total: 100 }), 'v-big', 999)], 'c'))
    const out = saleRowsFromRumor(rumor, sealer, STALL, opts)!
    expect(out.rows).toEqual([])
    expect(out.refused.map((r) => r.reason)).toEqual(['not-a-terminal-sale', 'warrant-failed'])
  })

  it('ignores a gift wrap that is not a sale record', () => {
    const { rumor, sealer } = received(JSON.stringify({ type: 'imani-terminal-enrolled/1' }))
    expect(saleRowsFromRumor(rumor, sealer, STALL, opts)).toBeNull()
  })

  it('names the wire type', () => {
    expect(JSON.parse(saleMessageJson([saleRow()], 'cred-1')).type).toBe(SALE_DM_TYPE)
  })
})

describe('the till sends, and keeps what did not land', () => {
  beforeEach(() => localStorage.clear())

  const tillSeal = <T,>(borrow: (k: Uint8Array) => T) => borrow(hexToBytes(TILL_SK))

  it('sends one wrap to the stall, sealed by K, and needs no wallet', async () => {
    const sent: Event[] = []
    const ok = await sendTillSale([saleRow()], STALL, 'cred-1', tillSeal, {
      publish: async (w) => (sent.push(w), true),
    })
    expect(ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].tags).toEqual([['p', STALL]])
    const opened = unwrapSealed(sent[0], hexToBytes(STALL_SK))!
    expect(opened.sealer).toBe(TILL)
    expect(pendingTillSales()).toBe(0)
  })

  // Review rv6 (W1-M1): NIP-17 encrypts twice and NIP-44 pads in steps, so a 12-part sale (about
  // 25 KB of rows) became a 66,045-byte wrap, over strfry's 65,536 maxEventSize (the gc#207 H1
  // step). The relay refused it; only the gateway mirror held it. Every wrap must fit the relay.
  it('splits a large sale so every wrap fits the relay (strfry maxEventSize 65,536)', async () => {
    const w = terminalWarrant()
    const rows = Array.from({ length: 30 }, (_, i) => saleRow(w, `v-${i}-${'x'.repeat(30)}`))
    const sent: Event[] = []
    expect(await sendTillSale(rows, STALL, 'cred-1', tillSeal, { publish: async (e) => (sent.push(e), true) })).toBe(true)
    for (const e of sent) expect(JSON.stringify(e).length).toBeLessThanOrEqual(65_536)
    const filed = sent.flatMap((e) => {
      const o = unwrapSealed(e, hexToBytes(STALL_SK))!
      return saleRowsFromRumor(o.rumor, o.sealer, STALL, opts)!.rows
    })
    expect(filed).toHaveLength(30)
  })

  // Review sh6 (W1-M1 follow-up): the budget counted UTF-16 code units, the relay counts bytes,
  // and the Sell note was uncapped. 30 rows with a 500-character CJK note made a 66,045-byte
  // wrap; one row with a 30,000-character note made 76,965 (one row never splits). Now the
  // budget is UTF-8 bytes and the note is capped at NOTE_MAX_CHARS where the till builds the DM.
  const wrapBytes = (e: Event) => new TextEncoder().encode(JSON.stringify(e)).length
  async function sendWithMemo(memo: string, n: number) {
    const w = terminalWarrant()
    const rows = Array.from({ length: n }, (_, i) => ({ ...saleRow(w, `v-${i}-${'x'.repeat(30)}`), memo }) as TransactionRow)
    const sent: Event[] = []
    expect(await sendTillSale(rows, STALL, 'cred-1', tillSeal, { publish: async (e) => (sent.push(e), true) })).toBe(true)
    const filed = sent.flatMap((e) => {
      const o = unwrapSealed(e, hexToBytes(STALL_SK))!
      return saleRowsFromRumor(o.rumor, o.sealer, STALL, opts)!.rows
    })
    return { sent, filed }
  }

  for (const [label, memo] of [
    ['CJK', '漢'.repeat(500)],
    ['Arabic', 'ع'.repeat(1_000)],
    ['emoji (4-byte)', '😀'.repeat(400)],
    ['quotes and backslashes', '"\\'.repeat(1_000)],
  ] as const) {
    it(`budgets in UTF-8 bytes: 30 rows with a long ${label} note all fit the relay (≤ 55,121 bytes)`, async () => {
      const { sent, filed } = await sendWithMemo(memo, 30)
      for (const e of sent) expect(wrapBytes(e)).toBeLessThanOrEqual(55_121)
      expect(filed).toHaveLength(30)
    })
  }

  it('one row with a note far past the cap still fits one wrap (≤ 55,121 bytes)', async () => {
    const { sent, filed } = await sendWithMemo('a'.repeat(30_000), 1)
    expect(sent).toHaveLength(1)
    expect(wrapBytes(sent[0])).toBeLessThanOrEqual(55_121)
    expect(filed).toHaveLength(1)
  })

  // The cap counts UTF-16 code units, as HTML maxLength and the portal's @Size(max = 280) do, so
  // the most raw UTF-8 a capped note can be is 280 three-byte characters (840 B); 4-byte
  // characters are two units each (140 of them, 560 B). Escaped in the rumor, as the budget
  // measures it, the worst is ~1,960 B (280 control characters at 7 B each, review rw1).
  const MAX_EMOJI = '😀'.repeat(NOTE_MAX_CHARS / 2)
  const MAX_CJK = '漢'.repeat(NOTE_MAX_CHARS)
  for (const [label, memo] of [['4-byte', MAX_EMOJI], ['3-byte', MAX_CJK]] as const) {
    it(`one row with the maximum note of ${label} characters fits one wrap (≤ 55,121 bytes)`, async () => {
      const { sent, filed } = await sendWithMemo(memo, 1)
      expect(sent).toHaveLength(1)
      expect(wrapBytes(sent[0])).toBeLessThanOrEqual(55_121)
      expect(toTransaction(filed[0]).memo).toBe(memo)
    })

    it(`30 rows with the maximum note of ${label} characters all fit (≤ 55,121 bytes)`, async () => {
      const { sent, filed } = await sendWithMemo(memo, 30)
      for (const e of sent) expect(wrapBytes(e)).toBeLessThanOrEqual(55_121)
      expect(filed).toHaveLength(30)
      for (const r of filed) expect(toTransaction(r).memo).toBe(memo)
    })
  }

  // Review rw1: the cap alone kept every test above green with the budget back on `.length`. The
  // note is not the only non-ASCII text in a row: the warrant carries the credential, and the
  // credential carries the till's NAME, which the owner types and nothing caps. With the budget in
  // UTF-16 units, 30 rows at a capped CJK note made 66,045 bytes with a 40-character CJK till name
  // and 76,965 with 400. In bytes, every wrap stays at 55,121.
  for (const nameLen of [40, 400]) {
    it(`budgets in UTF-8 bytes beyond the note: a ${nameLen}-character CJK till name (≤ 55,121 bytes)`, async () => {
      const w = terminalWarrant({ secret: credentialSecret({ name: '收'.repeat(nameLen) }) })
      const rows = Array.from({ length: 30 }, (_, i) => ({ ...saleRow(w, `v-${i}`), memo: MAX_CJK }) as TransactionRow)
      const sent: Event[] = []
      expect(await sendTillSale(rows, STALL, 'cred-1', tillSeal, { publish: async (e) => (sent.push(e), true) })).toBe(true)
      for (const e of sent) expect(wrapBytes(e)).toBeLessThanOrEqual(55_121)
      const filed = sent.flatMap((e) => {
        const o = unwrapSealed(e, hexToBytes(STALL_SK))!
        return saleRowsFromRumor(o.rumor, o.sealer, STALL, opts)!.rows
      })
      expect(filed).toHaveLength(30)
    })
  }

  it('caps the note where the till builds the sale record, never splitting a character', () => {
    const memoOf = (memo: string) =>
      (JSON.parse(saleMessageJson([{ ...saleRow(), memo } as TransactionRow], 'cred-1')) as { rows: Array<{ memo?: string }> }).rows[0].memo!
    expect(memoOf('😀'.repeat(NOTE_MAX_CHARS))).toBe(MAX_EMOJI)
    // An odd cut lands inside a surrogate pair: the whole character goes, never half of it.
    const odd = memoOf('a' + '😀'.repeat(NOTE_MAX_CHARS))
    expect(odd).toBe('a' + '\u{1F600}'.repeat(NOTE_MAX_CHARS / 2 - 1))
    expect(odd.length).toBeLessThanOrEqual(NOTE_MAX_CHARS)
    expect(memoOf('a'.repeat(30_000))).toHaveLength(NOTE_MAX_CHARS)
    expect(memoOf('short note')).toBe('short note')
  })

  it('queues a wrap that landed nowhere, and the next flush sends exactly it', async () => {
    const ok = await sendTillSale([saleRow()], STALL, 'cred-1', tillSeal, { publish: async () => false })
    expect(ok).toBe(false)
    expect(pendingTillSales()).toBe(1)

    // Still offline: kept.
    expect(await flushSaleOutbox(tillSeal, { publish: async () => false })).toBe(0)
    expect(pendingTillSales()).toBe(1)

    const later: Event[] = []
    expect(await flushSaleOutbox(tillSeal, { publish: async (w) => (later.push(w), true) })).toBe(1)
    expect(pendingTillSales()).toBe(0)
    expect(unwrapSealed(later[0], hexToBytes(STALL_SK))!.sealer).toBe(TILL)
  })

  it('a publisher that throws is a wrap that did not land, never a failed sale', async () => {
    await expect(
      sendTillSale([saleRow()], STALL, 'cred-1', tillSeal, { publish: async () => { throw new Error('down') } }),
    ).resolves.toBe(false)
    expect(pendingTillSales()).toBe(1)
  })
})

describe('the owner collects till sales from its inbox', () => {
  beforeEach(() => localStorage.clear())

  function harness(wraps: Event[]) {
    const written = new Map<string, TransactionRow>()
    const queries: Array<number | undefined> = []
    const deps = {
      wraps: async (_p: string, since?: number) => (queries.push(since), wraps),
      open: (w: Event) => unwrapSealed(w, hexToBytes(STALL_SK)),
      has: async (id: string) => written.has(id),
      write: async (row: TransactionRow) => void written.set(row.id as string, row),
      trustedServiceKeys: [SERVICE],
      now: 2_000_000_000_000,
    }
    return { written, queries, deps }
  }

  it('files each verified row once, however often it runs (idempotent)', async () => {
    const wrap = wrapMessage(hexToBytes(TILL_SK), STALL, saleMessageJson([saleRow()], 'cred-1'))
    const { written, deps } = harness([wrap, wrap])
    expect(await collectTillSales(STALL, deps)).toBe(1)
    expect(await collectTillSales(STALL, deps)).toBe(0)
    expect([...written.keys()]).toEqual(['issued:v-1'])
  })

  // Review rw1: the clamp is the till's, not the owner's. A wrap from a till built before the cap
  // (76,965 bytes, so the relay refused it and only the gateway mirror kept it) still arrives by
  // the mirror, and is filed whole, its long note intact. Garbage that size is skipped, not thrown.
  it('files an oversize wrap from a till built before the note cap, whole, and skips oversize garbage', async () => {
    const legacy = JSON.stringify({
      type: SALE_DM_TYPE,
      rows: [toContent(toTransaction({ ...saleRow(), memo: 'a'.repeat(30_000) } as TransactionRow))],
      credential_voucher_id: 'cred-1',
    })
    const wrap = wrapMessage(hexToBytes(TILL_SK), STALL, legacy)
    expect(new TextEncoder().encode(JSON.stringify(wrap)).length).toBeGreaterThan(65_536)
    const garbage = wrapMessage(hexToBytes(STRANGER_SK), STALL, 'x'.repeat(200_000))
    const { written, deps } = harness([garbage, { ...garbage, id: 'f'.repeat(64), content: 'A'.repeat(200_000) }, wrap])
    expect(await collectTillSales(STALL, deps)).toBe(1)
    expect(toTransaction(written.get('issued:v-1')!).memo).toHaveLength(30_000)
  })

  it("notes the till's last use on the roster", async () => {
    recordTerminal(STALL, { terminalPubkey: TILL, name: 'Sales counter', role: 'issue-and-redeem', enrolledAt: 1 })
    const wrap = wrapMessage(hexToBytes(TILL_SK), STALL, saleMessageJson([saleRow()], 'cred-1'))
    await collectTillSales(STALL, harness([wrap]).deps)
    const rows = JSON.parse(localStorage.getItem(`imani-wallet:terminals:${STALL}`)!) as Array<{ lastUsedAt?: number }>
    // The wire carries seconds, as every 7376 does.
    expect(rows[0].lastUsedAt).toBe(1_786_891_362_000)
  })

  it('reads from a cursor after the first run, and from 24 h before the earliest terminal before it', async () => {
    recordTerminal(STALL, { terminalPubkey: TILL, name: 'S', role: 'issue-and-redeem', enrolledAt: 1_900_000_000_000 })
    const wrap = wrapMessage(hexToBytes(TILL_SK), STALL, saleMessageJson([saleRow()], 'cred-1'))
    const { queries, deps } = harness([wrap])
    await collectTillSales(STALL, deps)
    await collectTillSales(STALL, deps)
    expect(queries[0]).toBe(1_900_000_000 - 24 * 3600)
    expect(queries[1]).toBe(wrap.created_at - WRAP_BLUR_SECONDS)
  })

  // Found by the local gate (E3): NIP-59 backdates a wrap by up to ten minutes. A sale sent after
  // the cursor was set can carry an older created_at than the cursor, so a cursor read from the
  // newest created_at seen skipped it for good. The read goes back by the blur.
  it('still files a sale whose wrap is backdated before the cursor (NIP-59 blur)', async () => {
    const first = { ...wrapMessage(hexToBytes(TILL_SK), STALL, saleMessageJson([saleRow()], 'cred-1')), created_at: 1_900_000_500 }
    const later = { ...wrapMessage(hexToBytes(TILL_SK), STALL, saleMessageJson([saleRow(terminalWarrant(), 'v-2')], 'cred-1')), created_at: 1_900_000_100, id: 'later' }
    const relay = [first]
    const { written, deps } = harness([])
    deps.wraps = async (_p: string, since?: number) => relay.filter((w) => since === undefined || w.created_at >= since)
    await collectTillSales(STALL, deps)
    relay.push(later)
    await collectTillSales(STALL, deps)
    expect([...written.keys()].sort()).toEqual(['issued:v-1', 'issued:v-2'])
  })

  it('files nothing a stranger sealed', async () => {
    const wrap = wrapMessage(hexToBytes(STRANGER_SK), STALL, saleMessageJson([saleRow()], 'cred-1'))
    const { written, deps } = harness([wrap])
    expect(await collectTillSales(STALL, deps)).toBe(0)
    expect(written.size).toBe(0)
  })
})

describe('dm-poll hands a sale record to the collector', () => {
  it('recognises a sale record and nothing else', async () => {
    const { isTillSaleMessage } = await import('../tillSales')
    expect(isTillSaleMessage(saleMessageJson([saleRow()], 'cred-1'))).toBe(true)
    expect(isTillSaleMessage(JSON.stringify({ type: 'cashu_token_transfer' }))).toBe(false)
    expect(isTillSaleMessage('not json')).toBe(false)
  })
})

describe('trigger (b): a filed till sale is checked against the roster (#160 phase 6, W4)', () => {
  beforeEach(() => localStorage.clear())

  it('files the sale and marks it when its credential is not on the list, once synced', async () => {
    localStorage.setItem(`imani-wallet:terminals-synced:${STALL}`, '1')
    recordTerminal(STALL, { terminalPubkey: TILL, name: 'Sales counter', role: 'issue-and-redeem', enrolledAt: 1, voucherId: 'other-cred', token: 't' })
    const wrap = wrapMessage(hexToBytes(TILL_SK), STALL, saleMessageJson([saleRow()], 'cred-1'))
    const written = new Map<string, TransactionRow>()
    const filed = await collectTillSales(STALL, {
      wraps: async () => [wrap],
      open: (w) => unwrapSealed(w, hexToBytes(STALL_SK)),
      has: async (id) => written.has(id),
      write: async (row) => void written.set(row.id as string, row),
      trustedServiceKeys: [SERVICE],
      // The published list does not have it either.
      refreshRoster: async () => true,
    })
    expect(filed).toBe(1)
    expect((written.get('issued:v-1') as unknown as { homecomingAlert?: string }).homecomingAlert).toBe('unknown-till')
  })

  it('does not mark a sale from a till on the list', async () => {
    localStorage.setItem(`imani-wallet:terminals-synced:${STALL}`, '1')
    recordTerminal(STALL, { terminalPubkey: TILL, name: 'Sales counter', role: 'issue-and-redeem', enrolledAt: 1, voucherId: 'cred-1', token: 't' })
    const wrap = wrapMessage(hexToBytes(TILL_SK), STALL, saleMessageJson([saleRow()], 'cred-1'))
    const written = new Map<string, TransactionRow>()
    await collectTillSales(STALL, {
      wraps: async () => [wrap],
      open: (w) => unwrapSealed(w, hexToBytes(STALL_SK)),
      has: async (id) => written.has(id),
      write: async (row) => void written.set(row.id as string, row),
      trustedServiceKeys: [SERVICE],
    })
    expect((written.get('issued:v-1') as unknown as { homecomingAlert?: string }).homecomingAlert).toBeUndefined()
  })
})
