import { describe, expect, it } from 'vitest'

import { cardPaymentsPlan } from '../cardPaymentsAccess'
import type { LicenceStatus } from '../licenceStatus'

/** Card payments are Essentials and above: any paid plan in force, never Starter. */

const NOW = 1_800_000_000

const status = (grant: { features: string[]; tier?: string } | null, expiresAt = NOW + 86_400): LicenceStatus =>
  ({
    checkedAt: NOW,
    decision: grant ? { granted: true, source: 'verified', grant: { ...grant, expiresAt } } : { granted: false, reason: 'absent' },
    grants: grant ? [{ ...grant, expiresAt }] : [],
  }) as unknown as LicenceStatus

describe('cardPaymentsPlan', () => {
  it('is included on Essentials and on Pro', () => {
    expect(cardPaymentsPlan(status({ tier: 'basic', features: ['terminals'] }))).toBe('included')
    expect(cardPaymentsPlan(status({ tier: 'pro', features: ['terminals', 'api', 'ecommerce'] }))).toBe('included')
  })

  it('is included on a licence sold before tiers, which names no tier', () => {
    expect(cardPaymentsPlan(status({ features: ['terminals'] }))).toBe('included')
  })

  it('is not included on Starter, with no licence', () => {
    expect(cardPaymentsPlan(status(null))).toBe('not-included')
  })

  it('is not included once the plan has ended', () => {
    expect(cardPaymentsPlan(status({ tier: 'basic', features: ['terminals'] }, NOW - 1))).toBe('not-included')
  })

  it('is unknown when the plan could not be checked', () => {
    expect(cardPaymentsPlan(null)).toBe('unknown')
  })

  // Regression (review): licenceStatus resolves a store it could not read as a refusal with a
  // GRACE reason, not a throw. Read as Starter, an outage withdrew a paying stall's card offer.
  it('is unknown, not Starter, when the licence store could not be read', () => {
    for (const reason of ['never-verified', 'grace-elapsed']) {
      const outage = { checkedAt: NOW, decision: { granted: false, reason, detail: 'the wallet could not be read' }, grants: [] } as unknown as LicenceStatus
      expect(cardPaymentsPlan(outage)).toBe('unknown')
    }
  })

  it('is not included on an ANSWERED refusal: expired, revoked, absent', () => {
    for (const reason of ['expired', 'revoked-by-seller', 'absent']) {
      const answered = { checkedAt: NOW, decision: { granted: false, reason, detail: '' }, grants: [] } as unknown as LicenceStatus
      expect(cardPaymentsPlan(answered)).toBe('not-included')
    }
  })

  it('is included under the grace window, which carries the last verified grant', () => {
    const grace = {
      checkedAt: NOW,
      decision: { granted: true, source: 'grace', grant: { tier: 'basic', features: ['terminals'], expiresAt: NOW + 86_400 } },
      grants: [{ tier: 'basic', features: ['terminals'], expiresAt: NOW + 86_400 }],
    } as unknown as LicenceStatus
    expect(cardPaymentsPlan(grace)).toBe('included')
  })
})
