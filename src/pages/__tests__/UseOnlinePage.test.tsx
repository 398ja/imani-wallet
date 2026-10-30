/**
 * @vitest-environment jsdom
 *
 * #402 "Use online": the stall picker offers only stalls with an online shop, the amount screen
 * says what is usable at that shop (and why the rest is not), Get code hands the plan to the flow,
 * and the code screen shows the code in the platform's form with Copy and Cancel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { VoucherRow } from '@imani/wallet-storage'

vi.mock('../../lib/trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))

const { UseOnlinePage } = await import('../UseOnlinePage')
const W = await import('../../lib/__tests__/cashlinkWorld')
const { checkSymbol } = await import('../../lib/checkoutCode')
type Deps = import('../UseOnlinePage').UseOnlineDeps
type Rec = import('../../lib/checkoutCodeRecords').CheckoutCodeRecord

const NOW_S = 1_800_000_000
const ME = 'e'.repeat(64)
const OTHER = 'f'.repeat(64)
const SHOP = { url: 'https://shop.example', redeemKey: 'd4'.repeat(32), platform: 'woocommerce' as const, since: 1 }
const CODE = `IMANI${'0'.repeat(10)}1${checkSymbol('0'.repeat(10) + '1')}`

function rowOf(issuer: string, amounts: number[], n: string): VoucherRow {
  const w = W.world()
  const token = W.tokenOf(amounts.map((a, k) => w.mint.issue(W.bearerSecret({ issuerId: issuer, nonce: `${n}nnnnnnn` }, `${n}${k}`), a)))
  return { token_id: `row-${n}`, token, voucher_id: n, issuer_id: issuer, face_value: Math.round(amounts.reduce((s, a) => s + a, 0) * 0.125), face_unit: 'GBP', face_decimals: 2, token_amount: amounts.reduce((s, a) => s + a, 0), status: 'active', created_at: '' } as unknown as VoucherRow
}

const record = (extra: Partial<Rec> = {}): Rec => ({
  id: 'r1', stall: W.STALL, shopKey: SHOP.redeemKey, shopUrl: SHOP.url, platform: 'woocommerce', unit: 'GBP', decimals: 2,
  amount: 8, x: NOW_S + 7 * 86_400, createdAt: 0, status: 'reserved', code: CODE, parts: [], ...extra,
})

let deps: Deps
let codes: Rec[]
beforeEach(() => {
  codes = [record()]
  deps = {
    rows: async () => [rowOf(W.STALL, [64], 'a'), rowOf(OTHER, [64], 'b')],
    shopOf: async (stall) => (stall.toLowerCase() === W.STALL ? SHOP : null),
    nowMs: () => NOW_S * 1000,
    start: vi.fn(async (req) => ({ kind: 'issued' as const, record: record({ amount: req.amount }) })),
    cancel: vi.fn(async () => {
      codes = [record({ status: 'cancelling' })]
      return { ok: true }
    }),
    codes: () => codes,
    ports: () => ({}) as never,
  }
})
afterEach(cleanup)

const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/online" element={<UseOnlinePage pubkey={ME} deps={deps} />} />
        <Route path="/online/code/:id" element={<UseOnlinePage pubkey={ME} deps={deps} />} />
      </Routes>
    </MemoryRouter>,
  )

describe('Use online', () => {
  it('offers only stalls whose profile names an online shop', async () => {
    at('/online')
    expect(await screen.findByText(/shop\.example/)).toBeTruthy()
    expect(screen.getAllByRole('button').filter((b) => /shop\./.test(b.textContent ?? ''))).toHaveLength(1)
  })

  it('shows what is usable at the shop and hands the plan to the flow', async () => {
    at(`/online?stall=${W.STALL}`)
    expect(await screen.findByText('Usable at shop.example')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0.08' } })
    const get = screen.getByRole('button', { name: 'Get code' }) as HTMLButtonElement
    await waitFor(() => expect(get.disabled).toBe(false))
    fireEvent.click(get)
    await waitFor(() => expect(deps.start).toHaveBeenCalled())
    const req = (deps.start as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(req).toMatchObject({ amount: 8, unit: 'GBP', x: NOW_S + 7 * 86_400, shop: SHOP })
    expect(req.parts).toHaveLength(1)
  })

  it('says when the amount is more than the shop can take', async () => {
    at(`/online?stall=${W.STALL}`)
    await screen.findByText('Usable at shop.example')
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '5.00' } })
    expect(await screen.findByText(/can be used at shop\.example/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Get code' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('the code screen: display form, Only works at, Copy, Cancel', async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    at('/online/code/r1')
    expect(screen.getByTestId('checkout-code').textContent).toMatch(/^IMANI-\w{4}-\w{4}-\w{4}$/)
    expect(screen.getByText('Only works at shop.example')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Copy/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(screen.getByTestId('checkout-code').textContent))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel code' }))
    expect(await screen.findByText(/Cancelling\. Your money is back within 24 hours/)).toBeTruthy()
  })

  it('Shopify gets the compact form', () => {
    codes = [record({ platform: 'shopify' })]
    at('/online/code/r1')
    expect(screen.getByTestId('checkout-code').textContent).toBe(CODE)
  })
})
