/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'
import { DENIAL_REASONS } from '@imani/licence'

import { explain, forgetVerification, grants, licenceStatus, readLastVerification } from '../licenceStatus'
import { forgetLicenceParses } from '../licences'
import { forgetLicenceReport, reportLicence } from '../licenceReport'
import { forgetRevocations, isRevokedBySeller } from '../licenceRevocations'
import { licenceIssueParams, LICENCE_FEATURES, type LicenceTerms } from '../licenceIssue'
import { ENROL_REFUSAL, FREE_TERMINALS, mayEnrol } from '../terminalAllowance'
import { servingTerminals } from '../lapseService'
import { TERMINAL_ROLES } from '../terminalRole'
import type { TerminalRecord } from '../terminalRoster'
import { buildLicenceToken } from './voucherFixtures'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'

/**
 * Review of imani-wallet#226, W-1: after the seller revokes a subscription (a refund), the
 * server answers this account's licence report `422 LICENCE_REVOKED`. The wallet used to remember
 * only that the fingerprint was refused, keep saying "active", show every paid till as licensed
 * and let the owner enrol another, each of which then sells 402.
 *
 * Now the verdict is kept per (subscription, seller), the same key the server revokes by, and the
 * local check stops granting: "revoked by the seller", the extra tills stop, and no new till is
 * enrolled past the free one.
 */

const STALL = 'b'.repeat(64)
const NOW = 1_800_000_000
const YEAR = 365 * 86400
const GATEWAY_SK = schnorr.utils.randomSecretKey()
const GATEWAY = bytesToHex(schnorr.getPublicKey(GATEWAY_SK))
const SELLER = 'a'.repeat(64)

function terms(over: Partial<LicenceTerms> = {}): LicenceTerms {
  return { lockKey: STALL, subscriptionId: 'sub_9f2c11', paidAmountMinor: 4000, paidCurrency: 'GBP', ...over }
}

function licenceRow(o: { sub?: string; expiresAt?: number; voucherId: string; seller?: string }): VoucherRow {
  const params = licenceIssueParams(terms(o.sub ? { subscriptionId: o.sub } : {}))
  const built = buildLicenceToken({
    metadata: params.merchantMetadata,
    lockKey: STALL,
    expiresAt: o.expiresAt ?? NOW + YEAR,
    faceValue: params.faceValueMinor,
    unit: params.currency,
    sellerId: o.seller ?? SELLER,
    voucherId: o.voucherId,
    signerKey: GATEWAY_SK,
  })
  return {
    token_id: `id-${o.voucherId}`, token: built.token, amount: 1, face_value: params.faceValueMinor,
    face_unit: params.currency, face_decimals: 2, token_amount: 1, issuer_id: built.issuerPublicKey,
    status: 'active', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  }
}

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

function status(rows: VoucherRow[], now = NOW) {
  return licenceStatus({ pubkey: STALL, now, issuerPublicKey: GATEWAY, sellerPublicKey: SELLER, loadRows: async () => rows })
}

/** The portal relaying gc: the given answer for every report. */
function answering(status: number, code?: string) {
  return vi.fn(async () => ({ status, ...(code ? { code } : {}) }))
}

function roster(): TerminalRecord[] {
  return ['c', 'd', 'e'].map((c, i) => ({
    terminalPubkey: c.repeat(64),
    name: `Till ${i}`,
    role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
    enrolledAt: NOW + i,
  })) as unknown as TerminalRecord[]
}

beforeEach(() => {
  forgetLicenceParses()
  forgetVerification(STALL)
  forgetLicenceReport(STALL)
  forgetRevocations(STALL)
})

afterEach(() => {
  forgetVerification(STALL)
  forgetLicenceReport(STALL)
  forgetRevocations(STALL)
})

