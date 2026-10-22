/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * #300 ask 2: the stall's own till shows Paid on gateway-core's verdict.
 *
 * On staging (Test Stall S3, run 1) the buyer saw "Paid £6.50", gateway-core counted the send,
 * and the stall's own Redeem screen sat on "Waiting for payment" for two minutes, because it
 * learned Paid ONLY from its wallet receiving the DM'd coupon, and that receive stalled. The
 * screen now also asks gateway-core, through the same check a terminal uses (`fulfilmentOf` +
 * `paidForStall`), and shows Paid when core counts the payment. The receive carries on
 * underneath; if it fails, the merchant is told, and Paid stays.
 */

// The owner's wallet, stuck: the coupon never arrives until a test puts a row in it. The real
// reconcile runs over these rows, so filing and double-counting are the production rules.
const wallet = vi.hoisted(() => ({ rows: [] as unknown[], listeners: [] as Array<() => void> }))
vi.mock('../../lib/wallet', () => ({
  listTransactions: async () => wallet.rows,
  onWalletChanged: (fn: () => void) => {
    wallet.listeners.push(fn)
    return () => {
      wallet.listeners = wallet.listeners.filter((l) => l !== fn)
    }
  },
}))
vi.mock('../../components/ui/RefusedCouponsNote', () => ({ RefusedCouponsNote: () => null }))
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,' } }))

const { RedeemPage } = await import('../RedeemPage')
const { recordReceiveTrouble } = await import('../../lib/receiveTrouble')
import type { MerchantProfile } from '../../lib/merchant'

const STALL = 'a'.repeat(64)
const ID = 'pr-0123456789abcdef'
const merchant = { pubkey: STALL, active: true, categories: [], issuanceCurrency: 'GBP' } as unknown as MerchantProfile

/** gateway-core's verdict for this screen's request (650 pence of the stall's coupons) paid in full. */
const PAID = { fulfilled: true, sendId: 's1', issuerId: STALL, recipientPubkey: STALL, amount: 650, unit: 'GBP' }

let fetchCalls: string[] = []

