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

  it('books the last part of a fractional-ratio split at its cumulative credit', async () => {
    // 9 + 9 + 17802 proofs at this ratio: the first two booked 0 and 1 (their
    // exact values 0.505 each ride on the rows), so the last books 999 and the
    // voucher closes at exactly its face.
    const RATIO = 0.05611672278338945
    stubs.rows = [
      { ...received(0), id: 'tx-a', exactValue: 9 * RATIO },
      { ...received(1), id: 'tx-b', exactValue: 9 * RATIO },
    ] as unknown as TransactionRow[]
    const { token } = buildVoucherToken({ issuanceRatio: RATIO, faceValue: 1000 }, [17802])
    const meta = { voucherId: VOUCHER, faceValue: 999, validation: verified }

    await expect(refuseIfOverRedeemed(meta, token)).resolves.toBe(999)
  })

  it('refuses the many-tiny-parts attack once the genuine value is booked', async () => {
    // 2000 one-sat parts at ratio 0.5 have booked their genuine 1000 already.
    // The next is worth 0.5 and rounds to 1 on its own; cumulatively it books
    // 1 on a full face, which the exact ceiling refuses.
    stubs.rows = Array.from({ length: 2000 }, (_, i) => ({
      ...received(i % 2),
      id: `tx-${i}`,
      exactValue: 0.5,
    })) as unknown as TransactionRow[]
    const { token } = buildVoucherToken({ issuanceRatio: 0.5, faceValue: 1000 }, [1])
    const meta = { voucherId: VOUCHER, faceValue: 1, validation: verified }

    await expect(refuseIfOverRedeemed(meta, token)).rejects.toBeInstanceOf(RedemptionRefusedError)
  })

  it("passes a customer's last honest part when the earlier parts carry no exact figure (R1)", async () => {
    // A customer's received rows as they were written before every verified
    // row carried `exactValue`: 9 proofs each, booked at their own rounding, 1
    // and 1. The last part is worth 998.99; without an allowance for those two
    // legacy rows the exact ceiling sees 2 + 998.99 > 1000 and refuses it.
    const RATIO = 0.05611672278338945
    stubs.rows = [
      { ...received(1), id: 'tx-a' },
      { ...received(1), id: 'tx-b' },
    ] as unknown as TransactionRow[]
    const { token } = buildVoucherToken({ issuanceRatio: RATIO, faceValue: 1000 }, [17802])
    const meta = { voucherId: VOUCHER, faceValue: 999, validation: verified }

    await expect(refuseIfOverRedeemed(meta, token)).resolves.toBe(998)
  })

  it('gives legacy rows no allowance that new tiny parts can grow (R1)', async () => {
    // Two legacy rows buy at most one unit of exact slack, however many new
    // parts follow. Here 1998 new half-unit parts (999 exact) sit on top of
    // them, so the exact total is 1001, the face plus that whole allowance,
    // and the next part is refused. A slack over the PART count would have
    // admitted another thousand.
    stubs.rows = [
      { ...received(1), id: 'legacy-a' },
      { ...received(1), id: 'legacy-b' },
      ...Array.from({ length: 1998 }, (_, i) => ({ ...received(i % 2), id: `tx-${i}`, exactValue: 0.5 })),
    ] as unknown as TransactionRow[]
    const { token } = buildVoucherToken({ issuanceRatio: 0.5, faceValue: 1000 }, [1])
    const meta = { voucherId: VOUCHER, faceValue: 1, validation: verified }

    await expect(refuseIfOverRedeemed(meta, token)).rejects.toBeInstanceOf(RedemptionRefusedError)
  })
})
