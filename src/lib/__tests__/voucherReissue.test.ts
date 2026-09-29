/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'

import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hexToBytes } from '@noble/hashes/utils'

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
/** The key the predecessor is locked to, so the one whose signature the gateway wants. */
const LOCK_KEY = generateSecretKey()
const OTHER_KEY = generateSecretKey()

/**
 * Lends `key` the way `WalletSigner.withPrivkey` does: a copy for the length of the
 * call, wiped afterwards. Tests use it so they never touch the session signer.
 */
const lend = (key: Uint8Array) => <T>(borrow: (borrowed: Uint8Array) => T): T => {
  const copy = key.slice()
  try {
    return borrow(copy)
  } finally {
    copy.fill(0)
  }
}
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

    await expect(reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer, lendKey: lend(LOCK_KEY) })).resolves.toBe(SIGNED)
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

    const refused = await reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer, lendKey: lend(LOCK_KEY) }).catch(
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

    const refused = await reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer, lendKey: lend(LOCK_KEY) }).catch(
      (error: unknown) => error,
    )

    expect((refused as VoucherReissueRefused).refusal).toBe('PREDECESSOR_ALREADY_CLAIMED')
    expect((refused as VoucherReissueRefused).retryable).toBe(false)
  })

  /**
   * A request not signed by the coupon's holder is named as such, not reduced to
   * UNKNOWN, so the wallet can tell the user the coupon is not theirs to re-lock.
   * Permanent: the signer will never hold the lock key however often it asks.
   */
  it('names a refusal for not holding the coupon, and does not retry it', async () => {
    respondWith(422, { refusal: 'NOT_AUTHORISED_BY_HOLDER' })

    const refused = await reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer, lendKey: lend(LOCK_KEY) }).catch(
      (error: unknown) => error,
    )

    expect(refused).toBeInstanceOf(VoucherReissueRefused)
    expect((refused as VoucherReissueRefused).refusal).toBe('NOT_AUTHORISED_BY_HOLDER')
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

    const refused = await reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer, lendKey: lend(LOCK_KEY) }).catch(
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

    const refused = await reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer, lendKey: lend(LOCK_KEY) }).catch(
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

    const refused = await reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer, lendKey: lend(LOCK_KEY) }).catch(
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

    await expect(reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer, lendKey: lend(LOCK_KEY) })).rejects.toBeInstanceOf(
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

    await reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer, lendKey: lend(LOCK_KEY) })

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))
    expect(body).toEqual({
      predecessor_secret: PREDECESSOR,
      proposed_secret: PROPOSED,
      lock_authorization: expect.stringMatching(/^[0-9a-f]{128}$/),
    })
  })

  /**
   * The holder's signature, which the gateway checks before anything else
   * (imani-gateway-customer#136). Knowing a coupon's secret is not holding it:
   * whoever handed it over authored that secret, so only a signature by the key
   * the coupon is locked to proves the caller holds it.
   *
   * Verified here against an independent spelling of the documented message, not
   * by calling the code under test, so a wrong tag, a wrong length encoding or the
   * secrets in the wrong order all fail. The gateway's own tests use the same
   * message, so a mismatch between the two sides shows up on one of them.
   */
  it('signs the documented message with the lock key, as the gateway verifies it', async () => {
    const fetchSpy = respondWith(200, { signed_secret: SIGNED })

    await reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer, lendKey: lend(LOCK_KEY) })

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))
    expect(body.lock_authorization).toMatch(/^[0-9a-f]{128}$/)
    expect(
      schnorr.verify(
        hexToBytes(body.lock_authorization),
        documentedMessage(PREDECESSOR, PROPOSED),
        schnorr.getPublicKey(LOCK_KEY),
      ),
    ).toBe(true)
  })

  /** A signature by any other key would be refused, so it must not be what is sent. */
  it('does not sign with a key other than the one it was given', async () => {
    const fetchSpy = respondWith(200, { signed_secret: SIGNED })

    await reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer, lendKey: lend(LOCK_KEY) })

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))
    expect(
      schnorr.verify(
        hexToBytes(body.lock_authorization),
        documentedMessage(PREDECESSOR, PROPOSED),
        schnorr.getPublicKey(OTHER_KEY),
      ),
    ).toBe(false)
  })

  /**
   * The key is borrowed once, for the signature, and not kept (IW-14). The lender
   * wipes its copy when the borrow returns, so code that signed after the borrow
   * ended, or signed with a key it had kept, would sign with a zeroed key and the
   * signature would not verify against the lock key.
   */
  it('signs inside a single borrow of the key, not with a key it kept', async () => {
    const fetchSpy = respondWith(200, { signed_secret: SIGNED })
    let borrows = 0
    const counting = <T>(borrow: (key: Uint8Array) => T): T => {
      borrows++
      return lend(LOCK_KEY)(borrow)
    }

    await reissueVoucherSecret(PREDECESSOR, PROPOSED, { signer, lendKey: counting })

    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))
    expect(borrows).toBe(1)
    expect(
      schnorr.verify(
        hexToBytes(body.lock_authorization),
        documentedMessage(PREDECESSOR, PROPOSED),
        schnorr.getPublicKey(LOCK_KEY),
      ),
    ).toBe(true)
  })
})

/**
 * `sha256("imani/voucher-reissue/v1" || u32be(len) || predecessor || u32be(len) || proposed)`,
 * secrets as UTF-8. Written out here rather than imported, so this test is a second
 * opinion on the layout and not an echo of it.
 */
function documentedMessage(predecessor: string, proposed: string): Uint8Array {
  const encoder = new TextEncoder()
  const parts = [encoder.encode('imani/voucher-reissue/v1')]
  for (const secret of [predecessor, proposed]) {
    const bytes = encoder.encode(secret)
    const length = new Uint8Array(4)
    new DataView(length.buffer).setUint32(0, bytes.length, false)
    parts.push(length, bytes)
  }
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return sha256(joined)
}
