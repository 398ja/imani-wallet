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
    split: vi.fn(async () => ({ kind: 'refused' as const, why: 'unused' })),
  }
})

/** #402: one 1024-sat proof at ratio 1 (1 sat = 1 p): no subset of it makes 3.37, a split does. */
function splittableRow(): VoucherRow {
  const w = W.world()
  const token = W.tokenOf([w.mint.issue(W.bearerSecret({ issuerId: W.STALL, nonce: 'splitnnn', issuanceRatio: 1, faceValue: 100_000 }, 's0'), 1024)])
  return { token_id: 'row-split', token, voucher_id: 's', issuer_id: W.STALL, face_value: 1024, face_unit: 'GBP', face_decimals: 2, token_amount: 1024, status: 'active', created_at: '' } as unknown as VoucherRow
}
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
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '0.08' } })
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
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '5.00' } })
    expect(await screen.findByText(/can be used at shop\.example/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Get code' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('#402: an amount only a split can make is offered, says so, splits on Get code, then makes the code', async () => {
    deps.rows = async () => [splittableRow()]
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    deps.split = vi.fn(async () => {
      await gate
      return { kind: 'split' as const, parts: [{ tokenId: 'part-337', token: 'cashuBpart', amount: 337, faceValue: 337 }] }
    })
    at(`/online?stall=${W.STALL}`)
    await screen.findByText('Usable at shop.example')
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '3.37' } })
    expect(await screen.findByText('Imani will split a voucher to make this amount.')).toBeTruthy()
    expect(screen.queryByText(/cannot make exactly this amount/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Get code' }))
    expect(await screen.findByRole('button', { name: 'Splitting your voucher…' })).toBeTruthy()
    expect(deps.start).not.toHaveBeenCalled()
    release()
    await waitFor(() => expect(deps.start).toHaveBeenCalled())
    expect((deps.split as ReturnType<typeof vi.fn>).mock.calls[0][2]).toEqual({ tokenId: 'row-split', token: expect.any(String), amount: 337 })
    const req = (deps.start as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(req.amount).toBe(337)
    expect(req.parts).toEqual([{ tokenId: 'part-337', token: 'cashuBpart', amount: 337, faceValue: 337 }])
  })

  it.each([
    [{ kind: 'refused', why: 'split_route_unavailable' }, 'Your voucher could not be split right now. Nothing has changed.'],
    [{ kind: 'kept_as_sats', why: 'SAT_BOUND_EXCEEDED' }, 'Your voucher could not be split. Its value is still in your wallet, now as sats.'],
    [{ kind: 'pending', why: 'the mint is down' }, 'Your voucher is being split. It is safe, and it finishes the next time Imani opens. Try again in a moment.'],
  ])('#402: a split that does not finish says what moved in plain words (%o)', async (outcome, words) => {
    deps.rows = async () => [splittableRow()]
    deps.split = vi.fn(async () => outcome as never)
    at(`/online?stall=${W.STALL}`)
    await screen.findByText('Usable at shop.example')
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '3.37' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Get code' }))
    expect(await screen.findByText(words)).toBeTruthy()
    expect(deps.start).not.toHaveBeenCalled()
  })

  it('#402: split, but no code: says both parts are in the wallet', async () => {
    deps.rows = async () => [splittableRow()]
    deps.split = vi.fn(async () => ({ kind: 'split' as const, parts: [{ tokenId: 'p', token: 't', amount: 337, faceValue: 337 }] }))
    deps.start = vi.fn(async (req) => ({ kind: 'refused' as const, why: 'x', record: record({ amount: req.amount }) }))
    at(`/online?stall=${W.STALL}`)
    await screen.findByText('Usable at shop.example')
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '3.37' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Get code' }))
    expect(await screen.findByText('Your voucher was split, but no code could be made. Both parts are in your wallet.')).toBeTruthy()
  })

  it('a carvable amount does not split', async () => {
    at(`/online?stall=${W.STALL}`)
    await screen.findByText('Usable at shop.example')
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '0.08' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Get code' }))
    await waitFor(() => expect(deps.start).toHaveBeenCalled())
    expect(screen.queryByText(/will split a voucher/)).toBeNull()
    expect(deps.split).not.toHaveBeenCalled()
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