describe('a 422 LICENCE_REVOKED is remembered as the seller ending that subscription', () => {
  it('records (subscription, seller) and stops granting locally', async () => {
    const row = licenceRow({ voucherId: A })
    expect((await status([row])).decision.granted).toBe(true)

    await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => [row], post: answering(422, 'LICENCE_REVOKED'), sellerPublicKey: SELLER })

    expect(isRevokedBySeller(STALL, 'sub_9f2c11', SELLER)).toBe(true)
    forgetLicenceParses()
    const after = await status([row])
    expect(after.decision.granted).toBe(false)
    if (!after.decision.granted) expect(after.decision.reason).toBe(DENIAL_REASONS.REVOKED_BY_SELLER)
    expect(grants(after, LICENCE_FEATURES.TERMINALS)).toBe(false)
  })

  it('says "revoked by the seller", and still shows the subscription for support', async () => {
    const row = licenceRow({ voucherId: A })
    await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => [row], post: answering(422, 'LICENCE_REVOKED'), sellerPublicKey: SELLER })

    const after = await status([row])

    expect(explain(after)).toMatch(/revoked by the seller/i)
    expect(after.licence?.subscriptionId).toBe('sub_9f2c11')
  })

  it('gives no grace: the window a revoked licence earned is dropped', async () => {
    const row = licenceRow({ voucherId: A })
    await status([row])
    expect(readLastVerification(STALL)).not.toBeNull()

    await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => [row], post: answering(422, 'LICENCE_REVOKED'), sellerPublicKey: SELLER })

    expect(readLastVerification(STALL)).toBeNull()
    const offline = await licenceStatus({
      pubkey: STALL, now: NOW + 60, issuerPublicKey: GATEWAY, sellerPublicKey: SELLER,
      loadRows: () => Promise.reject(new Error('storage unavailable')),
    })
    expect(offline.decision.granted).toBe(false)
  })

  it('a renewal under the SAME revoked id grants nothing either (the server revokes the id for ever)', async () => {
    const old = licenceRow({ voucherId: A })
    await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => [old], post: answering(422, 'LICENCE_REVOKED'), sellerPublicKey: SELLER })

    const renewal = licenceRow({ voucherId: B, expiresAt: NOW + 2 * YEAR })
    forgetLicenceParses()
    expect((await status([old, renewal])).decision.granted).toBe(false)
  })

  it('another subscription still held keeps granting', async () => {
    const revoked = licenceRow({ voucherId: A, expiresAt: NOW + 2 * YEAR })
    const other = licenceRow({ voucherId: B, sub: 'sub_other', expiresAt: NOW + YEAR })
    await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => [revoked], post: answering(422, 'LICENCE_REVOKED'), sellerPublicKey: SELLER })

    forgetLicenceParses()
    const after = await status([revoked, other])
    expect(after.decision.granted).toBe(true)
    expect(after.licence?.subscriptionId).toBe('sub_other')
  })

  it('another 422 (a wrong key, a stranger) is NOT taken as a revocation', async () => {
    const row = licenceRow({ voucherId: A })
    await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => [row], post: answering(422, 'LICENCE_WRONG_KEY'), sellerPublicKey: SELLER })
    await reportLicence({ pubkey: STALL, now: NOW + 1, loadRows: async () => [row], post: answering(422), sellerPublicKey: SELLER })

    expect(isRevokedBySeller(STALL, 'sub_9f2c11', SELLER)).toBe(false)
    forgetLicenceParses()
    expect((await status([row])).decision.granted).toBe(true)
  })

  it('is per account: another stall on this device is unaffected', async () => {
    const row = licenceRow({ voucherId: A })
    await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => [row], post: answering(422, 'LICENCE_REVOKED'), sellerPublicKey: SELLER })

    expect(isRevokedBySeller('f'.repeat(64), 'sub_9f2c11', SELLER)).toBe(false)
  })
})

describe('the tills after a revocation', () => {
  async function revokedStatus() {
    const row = licenceRow({ voucherId: A })
    await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => [row], post: answering(422, 'LICENCE_REVOKED'), sellerPublicKey: SELLER })
    forgetLicenceParses()
    return status([row])
  }

  it('every till stops: the free allowance is none', async () => {
    expect(servingTerminals(await revokedStatus(), roster())).toHaveLength(FREE_TERMINALS)
  })

  it('no till is enrolled, and the owner is told the seller ended it', async () => {
    const decision = mayEnrol(await revokedStatus(), FREE_TERMINALS)

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toBe(ENROL_REFUSAL.REVOKED)
      expect(decision.message).toMatch(/seller ended/i)
      expect(decision.message).not.toMatch(/Renewing restores/i)
    }
  })

  it('leaves no till to enrol: the free allowance it falls back to is none', async () => {
    const decision = mayEnrol(await revokedStatus(), 0)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe(ENROL_REFUSAL.REVOKED)
  })
})
