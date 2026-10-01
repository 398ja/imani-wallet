/**
 * Issuing cashback with the stall's warrant on the wire (#144).
 *
 * A warrant is part of the voucher's signed NUT-10 secret, so it has to reach
 * the portal BEFORE the coupon is minted. One signed afterwards can only ever
 * sit in local history, and the till refuses the coupon as unwarranted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import { createCashbackIssuer, issueCashback, prepareCashbackAttempt } from '../cashbackIssue'
import { IDEMPOTENCY_CONFLICT_MESSAGE, WARRANT_REFUSED_MESSAGE } from '../cashback'
import { parseIssuanceWarrant, verifyIssuanceWarrant } from '../issuanceWarrant'
import { parseVoucherToken, verifyVoucher, creditableFaceValue } from '../voucherToken'
import { buildVoucherToken } from './voucherFixtures'
import type { Actor } from '../actor'

const STALL_SK = 'a'.repeat(63) + '7'
const STALL = bytesToHex(schnorr.getPublicKey(hexToBytes(STALL_SK)))
const owner: Actor = { kind: 'owner', stallPubkey: STALL }
const OTHER_SK = 'b'.repeat(63) + '9'
const OTHER = bytesToHex(schnorr.getPublicKey(hexToBytes(OTHER_SK)))
const otherOwner: Actor = { kind: 'owner', stallPubkey: OTHER }

const calls = vi.hoisted(() => ({
  order: [] as string[],
  bodies: [] as Array<Record<string, unknown>>,
  rows: [] as Array<Record<string, unknown>>,
  respond: null as null | (() => Response),
  /** The unlocked key, or null while the wallet is locked. */
  signerKey: ('a'.repeat(63) + '7') as string | null,
}))

vi.mock('../nap', async () => {
  const { hexToBytes: h } = await import('@noble/hashes/utils')
  const { schnorr: s } = await import('@noble/curves/secp256k1.js')
  const { bytesToHex: b } = await import('@noble/hashes/utils')
  return {
    getSigner: () => {
      const sk = calls.signerKey
      if (!sk) throw new Error('The wallet is locked.')
      return {
        pubkey: b(s.getPublicKey(h(sk))),
        withPrivkey: <T,>(borrow: (key: Uint8Array) => T): T => {
          calls.order.push('sign')
          return borrow(h(sk))
        },
      }
    },
  }
})

vi.mock('../nip98', () => ({
  signedFetch: async (_path: string, _method: string, body: Record<string, unknown>) => {
    calls.order.push('generate')
    calls.bodies.push(body)
    return calls.respond
      ? calls.respond()
      : new Response(
          JSON.stringify({
            cashbackId: 'cb-1',
            claimCode: 'CB-ABCDE-FGHIJ',
            amountMinor: 1500,
            unit: 'EUR',
            expiresAt: '2026-12-01T00:00:00Z',
            voucherId: 'v-cash-1',
          }),
          { status: 200 },
        )
  },
}))

vi.mock('../wallet', () => ({
  notifyWalletChanged: () => {},
  recordCashbackStatus: async () => {},
  getWallet: () => ({
    addTransaction: async (row: Record<string, unknown>) => {
      calls.rows.push(row)
    },
  }),
}))

vi.mock('../legacyBridge', () => ({ legacyApi: async () => ({}), withCorrelation: async () => ({}) }))

beforeEach(() => {
  calls.order.length = 0
  calls.bodies.length = 0
  calls.rows.length = 0
  calls.respond = null
  calls.signerKey = STALL_SK
})

const issue = () =>
  issueCashback({ actor: owner, amountMinor: 1500, unit: 'EUR', decimals: 2, expiryDays: 30 })

