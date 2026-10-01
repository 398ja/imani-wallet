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

const calls = vi.hoisted(() => ({
  order: [] as string[],
  bodies: [] as Array<Record<string, unknown>>,
  rows: [] as Array<Record<string, unknown>>,
  respond: null as null | (() => Response),
}))

vi.mock('../nap', async () => {
  const { hexToBytes: h } = await import('@noble/hashes/utils')
  const { schnorr: s } = await import('@noble/curves/secp256k1.js')
  const { bytesToHex: b } = await import('@noble/hashes/utils')
  const sk = 'a'.repeat(63) + '7'
  return {
    getSigner: () => ({
      pubkey: b(s.getPublicKey(h(sk))),
      withPrivkey: <T,>(borrow: (key: Uint8Array) => T): T => {
        calls.order.push('sign')
        return borrow(h(sk))
      },
    }),
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
