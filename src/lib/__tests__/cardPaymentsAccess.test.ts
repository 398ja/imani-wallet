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
})
