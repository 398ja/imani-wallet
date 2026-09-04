/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'

import {
  DM_NOTICE_DAYS,
  NOTICE_URGENCY,
  NOTICE_WINDOW_DAYS,
  dmDueOn,
  noticeFor,
  noticeText,
} from '../expiryNotice'
import { forgetVerification, licenceStatus } from '../licenceStatus'
import { forgetLicenceParses } from '../licences'
import { licenceIssueParams, type LicenceTerms } from '../licenceIssue'
import { buildVoucherToken } from './voucherFixtures'

/**
 * Telling a stall owner their subscription is ending.
 *
 * These run the notice against a REAL `licenceStatus` over real signed
 * vouchers, rather than a hand-built status object. The difference matters: the
 * requirement "renewing clears the notice" is a claim about what happens when a
 * second voucher lands in the store, and a fabricated status cannot exercise it.
 */

const CUSTOMER = 'b'.repeat(64)
const SOLD_AT = 1_800_000_000
const DAY = 86_400
const YEAR = 365 * DAY

function terms(over: Partial<LicenceTerms> = {}): LicenceTerms {
  return {
    lockKey: CUSTOMER,
    subscriptionId: 'sub_9f2c11',
    paidAmountMinor: 4000,
    paidCurrency: 'GBP',
    ...over,
  }
}

function idFor(token: string): string {
  let hash = 0
  for (let i = 0; i < token.length; i += 1) {
    hash = (Math.imul(hash, 31) + token.charCodeAt(i)) | 0
  }
  return `id-${hash}`
}