describe('the warrant travels with the generate request', () => {
  /** The POST body carries a merchant warrant that verifies against the stall. */
  it('sends a verifiable warrant as issuanceWarrant', async () => {
    // Arrange, Act
    await issue()

    // Assert
    const sent = calls.bodies[0].issuanceWarrant as string
    expect(typeof sent).toBe('string')
    const verdict = verifyIssuanceWarrant(parseIssuanceWarrant(sent), STALL, {
      faceValueMinor: 1500,
      unit: 'EUR',
      faceDecimals: 2,
    })
    expect(verdict).toEqual({ verdict: 'verified' })
  })

  /** History keeps the very string the coupon carries, not a second signature. */
  it('records the same warrant string on the history row', async () => {
    // Act
    await issue()

    // Assert
    expect(calls.rows[0].issuanceWarrant).toBe(calls.bodies[0].issuanceWarrant)
  })

  /** Signing happens before the network call, because the mint signs the secret then. */
  it('signs before it asks the portal to mint', async () => {
    // Act
    await issue()

    // Assert
    expect(calls.order).toEqual(['sign', 'generate'])
  })

  /** The voucher id from the response lands on the row, so the Vouchers list can show it. */
  it('stores the voucherId from the generate response', async () => {
    // Act
    const result = await issue()

    // Assert
    expect(result.voucherId).toBe('v-cash-1')
    expect(calls.rows[0].voucherId).toBe('v-cash-1')
  })

  /** A refused warrant reads as its own problem, not a generic failure. */
  it('names a refused warrant clearly', async () => {
    // Arrange
    calls.respond = () =>
      new Response(
        JSON.stringify({ code: 'INVALID_WARRANT', message: 'issuance_warrant does not authorise this sale', retryable: false }),
        { status: 400 },
      )

    // Act, Assert
    await expect(issue()).rejects.toThrow(WARRANT_REFUSED_MESSAGE)
    expect(calls.rows).toHaveLength(0)
  })

  /** The refusal is told by the portal's code, not by the word "warrant" in some other 400. */
  it('does not call a different 400 a warrant refusal because it mentions warrants', async () => {
    // Arrange
    calls.respond = () =>
      new Response(JSON.stringify({ code: 'INVALID_AMOUNT', message: 'amount exceeds the warrant' }), { status: 400 })

    // Act, Assert
    await expect(issue()).rejects.toThrow(/amount exceeds the warrant/)
  })

  /** A key reused with a different warrant reads in plain words. */
  it('explains an idempotency conflict plainly', async () => {
    // Arrange
    calls.respond = () =>
      new Response(JSON.stringify({ code: 'IDEMPOTENCY_CONFLICT', message: 'warrant digest differs' }), { status: 409 })

    // Act, Assert
    await expect(issue()).rejects.toThrow(IDEMPOTENCY_CONFLICT_MESSAGE)
  })

  /** A 400 about something else keeps its own message. */
  it('leaves other 400s alone', async () => {
    // Arrange
    calls.respond = () => new Response(JSON.stringify({ message: 'unit too long' }), { status: 400 })

    // Act, Assert
    await expect(issue()).rejects.toThrow(/unit too long/)
  })
})

