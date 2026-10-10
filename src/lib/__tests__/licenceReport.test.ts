/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'

import { forgetLicenceParses } from '../licences'
import { licenceIssueParams, type LicenceTerms } from '../licenceIssue'
import { forgetLicenceReport, reportLicence, REPORT_INTERVAL_SECONDS } from '../licenceReport'
import { tokenProofs } from '../voucherToken'
import { buildLicenceToken, buildVoucherToken } from './voucherFixtures'

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

/** A licence as gateway-customer mints it (P2PK, one proof). See `lockedRow` below. */
function licenceRow(t: LicenceTerms, expiresAt: number, voucherId = '1d4410af-70f5-4c14-8606-519404684ea7'): VoucherRow {
  return lockedRow({ expiresAt, voucherId, lockKey: t.lockKey })
}

/** A pre-#226 plain VOUCHER licence: the lock is only in its metadata. */
function plainLicenceRow(t: LicenceTerms, expiresAt: number, voucherId = '1d4410af-70f5-4c14-8606-519404684ea7'): VoucherRow {
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

// ---------------------------------------------------------------- review of #197, MEDIUM-3

/** A licence as gateway-customer mints it: one P2PK proof locked to `lockKey`, sold by `seller`. */
function lockedRow(o: { expiresAt: number; voucherId: string; seller?: string; lockKey?: string; sub?: string }): VoucherRow {
  const params = licenceIssueParams(terms({ lockKey: o.lockKey ?? STALL, ...(o.sub ? { subscriptionId: o.sub } : {}) }))
  const built = buildLicenceToken({
    metadata: params.merchantMetadata, lockKey: o.lockKey ?? STALL, expiresAt: o.expiresAt,
    faceValue: params.faceValueMinor, unit: params.currency, sellerId: o.seller, voucherId: o.voucherId,
  })
  return {
    token_id: `id-${o.voucherId}`, token: built.token, amount: 1, face_value: params.faceValueMinor,
    face_unit: params.currency, face_decimals: 2, token_amount: 1, issuer_id: built.issuerPublicKey,
    status: 'active', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  }
}

const GENUINE = '11111111-1111-4111-8111-111111111111'
const FAKE = '22222222-2222-4222-8222-222222222222'
const FAKE2 = '33333333-3333-4333-8333-333333333333'
const FAKE3 = '44444444-4444-4444-8444-444444444444'

/** The portal: 422 for every voucher in `refused`, 200 otherwise. Records which voucher was sent. */
function portal(rows: VoucherRow[], refused: string[]) {
  const sentIds: string[] = []
  const post = vi.fn(async (body: { secrets: string[] }) => {
    const row = rows.find((r) => tokenProofs(r.token).some((p) => p.secret === body.secrets[0]))
    const id = row?.token_id?.replace(/^id-/, '') ?? '?'
    sentIds.push(id)
    return { status: refused.includes(id) ? 422 : 200 }
  })
  return { post, sentIds }
}

describe("a stranger's licence-shaped DM cannot shadow the real licence (review of #197, MEDIUM-3)", () => {
  it('on a 422 it reports the next candidate by expiry, and that one is recorded', async () => {
    const genuine = lockedRow({ expiresAt: NOW + YEAR, voucherId: GENUINE })
    const fake = lockedRow({ expiresAt: NOW + 2 * YEAR, voucherId: FAKE, seller: 'f'.repeat(64), sub: 'sub_fake' })
    const rows = [genuine, fake]
    const { post, sentIds } = portal(rows, [FAKE])

    expect(await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => rows, post })).toBe('reported')
    expect(sentIds).toEqual([FAKE, GENUINE])
  })

  it("falls back even when the fake copies the genuine licence's subscription_id", async () => {
    // heldLicences keeps one licence per subscription, the later expiry winning, so a fake naming
    // the victim's own subscription would otherwise hide the genuine licence from the report.
    const genuine = lockedRow({ expiresAt: NOW + YEAR, voucherId: GENUINE })
    const fake = lockedRow({ expiresAt: NOW + 2 * YEAR, voucherId: FAKE, seller: 'f'.repeat(64) })
    const rows = [genuine, fake]
    const { post, sentIds } = portal(rows, [FAKE])

    expect(await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => rows, post })).toBe('reported')
    expect(sentIds).toEqual([FAKE, GENUINE])
  })

  it('remembers a refused voucher and never sends it again', async () => {
    const genuine = lockedRow({ expiresAt: NOW + YEAR, voucherId: GENUINE })
    const fake = lockedRow({ expiresAt: NOW + 2 * YEAR, voucherId: FAKE, seller: 'f'.repeat(64) })
    const rows = [genuine, fake]
    const { post, sentIds } = portal(rows, [FAKE])

    await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => rows, post })
    await reportLicence({ pubkey: STALL, now: NOW + REPORT_INTERVAL_SECONDS + 1, loadRows: async () => rows, post })

    expect(sentIds).toEqual([FAKE, GENUINE, GENUINE])
  })

  it('tries at most three candidates in one report', async () => {
    const rows = [
      lockedRow({ expiresAt: NOW + 4 * YEAR, voucherId: FAKE, seller: 'f'.repeat(64) }),
      lockedRow({ expiresAt: NOW + 3 * YEAR, voucherId: FAKE2, seller: 'f'.repeat(64) }),
      lockedRow({ expiresAt: NOW + 2 * YEAR, voucherId: FAKE3, seller: 'f'.repeat(64) }),
      lockedRow({ expiresAt: NOW + YEAR, voucherId: GENUINE }),
    ]
    const { post, sentIds } = portal(rows, [FAKE, FAKE2, FAKE3])

    expect(await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => rows, post })).toBe('failed')
    expect(sentIds).toEqual([FAKE, FAKE2, FAKE3])
    // The three are remembered, so the next look reaches the genuine one at once.
    expect(await reportLicence({ pubkey: STALL, now: NOW + 1, loadRows: async () => rows, post })).toBe('reported')
    expect(sentIds.slice(3)).toEqual([GENUINE])
  })

  it('an outage (503) is not a refusal: it stops there and remembers nothing', async () => {
    const genuine = lockedRow({ expiresAt: NOW + YEAR, voucherId: GENUINE })
    const fake = lockedRow({ expiresAt: NOW + 2 * YEAR, voucherId: FAKE })
    const rows = [genuine, fake]
    const post = vi.fn(async () => ({ status: 503 }))

    expect(await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => rows, post })).toBe('failed')
    expect(post).toHaveBeenCalledTimes(1)
    const ok = okPost()
    await reportLicence({ pubkey: STALL, now: NOW + 1, loadRows: async () => rows, post: ok })
    expect(ok.mock.calls[0][0].secrets).toEqual(tokenProofs(fake.token).map((p) => p.secret))
  })

  it('a pinned seller (VITE_LICENCE_SELLER_PUBKEY) means a stranger-sold licence is never sent', async () => {
    const seller = 'e'.repeat(64)
    const genuine = lockedRow({ expiresAt: NOW + YEAR, voucherId: GENUINE, seller })
    const fake = lockedRow({ expiresAt: NOW + 2 * YEAR, voucherId: FAKE, seller: 'f'.repeat(64) })
    const rows = [genuine, fake]
    const { post, sentIds } = portal(rows, [])

    await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => rows, post, sellerPublicKey: seller })

    expect(sentIds).toEqual([GENUINE])
  })

  it('a plain VOUCHER licence is never reported: the server refuses it NOT_LOCKED_AT_MINT', async () => {
    const plain = plainLicenceRow(terms(), NOW + 2 * YEAR, FAKE)
    const genuine = lockedRow({ expiresAt: NOW + YEAR, voucherId: GENUINE })
    const rows = [plain, genuine]
    const { post, sentIds } = portal(rows, [])

    await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => rows, post })

    expect(sentIds).toEqual([GENUINE])
  })
})