function mint(t: LicenceTerms, expiresAt: number) {
  const params = licenceIssueParams(t)
  const built = buildVoucherToken({
    merchantMetadata: params.merchantMetadata,
    faceValue: params.faceValueMinor,
    unit: params.currency,
    expiresAt,
  })
  const row: VoucherRow = {
    token_id: idFor(built.token),
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
  return { row, issuerPublicKey: built.voucher.issuerPublicKey }
}

/** The real status, then the notice derived from it. */
async function noticeAt(rows: VoucherRow[], issuerPublicKey: string, now: number) {
  const status = await licenceStatus({
    pubkey: CUSTOMER,
    now,
    issuerPublicKey,
    loadRows: async () => rows,
  })
  return noticeFor(status, now)
}

beforeEach(() => {
  forgetLicenceParses()
  forgetVerification(CUSTOMER)
})

afterEach(() => {
  forgetVerification(CUSTOMER)
  vi.unstubAllEnvs()
})

describe('when the banner appears', () => {
  it('says nothing while the subscription has plenty of time left', async () => {
    const expiresAt = SOLD_AT + YEAR
    const { row, issuerPublicKey } = mint(terms(), expiresAt)

    expect(await noticeAt([row], issuerPublicKey, expiresAt - 8 * DAY)).toBeNull()
  })

  it('appears from exactly seven days out', async () => {
    const expiresAt = SOLD_AT + YEAR
    const { row, issuerPublicKey } = mint(terms(), expiresAt)

    // The boundary, both sides. A day earlier is silence; the seventh day
    // speaks. Off by one here is a week of missing warning or a week of noise.
    expect(await noticeAt([row], issuerPublicKey, expiresAt - 7 * DAY - 1)).toBeNull()
    const notice = await noticeAt([row], issuerPublicKey, expiresAt - 7 * DAY)
    expect(notice?.urgency).toBe(NOTICE_URGENCY.SOON)
    expect(notice?.daysLeft).toBe(7)
  })

  it('names the date it ends', async () => {
    const expiresAt = SOLD_AT + YEAR
    const { row, issuerPublicKey } = mint(terms(), expiresAt)

    const notice = await noticeAt([row], issuerPublicKey, expiresAt - 3 * DAY)
    // The signed expiry, carried through unchanged for the caller to format.
    expect(notice?.expiresAt).toBe(expiresAt)
    expect(noticeText(notice!, '14 Mar 2027')).toContain('14 Mar 2027')
  })

  it('marks the last day as its own thing', async () => {
    const expiresAt = SOLD_AT + YEAR
    const { row, issuerPublicKey } = mint(terms(), expiresAt)

    const notice = await noticeAt([row], issuerPublicKey, expiresAt - 3600)
    expect(notice?.urgency).toBe(NOTICE_URGENCY.LAST_DAY)
    expect(notice?.daysLeft).toBe(0)
    expect(noticeText(notice!, 'today')).toContain('today')
  })
})

describe('when it says nothing at all', () => {
  it('says nothing to a stall with no subscription', async () => {
    // A free stall is not "expiring". Warning here would nag every merchant
    // who never bought anything, forever.
    expect(await noticeAt([], 'f'.repeat(64), SOLD_AT)).toBeNull()
  })

  it('stops once it has lapsed, rather than nagging', async () => {
    const expiresAt = SOLD_AT + YEAR
    const { row, issuerPublicKey } = mint(terms(), expiresAt)

    // The whole of "told twice and then simply lapses".
    expect(await noticeAt([row], issuerPublicKey, expiresAt + 1)).toBeNull()
    expect(await noticeAt([row], issuerPublicKey, expiresAt + 30 * DAY)).toBeNull()
  })

  it('says nothing when handed an already-expired status by a stale caller', () => {
    /**
     * `licenceStatus` refuses an expired licence before this module sees it, so
     * this case is unreachable through the normal path — and that is exactly
     * why it is worth pinning. The guard is the only thing standing between a
     * caller holding a status from a minute ago and a banner announcing that a
     * dead subscription is "ending soon".
     *
     * Verified to be load-bearing: removing the `remaining <= 0` check makes
     * this test fail while every other test in this file still passes.
     */
    const stale = {
      decision: {
        granted: true,
        source: 'verified',
        grant: { features: ['terminals'], expiresAt: SOLD_AT, pilot: false },
      },
      licence: null,
      checkedAt: SOLD_AT + DAY,
    } as never

    expect(noticeFor(stale, SOLD_AT + DAY)).toBeNull()
  })

  it('says nothing from a REMEMBERED expiry when the device cannot check', async () => {
    // Under grace the expiry is the one last read, and the renewal is exactly
    // what could not be read. Warning here risks telling a merchant who renewed
    // yesterday that they are about to lapse.
    const expiresAt = SOLD_AT + 3 * DAY
    const { row, issuerPublicKey } = mint(terms(), expiresAt)

    await licenceStatus({
      pubkey: CUSTOMER,
      now: SOLD_AT,
      issuerPublicKey,
      loadRows: async () => [row],
    })

    const offline = await licenceStatus({
      pubkey: CUSTOMER,
      now: SOLD_AT + 3600,
      issuerPublicKey,
      loadRows: () => Promise.reject(new Error('offline')),
    })
    expect(offline.decision.granted).toBe(true)
    expect(noticeFor(offline, SOLD_AT + 3600)).toBeNull()
  })
})

describe('renewing', () => {
  it('clears the notice with nothing for the customer to dismiss', async () => {
    const expiresAt = SOLD_AT + YEAR
    const original = mint(terms(), expiresAt)
    const nearlyOver = expiresAt - 2 * DAY

    // Warned.
    expect(await noticeAt([original.row], original.issuerPublicKey, nearlyOver)).not.toBeNull()

    // The renewal lands in the same store. Nothing else happens: no dismissal,
    // no reset, no flag.
    forgetLicenceParses()
    const renewal = mint(terms(), expiresAt + YEAR)

    expect(
      await noticeAt([original.row, renewal.row], renewal.issuerPublicKey, nearlyOver),
    ).toBeNull()
  })

  it('warns again a year later, rather than staying silent forever', async () => {
    // The failure a "dismissed" flag would cause: warned once, then never
    // again, then a silent lapse.
    const first = SOLD_AT + YEAR
    forgetLicenceParses()
    const renewal = mint(terms(), first + YEAR)

    const notice = await noticeAt([renewal.row], renewal.issuerPublicKey, first + YEAR - 5 * DAY)
    expect(notice?.daysLeft).toBe(5)
  })
})

describe('the wording', () => {
  it('never implies the stall stops trading', async () => {
    const expiresAt = SOLD_AT + YEAR
    const { row, issuerPublicKey } = mint(terms(), expiresAt)

    for (const at of [expiresAt - 7 * DAY, expiresAt - DAY, expiresAt - 60]) {
      const notice = await noticeAt([row], issuerPublicKey, at)
      const text = noticeText(notice!, '14 Mar 2027')
      // A lapse takes tills, never trade. Frightening a merchant into thinking
      // they cannot sell tomorrow is the opposite of what the design promises.
      expect(text).not.toMatch(/suspend|closed|blocked|cannot sell|stop trading/i)
      expect(text).toMatch(/tills/)
    }
  })

  it('says "1 day", not "1 days"', async () => {
    const expiresAt = SOLD_AT + YEAR
    const { row, issuerPublicKey } = mint(terms(), expiresAt)

    const notice = await noticeAt([row], issuerPublicKey, expiresAt - DAY - 60)
    expect(noticeText(notice!, 'x')).toContain('1 day,')
  })
})

describe('the DM schedule', () => {
  it('fires on exactly two days: seven out, and the last', () => {
    const expiresAt = SOLD_AT + YEAR
    const fired: number[] = []
    // Walk every day of the final fortnight, an hour into each.
    for (let d = 14; d >= 0; d -= 1) {
      const due = dmDueOn(expiresAt, expiresAt - d * DAY + 3600)
      if (due !== null) fired.push(due)
    }
    expect(fired).toEqual([...DM_NOTICE_DAYS])
  })

  it('says nothing once it has expired', () => {
    const expiresAt = SOLD_AT + YEAR
    expect(dmDueOn(expiresAt, expiresAt)).toBeNull()
    expect(dmDueOn(expiresAt, expiresAt + DAY)).toBeNull()
  })

  it('agrees with the window the banner uses', () => {
    // The first DM and the first banner are the same moment by construction.
    expect(DM_NOTICE_DAYS[0]).toBe(NOTICE_WINDOW_DAYS)
  })
})

describe('the sender script writes the same schedule the app reads', () => {
  /**
   * `scripts/notify-expiring.mjs` decides when the DM goes; `expiryNotice.ts`
   * decides when the banner shows. Two implementations of one policy, because
   * a `.mjs` script cannot import this app's TypeScript without a build step.
   *
   * Drift is silent and asymmetric: a customer sees a banner for a week and is
   * never messaged, or is messaged about a subscription the app says is fine.
   * Comparing the two answers across the whole window is what catches it.
   */
  it('fires on the same days as dmDueOn, across the final fortnight', async () => {
    const script = await import('../../../scripts/notify-expiring.mjs')
    const expiresAt = SOLD_AT + YEAR

    for (let d = 14; d >= 0; d -= 1) {
      const now = expiresAt - d * DAY + 3600
      expect(script.noticeDueOn(expiresAt, now)).toBe(dmDueOn(expiresAt, now))
    }
    // And past the end, where both must be silent.
    expect(script.noticeDueOn(expiresAt, expiresAt + DAY)).toBe(dmDueOn(expiresAt, expiresAt + DAY))
  })
})
