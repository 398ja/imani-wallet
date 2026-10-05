/**
 * Refusing an unwarranted coupon at the till, before the mint swap.
 *
 * The ordering is the part worth testing. A refusal one line later, after
 * `redeem()`, would already have taken the money at the mint and left the
 * customer with neither the coupon nor the goods — so these assert that the
 * refusal is a throw from a pure function, reachable before anything moves.
 */
import { describe, it, expect } from 'vitest'

import { refuseIfUnwarranted } from '../dmPoll'
import type { VoucherValidation } from '../voucherToken'

function meta(warrant: VoucherValidation['warrant'], over: Partial<VoucherValidation> = {}) {
  return {
    voucherId: '6f39585b-7826-4493-84e5-2a7e907c0820',
    validation: {
      signatureValid: true,
      legacyCanonical: false,
      signedFaceValue: 2500,
      cappedAtFaceValue: false,
      warrant,
      ...over,
    } satisfies VoucherValidation,
  }
}

describe('all three unauthorised states are refused', () => {
  it('refuses a coupon with no warrant at all', () => {
    // The state an attacker would choose if only forgeries were caught.
    expect(() => refuseIfUnwarranted(meta('absent'))).toThrow(/no usable authorisation/)
  })

  it('refuses a coupon whose issuer signed `none`', () => {
    expect(() => refuseIfUnwarranted(meta('unwarranted'))).toThrow(/no usable authorisation/)
  })

  it('refuses a coupon whose warrant did not hold', () => {
    expect(() => refuseIfUnwarranted(meta('failed'))).toThrow(/no usable authorisation/)
  })

  // An unsigned processor claim (#152): nothing on this device can check it,
  // so it is the issuing service's word alone and is refused like the others.
  it('refuses an unsigned processor claim', () => {
    expect(() => refuseIfUnwarranted(meta('claimed'))).toThrow(/no usable authorisation/)
  })

  it('omitting a warrant is no safer than forging one', () => {
    // The property that made the earlier policy wrong. Both must refuse, or the
    // scheme is opt-out for the party it was written to catch.
    expect(() => refuseIfUnwarranted(meta('absent'))).toThrow()
    expect(() => refuseIfUnwarranted(meta('failed'))).toThrow()
  })

  it('carries the `unwarranted` reason, so the toast can explain itself', () => {
    try {
      refuseIfUnwarranted(meta('absent'))
      throw new Error('should have refused')
    } catch (e) {
      expect((e as { reason?: string }).reason).toBe('unwarranted')
    }
  })
})

describe('what must NOT be refused', () => {
  it('accepts a verified warrant', () => {
    expect(() => refuseIfUnwarranted(meta('verified'))).not.toThrow()
  })

  it('accepts a row whose validation predates the warrant field', () => {
    // `warrant` undefined: the question was never asked. Refusing on a check
    // that never ran would reject good coupons for a reason nobody can act on,
    // and every row stored before this shipped is in exactly that state.
    expect(() => refuseIfUnwarranted(meta(undefined))).not.toThrow()
  })

  it('leaves an unsigned coupon to the signature check', () => {
    // Not this function's question. `signatureValid: false` is caught earlier
    // and with a better message; duplicating it here would make whichever
    // check fired first decide what the merchant is told.
    expect(() => refuseIfUnwarranted(meta('absent', { signatureValid: false }))).not.toThrow()
  })

  it('does nothing without a validation record', () => {
    expect(() => refuseIfUnwarranted(undefined)).not.toThrow()
    expect(() => refuseIfUnwarranted({})).not.toThrow()
  })
})
