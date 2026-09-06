import { describe, expect, it } from 'vitest'

import { DmPollService } from './core/DmPollService'

/**
 * A token the mint will never accept must not be retried forever.
 *
 * `DmPollService.redeemToken` rethrows on failure, deliberately: that keeps the
 * event out of `eventTracker` so a later poll can try again after a transient
 * mint blip. For a permanently malformed token the same path is a loop.
 * Observed in the field at roughly 30 failures a minute against eight stuck
 * DMs, each one a mint round trip, filling the customer's console with an error
 * they cannot act on.
 *
 * The classifier is what tells the two apart, so it is what these tests pin.
 */
describe('DmPollService — permanently unredeemable tokens', () => {
  // Reaching a private method is the point: the branch it guards decides
  // whether the service loops, and a test that went through the whole poll
  // loop to observe it would be testing the loop rather than the decision.
  const isPermanent = (error: unknown): boolean =>
    (
      DmPollService.prototype as unknown as {
        isPermanentlyUnredeemableError(e: unknown): boolean
      }
    ).isPermanentlyUnredeemableError(error)

  /**
   * The error seen in the field. Produced by cashu-lib 0.30.0, whose redacted
   * `PrivateKey.toString()` gave every proof of a voucher the same nonce, so a
   * split voucher's proofs collided on Y and the mint saw one input repeated.
   * The library is fixed, but tokens minted before the fix still sit in
   * customers' DMs and can never become spendable.
   */
  it('treats 11007 duplicate inputs as permanent', () => {
    const real = new Error(
      'Failed to receive token: Token validation failed at mint http://127.0.0.1.mint:7777: ' +
        'Failed to swap tokens: mintUrl=http://127.0.0.1.mint:7777. HTTP client error: 400 ' +
        '(mint_error_code=11007, reason=Duplicate inputs provided). Suggestion: Check network ' +
        'connectivity, verify the mint URL and parameters, then retry.'
    )

    expect(isPermanent(real)).toBe(true)
  })

  it('matches on the code or the reason, since either may reach us', () => {
    expect(isPermanent(new Error('mint_error_code=11007'))).toBe(true)
    expect(isPermanent(new Error('Duplicate inputs provided'))).toBe(true)
  })

  /**
   * The important negative. A network blip, a 5xx, a busy mint — all of these
   * must keep retrying, because the token is fine and the next attempt may
   * work. Classifying one of these as permanent would silently drop a
   * customer's money.
   */
  it('leaves transient failures retryable', () => {
    expect(isPermanent(new Error('Connection refused'))).toBe(false)
    expect(isPermanent(new Error('HTTP client error: 503 Service Unavailable'))).toBe(false)
    expect(isPermanent(new Error('Rate limit exceeded'))).toBe(false)
    expect(isPermanent(new Error('socket hang up'))).toBe(false)
  })

  /**
   * "Already spent" is handled separately and means the value DID reach its
   * owner, so it must not be swept into this branch — the two lead to
   * different outcomes for the token record.
   */
  it('does not claim an already-spent token as unredeemable', () => {
    expect(isPermanent(new Error('Proof already used'))).toBe(false)
    expect(isPermanent(new Error('Token already redeemed'))).toBe(false)
  })

  it('tolerates a non-Error rejection', () => {
    expect(isPermanent('mint_error_code=11007')).toBe(true)
    expect(isPermanent(null)).toBe(false)
    expect(isPermanent(undefined)).toBe(false)
  })
})
