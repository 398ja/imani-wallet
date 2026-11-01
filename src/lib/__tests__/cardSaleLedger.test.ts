/**
 * @vitest-environment jsdom
 */
/**
 * A card sale reaches the stall's own ledger (imani-wallet#275, audit gap D).
 *
 * In Stripe S1 the merchant record for a card voucher read "No record of this voucher" until a
 * ledger row was seeded by hand. The purchase issuer now sends the stall the same
 * `imani-terminal-sale/1` record a till sends, carrying the coupon's `delegated` warrant and
 * sealed by the delegate key. The owner files it only when:
 *
 * - the stall's own delegation inside the warrant verifies (NIP-01 id + sig, kind 30078,
 *   `d` = imani:issuer-delegation, scope `coupon:issue`, signed by THIS stall), in force when
 *   the sale was made;
 * - the seal is the delegation's `p`, the issuer key the stall delegated to;
 * - the delegate's signature over the sale (and its pi_ reference) verifies.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { finalizeEvent } from 'nostr-tools/pure'
import type { Event } from 'nostr-tools'
import type { TransactionRow } from '@imani/wallet-storage'

import { collectTillSales, saleMessageJson, saleRowsFromRumor } from '../tillSales'
import { unwrapSealed, wrapMessage } from '../terminalDelivery'
import { delegatedSaleDigest } from '../issuanceWarrant'
import { issuerDelegationTemplate } from '../issuerDelegation'
import { buildIssueTransaction, toTransaction } from '../transactions'
import { issuedVoucher } from '../issuedVoucher'
import { describeRail } from '../issuedVoucherWording'

const STALL_SK = '22'.repeat(32)
const STALL = bytesToHex(schnorr.getPublicKey(hexToBytes(STALL_SK)))
const ISSUER_SK = '66'.repeat(32)
const ISSUER = bytesToHex(schnorr.getPublicKey(hexToBytes(ISSUER_SK)))
const STRANGER_SK = '44'.repeat(32)
const OTHER_STALL_SK = '55'.repeat(32)
const OTHER_STALL = bytesToHex(schnorr.getPublicKey(hexToBytes(OTHER_STALL_SK)))

const SOLD_AT = 1_800_000_000_000
const REF = 'pi_3UQtCard'

function delegation(o: { stallSk?: string; delegate?: string; scope?: string; expiresAt?: number } = {}): Event {
  const template = issuerDelegationTemplate({
    delegatePubkey: o.delegate ?? ISSUER,
    expiresAt: o.expiresAt ?? 4_000_000_000,
    createdAt: Math.floor(SOLD_AT / 1000) - 3600,
  })
  if (o.scope) template.tags = template.tags.map((t) => (t[0] === 'scope' ? ['scope', o.scope!] : t))
  return finalizeEvent(template, hexToBytes(o.stallSk ?? STALL_SK))
}

function cardWarrant(o: { total?: number; signerSk?: string; delegation?: Event; ref?: string | null } = {}): string {
  const total = o.total ?? 500
  const nonce = 'card-nonce-1'
  const ref = o.ref === undefined ? REF : o.ref
  return JSON.stringify({
    form: 'delegated',
    sale_total: total,
    face_decimals: 2,
    unit: 'GBP',
    nonce,
    sig: bytesToHex(
      schnorr.sign(delegatedSaleDigest(STALL, total, 2, 'GBP', nonce, ref ?? undefined), hexToBytes(o.signerSk ?? ISSUER_SK)),
    ),
    delegation: o.delegation ?? delegation(),
    ...(ref ? { ref } : {}),
  })
}

function cardRow(warrant = cardWarrant(), amount = 500): TransactionRow {
  return buildIssueTransaction({
    voucherId: '8027e345',
    amount,
    unit: 'GBP',
    decimals: 2,
    recipientPubkey: 'cc'.repeat(32),
    at: SOLD_AT,
    issuanceWarrant: warrant,
    merchantId: STALL,
  })
}

function received(content: string, sealSk = ISSUER_SK) {
  const opened = unwrapSealed(wrapMessage(hexToBytes(sealSk), STALL, content), hexToBytes(STALL_SK))
  if (!opened) throw new Error('did not open')
  return opened
}

function read(row: TransactionRow, sealSk = ISSUER_SK) {
  const { rumor, sealer } = received(saleMessageJson([row], 'cred-card'), sealSk)
  return saleRowsFromRumor(rumor, sealer, STALL)!
}

describe('the owner files a card sale sent by its delegated issuer', () => {
  beforeEach(() => localStorage.clear())

  it('files a genuine card sale as this stall, under the voucher id, with no till named', () => {
    const out = read(cardRow())
    expect(out.refused).toEqual([])
    expect(out.rows).toHaveLength(1)
    const tx = toTransaction(out.rows[0])
    expect(out.rows[0].id).toBe('issued:8027e345')
    expect(tx.merchantId).toBe(STALL)
    expect(tx.direction).toBe('out')
    expect(tx.amount).toBe(500)
    // The issuer is not a till: naming it as one would put it on the terminal roster.
    expect(tx.terminalPubkey).toBeUndefined()
  })

  it('shows "Card" and the pi_ reference on the merchant record, as the S1 manual check did', () => {
    const [row] = read(cardRow()).rows
    const record = issuedVoucher([toTransaction(row)], '8027e345', { now: SOLD_AT + 1000, stallPubkey: STALL })
    expect(record?.rail).toEqual({ kind: 'card', reference: REF })
    expect(record?.warrantVerdict).toEqual({ verdict: 'verified' })
    expect(describeRail(record!.rail).label).toBe('Card')
  })

  it('refuses a seal by anyone but the delegated key (mutant: drop the sealer check)', () => {
    const out = read(cardRow(), STRANGER_SK)
    expect(out.rows).toEqual([])
    expect(out.refused).toEqual([{ id: 'issued:8027e345', reason: 'sealer-not-delegate' }])
  })

  it('refuses a delegation another stall signed (stall = this stall)', () => {
    const forged = cardWarrant({ delegation: delegation({ stallSk: OTHER_STALL_SK }) })
    const out = read(cardRow(forged))
    expect(out.rows).toEqual([])
    expect(out.refused[0].reason).toBe('warrant-failed')
  })

  it('refuses a delegation with a tampered id or sig (NIP-01)', () => {
    const d = delegation()
    const tamperedSig = cardWarrant({ delegation: { ...d, sig: d.sig.replace(/^./, d.sig[0] === 'a' ? 'b' : 'a') } })
    const tamperedTags = cardWarrant({ delegation: { ...d, tags: [...d.tags, ['x', '1']] } })
    expect(read(cardRow(tamperedSig)).refused[0].reason).toBe('warrant-failed')
    expect(read(cardRow(tamperedTags)).refused[0].reason).toBe('warrant-failed')
  })

  it('refuses a delegation of any scope but coupon:issue', () => {
    const out = read(cardRow(cardWarrant({ delegation: delegation({ scope: 'coupon:redeem' }) })))
    expect(out.refused[0].reason).toBe('warrant-failed')
  })

  it('refuses a delegation naming another key than the sealer (p = the issuer key)', () => {
    // Signed and sealed by the stranger, under a delegation to the real issuer.
    const out = read(cardRow(cardWarrant({ signerSk: STRANGER_SK })), STRANGER_SK)
    expect(out.rows).toEqual([])
    expect(out.refused[0].reason).toBe('sealer-not-delegate')
  })

  it('refuses a sale signed by a key the delegation does not name', () => {
    const otherDelegate = bytesToHex(schnorr.getPublicKey(hexToBytes(STRANGER_SK)))
    const w = cardWarrant({ delegation: delegation({ delegate: otherDelegate }) })
    // Sealed by the named delegate, but the sale was signed by ISSUER: the signature fails.
    const out = read(cardRow(w), STRANGER_SK)
    expect(out.refused[0].reason).toBe('warrant-failed')
  })

  it('judges the delegation at the sale time, not today', () => {
    const lapsed = cardWarrant({ delegation: delegation({ expiresAt: Math.floor(SOLD_AT / 1000) + 60 }) })
    expect(read(cardRow(lapsed)).rows).toHaveLength(1)
  })

  it('refuses a row claiming more than its warrant', () => {
    expect(read(cardRow(cardWarrant({ total: 500 }), 900)).refused[0].reason).toBe('warrant-failed')
  })

  it('refuses a delegated sale with no processor reference: it is not a card sale', () => {
    const out = read(cardRow(cardWarrant({ ref: null })))
    expect(out.refused[0].reason).toBe('not-a-card-sale')
  })

  it('collectTillSales files it once, and never notes a till on the roster', async () => {
    const wrap = wrapMessage(hexToBytes(ISSUER_SK), STALL, saleMessageJson([cardRow()], 'cred-card'))
    const written = new Map<string, TransactionRow>()
    const deps = {
      wraps: async () => [wrap, wrap],
      open: (w: Event) => unwrapSealed(w, hexToBytes(STALL_SK)),
      has: async (id: string) => written.has(id),
      write: async (row: TransactionRow) => void written.set(row.id as string, row),
      refreshRoster: async () => false,
    }
    expect(await collectTillSales(STALL, deps)).toBe(1)
    expect(await collectTillSales(STALL, deps)).toBe(0)
    expect([...written.keys()]).toEqual(['issued:8027e345'])
    expect(localStorage.getItem(`imani-wallet:terminals:${STALL}`)).toBeNull()
    void OTHER_STALL
  })
})