describe('a retry of the same issue', () => {
  const request = { actor: owner, amountMinor: 1500, unit: 'EUR', decimals: 2, expiryDays: 30 }

  /**
   * After a network error the retry must resend the same key AND warrant. The
   * portal compares the warrant's hash, and a fresh nonce would get a 409.
   */
  it('resends the same idempotency key and warrant string', async () => {
    // Arrange
    const attempt = await prepareCashbackAttempt(request)
    calls.respond = () => {
      throw new TypeError('network down')
    }
    await expect(issueCashback(request, attempt)).rejects.toThrow()
    calls.respond = null

    // Act
    await issueCashback(request, attempt)

    // Assert
    expect(calls.bodies[1].idempotencyKey).toBe(calls.bodies[0].idempotencyKey)
    expect(calls.bodies[1].issuanceWarrant).toBe(calls.bodies[0].issuanceWarrant)
    expect(calls.order.filter((step) => step === 'sign')).toHaveLength(1)
  })

  /** A new issue is a new sale: new key, new warrant nonce. */
  it('gives a new issue a new key and a new warrant', async () => {
    // Act
    await issueCashback(request)
    await issueCashback(request)

    // Assert
    expect(calls.bodies[1].idempotencyKey).not.toBe(calls.bodies[0].idempotencyKey)
    expect(calls.bodies[1].issuanceWarrant).not.toBe(calls.bodies[0].issuanceWarrant)
  })

  /** A second press while the first is still in flight does nothing: one request, one code. */
  it('ignores a second press while one is in flight', async () => {
    // Arrange
    const issuer = createCashbackIssuer()

    // Act
    const [first, second] = await Promise.all([issuer.submit(request), issuer.submit(request)])

    // Assert
    expect(calls.bodies).toHaveLength(1)
    expect(first?.claimCode).toBe('CB-ABCDE-FGHIJ')
    expect(second).toBeNull()
  })

  /** The issuer keeps the attempt after a failure, so pressing again is a retry of the same sale. */
  it('retries with the same key and warrant after a failure', async () => {
    // Arrange
    const issuer = createCashbackIssuer()
    calls.respond = () => {
      throw new TypeError('network down')
    }
    await expect(issuer.submit(request)).rejects.toThrow()
    calls.respond = null

    // Act
    await issuer.submit(request)

    // Assert
    expect(calls.bodies[1].idempotencyKey).toBe(calls.bodies[0].idempotencyKey)
    expect(calls.bodies[1].issuanceWarrant).toBe(calls.bodies[0].issuanceWarrant)
  })

  /** Once a code is issued, the next press is a new sale. Editing the amount is too. */
  it('starts a new key after success or after the inputs change', async () => {
    // Arrange
    const issuer = createCashbackIssuer()

    // Act
    await issuer.submit(request)
    await issuer.submit(request)
    calls.respond = () => {
      throw new TypeError('network down')
    }
    await expect(issuer.submit(request)).rejects.toThrow()
    calls.respond = null
    await issuer.submit({ ...request, amountMinor: 1600 })

    // Assert
    const keys = calls.bodies.map((body) => body.idempotencyKey)
    expect(new Set(keys).size).toBe(4)
  })

  /**
   * A press while locked sends no warrant. That attempt must not be reused
   * after unlocking, or the coupon is minted unwarranted and refused at the till.
   */
  it('signs a fresh warrant on the retry after the wallet is unlocked', async () => {
    // Arrange
    const issuer = createCashbackIssuer()
    calls.signerKey = null
    calls.respond = () => {
      throw new TypeError('network down')
    }
    await expect(issuer.submit(request)).rejects.toThrow()
    calls.signerKey = STALL_SK
    calls.respond = null

    // Act
    await issuer.submit(request)

    // Assert
    expect(calls.bodies[0].issuanceWarrant).toBeUndefined()
    const warrant = calls.bodies[1].issuanceWarrant as string
    expect(verifyIssuanceWarrant(parseIssuanceWarrant(warrant), STALL, {
      faceValueMinor: 1500,
      unit: 'EUR',
      faceDecimals: 2,
    })).toEqual({ verdict: 'verified' })
  })

  /**
   * An attempt with no warrant is never kept while there is an actor, even if
   * the signer key reads the same both times (here, still locked on retry).
   */
  it('does not keep an unwarranted attempt for the next press', async () => {
    // Arrange
    const issuer = createCashbackIssuer()
    calls.signerKey = null
    calls.respond = () => {
      throw new TypeError('network down')
    }
    await expect(issuer.submit(request)).rejects.toThrow()
    calls.respond = null

    // Act
    await issuer.submit(request)

    // Assert
    expect(calls.bodies[1].idempotencyKey).not.toBe(calls.bodies[0].idempotencyKey)
  })

  /**
   * The signing key is part of the attempt. A different key under the same
   * stall (a restored session) gets a new key and warrant.
   */
  it('starts a new attempt when the signing key changes under the same stall', async () => {
    // Arrange
    const issuer = createCashbackIssuer()
    calls.respond = () => {
      throw new TypeError('network down')
    }
    await expect(issuer.submit(request)).rejects.toThrow()
    calls.respond = null
    calls.signerKey = OTHER_SK

    // Act
    await issuer.submit(request)

    // Assert
    expect(calls.bodies[1].idempotencyKey).not.toBe(calls.bodies[0].idempotencyKey)
  })

  /**
   * A terminal signs with its own key, not the stall's. Re-paired to another
   * stall, the signer is unchanged, so the stall must be part of the attempt.
   */
  it('starts a new attempt when the same terminal key issues for another stall', async () => {
    // Arrange
    const issuer = createCashbackIssuer()
    const terminalFor = (stallPubkey: string) =>
      ({ kind: 'terminal', stallPubkey, terminalPubkey: OTHER, role: 'issue-and-redeem' }) as Actor
    calls.signerKey = OTHER_SK
    calls.respond = () => {
      throw new TypeError('network down')
    }
    await expect(issuer.submit({ ...request, actor: terminalFor(STALL) })).rejects.toThrow()
    calls.respond = null

    // Act
    await issuer.submit({ ...request, actor: terminalFor(OTHER) })

    // Assert
    expect(calls.bodies[1].idempotencyKey).not.toBe(calls.bodies[0].idempotencyKey)
  })

  /** Signing in as another stall with the same amount is a different sale: new key and warrant. */
  it('starts a new key and warrant after an account switch', async () => {
    // Arrange
    const issuer = createCashbackIssuer()
    calls.respond = () => {
      throw new TypeError('network down')
    }
    await expect(issuer.submit(request)).rejects.toThrow()
    calls.respond = null
    calls.signerKey = OTHER_SK

    // Act
    await issuer.submit({ ...request, actor: otherOwner })

    // Assert
    expect(calls.bodies[1].idempotencyKey).not.toBe(calls.bodies[0].idempotencyKey)
    expect(calls.bodies[1].issuanceWarrant).not.toBe(calls.bodies[0].issuanceWarrant)
    const warrant = parseIssuanceWarrant(calls.bodies[1].issuanceWarrant as string)
    expect(verifyIssuanceWarrant(warrant, OTHER, { faceValueMinor: 1500, unit: 'EUR', faceDecimals: 2 }))
      .toEqual({ verdict: 'verified' })
  })

  /** A definite refusal (a 4xx envelope) ends the attempt, so the next press signs afresh. */
  it('drops the attempt after a definite 4xx refusal', async () => {
    // Arrange
    const issuer = createCashbackIssuer()
    calls.respond = () =>
      new Response(JSON.stringify({ code: 'INVALID_WARRANT', message: 'no' }), { status: 400 })
    await expect(issuer.submit(request)).rejects.toThrow()
    calls.respond = null

    // Act
    await issuer.submit(request)

    // Assert
    expect(calls.bodies[1].idempotencyKey).not.toBe(calls.bodies[0].idempotencyKey)
  })

  /** A 5xx or a 409 may mean the first request landed, so the attempt is kept for the retry. */
  it.each([
    [500, { code: 'INTERNAL', message: 'boom' }],
    [409, { code: 'IDEMPOTENCY_CONFLICT', message: 'busy' }],
  ])('keeps the attempt after a %i', async (status, envelope) => {
    // Arrange
    const issuer = createCashbackIssuer()
    calls.respond = () => new Response(JSON.stringify(envelope), { status })
    await expect(issuer.submit(request)).rejects.toThrow()
    calls.respond = null

    // Act
    await issuer.submit(request)

    // Assert
    expect(calls.bodies[1].idempotencyKey).toBe(calls.bodies[0].idempotencyKey)
  })
})

