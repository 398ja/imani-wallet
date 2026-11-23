/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { isCardReference, paypalEnabled, processorName, processorOf, processorOfReference } from '../cardProcessor'
import { chooseCardAccount } from '../cardAccount'
import type { StripeResult } from '../stripeAccount'

/** Stripe or PayPal: payment-adapter ADR 0002 tells them apart the same way. */
describe('card processors', () => {
  it('tells a reference’s processor by its shape', () => {
    expect(processorOfReference('pi_3PqRsTuVwXyZ')).toBe('stripe')
    expect(processorOfReference('5O190127TN364715T')).toBe('paypal')
    for (const other of ['5o190127tn364715t', '5O190127TN364715', '5O190127TN364715TX', 'ch_123', '', 'pi_']) {
      expect(processorOfReference(other), other).toBeUndefined()
    }
    expect(processorOfReference(undefined)).toBeUndefined()
    expect(isCardReference('5O190127TN364715T')).toBe(true)
    expect(isCardReference('../accounts/x')).toBe(false)
  })

  it('reads only a literal paypal as PayPal on a stall record', () => {
    expect(processorOf({ cardProcessor: 'paypal' })).toBe('paypal')
    for (const other of [undefined, 'stripe', 'PAYPAL', 1, null]) {
      expect(processorOf({ cardProcessor: other })).toBe('stripe')
    }
    expect(processorOf(null)).toBe('stripe')
    expect(processorName('paypal')).toBe('PayPal')
    expect(processorName('stripe')).toBe('Stripe')
  })

  it('offers PayPal only when the build says on', () => {
    expect(paypalEnabled('on')).toBe(true)
    expect(paypalEnabled(' ON ')).toBe(true)
    for (const off of [undefined, '', 'true', 'off', 1]) expect(paypalEnabled(off)).toBe(false)
  })
})

const ok = (status: string, chargesEnabled = false): StripeResult => ({
  kind: 'ok',
  status: { status, chargesEnabled, payoutsEnabled: false, detailsSubmitted: false, requirementsDue: [] },
})
const down: StripeResult = { kind: 'unreachable', reason: 'down' }

describe('which card account the screen is about', () => {
  it('is the connected one, whichever the record names', () => {
    expect(chooseCardAccount({ stripe: ok('not_connected'), paypal: ok('charges_enabled', true) }, 'stripe').processor).toBe('paypal')
    expect(chooseCardAccount({ stripe: ok('charges_enabled', true), paypal: ok('not_connected') }, 'paypal').processor).toBe('stripe')
  })

  it('is the recorded one with neither connected, so a merchant can still pick', () => {
    expect(chooseCardAccount({ stripe: ok('not_connected'), paypal: ok('not_connected') }, 'paypal').processor).toBe('paypal')
    expect(chooseCardAccount({ stripe: ok('not_connected'), paypal: ok('not_connected') }, 'stripe').processor).toBe('stripe')
  })

  it('never reads a failed read as not connected', () => {
    // Stripe answered "not connected" and PayPal could not be asked: the failure goes on, so the
    // reconcile changes nothing rather than withdrawing a PayPal stall's offer over a blip.
    const chosen = chooseCardAccount({ stripe: ok('not_connected'), paypal: down }, 'paypal')
    expect(chosen).toEqual({ processor: 'paypal', result: down })
    expect(chooseCardAccount({ stripe: ok('not_connected'), paypal: down }, 'stripe').result).toBe(down)
  })

  it('prefers the recorded one when both are connected, unless only the other can charge', () => {
    expect(chooseCardAccount({ stripe: ok('restricted'), paypal: ok('charges_enabled', true) }, 'stripe').processor).toBe('paypal')
    expect(chooseCardAccount({ stripe: ok('charges_enabled', true), paypal: ok('charges_enabled', true) }, 'paypal').processor).toBe('paypal')
    expect(chooseCardAccount({ stripe: ok('restricted'), paypal: ok('restricted') }, 'stripe').processor).toBe('stripe')
  })

  it('works with PayPal not asked at all', () => {
    expect(chooseCardAccount({ stripe: ok('not_connected') }, 'stripe').processor).toBe('stripe')
  })
})