beforeEach(() => {
  localStorage.clear()
  wallet.rows = []
  wallet.listeners = []
  fetchCalls = []
  ;(window as unknown as { NUT18V: unknown }).NUT18V = {
    generate: () => ({ paymentId: ID, requestString: 'vreqA' + 'x'.repeat(60), clickableUri: 'cashu:vreqA' }),
  }
  // Anything the screen fetches by itself is recorded, so a receive it starts would show here.
  vi.stubGlobal('fetch', async (input: string) => {
    fetchCalls.push(String(input))
    return new Response('{}')
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function ownerAsks(
  fulfilment: (id: string) => Promise<unknown>,
  register: (terms: unknown) => Promise<boolean> = async () => true,
) {
  const view = render(
    <MemoryRouter>
      <RedeemPage pubkey={STALL} merchant={merchant} fulfilment={fulfilment as never} register={register as never} />
    </MemoryRouter>,
  )
  fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: '6.50' } })
  fireEvent.click(screen.getByRole('button', { name: 'Show payment code' }))
  return view
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('the stall’s own till shows Paid on gateway-core’s verdict (#300)', () => {
  // Run 1 on staging: the receive never completes (the wallet never changes), but gateway-core
  // has counted the send. The till says Paid, and says the coupons are still on their way.
  it('shows Paid while the receive is stalled, once core counts the payment', async () => {
    let counted = false
    await ownerAsks(async () => (counted ? PAID : { fulfilled: false, reason: 'unpaid' }))
    expect(await screen.findByText('Waiting for payment')).toBeTruthy()

    counted = true
    expect(await screen.findByText('Paid', {}, { timeout: 5_000 })).toBeTruthy()
    expect(screen.getByText(/receiving the coupons/i)).toBeTruthy()
    // The QR is gone: a paid request must not be paid twice.
    expect(screen.queryByAltText('Payment request QR code')).toBeNull()
    // Recorded, so the request list agrees after a reload.
    const stored = JSON.parse(localStorage.getItem(`imani-wallet:payment-requests:${STALL}`)!)
    expect(stored[0]).toMatchObject({ paymentId: ID, status: 'fulfilled', receivedAmount: 650 })
  })

  // Paid is core's verdict, checked against this request, never the buyer's word: an unpaid
  // answer, an underpaid one, and a "fulfilled" that falls short or went elsewhere all leave the
  // till waiting.
  it('never shows Paid when core says unpaid, underpaid, or its facts do not cover the request', async () => {
    const answers = [
      { fulfilled: false, reason: 'unpaid', amount: 0 },
      { fulfilled: false, reason: 'underpaid', issuerId: STALL, recipientPubkey: STALL, amount: 649, unit: 'GBP' },
      { ...PAID, amount: 649 },
      { ...PAID, recipientPubkey: 'b'.repeat(64) },
      { ...PAID, unit: 'EUR' },
    ]
    for (const answer of answers) {
      const asked: string[] = []
      await ownerAsks(async (id) => {
        asked.push(id)
        return answer
      })
      await screen.findByText('Waiting for payment')
      await sleep(50)
      expect(asked.length).toBeGreaterThan(0)
      expect(screen.queryByText('Paid')).toBeNull()
      cleanup()
    }
  })

  // The owner's terms are registered with core before the code is shown, exactly as a terminal
  // does, so core measures against THIS till's terms. If they could not be registered, core's
  // verdict is about someone else's terms, so it is never asked; the wallet path still works.
  it('registers its terms first, and does not trust core when it could not', async () => {
    const registered: unknown[] = []
    await ownerAsks(async () => PAID, async (terms) => {
      registered.push(terms)
      return true
    })
    expect(await screen.findByText('Paid', {}, { timeout: 5_000 })).toBeTruthy()
    expect(registered).toEqual([{ paymentId: ID, issuerId: STALL, amount: 650, unit: 'GBP' }])
    cleanup()

    const asked: string[] = []
    await ownerAsks(
      async (id) => {
        asked.push(id)
        return PAID
      },
      async () => false,
    )
    // Unlike a terminal, the owner still gets a code: its wallet can see the payment arrive.
    expect(await screen.findByText('Waiting for payment')).toBeTruthy()
    await sleep(50)
    expect(asked).toEqual([])
    expect(screen.queryByText('Paid')).toBeNull()
  })

  // Polling stops once core says Paid: a settled till has nothing left to ask.
  it('stops asking core after Paid', async () => {
    const asked: string[] = []
    await ownerAsks(async (id) => {
      asked.push(id)
      return PAID
    })
    expect(await screen.findByText('Paid', {}, { timeout: 5_000 })).toBeTruthy()
    const after = asked.length
    await act(() => sleep(2_500))
    expect(asked.length).toBe(after)
  })

  // And when the screen goes away: a till that was closed must not keep polling in the background.
  it('stops asking core on unmount', async () => {
    const asked: string[] = []
    const view = await ownerAsks(async (id) => {
      asked.push(id)
      return { fulfilled: false, reason: 'unpaid' }
    })
    await screen.findByText('Waiting for payment')
    await act(() => sleep(10))
    view.unmount()
    const after = asked.length
    await sleep(2_500)
    expect(asked.length).toBe(after)
  })

  // Showing Paid never starts a receive of its own: the coupon is received once, by dm-poll,
  // under its idempotency key. The screen only reads core's verdict.
  it('does not receive anything itself when core says Paid', async () => {
    await ownerAsks(async () => PAID)
    expect(await screen.findByText('Paid', {}, { timeout: 5_000 })).toBeTruthy()
    expect(fetchCalls.filter((u) => u.includes('/wallet/receive'))).toEqual([])
  })

  // The receive lands afterwards: the "receiving" note goes, Paid stays, and nothing is counted
  // twice (the amount stays what core counted).
  it('drops the receiving note once the coupons arrive, without counting them again', async () => {
    await ownerAsks(async () => PAID)
    expect(await screen.findByText('Paid', {}, { timeout: 5_000 })).toBeTruthy()

    wallet.rows = [{ id: 'tx1', type: 'received', timestamp: Date.now() + 1, amount: 650, unit: 'GBP', requestId: ID }]
    await act(async () => wallet.listeners.forEach((l) => l()))

    await vi.waitFor(() => expect(screen.queryByText(/receiving the coupons/i)).toBeNull())
    expect(screen.getByText('Paid')).toBeTruthy()
    const stored = JSON.parse(localStorage.getItem(`imani-wallet:payment-requests:${STALL}`)!)
    expect(stored.filter((r: { status: string }) => r.status === 'fulfilled')).toHaveLength(1)
    expect(stored[0]).toMatchObject({ paymentId: ID, settledBy: 'tx1', receivedAmount: 650 })
  })

  // The receive fails after core counted the payment. The money is counted (Paid stays), but the
  // coupons are the merchant's custody, so the till says they have not reached this wallet.
  it('surfaces a failed receive without taking Paid back', async () => {
    await ownerAsks(async () => PAID)
    expect(await screen.findByText('Paid', {}, { timeout: 5_000 })).toBeTruthy()

    await act(async () => {
      recordReceiveTrouble(STALL, { eventId: 'e1', requestId: ID, kind: 'failed' })
    })

    expect(await screen.findByText(/not reached this wallet/i)).toBeTruthy()
    expect(screen.getByText('Paid')).toBeTruthy()
  })

  // #314: "will keep trying" is now a promise the wallet keeps, so it is said for a failure it
  // will retry, and only then.
  it('says the wallet will keep trying for a failure it retries', async () => {
    await ownerAsks(async () => PAID)
    expect(await screen.findByText('Paid', {}, { timeout: 5_000 })).toBeTruthy()
    await act(async () => {
      recordReceiveTrouble(STALL, { eventId: 'e1', requestId: ID, kind: 'failed', retryable: true })
    })
    expect(await screen.findByText(/will keep trying/i)).toBeTruthy()
  })

  // #307 review / #314: a permanent refusal (a coupon the mint will never accept) is not
  // retried, so the strip must not promise it. Red on main: it said "will keep trying".
  it('a permanent refusal shows the other message, never "will keep trying"', async () => {
    await ownerAsks(async () => PAID)
    expect(await screen.findByText('Paid', {}, { timeout: 5_000 })).toBeTruthy()
    await act(async () => {
      recordReceiveTrouble(STALL, { eventId: 'e1', requestId: ID, kind: 'failed', retryable: false })
    })
    expect(await screen.findByText(/could not be added to this wallet/i)).toBeTruthy()
    expect(screen.queryByText(/keep trying/i)).toBeNull()
    expect(screen.getByText('Paid')).toBeTruthy()
  })
})

describe('the app gives the stall’s own Redeem screen the core check (#300)', () => {
  // The screen can only fall back to core if the app hands it the check. The owner's route used
  // to pass no `fulfilment`, which is exactly why run 1 depended on the receive alone.
  it('App passes fulfilment and register to the owner’s RedeemPage', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const app = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8')
    const redeem = app.slice(app.indexOf('<RedeemPage'), app.indexOf('/>', app.indexOf('<RedeemPage')))
    expect(redeem).toMatch(/fulfilment=\{/)
    expect(redeem).toMatch(/register=\{/)
  })
})
