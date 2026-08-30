import { describe, expect, it } from 'vitest'

import { QrType, QrTypeDetector } from '../../../packages/imani-qr/src/detector'
import {
  PaymentRequestHandler,
  TokenHandler,
  VoucherRedeemHandler,
} from '../../../packages/imani-qr/src/handlers'
import { BARCODE_PREFIX } from '../pass'

/**
 * DEV-131 — the wallet's own scanner recognising the pass barcode it prints.
 *
 * Imported from source rather than through the `imani-qr` barrel, matching
 * `aliases.test.ts`: the barrel pulls in nut16, which needs browser APIs this
 * environment does not have.
 *
 * The property under test is not "a regex matches". It is that a REDEMPTION
 * IDENTIFIER and BEARER VALUE route to different places. Conflating them would
 * have a merchant's till receive a customer's whole token instead of resolving
 * a redemption against it, so each test here names the confusion it prevents.
 */

const VOUCHER_ID = '17be770a-0000-4000-8000-000000000000'

describe('the voucher pass barcode is recognised', () => {
  const detector = new QrTypeDetector()

  it('detects what pass.ts actually prints', () => {
    // Built from the REAL constant the pass writer uses, not a copy of it. The
    // producer and the reader live in different packages, and a literal here
    // would keep passing after the two drifted apart — which is exactly the
    // failure this whole card is about.
    expect(detector.getType(`${BARCODE_PREFIX}${VOUCHER_ID}`)).toBe(QrType.VOUCHER_REDEEM)
    expect(BARCODE_PREFIX).toBe('voucher:')
  })

  it('was UNKNOWN before, which is the defect the card reported', () => {
    // Guarding the fix rather than restating it: every other payload the
    // scanner accepts is prefix-discriminated, and this one matched nothing, so
    // imani's scanner was the one thing that could not read an imani pass.
    expect(detector.getType(`voucher:${VOUCHER_ID}`)).not.toBe(QrType.UNKNOWN)
  })

  it('carries a description, so an unrouted scan can still be named', () => {
    expect(detector.getDescription(QrType.VOUCHER_REDEEM)).toBe('Voucher')
  })

  it('survives the case-folding a QR encoder may apply', () => {
    // Alphanumeric QR mode is denser and upper-cases; the prefix match must not
    // depend on the encoder's choice.
    expect(detector.getType(`VOUCHER:${VOUCHER_ID}`)).toBe(QrType.VOUCHER_REDEEM)
  })

  it('does not claim a bare uuid', () => {
    // Exactly why the prefix exists. A bare UUID collides with nothing and
    // means nothing; treating one as a voucher would make any opaque string a
    // merchant scanned look like a coupon.
    expect(detector.getType(VOUCHER_ID)).toBe(QrType.UNKNOWN)
  })
})

describe('an identifier is never confused with bearer value', () => {
  const detector = new QrTypeDetector()

  it('routes a transfer token to CASHU_TOKEN, not to the voucher lookup', () => {
    // `renderShareQr` emits the raw token: scanning it hands over the money.
    // If it landed on VOUCHER_REDEEM, a till scanning a customer's share code
    // would silently receive their whole token.
    expect(detector.getType('cashuBo2FteCJodHRwczovL21pbnQ')).toBe(QrType.CASHU_TOKEN)
  })

  it('routes an animated transfer frame to UR_FRAGMENT', () => {
    expect(detector.getType('ur:bytes/1-3/lpadaxcsvdcyhkaenshd')).toBe(QrType.UR_FRAGMENT)
  })

  it('the token handler refuses a voucher id', () => {
    // Asserted on the handler, not just the detector: a mis-registered handler
    // is the other way these two could cross.
    expect(new TokenHandler().validate(`voucher:${VOUCHER_ID}`)).toBe(false)
  })

  it('the voucher handler refuses a token, a payment request, and an address', () => {
    const handler = new VoucherRedeemHandler()
    expect(handler.validate('cashuBo2FteCJodHRwcw')).toBe(false)
    expect(handler.validate('vreqAo2F0gaJhb')).toBe(false)
    expect(handler.validate('song@staging.398ja.xyz')).toBe(false)
    expect(handler.validate(`npub1${'q'.repeat(58)}`)).toBe(false)
  })

  it('the payment request handler refuses a voucher id', () => {
    // ScanPage tries the payment request FIRST, so a false positive there
    // would shadow the voucher route entirely.
    expect(new PaymentRequestHandler().validate(`voucher:${VOUCHER_ID}`)).toBe(false)
  })
})

describe('what the handler hands the screen', () => {
  const handler = new VoucherRedeemHandler()

  it('strips the prefix, leaving the id a merchant record is keyed on', async () => {
    // `IssuedCouponPage` looks up `issued:${voucherId}`, so anything left on
    // the front of the id makes the lookup miss and reads as a lost coupon.
    expect(await handler.parse(`voucher:${VOUCHER_ID}`)).toEqual({ voucherId: VOUCHER_ID })
  })

  it('does not lower-case the id itself', async () => {
    // The prefix is matched case-insensitively; the id is opaque and compared
    // verbatim against stored records. Folding it would break the lookup for
    // any id that is not already lower-case.
    const mixed = 'AB12-cdEF'
    expect((await handler.parse(`voucher:${mixed}`)).voucherId).toBe(mixed)
  })

  it('tolerates surrounding whitespace, which a paste often carries', async () => {
    expect((await handler.parse(`  voucher:${VOUCHER_ID}  `)).voucherId).toBe(VOUCHER_ID)
  })

  it('refuses a prefix with no id rather than routing to a lookup that cannot succeed', async () => {
    // `voucher:` alone names nothing. Accepting it would land the merchant on
    // "No record of this voucher", which reads as a broken scanner rather than
    // an unrecognised code.
    expect(handler.validate('voucher:')).toBe(false)
    expect(handler.validate('voucher:   ')).toBe(false)
    await expect(handler.parse('voucher:')).rejects.toThrow(/not a voucher/i)
  })

  it('names the param the route uses', () => {
    expect(handler.getParams({ voucherId: VOUCHER_ID })).toEqual({ voucherId: VOUCHER_ID })
  })
})
