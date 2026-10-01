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

import { issueCashback } from '../cashbackIssue'
import { WARRANT_REFUSED_MESSAGE } from '../cashback'
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
      new Response(JSON.stringify({ message: 'issuanceWarrant does not verify' }), { status: 400 })

    // Act, Assert
    await expect(issue()).rejects.toThrow(WARRANT_REFUSED_MESSAGE)
    expect(calls.rows).toHaveLength(0)
  })

  /** A 400 about something else keeps its own message. */
  it('leaves other 400s alone', async () => {
    // Arrange
    calls.respond = () => new Response(JSON.stringify({ message: 'unit too long' }), { status: 400 })

    // Act, Assert
    await expect(issue()).rejects.toThrow(/unit too long/)
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
