/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'

import {
  explain,
  forgetVerification,
  grants,
  licenceIssuerPubkey,
  licenceStatus,
  readLastVerification,
} from '../licenceStatus'
import { forgetLicenceParses } from '../licences'
import { licenceIssueParams, LICENCE_FEATURES, type LicenceTerms } from '../licenceIssue'
import { buildVoucherToken } from './voucherFixtures'

/**
 * What the device believes about its subscription.
 *
 * These are the join tests: storage, recognition, verification, the grace
 * window and the persistence that feeds it, exercised together. Each piece has
 * its own tests already, and every one of them passes against a composition
 * that wires them up wrongly — which is the only failure this file can catch.
 *
 * The clock is a NUMBER passed in, never faked globally, so "let it expire" is
 * an argument rather than a wait.
 */

const CUSTOMER = 'b'.repeat(64)
const SOLD_AT = 1_800_000_000
const YEAR = 365 * 86400
const DAY = 86400

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

/** A real signed licence, and the issuer key it was signed with. */
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

/** Ask the real composition, with one deployment key and one set of rows. */
function ask(rows: VoucherRow[], issuerPublicKey: string, now: number) {
  return licenceStatus({
    pubkey: CUSTOMER,
    now,
    issuerPublicKey,
    loadRows: async () => rows,
  })
}

beforeEach(() => {
  forgetLicenceParses()
  forgetVerification(CUSTOMER)
})

