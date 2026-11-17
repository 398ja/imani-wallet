import { describe, expect, it } from 'vitest'

import { currencyFromRecord, DEFAULT_VALIDITY_DAYS, NEVER_EXPIRES, validityFromRecord } from '../index'

/**
 * imani-wallet#312: the record decoding the wallet's Sell screen and the purchase issuer share.
 */
describe('validityFromRecord', () => {
  // A valid term is the stall's term, whether written as a number or a digit string.
  it('reads a valid voucherValidityDays', () => {
    expect(validityFromRecord(JSON.stringify({ voucherValidityDays: 90 }))).toBe(90)
    expect(validityFromRecord(JSON.stringify({ voucherValidityDays: '30' }))).toBe(30)
    expect(validityFromRecord(JSON.stringify({ voucherValidityDays: 0 }))).toBe(NEVER_EXPIRES)
  })

  // Anything that is not a term is the stall's default, exactly as `mergeMerchantEvent` over
  // `emptyMerchant` reads it: never a hard-coded year.
  it.each([['{}'], ['not json'], ['null'], [JSON.stringify({ voucherValidityDays: 731 })], [JSON.stringify({ voucherValidityDays: false })]])(
    'reads %s as the default',
    (content) => {
      expect(validityFromRecord(content)).toBe(DEFAULT_VALIDITY_DAYS)
    },
  )
})

describe('currencyFromRecord', () => {
  it.each([
    [JSON.stringify({ issuanceCurrency: 'GBP' }), 'GBP'],
    [JSON.stringify({ issuanceCurrency: ' eur ' }), 'EUR'],
    [JSON.stringify({ issuanceCurrency: 'pounds' }), null],
    [JSON.stringify({ issuanceCurrency: 826 }), null],
    ['{}', null],
    ['not json', null],
    ['null', null],
  ])('reads %s as %o', (content, unit) => {
    expect(currencyFromRecord(content)).toBe(unit)
  })
})
