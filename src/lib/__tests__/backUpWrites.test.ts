import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { VoucherRow } from '@imani/wallet-storage'
import type { WalletStorage } from '@imani/wallet-storage'
import { backUpWrites } from '../wallet'
import { publishVoucher } from '../voucherRecords'
import { publishTx } from '../txRecords'

vi.mock('../voucherRecords', () => ({
  publishVoucher: vi.fn().mockResolvedValue(undefined),
  tombstoneVoucher: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../txRecords', () => ({ publishTx: vi.fn().mockResolvedValue(undefined) }))

/**
 * A stand-in for the store, faithful on the one point that matters: it derives
 * `token_id` from the token ONTO A COPY, exactly as WalletStorage.ts:537 does,
 * and never touches the caller's object.
 */
function fakeStore() {
  const written: VoucherRow[] = []
  const store = {
    init: vi.fn(),
    addTransaction: vi.fn(async (row) => row),
    atomicallyWrite: vi.fn(async (input: { vouchers?: VoucherRow[] }) => {
      for (const row of input.vouchers ?? []) {
        written.push({ ...row, token_id: `id-of-${row.token}` })
      }
    }),
    saveVoucher: vi.fn(async (row: VoucherRow) => ({ ...row, token_id: `id-of-${row.token}` })),
    removeVoucher: vi.fn(async () => true),
    removeVouchers: vi.fn(async () => 0),
    clearAndReplaceAllVouchers: vi.fn(async (rows: VoucherRow[]) => {
      written.length = 0
      for (const row of rows) written.push({ ...row, token_id: `id-of-${row.token}` })
    }),
    getAllVouchers: vi.fn(async () => written),
  }
  return store as unknown as WalletStorage
}

/** What `shared/tokenRedemption.js::buildVoucher` hands over: no `token_id`. */
const arrived = (token: string) => ({ voucher_id: `v-${token}`, token }) as VoucherRow

describe('backUpWrites', () => {
  beforeEach(() => vi.mocked(publishVoucher).mockClear())

  it('backs up a coupon that arrived WITHOUT a token_id', async () => {
    // The regression, and it cost a staging customer their coupons: `token_id`
    // is the backup event's `d` tag, the store derives it during the write, and
    // publishing the caller's row instead of the stored one meant every coupon
    // received over DM hit publishVoucher's `if (!row.token_id) return`. The
    // transaction row went out — it carries its own id — so the relay held a
    // history event for a coupon it had no backup of, and the coupon died at
    // the next logout.
    const ws = fakeStore()
    backUpWrites(ws)

    await ws.atomicallyWrite({ vouchers: [arrived('cashuA')], transactions: [] })
    await vi.waitFor(() => expect(publishVoucher).toHaveBeenCalled())

    expect(vi.mocked(publishVoucher).mock.calls[0][0].token_id).toBe('id-of-cashuA')
  })

  it('publishes the transaction rows alongside', async () => {
    const ws = fakeStore()
    backUpWrites(ws)

    await ws.atomicallyWrite({ vouchers: [], transactions: [{ id: 'received:abc' }] as never })

    expect(publishTx).toHaveBeenCalledWith({ id: 'received:abc' })
  })

  it('backs up the stored row on saveVoucher too, not the argument', async () => {
    const ws = fakeStore()
    backUpWrites(ws)

    await ws.saveVoucher(arrived('cashuB'))

    expect(vi.mocked(publishVoucher).mock.calls[0][0].token_id).toBe('id-of-cashuB')
  })

  it('reads nothing back when a write carried no coupons', async () => {
    // Every receive writes a transaction row; only some write coupons. A
    // getAllVouchers() per transaction row would be a scan of the whole store
    // for nothing.
    const ws = fakeStore()
    backUpWrites(ws)

    await ws.atomicallyWrite({ transactions: [{ id: 'payment:abc' }] as never })

    expect(ws.getAllVouchers).not.toHaveBeenCalled()
    expect(publishVoucher).not.toHaveBeenCalled()
  })
})
