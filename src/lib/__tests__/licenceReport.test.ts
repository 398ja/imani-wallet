/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'

import { forgetLicenceParses } from '../licences'
import { licenceIssueParams, type LicenceTerms } from '../licenceIssue'
import { forgetLicenceReport, reportLicence, REPORT_INTERVAL_SECONDS } from '../licenceReport'
import { tokenProofs } from '../voucherToken'
import { buildVoucherToken } from './voucherFixtures'

/**
 * imani-wallet#197: the owner's wallet tells the server about its licence, so the stall's paid
 * terminals can sell.
 *
 * What is pinned here is what LEAVES the device: the proof secrets and nothing else. A proof's C
 * is what spends it, so a report that carried C would hand the licence to anything on the path.
 */

const STALL = 'b'.repeat(64)
const NOW = 1_800_000_000
const YEAR = 365 * 86400

function terms(over: Partial<LicenceTerms> = {}): LicenceTerms {
  return { lockKey: STALL, subscriptionId: 'sub_9f2c11', paidAmountMinor: 4000, paidCurrency: 'GBP', ...over }
}

function licenceRow(t: LicenceTerms, expiresAt: number, voucherId = '1d4410af-70f5-4c14-8606-519404684ea7'): VoucherRow {
  const params = licenceIssueParams(t)
  const built = buildVoucherToken(
    {
      voucherId,
      merchantMetadata: params.merchantMetadata,
      faceValue: params.faceValueMinor,
      unit: params.currency,
      expiresAt,
    },
    [1000, 782],
    {},
    undefined,
    true,
  )
  return {
    token_id: `id-${voucherId}-${expiresAt}`,
    token: built.token,
    amount: 1782,
    face_value: params.faceValueMinor,
    face_unit: params.currency,
    face_decimals: 2,
    token_amount: 1782,
    issuer_id: built.voucher.issuerPublicKey,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

function okPost() {
  return vi.fn<(body: { secrets: string[] }) => Promise<{ status: number }>>(async () => ({ status: 200 }))
}

beforeEach(() => {
  forgetLicenceParses()
  forgetLicenceReport(STALL)
})

describe('what a licence report sends', () => {
  it('sends every proof secret of the licence, and never C', async () => {
    const row = licenceRow(terms(), NOW + YEAR)
    const post = okPost()

    const outcome = await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => [row], post })

    expect(outcome).toBe('reported')
    expect(post).toHaveBeenCalledTimes(1)
    const sent = post.mock.calls[0][0]
    expect(Object.keys(sent)).toEqual(['secrets'])
    const proofs = tokenProofs(row.token)
    expect(sent.secrets).toEqual(proofs.map((p) => p.secret))
    const wire = JSON.stringify(sent)
    for (const p of proofs) {
      expect(p.C).toBeTruthy()
      expect(wire).not.toContain(p.C)
    }
    expect(wire).not.toContain(row.token)
  })

  it('sends the licence that expires last when it holds two', async () => {
    const old = licenceRow(terms(), NOW + 30 * 86400, '11111111-1111-4111-8111-111111111111')
    const renewal = licenceRow(terms(), NOW + YEAR, '22222222-2222-4222-8222-222222222222')
    const post = okPost()

    await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => [renewal, old], post })

    expect(post.mock.calls[0][0].secrets).toEqual(tokenProofs(renewal.token).map((p) => p.secret))
  })
})

describe('when it reports nothing', () => {
  it('holds no licence', async () => {
    const post = okPost()
    expect(await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => [], post })).toBe('none')
    expect(post).not.toHaveBeenCalled()
  })

  it('holds a licence locked to someone else (the server would refuse it anyway)', async () => {
    const post = okPost()
    const row = licenceRow(terms({ lockKey: 'c'.repeat(64) }), NOW + YEAR)
    expect(await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => [row], post })).toBe('none')
    expect(post).not.toHaveBeenCalled()
  })

  it('holds only an expired licence', async () => {
    const post = okPost()
    const row = licenceRow(terms(), NOW - 1)
    expect(await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => [row], post })).toBe('none')
    expect(post).not.toHaveBeenCalled()
  })
})

describe('how often it reports', () => {
  it('reports the same licence once per interval, and a renewal at once', async () => {
    const row = licenceRow(terms(), NOW + 30 * 86400, '11111111-1111-4111-8111-111111111111')
    const post = okPost()
    const load = async () => [row]

    expect(await reportLicence({ pubkey: STALL, now: NOW, loadRows: load, post })).toBe('reported')
    expect(await reportLicence({ pubkey: STALL, now: NOW + 60, loadRows: load, post })).toBe('recent')
    expect(post).toHaveBeenCalledTimes(1)

    const renewal = licenceRow(terms(), NOW + YEAR, '22222222-2222-4222-8222-222222222222')
    expect(await reportLicence({ pubkey: STALL, now: NOW + 120, loadRows: async () => [row, renewal], post }))
      .toBe('reported')
    expect(post).toHaveBeenCalledTimes(2)

    expect(await reportLicence({
      pubkey: STALL, now: NOW + 120 + REPORT_INTERVAL_SECONDS, loadRows: async () => [row, renewal], post,
    })).toBe('reported')
    expect(post).toHaveBeenCalledTimes(3)
  })

  it('retries on the next call after a refusal or an outage, and never throws', async () => {
    const row = licenceRow(terms(), NOW + YEAR)
    const load = async () => [row]

    const refused = vi.fn(async () => ({ status: 503 }))
    expect(await reportLicence({ pubkey: STALL, now: NOW, loadRows: load, post: refused })).toBe('failed')
    const thrown = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await reportLicence({ pubkey: STALL, now: NOW + 1, loadRows: load, post: thrown })).toBe('failed')
    const ok = okPost()
    expect(await reportLicence({ pubkey: STALL, now: NOW + 2, loadRows: load, post: ok })).toBe('reported')
  })

  it('a wallet that cannot be read is a failure, not a throw', async () => {
    const post = okPost()
    const outcome = await reportLicence({
      pubkey: STALL, now: NOW, post,
      loadRows: async () => {
        throw new Error('idb closed')
      },
    })
    expect(outcome).toBe('failed')
    expect(post).not.toHaveBeenCalled()
  })

  it('two screens asking at once send ONE report (seen on the local gate: dashboard and Terminals)', async () => {
    const row = licenceRow(terms(), NOW + YEAR)
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    const post = vi.fn<(body: { secrets: string[] }) => Promise<{ status: number }>>(async () => {
      await gate
      return { status: 200 }
    })
    const load = async () => [row]

    const first = reportLicence({ pubkey: STALL, now: NOW, loadRows: load, post })
    const second = reportLicence({ pubkey: STALL, now: NOW, loadRows: load, post })
    release()

    expect(await first).toBe('reported')
    expect(await second).toBe('reported')
    expect(post).toHaveBeenCalledTimes(1)
  })
})
