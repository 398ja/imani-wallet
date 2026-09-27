import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'

// Stand-ins for the wallet store and imani-apps' classic-script API client.
// Both are hoisted so the module mocks below can close over them.
const stubs = vi.hoisted(() => ({
  api: {} as Record<string, unknown>,
  saved: [] as VoucherRow[],
  rows: [] as VoucherRow[],
  notified: { count: 0 },
}))

vi.mock('../wallet', () => ({
  getWallet: () => ({
    saveVoucher: async (row: VoucherRow) => {
      stubs.saved.push(row)
      return row
    },
  }),
  listVouchers: async () => stubs.rows,
  notifyWalletChanged: () => {
    stubs.notified.count += 1
  },
}))

vi.mock('../legacyBridge', () => ({ legacyApi: async () => stubs.api }))

import { burnIfSelfIssued, sweepBurnable } from '../burn'
import { _setReceivePacerForTests } from '../receivePacer'

// Pacing is pinned in receivePacer.test.ts; here it would only add real waits.
_setReceivePacerForTests({ acquire: async () => {}, reset: () => {} })

const MERCHANT = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

const row = (over: Partial<VoucherRow> = {}): VoucherRow =>
  ({
    token_id: 'token-1',
    token: 'cashuBv2xyz',
    amount: 500,
    face_value: 500,
    face_unit: 'EUR',
    face_decimals: 2,
    token_amount: 500,
    issuer_id: MERCHANT,
    status: 'active',
    created_at: '2026-08-17T10:00:00.000Z',
    updated_at: '2026-08-17T10:00:00.000Z',
    ...over,
  }) as VoucherRow

let received: string[]
let acked: string[]

beforeEach(() => {
  received = []
  acked = []
  stubs.saved = []
  stubs.rows = []
  stubs.notified.count = 0
  stubs.api = {
    receive: async (token: string) => {
      received.push(token)
      return { receive_id: 'escrow-1', token: 'cashuBfresh' }
    },
    acknowledgeReceive: async (id: string) => {
      acked.push(id)
    },
    // Default: the mint says the proofs are still live, so a failed burn is a
    // real failure and the row must stay spendable.
    validateToken: async () => ({ state: 'UNSPENT' }),
  }
})

