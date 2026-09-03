/**
 * A prepared part, read by the WALLET's own receiving path.
 *
 * The other tests prove the service returns an event of the right shape. This
 * one proves the shape is the right one, which is a different claim and the
 * only one the ticket's "accepted by a wallet as a genuine send" can mean.
 *
 * The fixture is a REAL response, captured from the running stack: wallet-api
 * in its container, gateway-core splitting a coupon the seeded issuer actually
 * minted, over a real mint. Nothing here is hand-written, because a
 * hand-written token would carry a voucher signature this file forged, and
 * `parseTokenTransferMessage` REJECTS a voucher whose issuer signature does not
 * check out — which is precisely the check being exercised.
 *
 * Captured rather than live so the suite stays runnable without the stack.
 * Regenerate with `prepare-e2e` against a running deployment if the payload
 * shape ever changes; a drift here means a coupon that arrives worth nothing.
 */
import { describe, expect, it } from 'vitest'

import fixture from './fixtures/preparedPart.json'

const { unsignedEvent, sent, recipientPubkey } = fixture.prepared

describe('a prepared part, as the receiving wallet reads it', () => {
  it('is an unsigned rumor addressed to the recipient', () => {
    expect(unsignedEvent.kind).toBe(14)
    expect(unsignedEvent).not.toHaveProperty('id')
    expect(unsignedEvent).not.toHaveProperty('pubkey')
    expect(unsignedEvent).not.toHaveProperty('sig')
    expect(unsignedEvent.tags).toContainEqual(['p', recipientPubkey])
  })

  it('carries a voucher whose ISSUER signature verifies', async () => {
    // The check that matters, asserted directly rather than through the reader.
    //
    // Going only through `parseTokenTransferMessage` is not enough: when a
    // token cannot be parsed as a voucher at all, the reader falls back to the
    // sender-written envelope, which carries the same face value — so a
    // corrupted token still answered 200 EUR and the test passed. Verified by
    // corrupting the fixture: this assertion goes red, the reader one did not.
    const { parseVoucherToken, verifyVoucher, creditableFaceValue } = await import(
      '../voucherToken.js'
    )

    const parsed = parseVoucherToken(JSON.parse(unsignedEvent.content).token)

    // Signed by the stall that issued the coupon, and still valid after the
    // gateway split it. A split that broke the signature would produce a coupon
    // the recipient's wallet refuses, which is money that stops.
    expect(verifyVoucher(parsed.voucher).signatureValid).toBe(true)
    expect(parsed.voucher.issuerId).toBe(sent.stallId)
    // What the wallet will actually credit — from the signed voucher, capped by
    // the proofs, and equal to the part that was asked for.
    expect(creditableFaceValue(parsed).faceValue).toBe(sent.faceValue)
  })

  it('parses through the wallet’s own DM reader', async () => {
    // The shipping module, not a copy: the same function the poller calls on a
    // real arrival. It prefers the signed voucher over the envelope, and
    // returns null outright when the issuer signature fails.
    const { createDmCryptoAdapter } = await import('../dmCrypto.js')
    const metadata = createDmCryptoAdapter().parseTokenTransferMessage(unsignedEvent.content)

    expect(metadata).not.toBeNull()
    expect(metadata!.faceValue).toBe(sent.faceValue)
    expect(metadata!.faceUnit).toBe(sent.faceUnit)
    expect(metadata!.issuerId).toBe(sent.stallId)
  })

  it('carries the token the service reported splitting', () => {
    const payload = JSON.parse(unsignedEvent.content)
    expect(payload.type).toBe('cashu_token_transfer')
    expect(payload.token).toBe(sent.token)
  })
})
