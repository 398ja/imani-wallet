import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Review of #145: a cashback redeem writes beside a DM redeem.
 *
 * The cashback path did not register with the bridge, so its write named no
 * redeem. While a DM redeem was in flight, the old "only one in flight"
 * fallback stamped the DM coupon's claim onto the cashback row. The cashback
 * redeem now registers and names itself, and each write gets its own stamp.
 */

const written = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }))

vi.mock('../wallet', () => ({
  notifyWalletChanged: () => {},
  recordCashbackStatus: async () => {},
  getWallet: () => ({}),
}))
vi.mock('../nip98', () => ({ signedFetch: async () => new Response('{}', { status: 200 }) }))
vi.mock('../legacyBridge', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  legacyApi: async () => ({}),
}))

const { installTokenIdFill, withCorrelation } = await import('../legacyBridge')
const { replayPendingCashback } = await import('../cashback')

/** Lets the test choose when each redeem's write lands. */
const gate = () => {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { open, opened }
}

/** What tokenRedemption writes at the end of a redeem: the voucher it built, naming its redeem. */
const writeVoucher = (tokenId: string, correlation: unknown) =>
  window.walletStorageIntegration!.atomicallyWrite({
    vouchers: [{ token_id: tokenId, voucher_id: `gw-${tokenId}`, face_value: 5, face_unit: 'EUR', correlation_id: correlation }],
    transactions: [{ id: `received:${tokenId}`, tokenId }],
  })

const rowFor = (tokenId: string) => written.rows.find((r) => r.tokenId === tokenId)

beforeEach(() => {
  written.rows = []
  const store = new Map<string, string>([['imani:cashback:pending', 'cashuBcashback']])
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
})

describe('a cashback redeem beside a DM redeem (#145 review)', () => {
  /**
   * The cashback redeem names itself, its row stays the cashback's, and the DM
   * row gets the DM coupon's claim.
   */
  it('stamps each write with its own redeem', async () => {
    // Arrange
    const cashbackWrite = gate()
    const cashbackCorrelation: unknown[] = []
    vi.stubGlobal('window', {
      TokenRedemption: {
        async redeem(_token: string, opts: { metadata?: Record<string, unknown> }) {
          cashbackCorrelation.push(opts.metadata?.correlation_id)
          await cashbackWrite.opened
          await writeVoucher('tok-cashback', opts.metadata?.correlation_id)
          return {}
        },
      },
      walletStorageIntegration: {
        init: vi.fn(),
        atomicallyWrite: async (input: { transactions?: unknown[] }) => {
          written.rows.push(...((input.transactions ?? []) as Record<string, unknown>[]))
        },
      },
    })
    installTokenIdFill()
    const dmWrite = gate()
    const dm = withCorrelation(
      { claim: { voucherId: 'dm-voucher', amount: 15, unit: 'EUR' } },
      async (correlation) => {
        await dmWrite.opened
        await writeVoucher('tok-dm', correlation)
      },
    )

    // Act: the cashback write lands while the DM redeem is still in flight.
    const cashback = replayPendingCashback()
    cashbackWrite.open()
    await cashback
    dmWrite.open()
    await dm

    // Assert
    expect(cashbackCorrelation).toEqual([expect.any(String)])
    expect(rowFor('tok-cashback')?.voucherId).toBeUndefined()
    expect(rowFor('tok-dm')).toMatchObject({ voucherId: 'dm-voucher', amount: 15 })
  })
})