afterEach(() => {
  forgetVerification(CUSTOMER)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('a licence that arrived and verifies', () => {
  it('unlocks the feature, with no step the customer has to take', async () => {
    const { row, issuerPublicKey } = mint(terms(), SOLD_AT + YEAR)

    const status = await ask([row], issuerPublicKey, SOLD_AT)

    expect(status.decision.granted).toBe(true)
    expect(grants(status, LICENCE_FEATURES.TERMINALS)).toBe(true)
    expect(explain(status)).toContain('active')
  })

  it('records the verification, so the grace window has something to run from', async () => {
    const { row, issuerPublicKey } = mint(terms(), SOLD_AT + YEAR)

    expect(readLastVerification(CUSTOMER)).toBeNull()
    await ask([row], issuerPublicKey, SOLD_AT)

    const remembered = readLastVerification(CUSTOMER)
    expect(remembered?.at).toBe(SOLD_AT)
    expect(remembered?.grant.expiresAt).toBe(SOLD_AT + YEAR)
  })
})

describe('a licence that is not ours', () => {
  it('grants nothing when the deployment names a different issuer', async () => {
    // A perfectly formed licence, signed by someone else. This is the check
    // that stops a customer minting their own subscription, reached through the
    // composition rather than by calling the verifier directly.
    const { row } = mint(terms(), SOLD_AT + YEAR)

    const status = await ask([row], 'f'.repeat(64), SOLD_AT)

    expect(status.decision.granted).toBe(false)
    expect(explain(status)).toContain('not issued by us')
  })

  it('grants nothing when the deployment sets no issuer key at all', async () => {
    // An unconfigured deployment must be OFF, not open. Empty issuer key means
    // no licence can match it.
    const { row } = mint(terms(), SOLD_AT + YEAR)

    const status = await ask([row], '', SOLD_AT)

    expect(status.decision.granted).toBe(false)
  })

  it('grants nothing to a licence locked to another device', async () => {
    const { row, issuerPublicKey } = mint(terms({ lockKey: 'c'.repeat(64) }), SOLD_AT + YEAR)

    const status = await ask([row], issuerPublicKey, SOLD_AT)

    expect(status.decision.granted).toBe(false)
    expect(explain(status)).toContain('different device')
  })
})

describe('no licence at all', () => {
  it('refuses, and does not treat an empty wallet as a grace period', async () => {
    const status = await ask([], 'f'.repeat(64), SOLD_AT)

    expect(status.decision.granted).toBe(false)
    expect(explain(status)).toContain('No subscription has arrived')
    // Nothing was verified, so nothing was remembered — a device that clears
    // its storage must not acquire a free day.
    expect(readLastVerification(CUSTOMER)).toBeNull()
  })
})

describe('letting it expire', () => {
  it('keeps working right up to the last second of the term', async () => {
    const expiresAt = SOLD_AT + YEAR
    const { row, issuerPublicKey } = mint(terms(), expiresAt)

    expect((await ask([row], issuerPublicKey, expiresAt - 1)).decision.granted).toBe(true)
  })

  it('locks the moment the term ends, with no grace window softening it', async () => {
    // The distinction the whole design rests on: an expiry is a SIGNED answer,
    // not an outage. A device that verified a minute ago still locks now.
    const expiresAt = SOLD_AT + YEAR
    const { row, issuerPublicKey } = mint(terms(), expiresAt)

    await ask([row], issuerPublicKey, expiresAt - 60)
    expect(readLastVerification(CUSTOMER)).not.toBeNull()

    const status = await ask([row], issuerPublicKey, expiresAt + 1)

    expect(status.decision.granted).toBe(false)
    expect(explain(status)).toContain('ended')
  })
})

describe('the grace window, through the composition', () => {
  /** A wallet that cannot be read: an outage, not an answer. */
  const unreadable = () => Promise.reject(new Error('storage unavailable'))

  it('keeps working when nothing can be checked at all', async () => {
    const expiresAt = SOLD_AT + YEAR
    const { row, issuerPublicKey } = mint(terms(), expiresAt)

    await ask([row], issuerPublicKey, SOLD_AT)

    const status = await licenceStatus({
      pubkey: CUSTOMER,
      now: SOLD_AT + 3600,
      issuerPublicKey,
      loadRows: unreadable,
    })

    expect(status.decision.granted).toBe(true)
    expect(status.decision.granted && status.decision.source).toBe('grace')
    expect(explain(status)).toContain('not been able to confirm')
  })

  it('stops once the window passes, moving the clock rather than waiting', async () => {
    const { row, issuerPublicKey } = mint(terms(), SOLD_AT + YEAR)
    await ask([row], issuerPublicKey, SOLD_AT)

    const status = await licenceStatus({
      pubkey: CUSTOMER,
      now: SOLD_AT + DAY + 1,
      issuerPublicKey,
      loadRows: unreadable,
    })

    expect(status.decision.granted).toBe(false)
  })

  it('gives no window to a device that has never verified', async () => {
    const status = await licenceStatus({
      pubkey: CUSTOMER,
      now: SOLD_AT,
      issuerPublicKey: 'f'.repeat(64),
      loadRows: unreadable,
    })

    expect(status.decision.granted).toBe(false)
    expect(explain(status)).toContain('never been able to confirm')
  })

  it('does not let an offline device roll its own window forward', async () => {
    // The rule that makes staying offline unprofitable: the window runs from
    // the last SUCCESSFUL verification, and a decision carried BY the window is
    // not one. Checking repeatedly while offline must not extend anything.
    const { row, issuerPublicKey } = mint(terms(), SOLD_AT + YEAR)
    await ask([row], issuerPublicKey, SOLD_AT)

    for (const t of [SOLD_AT + 3600, SOLD_AT + 7200, SOLD_AT + 20 * 3600]) {
      const carried = await licenceStatus({
        pubkey: CUSTOMER,
        now: t,
        issuerPublicKey,
        loadRows: unreadable,
      })
      expect(carried.decision.granted).toBe(true)
      // The recorded moment must not move. Asserted INSIDE the loop and on the
      // record itself: a version that re-stamped it on every grace decision
      // would still grant here, and the window would silently become infinite —
      // the assertion below on the final refusal is not enough on its own,
      // because it only samples the end state.
      expect(readLastVerification(CUSTOMER)?.at).toBe(SOLD_AT)
    }

    // Still measured from the original verification, so it ends on time.
    expect(readLastVerification(CUSTOMER)?.at).toBe(SOLD_AT)
    const after = await licenceStatus({
      pubkey: CUSTOMER,
      now: SOLD_AT + DAY + 1,
      issuerPublicKey,
      loadRows: unreadable,
    })
    expect(after.decision.granted).toBe(false)
  })

  /**
   * The window must end 24h after the last SUCCESS, not 24h after the last
   * time the app happened to grant.
   *
   * The difference only shows when a grace decision is followed by more time
   * passing: an implementation that stamped the record on every granted
   * decision — including one the window itself carried — would push the
   * deadline forward each check, and a device that never reconnects would keep
   * its features forever.
   *
   * Tested by granting under grace at 20h and then asking at 25h. Under the
   * correct rule that is past the window and refused; under the bug the 20h
   * grant reset the clock and 25h is only 5h in, so it grants.
   */
  it('ends the window 24h after the last SUCCESS, not after the last grant', async () => {
    const { row, issuerPublicKey } = mint(terms(), SOLD_AT + YEAR)
    await ask([row], issuerPublicKey, SOLD_AT)

    const carried = await licenceStatus({
      pubkey: CUSTOMER,
      now: SOLD_AT + 20 * 3600,
      issuerPublicKey,
      loadRows: unreadable,
    })
    expect(carried.decision.granted).toBe(true)

    const later = await licenceStatus({
      pubkey: CUSTOMER,
      now: SOLD_AT + 25 * 3600,
      issuerPublicKey,
      loadRows: unreadable,
    })
    expect(later.decision.granted).toBe(false)
  })

  it('will not carry a licence whose signed expiry has passed', async () => {
    // Offline, inside the window, but the subscription itself ended. The signed
    // expiry we already read still binds — going offline before an expiry must
    // not buy a day the customer did not pay for.
    const expiresAt = SOLD_AT + 3600
    const { row, issuerPublicKey } = mint(terms(), expiresAt)
    await ask([row], issuerPublicKey, SOLD_AT)

    const status = await licenceStatus({
      pubkey: CUSTOMER,
      now: expiresAt + 1,
      issuerPublicKey,
      loadRows: unreadable,
    })

    expect(status.decision.granted).toBe(false)
    expect(explain(status)).toContain('ended')
  })
})

describe('renewing', () => {
  it('unlocks again with nothing to reinstall and nothing to re-enrol', async () => {
    const expiresAt = SOLD_AT + YEAR
    const original = mint(terms(), expiresAt)

    // Lapsed.
    const lapsed = await ask([original.row], original.issuerPublicKey, expiresAt + DAY)
    expect(lapsed.decision.granted).toBe(false)

    // The renewal arrives by DM and lands in the same store. Same subscription
    // id, later expiry, and nothing else happens.
    forgetLicenceParses()
    const renewal = mint(terms(), expiresAt + YEAR)

    const restored = await licenceStatus({
      pubkey: CUSTOMER,
      now: expiresAt + DAY,
      issuerPublicKey: renewal.issuerPublicKey,
      loadRows: async () => [original.row, renewal.row],
    })

    expect(restored.decision.granted).toBe(true)
    expect(restored.licence?.expiresAt).toBe(expiresAt + YEAR)
  })
})

describe('what the screen is told', () => {
  it('keeps the licence for a refusal, because that is what support asks about', async () => {
    const expiresAt = SOLD_AT + YEAR
    const { row, issuerPublicKey } = mint(terms(), expiresAt)

    const status = await ask([row], issuerPublicKey, expiresAt + 1)

    expect(status.decision.granted).toBe(false)
    // "Expired on the 3rd" needs the voucher that expired.
    expect(status.licence?.expiresAt).toBe(expiresAt)
    expect(status.licence?.subscriptionId).toBe('sub_9f2c11')
  })

  it('says something a customer could read, for every state', async () => {
    const expiresAt = SOLD_AT + YEAR
    const { row, issuerPublicKey } = mint(terms(), expiresAt)

    const states = [
      await ask([row], issuerPublicKey, SOLD_AT),
      await ask([row], issuerPublicKey, expiresAt + 1),
      await ask([], issuerPublicKey, SOLD_AT),
      await ask([row], 'f'.repeat(64), SOLD_AT),
    ]

    for (const status of states) {
      const sentence = explain(status)
      // No reason codes leaking through to a person.
      expect(sentence).not.toMatch(/[a-z]+-[a-z]+/)
      expect(sentence.length).toBeGreaterThan(20)
      expect(sentence).toMatch(/\.$/)
    }
  })
})

describe('the deployment key', () => {
  /**
   * An unconfigured deployment must be OFF, not open.
   *
   * This is the one input in the module that decides whether a stranger's
   * voucher unlocks a paid feature, and the failure is silent in the dangerous
   * direction: if it ever defaulted to something a licence could match, every
   * build without the env var would ship a feature anyone could mint.
   */
  it('is empty when the deployment sets none, so nothing verifies', () => {
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', '')
    expect(licenceIssuerPubkey()).toBe('')
  })

  it('is read at call time, so a build is not the only way to change it', () => {
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', 'a'.repeat(64))
    expect(licenceIssuerPubkey()).toBe('a'.repeat(64))
  })

  it('is what licenceStatus uses when the caller names none', async () => {
    // The default path, not the override every other test here uses. Without
    // this, the wiring between the env var and the verifier is untested and
    // could be broken in a build while every test still passed.
    const { row, issuerPublicKey } = mint(terms(), SOLD_AT + YEAR)
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', issuerPublicKey)

    const status = await licenceStatus({
      pubkey: CUSTOMER,
      now: SOLD_AT,
      loadRows: async () => [row],
    })

    expect(status.decision.granted).toBe(true)
  })

  it('refuses that same licence once the deployment key is cleared', async () => {
    const { row } = mint(terms(), SOLD_AT + YEAR)
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', '')

    const status = await licenceStatus({
      pubkey: CUSTOMER,
      now: SOLD_AT,
      loadRows: async () => [row],
    })

    expect(status.decision.granted).toBe(false)
  })
})

describe('a corrupted or hostile grace record', () => {
  it('reads as never-verified rather than as a grant', async () => {
    localStorage.setItem(
      `imani.licence.verified.${CUSTOMER}`,
      JSON.stringify({ at: SOLD_AT, grant: { features: 'terminals', expiresAt: 'forever' } }),
    )

    expect(readLastVerification(CUSTOMER)).toBeNull()

    const status = await licenceStatus({
      pubkey: CUSTOMER,
      now: SOLD_AT,
      issuerPublicKey: 'f'.repeat(64),
      loadRows: () => Promise.reject(new Error('offline')),
    })
    expect(status.decision.granted).toBe(false)
  })

  it('survives storage that refuses to be written', async () => {
    const { row, issuerPublicKey } = mint(terms(), SOLD_AT + YEAR)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    // Degraded to "no window", never to "no licence": a merchant must not lose
    // their subscription because we could not write a note about it.
    const status = await ask([row], issuerPublicKey, SOLD_AT)
    expect(status.decision.granted).toBe(true)
  })
})