describe('re-review of #197: the fallback is bounded and the refused list cannot grow', () => {
  it('a flood of 80 fakes: at most MAX_CANDIDATES posts per look, no fake re-tried, and the genuine one is reached', async () => {
    const fakes = Array.from({ length: 80 }, (_, i) =>
      lockedRow({
        expiresAt: NOW + (100 - i) * YEAR,
        voucherId: `${String(i).padStart(8, '0')}-2222-4222-8222-222222222222`,
        seller: 'f'.repeat(64),
      }),
    )
    const genuine = lockedRow({ expiresAt: NOW + YEAR, voucherId: GENUINE })
    const rows = [...fakes, genuine]
    const { post, sentIds } = portal(rows, fakes.map((r) => r.token_id!.replace(/^id-/, '')))

    let looks = 0
    let outcome = 'failed'
    while (outcome !== 'reported' && looks < 40) {
      const before = sentIds.length
      outcome = await reportLicence({ pubkey: STALL, now: NOW + looks, loadRows: async () => rows, post })
      expect(sentIds.length - before).toBeLessThanOrEqual(3)
      const stored = JSON.parse(localStorage.getItem(`imani.licence.refused.${STALL}`) ?? '[]') as string[]
      expect(stored.length).toBeLessThanOrEqual(rows.length)
      looks++
    }
    expect(outcome).toBe('reported')
    // Every fake sent once, then the genuine one: nothing forgotten and re-tried.
    expect(sentIds).toHaveLength(81)
    expect(new Set(sentIds).size).toBe(81)
    expect(sentIds.at(-1)).toBe(GENUINE)
  })

  it('a refusal is forgotten once that voucher is no longer held, so the list cannot grow', async () => {
    const genuine = lockedRow({ expiresAt: NOW + YEAR, voucherId: GENUINE })
    const fake = lockedRow({ expiresAt: NOW + 2 * YEAR, voucherId: FAKE, seller: 'f'.repeat(64) })
    const fake2 = lockedRow({ expiresAt: NOW + 3 * YEAR, voucherId: FAKE2, seller: 'f'.repeat(64) })
    const { post } = portal([genuine, fake, fake2], [FAKE, FAKE2])
    await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => [genuine, fake], post })
    // fake is gone from the wallet (spent, deleted); a new one arrives and is refused.
    await reportLicence({ pubkey: STALL, now: NOW + REPORT_INTERVAL_SECONDS + 1, loadRows: async () => [genuine, fake2], post })
    const stored = JSON.parse(localStorage.getItem(`imani.licence.refused.${STALL}`) ?? '[]') as string[]
    expect(stored).toHaveLength(1)
  })

  it('a 409 (spent) stops the report and is not remembered as a refusal', async () => {
    const genuine = lockedRow({ expiresAt: NOW + YEAR, voucherId: GENUINE })
    const fake = lockedRow({ expiresAt: NOW + 2 * YEAR, voucherId: FAKE })
    const rows = [genuine, fake]
    const post = vi.fn(async () => ({ status: 409 }))
    expect(await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => rows, post })).toBe('failed')
    expect(post).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(`imani.licence.refused.${STALL}`)).toBeNull()
  })

  it("a fake that reuses the genuine licence's voucher_id cannot get the genuine one skipped", async () => {
    // The fake sorts first (later expiry), is refused 422, and its voucher_id is remembered. If that
    // id is the genuine one's, the genuine licence is then never a candidate again.
    const genuine = lockedRow({ expiresAt: NOW + YEAR, voucherId: GENUINE })
    const fake = lockedRow({ expiresAt: NOW + 2 * YEAR, voucherId: GENUINE, seller: 'f'.repeat(64) })
    const rows = [fake, genuine]
    const sent: string[] = []
    const post = vi.fn(async (body: { secrets: string[] }) => {
      const isFake = tokenProofs(fake.token).some((p) => p.secret === body.secrets[0])
      sent.push(isFake ? 'fake' : 'genuine')
      return { status: isFake ? 422 : 200 }
    })
    const first = await reportLicence({ pubkey: STALL, now: NOW, loadRows: async () => rows, post })
    const second = await reportLicence({ pubkey: STALL, now: NOW + 1, loadRows: async () => rows, post })
    expect(first).toBe('reported')
    expect(second).toBe('recent')
    expect(sent).toEqual(['fake', 'genuine'])
  })
})
