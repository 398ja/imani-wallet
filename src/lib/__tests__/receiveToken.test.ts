/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

import { ReceiveNotPossible, receiveTokenByOwnSwap, settleOwnSwap } from '../receiveToken'
import { loadSwapIntents } from '../swapIntent'
import { parseVoucherToken, tokenProofs } from '../voucherToken'

/**
 * The join between a token string and a wallet-chosen swap.
 *
 * `receiveSwap` is tested separately for the orchestration and `walletSwap` for the
 * crypto. What this covers is the seam: decoding a real token, deciding whether this
 * path may be used at all, and attaching witnesses. Those decisions are the ones a
 * call site would otherwise have to remember, and the ones that are silent when
 * wrong.
 *
 * Tokens here are REAL captured fixtures rather than hand-built ones. A fixture
 * written to suit the guard proves only that the guard matches itself; the point of
 * these is that the product's actual token shapes go through.
 */

const PUBKEY = 'a'.repeat(64)

function fixture(name: string): string {
  return readFileSync(`src/lib/__tests__/fixtures/${name}`, 'utf8').trim()
}

/** The token's own mint, so a test can trust it without hardcoding a URL. */
function mintUrlOf(token: string): string {
  return parseVoucherToken(token).mintUrl
}

/** A transport that fails loudly, so any test reaching the mint says so. */
function unreachableTransport() {
  const reached = { swap: 0, keys: 0, restore: 0 }
  return {
    reached,
    transport: {
      activeKeysetId: async () => {
        reached.keys += 1
        throw new Error('the mint must not be reached in this test')
      },
      keysetKeys: async () => {
        reached.keys += 1
        throw new Error('the mint must not be reached in this test')
      },
      swap: async () => {
        reached.swap += 1
        throw new Error('the mint must not be reached in this test')
      },
      restore: async () => {
        reached.restore += 1
        throw new Error('the mint must not be reached in this test')
      },
    },
  }
}

describe('receiveTokenByOwnSwap', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
    delete (globalThis as { GatewayConfig?: unknown }).GatewayConfig
  })

  /**
   * The refusal that prevents a silent loss.
   *
   * A wallet-chosen swap generates RANDOM output secrets, which is right for plain
   * ecash and destructive for a voucher: the secret carries the coupon's id, face
   * value, lock key and issuer signature. Pushed through, the swap returns the right
   * SATS with no coupon attached and nothing fails, because the mint balances sats
   * and never reads the coupon.
   *
   * Nothing about that is visible at the call site, which is why the refusal lives
   * here rather than in a comment.
   */
  it('refuses a real captured voucher token', async () => {
    const { transport, reached } = unreachableTransport()

    await expect(
      receiveTokenByOwnSwap(fixture('witness-positive.token'), PUBKEY, transport),
    ).rejects.toThrow(/voucher/i)

    expect(reached.swap).toBe(0)
    expect(loadSwapIntents(PUBKEY)).toEqual([])
  })

  /** Refused with a code, so the caller can route to the gateway rather than error. */
  it('names the refusal so a caller can fall back rather than fail', async () => {
    const { transport } = unreachableTransport()

    const failure = await receiveTokenByOwnSwap(
      fixture('witness-positive.token'),
      PUBKEY,
      transport,
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ReceiveNotPossible)
    expect((failure as ReceiveNotPossible).refusal).toBe('voucher-unsupported')
  })

  /**
   * A token this wallet cannot even read must not reach the mint.
   *
   * Distinguished from every other refusal because the advice differs: an
   * undecodable token is a client bug or a corrupted paste, not something the
   * gateway path would handle any better.
   */
  it('refuses an undecodable token without touching the mint', async () => {
    const { transport, reached } = unreachableTransport()

    const failure = await receiveTokenByOwnSwap('not-a-token', PUBKEY, transport).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(ReceiveNotPossible)
    expect((failure as ReceiveNotPossible).refusal).toBe('undecodable')
    expect(reached.keys + reached.swap).toBe(0)
  })

  /**
   * Settling is the caller's job, and separate on purpose.
   *
   * Doing it inside the receive would clear the recovery record while the proofs
   * were still only in memory, which is the exact window the intent exists to cover.
   * Exported here so a call site has one obvious function to reach for.
   */
  it('settling an unknown swap is harmless', () => {
    expect(() => settleOwnSwap(PUBKEY, 'never-existed')).not.toThrow()
  })

  /**
   * The mint gate, which a mutation check caught being untested.
   *
   * Every other test here uses a voucher or an undecodable token, both of which are
   * refused earlier, so deleting the mint check entirely left all of them green. A
   * gate nothing exercises is a gate that can be removed by accident, and this one
   * decides whether value from an unknown mint gets credited as if it were ours.
   *
   * Configures a trusted mint that is NOT the fixture's, so the token is well formed
   * and simply at the wrong place.
   */
  it('refuses proofs at a mint this build does not trust', async () => {
    const { transport, reached } = unreachableTransport()
    // As a gateway that has answered /api/v1/config does: whenReady fires its
    // callback synchronously, which is the signal readiness is actually read from.
    ;(globalThis as { GatewayConfig?: unknown }).GatewayConfig = {
      mintUrl: 'https://some-other-mint.example.test',
      whenReady: (callback: () => void) => callback(),
    }

    const failure = await receiveTokenByOwnSwap(
      fixture('control-unlocked.token'),
      PUBKEY,
      transport,
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ReceiveNotPossible)
    expect((failure as ReceiveNotPossible).refusal).toBe('untrusted-mint')
    expect(reached.swap).toBe(0)
  })

  /**
   * Both real voucher kinds are caught, matched against captured tokens.
   *
   * The guard compares the NUT-10 kind exactly, which looks brittle. It is not,
   * and the reason is that it must agree with cashu-lib's `Kind.valueOf`, which is
   * also exact. A secret whose kind is `p2pk_voucher` or `P2PK_VOUCHER ` evades
   * this guard AND is rejected by the mint as an unknown kind, so there is no
   * coupon to destroy.
   *
   * Pinned with real fixtures for both kinds, because the guard having two
   * literals in it is precisely the kind of thing that gets half-updated.
   */
  it.each([
    ['P2PK_VOUCHER', 'witness-positive.token'],
    ['VOUCHER', 'control-unlocked.token'],
  ])('refuses the %s kind, as captured from a real token', async (kind, file) => {
    const { transport } = unreachableTransport()
    // Trusted, so the mint gate cannot be what refuses this and mask the guard.
    ;(globalThis as { GatewayConfig?: unknown }).GatewayConfig = {
      mintUrl: mintUrlOf(fixture(file)),
      whenReady: (callback: () => void) => callback(),
    }
    expect(tokenProofs(fixture(file))[0].secret.startsWith(`["${kind}"`)).toBe(true)

    const failure = await receiveTokenByOwnSwap(fixture(file), PUBKEY, transport).catch(
      (error: unknown) => error,
    )

    expect((failure as ReceiveNotPossible).refusal).toBe('voucher-unsupported')
  })
})
