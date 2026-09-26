import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TransactionRow } from '@imani/wallet-storage'
import { RedemptionRefusedError } from '@imani/dm-poll'

const stubs = vi.hoisted(() => ({ rows: [] as TransactionRow[] }))
vi.mock('../wallet', () => ({
  listTransactions: async () => stubs.rows,
  getWallet: () => ({}),
  notifyWalletChanged: () => {},
}))
vi.mock('../legacyBridge', () => ({ legacyApi: async () => ({}), withCorrelation: vi.fn() }))

import { refuseIfOverRedeemed } from '../dmPoll'
import { buildVoucherToken } from './voucherFixtures'

const VOUCHER = '1d4410af-70f5-4c14-8606-519404684ea7'
const verified = { signatureValid: true, legacyCanonical: false, signedFaceValue: 1000, cappedAtFaceValue: false }

const received = (amount: number): TransactionRow =>
  ({ id: `tx-${amount}`, type: 'received', timestamp: 1, amount, unit: 'GBP', decimals: 2, voucherId: VOUCHER }) as unknown as TransactionRow

beforeEach(() => {
  stubs.rows = []
})

describe('refuseIfOverRedeemed', () => {
  it('allows a first redemption inside the issued face value', async () => {
    await expect(
      refuseIfOverRedeemed({ voucherId: VOUCHER, faceValue: 400, validation: verified }),
    ).resolves.toBeUndefined()
  })

  it('refuses the redemption that would breach the issued face value', async () => {
    // The whole point: the coupon is genuine and correctly signed, and it has
    // simply already paid out everything it was issued for.
    stubs.rows = [received(1000)]
    await expect(
      refuseIfOverRedeemed({ voucherId: VOUCHER, faceValue: 1000, validation: verified }),
    ).rejects.toBeInstanceOf(RedemptionRefusedError)
  })

  it('carries the numbers on the error so the refusal can be explained', async () => {
    stubs.rows = [received(800)]
    await refuseIfOverRedeemed({ voucherId: VOUCHER, faceValue: 300, validation: verified }).then(
      () => expect.fail('should have refused'),
      (e: RedemptionRefusedError) => {
        expect(e.voucherId).toBe(VOUCHER)
        expect(e.alreadyRedeemed).toBe(800)
        expect(e.signedFaceValue).toBe(1000)
      },
    )
  })

  it('stays silent for a token that was never verified', async () => {
    // Plain ecash, or a row from before verification existed. There is no
    // signed ceiling, so there is nothing to enforce.
    stubs.rows = [received(5000)]
    await expect(
      refuseIfOverRedeemed({ voucherId: VOUCHER, faceValue: 5000 }),
    ).resolves.toBeUndefined()
  })

  it('stays silent when the signature did not verify', async () => {
    // dmCrypto already refused the message; this must not double-handle it.
    stubs.rows = [received(5000)]
    await expect(
      refuseIfOverRedeemed({
        voucherId: VOUCHER,
        faceValue: 5000,
        validation: { ...verified, signatureValid: false },
      }),
    ).resolves.toBeUndefined()
  })

  it('lets the last part of a fractional-ratio split through, given its token', async () => {
    // 9 + 9 + 17802 proofs at this ratio credit 1 + 1 + 999 of 1000. The token
    // is what tells the ceiling the 999 was rounded; see
    // fractionalSplitCeiling.test.ts for the arithmetic.
    stubs.rows = [received(1), { ...received(1), id: 'tx-1b' } as unknown as TransactionRow]
    const { token } = buildVoucherToken({ issuanceRatio: 0.05611672278338945, faceValue: 1000 }, [17802])
    const meta = { voucherId: VOUCHER, faceValue: 999, validation: verified }

    await expect(refuseIfOverRedeemed(meta, token)).resolves.toBeUndefined()
    // Without the token the bound stays exact, and the same part is refused.
    await expect(refuseIfOverRedeemed(meta)).rejects.toBeInstanceOf(RedemptionRefusedError)
  })
})
