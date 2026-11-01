/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

import { ReceiveNotPossible, receiveTokenByOwnSwap, settleOwnSwap } from '../receiveToken'
import { loadSwapIntents } from '../swapIntent'
import { isVoucherSecret, parseVoucherToken, tokenProofs } from '../voucherToken'
import { gatewayAnswers, gatewayUnreachable, resetGate } from './trustedMintKit'
import { buildPlainToken } from './voucherFixtures'

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
    vi.unstubAllEnvs()
    resetGate()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    resetGate()
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
    // Trusted, so the mint gate cannot be what refuses this and mask the guard.
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', mintUrlOf(fixture('witness-positive.token')))

    await expect(
      receiveTokenByOwnSwap(fixture('witness-positive.token'), PUBKEY, transport),
    ).rejects.toThrow(/voucher/i)

    expect(reached.swap).toBe(0)
    expect(loadSwapIntents(PUBKEY)).toEqual([])
  })

  /** Refused with a code, so the caller can route to the gateway rather than error. */
  it('names the refusal so a caller can fall back rather than fail', async () => {
    const { transport } = unreachableTransport()
    vi.stubEnv('VITE_TRUSTED_MINT_URLS', mintUrlOf(fixture('witness-positive.token')))

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
    await gatewayAnswers('https://some-other-mint.example.test')

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
   * The attack #133 describes, on the token this path actually receives: plain
   * ecash naming a mint the attacker runs. This path swaps at the token's OWN mint,
   * so accepting it would send the swap to the attacker. Refused before the mint is
   * contacted at all, keys included.
   */
  it('refuses plain ecash from a rogue mint without contacting it', async () => {
    const { transport, reached } = unreachableTransport()
    await gatewayAnswers('https://mint.staging.398ja.xyz')

    const failure = await receiveTokenByOwnSwap(
      buildPlainToken('https://rogue-mint.example.test'),
      PUBKEY,
      transport,
    ).catch((error: unknown) => error)

    expect((failure as ReceiveNotPossible).refusal).toBe('untrusted-mint')
    expect(reached.keys + reached.swap + reached.restore).toBe(0)
    expect(loadSwapIntents(PUBKEY)).toEqual([])
  })

  /** Proofs at our own mint but in another unit are refused: their amounts mean nothing here. */
  it('refuses plain ecash at the trusted mint in the wrong unit', async () => {
    const { transport, reached } = unreachableTransport()
    await gatewayAnswers('https://mint.staging.398ja.xyz')

    const failure = await receiveTokenByOwnSwap(
      buildPlainToken('https://mint.staging.398ja.xyz', 'usd'),
      PUBKEY,
      transport,
    ).catch((error: unknown) => error)

    expect((failure as ReceiveNotPossible).refusal).toBe('wrong-unit')
    expect(reached.keys + reached.swap).toBe(0)
  })

  /**
   * FAIL CLOSED when the deployment names no mint. The crediting paths accept
   * `unchecked`, because there the money is already held. Here nothing has moved,
   * and the only mint on offer is the one the token names, which is exactly the
   * mint an attacker chooses. So an empty list is a refusal, not a pass.
   */
  it('refuses when the gateway has answered and names no trusted mint', async () => {
    const { transport, reached } = unreachableTransport()
    await gatewayAnswers('')

    const failure = await receiveTokenByOwnSwap(
      buildPlainToken('https://rogue-mint.example.test'),
      PUBKEY,
      transport,
    ).catch((error: unknown) => error)

    expect((failure as ReceiveNotPossible).refusal).toBe('no-trusted-mint')
    expect(reached.keys + reached.swap).toBe(0)
  })

  /**
   * And when the trusted list is not known at all, because the config never
   * arrived. Before #133 this was the default state of a build, and it waved the
   * swap through as `unchecked`.
   */
  it.each([
    ['nothing has been loaded', async () => {}],
    ['the config fetch failed', gatewayUnreachable],
  ])('refuses when %s', async (_name, arrange) => {
    const { transport, reached } = unreachableTransport()
    await arrange()

    const failure = await receiveTokenByOwnSwap(
      buildPlainToken('https://rogue-mint.example.test'),
      PUBKEY,
      transport,
    ).catch((error: unknown) => error)

    expect((failure as ReceiveNotPossible).refusal).toBe('not-ready')
    expect(reached.keys + reached.swap).toBe(0)
  })

  /**
   * The control for the four refusals above: plain ecash at the trusted mint gets
   * past the gate. What stops it is the next step, witness building, which needs
   * an unlocked wallet this test does not have. That error proves the gate let the
   * token through rather than refusing it for some other reason. The token's `m`
   * carries a trailing slash the config does not.
   */
  it('lets plain ecash at the trusted mint through the gate', async () => {
    const { transport } = unreachableTransport()
    await gatewayAnswers('https://mint.staging.398ja.xyz')

    const failure = await receiveTokenByOwnSwap(
      buildPlainToken('https://mint.staging.398ja.xyz/'),
      PUBKEY,
      transport,
    ).catch((error: unknown) => error)

    expect(failure).not.toBeInstanceOf(ReceiveNotPossible)
    expect(String(failure)).toMatch(/signer|unlocked/i)
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
    await gatewayAnswers(mintUrlOf(fixture(file)))
    expect(tokenProofs(fixture(file))[0].secret.startsWith(`["${kind}"`)).toBe(true)

    const failure = await receiveTokenByOwnSwap(fixture(file), PUBKEY, transport).catch(
      (error: unknown) => error,
    )

    expect((failure as ReceiveNotPossible).refusal).toBe('voucher-unsupported')
  })

  /**
   * The parser-divergence hole, found by a security reviewer.
   *
   * cashu-lib gates on brackets and then uses Jackson, which stops at the first
   * complete value and IGNORES trailing content. `JSON.parse` rejects the whole
   * string instead. So a secret with a stray bracket after the array was a
   * voucher to the mint and not a voucher to this guard, and this path would have
   * swapped it into random secrets: right sats, coupon gone, no error.
   *
   * Two readers of the same bytes disagreeing is the same class of bug as
   * cashu-voucher#48, and it is why the guard now reads what cashu-lib reads.
   */
  it.each([
    ['a stray closing bracket', ' ]'],
    ['a second array', '[1]]'],
    ['whitespace then a bracket', '\n  ]'],
  ])('refuses a voucher secret followed by %s, which Jackson accepts', (_name, suffix) => {
    const voucher = tokenProofs(fixture('witness-positive.token'))[0].secret

    // cashu-lib's gate is startsWith('[') && endsWith(']'), so only trailing
    // content that still ends in a bracket reaches its parser at all. Those are
    // exactly the cases where the two readers could disagree, and the ones that
    // matter: anything else is refused by both.
    expect(isVoucherSecret(voucher + suffix)).toBe(true)
  })

  /**
   * A bracketed secret nobody can parse is refused rather than assumed harmless.
   *
   * cashu-lib falls back to reading it as a bearer string, and so could this. The
   * downside is not symmetric: refusing costs a fallback to the gateway receive,
   * while accepting costs the coupon if any reader anywhere disagrees.
   */
  it('refuses a bracketed secret that will not parse at all', () => {
    expect(isVoucherSecret('[this is not json at all]')).toBe(true)
  })

  /** A plain bearer secret is still received normally, which is most traffic. */
  it('does not mistake an ordinary bearer secret for a voucher', () => {
    expect(isVoucherSecret('9a1b2c3d4e5f60718293a4b5c6d7e8f9')).toBe(false)
  })
})