describe('the till accepts the coupon', () => {
  /**
   * End to end on the client: the warrant this flow sends, placed in a coupon
   * signed by the owner, reads `verified` exactly as dmCrypto checks it.
   */
  it('a cashback coupon carrying the sent warrant verifies at the till', async () => {
    // Arrange
    await issue()
    const warrant = calls.bodies[0].issuanceWarrant as string
    const { token } = buildVoucherToken({
      issuerId: STALL,
      issuerPublicKey: STALL,
      unit: 'EUR',
      faceValue: 1500,
      faceDecimals: 2,
      issuanceRatio: 1,
      issuanceWarrant: warrant,
    }, [1024, 476], {}, hexToBytes(STALL_SK))
    const parsed = parseVoucherToken(token)

    // Act
    const signature = verifyVoucher(parsed.voucher)
    const { faceValue } = creditableFaceValue(parsed)
    const verdict = verifyIssuanceWarrant(
      parseIssuanceWarrant(parsed.voucher.issuanceWarrant),
      parsed.voucher.issuerId,
      { faceValueMinor: faceValue, unit: parsed.voucher.unit, faceDecimals: parsed.voucher.faceDecimals },
    )

    // Assert
    expect(parsed.voucher.issuanceWarrant).toBe(warrant)
    expect(signature.signatureValid).toBe(true)
    expect(verdict).toEqual({ verdict: 'verified' })
  })
})
