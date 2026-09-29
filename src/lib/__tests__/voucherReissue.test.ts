/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'

import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'

import { VoucherReissueRefused, reissueVoucherSecret } from '../voucherReissue'

/**
 * Asking the gateway to sign a voucher secret the wallet chose.
 *
 * What matters here is not the happy path, which is a POST. It is whether the
 * caller can tell a refusal worth retrying from one that never will be. Getting
 * that backwards has a cost in both directions: retrying a permanent refusal spins
 * while somebody's coupon sits unreceived, and giving up on a temporary one
 * abandons a receive whose predecessor is already burnt.
 *
 * The signer is stubbed because NIP-98 signing is tested in `nip98.test.ts`. What
 * is exercised here is the reading of the gateway's answer.
 */

const SECRET = generateSecretKey()
const PREDECESSOR = '["P2PK_VOUCHER",{"nonce":"aa","data":"02ab","tags":[]}]'
const PROPOSED = '["P2PK_VOUCHER",{"nonce":"bb","data":"02cd","tags":[]}]'
const SIGNED = '["P2PK_VOUCHER",{"nonce":"bb","data":"02cd","tags":[["issuer_sig","ff"]]}]'

/**
 * A real signer over a throwaway key.
 *
 * Real rather than a stub, because `signedFetch` builds and signs an actual
 * NIP-98 event and a stub that returned a shaped object would skip the code path
 * a malformed template fails in.
 */
const signer = {
  async signEvent(template: {
    kind: number
    created_at: number
    tags: string[][]
    content: string
  }) {
    return finalizeEvent(template, SECRET)
  },
}

function respondWith(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

describe('reissueVoucherSecret', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // A granted signature comes back as the whole secret, ready to blind.
  it('returns the signed secret the gateway produced', async () => {
    respondWith(200, { signed_secret: SIGNED })

    await expect(reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer })).resolves.toBe(SIGNED)
  })

  /**
   * The one refusal worth retrying, and the reason the flag exists.
   *
   * The predecessor's swap may simply not have landed at the mint yet. A caller
   * that treats this as permanent abandons a receive whose predecessor is already
   * burnt, which is the worst outcome available: value spent, coupon never
   * rebuilt.
   */
  it('marks a not-yet-burnt predecessor as retryable', async () => {
    respondWith(409, { refusal: 'PREDECESSOR_NOT_SPENT' })

    const refused = await reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer }).catch(
      (error: unknown) => error,
    )

    expect(refused).toBeInstanceOf(VoucherReissueRefused)
    expect((refused as VoucherReissueRefused).refusal).toBe('PREDECESSOR_NOT_SPENT')
    expect((refused as VoucherReissueRefused).retryable).toBe(true)
  })

  /**
   * Everything else answers the same way however often it is asked.
   *
   * Uses ALREADY_CLAIMED specifically, because it is the one that looks temporary
   * and is not: it is also about state, but the burn has been spent and never will
   * be again, so a retry loop here would never terminate.
   */
  it('marks an already-claimed predecessor as permanent, despite being about state', async () => {
    respondWith(422, { refusal: 'PREDECESSOR_ALREADY_CLAIMED' })

    const refused = await reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer }).catch(
      (error: unknown) => error,
    )

    expect((refused as VoucherReissueRefused).refusal).toBe('PREDECESSOR_ALREADY_CLAIMED')
    expect((refused as VoucherReissueRefused).retryable).toBe(false)
  })

  /**
   * A refusal this build has never heard of must not be passed through as known.
   *
   * A future gateway may add one. Treating an unrecognised string as a known value
   * is how a caller ends up switching on a case it has no branch for, and the
   * branch it falls into is whichever one happens to be last.
   */
  it('reduces an unrecognised refusal to UNKNOWN', async () => {
    respondWith(422, { refusal: 'SOME_FUTURE_RULE' })

    const refused = await reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer }).catch(
      (error: unknown) => error,
    )

    expect((refused as VoucherReissueRefused).refusal).toBe('UNKNOWN')
    expect((refused as VoucherReissueRefused).retryable).toBe(false)
  })

  /**
   * A gateway with no mint has no route, because a re-signer that cannot check is
   * a re-signer with no bound. That is an operator's problem, not a retry.
   */
  it('reports a missing route as permanent rather than retrying it', async () => {
    respondWith(404, {})

    const refused = await reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer }).catch(
      (error: unknown) => error,
    )

    expect(refused).toBeInstanceOf(VoucherReissueRefused)
    expect((refused as VoucherReissueRefused).retryable).toBe(false)
    expect((refused as Error).message).toMatch(/no voucher re-signing route/i)
  })

  /**
   * An unreadable answer says nothing about whether a retry would help.
   *
   * Defaulting to retryable would be the dangerous guess: each attempt asks the
   * gateway to spend a burn on a request that may never have been valid.
   */
  it('treats an unreadable answer as permanent rather than guessing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    )

    const refused = await reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer }).catch(
      (error: unknown) => error,
    )

    expect((refused as VoucherReissueRefused).refusal).toBe('UNKNOWN')
    expect((refused as VoucherReissueRefused).retryable).toBe(false)
  })

  /**
   * A 200 with no secret is not a success.
   *
   * Pinned because the obvious implementation returns `body.signed_secret` on any
   * ok status, and `undefined` would then flow onward as a secret and be blinded
   * into an output nobody can spend.
   */
  it('refuses a 200 that carries no signed secret', async () => {
    respondWith(200, { refusal: undefined })

    await expect(reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer })).rejects.toBeInstanceOf(
      VoucherReissueRefused,
    )
  })

  /**
   * The secrets must cross the wire under the names the gateway reads, and
   * verbatim. They are the exact NUT-10 strings the mint hashes, so any
   * re-serialisation produces a predecessor the mint reports as unknown.
   */
  it('sends both secrets under their snake_case names, unaltered', async () => {
    const fetchSpy = respondWith(200, { signed_secret: SIGNED })

    await reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer })

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))
    expect(body).toEqual({ predecessor_secret: PREDECESSOR, proposed_secret: PROPOSED })
  })
})
