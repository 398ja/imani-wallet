import { describe, it, expect, afterEach, beforeEach } from 'vitest'

import { effectiveNow, acceptsCallerHistory, testSeamsEnabled } from '../testSeams'

/**
 * Regression tests for IW-05 (High): caller-supplied clock and history.
 *
 * `redeem.ts` and `licence.ts` both read `now` from the request body, falling back to the server
 * clock only when it was absent. The docstrings described it as existing "so expiry is testable
 * to the second" — a test seam wired into the production request parser.
 *
 * That value decided every time-based refusal: the expired-coupon branch in redeem, the
 * `expires_at > now` rule in verifyLicence, and the grace-window comparison in decideWithGrace.
 * So a caller could redeem a coupon that expired last year by sending `{"now": 1600000000}`, and
 * `/v1/redeem/prepare` gates on that verdict before handing a till the receive URL and body.
 *
 * The licence path had no downstream authority at all — checkLicence is deliberately offline
 * (ADR 0007, no licence server) — so an expired licence plus any past timestamp returned
 * `granted: true` with the full feature list, permanently.
 */
describe('IW-05: the server clock decides expiry', () => {
  const SERVER_NOW = 1_800_000_000
  const ATTACKER_NOW = 1_600_000_000

  afterEach(() => {
    delete process.env.WALLET_API_ALLOW_TEST_SEAMS
  })

  describe('by default', () => {
    beforeEach(() => {
      delete process.env.WALLET_API_ALLOW_TEST_SEAMS
    })

    it('ignores a caller-supplied clock', () => {
      expect(effectiveNow(ATTACKER_NOW, SERVER_NOW)).toBe(SERVER_NOW)
    })

    it('ignores a caller-supplied clock even when it is in the future', () => {
      // Both directions matter: backwards revives an expired coupon, forwards can expire a
      // live one or push a grace window past its end.
      expect(effectiveNow(SERVER_NOW + 999_999, SERVER_NOW)).toBe(SERVER_NOW)
    })

    it('does not accept caller-supplied verification history', () => {
      // The grace window is computed from lastVerification, so accepting one from the request
      // lets the caller manufacture the evidence that grants them grace.
      expect(acceptsCallerHistory()).toBe(false)
    })

    it('reports the seam as disabled', () => {
      expect(testSeamsEnabled()).toBe(false)
    })
  })

  describe('with the seam explicitly enabled', () => {
    beforeEach(() => {
      process.env.WALLET_API_ALLOW_TEST_SEAMS = 'true'
    })

    it('honours the caller clock, which is what tests need', () => {
      expect(effectiveNow(ATTACKER_NOW, SERVER_NOW)).toBe(ATTACKER_NOW)
    })

    it('accepts caller history', () => {
      expect(acceptsCallerHistory()).toBe(true)
    })

    it('still falls back to the server clock for a non-numeric value', () => {
      expect(effectiveNow('not-a-number', SERVER_NOW)).toBe(SERVER_NOW)
      expect(effectiveNow(undefined, SERVER_NOW)).toBe(SERVER_NOW)
    })
  })

  describe('the flag itself', () => {
    it('is off for anything other than the exact string "true"', () => {
      // A truthy-string bug here would re-open the finding, so only one value enables it.
      for (const value of ['1', 'yes', 'TRUE', 'on', '']) {
        expect(testSeamsEnabled({ WALLET_API_ALLOW_TEST_SEAMS: value } as NodeJS.ProcessEnv))
          .toBe(false)
      }
    })
  })
})
