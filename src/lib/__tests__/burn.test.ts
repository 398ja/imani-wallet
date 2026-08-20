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
  }
})

describe('burnIfSelfIssued', () => {
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
