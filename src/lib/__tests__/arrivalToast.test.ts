import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Bug 3 as reported: "user valverde also did not get any toast for the last
 * FCFA 4 transaction from simon."
 *
 * The cause was not a broken toast. It was that nothing called one: the only
 * producer of an advance-notice envelope is the atomic-send saga, so a coupon
 * delivered any other way redeemed in silence. These tests pin the new
 * behaviour — settlement announces itself — and the guarantees that make it safe
 * to call from inside the redemption path.
 */

const toasts: { message: unknown; options?: Record<string, unknown> }[] = []
vi.mock('sonner', () => ({
  toast: {
    success: (message: unknown, options?: Record<string, unknown>) => {
      toasts.push({ message, options })
      return 'id'
    },
  },
}))

vi.mock('../../components/ui/IncomingPaymentToast', () => ({
  IncomingPaymentToast: () => null,
  ReceivedPaymentToast: () => null,
}))

const { announceArrival, resetAnnounced } = await import('../arrivalToast')

const VOUCHER = {
  voucher_id: 'v-4-xaf',
  face_value: 4,
  face_unit: 'XAF',
  face_decimals: 0,
  sender_pubkey: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
}

beforeEach(() => {
  resetAnnounced()
  toasts.length = 0
})

describe('announcing a coupon that actually arrived', () => {
  it('announces a receipt that no advance notice ever covered', () => {
    announceArrival(VOUCHER)
    expect(toasts).toHaveLength(1)
  })

  it('renders the amount in the sender own unit and decimals', () => {
    announceArrival(VOUCHER)
    // 4 XAF, not 0.04 — XAF is a zero-decimal currency, and the gateway's
    // `face_decimals: 2` default on every currency is the exact trap §15.9 of
    // the design spec records. The row carries its own decimals; we use them.
    const props = (toasts[0]!.message as { props: { amount: string } }).props
    expect(props.amount).toContain('4')
    expect(props.amount).not.toContain('0.04')
  })

  it('announces once per voucher, however many times dm-poll reprocesses it', () => {
    // An SSE reconnect re-queries a window it already saw, so the same gift wrap
    // can reach the redemption path twice. A second toast reads as a second
    // payment.
    announceArrival(VOUCHER)
    announceArrival(VOUCHER)
    announceArrival(VOUCHER)

    expect(toasts).toHaveLength(1)
  })

  it('treats two different vouchers as two payments', () => {
    announceArrival(VOUCHER)
    announceArrival({ ...VOUCHER, voucher_id: 'v-другой' })

    expect(toasts).toHaveLength(2)
  })

  it('still announces a coupon whose sender is unknown', () => {
    // `sender_pubkey` is optional on a redeemed voucher. An arrival from nobody
    // in particular is still the user money.
    announceArrival({ ...VOUCHER, sender_pubkey: undefined })
    expect(toasts).toHaveLength(1)
  })

  /**
   * The safety property that lets this be called from inside `redeem()`. The
   * proofs are already swapped at the mint by then, so an exception here would
   * turn a completed redemption into a reported failure — money taken, coupon
   * reported lost.
   */
  it('never throws, whatever it is handed', () => {
    expect(() => announceArrival(undefined)).not.toThrow()
    expect(() => announceArrival({})).not.toThrow()
    expect(() =>
      announceArrival({ voucher_id: 'x', face_value: Number.NaN, face_unit: undefined }),
    ).not.toThrow()
  })

  it('does not throw when the toast layer itself fails', async () => {
    vi.resetModules()
    vi.doMock('sonner', () => ({
      toast: {
        success: () => {
          throw new Error('no Toaster mounted')
        },
      },
    }))
    const { announceArrival: fragile } = await import('../arrivalToast')
    expect(() => fragile(VOUCHER)).not.toThrow()
  })
})