describe('burnIfSelfIssued', () => {
  /**
   * A 409 can mean "already running", not "failed".
   *
   * The gateway claims the idempotency key BEFORE the irreversible swap, so a
   * duplicate arriving while the winner is mid-swap is refused: the row is
   * CLAIMED and there is no outcome to replay yet. Observed live — the escrow
   * was created at 08:44:22.95 and the duplicate arrived 90ms later, settling
   * at 08:44:24, so it was seconds from succeeding.
   *
   * Reporting that as "redeemed coupon not burnt" is wrong twice over: the
   * coupon usually IS burnt a moment later, and the operator is told to act on
   * something that resolves itself.
   */
  it('retries once when the gateway says the burn is already in flight', async () => {
    let attempts = 0
    stubs.api.receive = async (token: string) => {
      attempts += 1
      received.push(token)
      if (attempts === 1) {
        const conflict = Object.assign(new Error('API request failed'), {
          status: 409,
          code: 'UNKNOWN_ERROR',
        })
        throw conflict
      }
      return { receive_id: 'escrow-1', token: 'cashuBfresh' }
    }

    expect(await burnIfSelfIssued(row(), MERCHANT)).toBe(true)
    expect(attempts).toBe(2)
    expect(stubs.saved.at(-1)?.status).toBe('redeemed')
  })

  it('still fails honestly when the contention does not clear', async () => {
    // One retry, not a loop. If the other caller is still holding the claim,
    // it will finish the burn and the next sweep sees it as already spent —
    // so hammering here would only delay the sweep.
    stubs.api.receive = async () => {
      throw Object.assign(new Error('API request failed'), { status: 409 })
    }

    expect(await burnIfSelfIssued(row(), MERCHANT)).toBe(false)
    expect(stubs.saved).toHaveLength(0)
  })

  /**
   * #110: a rate-limited burn used to fall straight through to "not burnt",
   * leaving a redeemed coupon counted as money until the next login. It is
   * treated like the 409: wait (here, the gateway's Retry-After) and retry once
   * under the same key.
   */
  it('retries once after Retry-After when the burn is rate limited', async () => {
    vi.useFakeTimers()
    try {
      const keys: Array<string | undefined> = []
      stubs.api.receive = async (_token: string, o?: { idempotencyKey?: string }) => {
        keys.push(o?.idempotencyKey)
        if (keys.length === 1) {
          throw Object.assign(new Error('Rate limit exceeded'), { status: 429, retryAfterMs: 30_000 })
        }
        return { receive_id: 'escrow-1', token: 'cashuBfresh' }
      }

      const pending = burnIfSelfIssued(row(), MERCHANT)
      await vi.advanceTimersByTimeAsync(29_000)
      expect(keys).toHaveLength(1) // still honouring Retry-After
      await vi.advanceTimersByTimeAsync(1_500)

      expect(await pending).toBe(true)
      expect(keys).toEqual(['burn_token-1', 'burn_token-1'])
      expect(stubs.saved.at(-1)?.status).toBe('redeemed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps an absurd Retry-After and still fails honestly if the retry is limited too', async () => {
    vi.useFakeTimers()
    try {
      let attempts = 0
      stubs.api.receive = async () => {
        attempts += 1
        throw Object.assign(new Error('Rate limit exceeded'), { status: 429, retryAfterMs: 3_600_000 })
      }
      const pending = burnIfSelfIssued(row(), MERCHANT)
      await vi.advanceTimersByTimeAsync(65_000)
      expect(await pending).toBe(false)
      expect(attempts).toBe(2)
      expect(stubs.saved).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a failure that is not a conflict', async () => {
    // A 500 is not contention. Retrying it just doubles the load on a gateway
    // that is already struggling.
    let attempts = 0
    stubs.api.receive = async () => {
      attempts += 1
      throw Object.assign(new Error('boom'), { status: 500 })
    }

    expect(await burnIfSelfIssued(row(), MERCHANT)).toBe(false)
    expect(attempts).toBe(1)
  })

  it('spends the proofs at the mint and marks the row redeemed', async () => {
    expect(await burnIfSelfIssued(row(), MERCHANT)).toBe(true)

    // The swap IS the burn: the token goes in, the fresh one is dropped, and
    // the mint will report SPENT for what went in.
    expect(received).toEqual(['cashuBv2xyz'])
    // Without the ack, spec-021's escrow recovery hands the value back on the
    // next boot and the coupon is live again.
    expect(acked).toEqual(['escrow-1'])
    expect(stubs.saved).toHaveLength(1)
    expect(stubs.saved[0].status).toBe('redeemed')
    expect(stubs.notified.count).toBe(1)
  })

  it('leaves another shop’s coupon alone', async () => {
    // Real money this merchant may spend or redeem in turn. Burning it would
    // destroy someone else's backing.
    expect(await burnIfSelfIssued(row({ issuer_id: OTHER }), MERCHANT)).toBe(false)
    expect(received).toEqual([])
    expect(stubs.saved).toEqual([])
  })

  it('does nothing to a coupon already burnt', async () => {
    expect(await burnIfSelfIssued(row({ status: 'redeemed' }), MERCHANT)).toBe(false)
    expect(received).toEqual([])
  })

  it('never matches on missing ids', async () => {
    // `issuerKey` maps anything absent to 'unknown', so an unopened wallet or a
    // coupon that arrived without an issuer would otherwise match itself.
    expect(await burnIfSelfIssued(row({ issuer_id: undefined }), MERCHANT)).toBe(false)
    expect(await burnIfSelfIssued(row(), '')).toBe(false)
    expect(received).toEqual([])
  })

  it('keeps the coupon spendable when the mint call fails', async () => {
    // The status must never run ahead of the burn: a row saying "redeemed"
    // whose value is still live is money the merchant cannot see or spend.
    stubs.api.receive = async () => {
      throw new Error('gateway unreachable')
    }
    expect(await burnIfSelfIssued(row(), MERCHANT)).toBe(false)
    expect(stubs.saved).toEqual([])
  })

  it('still marks the row when only the escrow ack fails', async () => {
    // The proofs are already spent by then. What the ack failure risks is the
    // recovery sweep handing the value back — as another self-issued row, which
    // the next sweep burns.
    stubs.api.acknowledgeReceive = async () => {
      throw new Error('ack failed')
    }
    expect(await burnIfSelfIssued(row(), MERCHANT)).toBe(true)
    expect(stubs.saved[0].status).toBe('redeemed')
  })
})

describe('sweepBurnable', () => {
  it('burns what an earlier attempt missed and counts it', async () => {
    stubs.rows = [
      row({ token_id: 'a', token: 'cashuBa' }),
      row({ token_id: 'b', token: 'cashuBb', issuer_id: OTHER }),
      row({ token_id: 'c', token: 'cashuBc', status: 'redeemed' }),
    ]
    expect(await sweepBurnable(MERCHANT)).toBe(1)
    expect(received).toEqual(['cashuBa'])
  })
})

/**
 * What happens when the mint call fails.
 *
 * Reported from the console as `[burn] redeemed coupon not burnt` with an
 * `error: Error` that showed nothing. Two very different situations reach this
 * branch and they need opposite handling, which is the bug: an unreachable
 * gateway leaves live money that must be retried, while proofs that are
 * ALREADY SPENT can never burn again and were being retried on every
 * saveVoucher, forever, with the row still counted as money the mint no longer
 * backs.
 */
describe('when the burn fails', () => {
  /** #111 delta review: logged out while queued. Nothing sent, nothing checked, no alarm. */
  it('a pacer reset (logout) returns quietly without checking the mint', async () => {
    const { PacerResetError } = await import('../receivePacer')
    const validateToken = vi.fn(async () => ({ state: 'SPENT' }))
    stubs.api.validateToken = validateToken
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    _setReceivePacerForTests({ acquire: async () => { throw new PacerResetError() }, reset: () => {} })
    try {
      await expect(burnIfSelfIssued(row(), MERCHANT)).resolves.toBe(false)
      expect(received).toEqual([])
      expect(validateToken).not.toHaveBeenCalled()
      expect(stubs.saved).toEqual([])
      expect(error).not.toHaveBeenCalled()
    } finally {
      _setReceivePacerForTests({ acquire: async () => {}, reset: () => {} })
      error.mockRestore()
    }
  })

  it('settles the row when the proofs are already spent', async () => {
    stubs.api.receive = async () => {
      throw Object.assign(new Error('Token already spent'), { status: 400, code: 'TOKEN_SPENT' })
    }
    stubs.api.validateToken = async () => ({ valid: false, state: 'SPENT' })

    // Reported as burnt, because the value really is gone.
    expect(await burnIfSelfIssued(row(), MERCHANT)).toBe(true)
    expect(stubs.saved.map((r) => r.status)).toEqual(['redeemed'])
  })

  it('leaves the row spendable when the gateway is simply unreachable', async () => {
    // The opposite case, and the one where writing "redeemed" would destroy a
    // merchant's record of live money. `validateToken` cannot answer either,
    // so the honest outcome is to change nothing and sweep later.
    stubs.api.receive = async () => {
      throw Object.assign(new Error('Failed to fetch'), { status: 0 })
    }
    stubs.api.validateToken = async () => {
      throw new Error('Failed to fetch')
    }

    expect(await burnIfSelfIssued(row(), MERCHANT)).toBe(false)
    expect(stubs.saved).toEqual([])
  })

  it('does NOT settle a row the mint still reports as unspent', async () => {
    // A burn that failed for some other reason on a coupon that is still live.
    // Marking it redeemed would write off real value.
    stubs.api.receive = async () => {
      throw Object.assign(new Error('Internal Server Error'), { status: 500 })
    }
    stubs.api.validateToken = async () => ({ valid: true, state: 'UNSPENT' })

    expect(await burnIfSelfIssued(row(), MERCHANT)).toBe(false)
    expect(stubs.saved).toEqual([])
  })

  it('does not settle a PENDING token, which is still in flight', async () => {
    stubs.api.receive = async () => {
      throw new Error('nope')
    }
    stubs.api.validateToken = async () => ({ state: 'PENDING' })

    expect(await burnIfSelfIssued(row(), MERCHANT)).toBe(false)
    expect(stubs.saved).toEqual([])
  })

  it('a settled row is not retried on the next sweep', async () => {
    // The point of settling: `isRedeemed` short-circuits, so the failing call
    // stops repeating on every saveVoucher.
    stubs.api.receive = async () => {
      throw new Error('Token already spent')
    }
    stubs.api.validateToken = async () => ({ state: 'SPENT' })

    await burnIfSelfIssued(row(), MERCHANT)
    const settled = stubs.saved[0]
    received.length = 0

    expect(await burnIfSelfIssued(settled, MERCHANT)).toBe(false)
    expect(received, 'a settled row must not call the mint again').toEqual([])
  })
})
