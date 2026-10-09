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

import { NEVER_EXPIRES } from '../merchant'
import { createCashbackIssuer, issueCashback, prepareCashbackAttempt } from '../cashbackIssue'
import { IDEMPOTENCY_CONFLICT_MESSAGE, WARRANT_REFUSED_MESSAGE } from '../cashback'
import { parseIssuanceWarrant, verifyIssuanceWarrant } from '../issuanceWarrant'
import { parseVoucherToken, verifyVoucher, creditableFaceValue } from '../voucherToken'
import { buildVoucherToken } from './voucherFixtures'
import type { Actor } from '../actor'
import { UnwarrantedSaleError } from '../warrantSigner'

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
  issueCashback({ actor: owner, amountMinor: 1500, unit: 'EUR', decimals: 2, expiryDays: 30, voucherValidityDays: 90 })

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
  const request = { actor: owner, amountMinor: 1500, unit: 'EUR', decimals: 2, expiryDays: 30, voucherValidityDays: 90 }

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
   * A press while locked is refused before anything is minted (#159): with
   * no warrant the coupon would be refused at the till. After unlocking, the
   * next press signs and mints once.
   */
  it('refuses a press while locked without minting, then signs after unlocking', async () => {
    // Arrange
    const issuer = createCashbackIssuer()
    calls.signerKey = null
    await expect(issuer.submit(request)).rejects.toThrow(/locked/)
    calls.signerKey = STALL_SK

    // Act
    await issuer.submit(request)

    // Assert
    expect(calls.bodies).toHaveLength(1)
    const warrant = calls.bodies[0].issuanceWarrant as string
    expect(verifyIssuanceWarrant(parseIssuanceWarrant(warrant), STALL, {
      faceValueMinor: 1500,
      unit: 'EUR',
      faceDecimals: 2,
    })).toEqual({ verdict: 'verified' })
  })

  /** Locked twice: nothing is ever sent, so no unwarranted coupon exists. */
  it('never mints an unwarranted coupon however often it is pressed', async () => {
    // Arrange
    const issuer = createCashbackIssuer()
    calls.signerKey = null

    // Act
    await expect(issuer.submit(request)).rejects.toThrow()
    await expect(issuer.submit(request)).rejects.toThrow()

    // Assert
    expect(calls.order).not.toContain('generate')
  })

  /**
   * A session key that is not the stall's can only sign `none`, which the
   * till refuses. Refused before minting (#159), even mid-retry.
   */
  it('refuses when the signing key changes to one that is not the stall', async () => {
    // Arrange
    const issuer = createCashbackIssuer()
    calls.respond = () => {
      throw new TypeError('network down')
    }
    await expect(issuer.submit(request)).rejects.toThrow()
    calls.respond = null
    calls.signerKey = OTHER_SK

    // Act
    const run = issuer.submit(request)

    // Assert
    await expect(run).rejects.toBeInstanceOf(UnwarrantedSaleError)
    expect(calls.bodies).toHaveLength(1)
  })

  /**
   * A terminal issues cashback only in a live FULL session with a selling role (#160 phase 5).
   * Without one (no session, or a REDUCED one that never reached the mint) it is refused before
   * anything is signed or minted, for any stall.
   */
  it('refuses a terminal outside a FULL session before signing or minting', async () => {
    // Arrange
    const issuer = createCashbackIssuer()
    const terminalFor = (stallPubkey: string) =>
      ({ kind: 'terminal', stallPubkey, terminalPubkey: OTHER, role: 'issue-and-redeem' }) as Actor
    const reduced = { kind: 'reduced', openedAt: Date.now(), expiresAt: Date.now() + 3600_000 } as never
    calls.signerKey = OTHER_SK

    // Act
    const first = await issuer.submit({ ...request, actor: terminalFor(STALL) }).catch((e: Error) => e)
    const second = await issuer
      .submit({ ...request, actor: terminalFor(OTHER), session: reduced })
      .catch((e: Error) => e)

    // Assert
    expect(String(first)).toMatch(/cannot issue cashback right now/)
    expect(String(second)).toMatch(/full session/)
    expect(calls.order).toEqual([])
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

/**
 * The coupon lives as long as a Sell coupon from the same stall
 * (398ja/imani-gateway-portal#58). The claim window is a separate clock.
 */
describe('the stall\'s voucher validity travels with the generate request', () => {
  const issueWith = (voucherValidityDays: number) =>
    issueCashback({
      actor: owner,
      amountMinor: 1500,
      unit: 'EUR',
      decimals: 2,
      expiryDays: 5,
      voucherValidityDays,
    })

  it('sends the merchant validity as voucherValidityDays and keeps the claim window', async () => {
    await issueWith(30)

    expect(calls.bodies[0].voucherValidityDays).toBe(30)
    expect(calls.bodies[0].expiryDays).toBe(5)
  })

  it('sends never-expires as 0, the same NEVER_EXPIRES the stall stores', async () => {
    await issueWith(NEVER_EXPIRES)

    // Present and 0, not omitted: an absent field is what an older wallet
    // sends, and the portal then falls back to the gateway default.
    expect(calls.bodies[0]).toHaveProperty('voucherValidityDays', 0)
    expect(calls.bodies[0].expiryDays).toBe(5)
  })

  it('treats a change of validity as a different issue', async () => {
    const issuer = createCashbackIssuer()
    calls.respond = () => new Response('{}', { status: 503 })
    await expect(issuer.submit({ actor: owner, amountMinor: 1500, unit: 'EUR', decimals: 2, expiryDays: 5, voucherValidityDays: 30 })).rejects.toThrow()
    calls.respond = null
    await issuer.submit({ actor: owner, amountMinor: 1500, unit: 'EUR', decimals: 2, expiryDays: 5, voucherValidityDays: 7 })

    expect(calls.bodies[1].idempotencyKey).not.toBe(calls.bodies[0].idempotencyKey)
    expect(calls.bodies[1].voucherValidityDays).toBe(7)
  })
})

describe('a terminal cannot issue cashback (#159)', () => {
  const terminal = {
    kind: 'terminal',
    stallPubkey: STALL,
    terminalPubkey: OTHER,
    role: 'issue-and-redeem',
  } as Actor
  const request = { actor: terminal, amountMinor: 1500, unit: 'EUR', decimals: 2, expiryDays: 30, voucherValidityDays: 90 }

  it('prepareCashbackAttempt refuses before signing', async () => {
    // Act
    const run = prepareCashbackAttempt(request)

    // Assert
    await expect(run).rejects.toBeInstanceOf(UnwarrantedSaleError)
    expect(calls.order).toEqual([])
  })

  it('issueCashback refuses a hand-built attempt rather than minting it', async () => {
    // Arrange: an attempt carrying the `none` a terminal would have signed.
    const attempt = { idempotencyKey: 'k-1', warrant: JSON.stringify({ form: 'none' }) }

    // Act
    const run = issueCashback(request, attempt)

    // Assert
    await expect(run).rejects.toBeInstanceOf(UnwarrantedSaleError)
    expect(calls.order).not.toContain('generate')
  })

  it('issueCashback refuses an owner attempt that carries no signed warrant', async () => {
    // Arrange
    const attempt = { idempotencyKey: 'k-2', warrant: JSON.stringify({ form: 'none' }) }

    // Act
    const run = issueCashback({ ...request, actor: owner }, attempt)

    // Assert
    await expect(run).rejects.toBeInstanceOf(UnwarrantedSaleError)
    expect(calls.order).not.toContain('generate')
  })
})

/**
 * A till's cashback reaches the stall's books (#160 phase 6, plan F1). `record` wrote it through
 * `getWallet()`, which a till does not have, so the code it read out at the counter was in nobody's
 * history. Now it goes to the stall as a sealed sale record, attributed to the till.
 */
describe("a till's cashback is recorded with its stall, never in a wallet it does not have", () => {
  it('sends the cashback row to the till sale sink, attributed to the till', async () => {
    const { setTillSaleSink } = await import('../tillSales')
    const { openSession, SESSION_KIND } = await import('../terminalSession')
    const { grantFor } = await import('../terminalRole')
    const till = {
      kind: 'terminal', stallPubkey: STALL, terminalPubkey: OTHER, role: 'issue-and-redeem',
      permissions: grantFor('issue-and-redeem', STALL), attested: true,
    } as Actor
    const warrant = JSON.stringify({
      form: 'terminal', sale_total: 1500, face_decimals: 2, unit: 'EUR', nonce: 'n', signature: 'ab'.repeat(64), credential: 'c',
    })
    const sent: Array<Record<string, unknown>> = []
    setTillSaleSink(async (rows) => (sent.push(...(rows as unknown as Array<Record<string, unknown>>)), true))
    calls.rows.length = 0
    try {
      await issueCashback(
        { actor: till, session: openSession(till as never, SESSION_KIND.FULL, Date.now()), amountMinor: 1500, unit: 'EUR', decimals: 2, expiryDays: 30, voucherValidityDays: 90 },
        { idempotencyKey: 'k-till', warrant },
      )
    } finally {
      setTillSaleSink(null)
    }
    expect(calls.rows).toEqual([])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ id: 'cashback:cb-1', type: 'cashback', terminalPubkey: OTHER, merchantId: STALL, issuanceWarrant: warrant })
  })
})
