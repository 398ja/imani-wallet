/**
 * @vitest-environment jsdom
 *
 * #402 "Use online": the stall picker offers only stalls with an online shop, the amount screen
 * says what is usable at that shop (and why the rest is not), Get code hands the plan to the flow,
 * and the code screen shows the code in the platform's form with Copy and Cancel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { VoucherRow } from '@imani/wallet-storage'

vi.mock('../../lib/trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))

const { UseOnlinePage } = await import('../UseOnlinePage')
const W = await import('../../lib/__tests__/cashlinkWorld')
const { checkSymbol, display } = await import('../../lib/checkoutCode')
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

describe('#639: a stall whose plan takes no new checkout codes', () => {
  const NOT_IN_PLAN = 'This shop is not taking new checkout codes right now. Nothing has changed: your vouchers are still in your wallet and still work at the stall.'

  const typed = async () => {
    at(`/online?stall=${W.STALL}`)
    await screen.findByText('Usable at shop.example')
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '0.08' } })
    return screen.getByRole('button', { name: 'Get code' }) as HTMLButtonElement
  }

  it('lists the stall with the not_in_plan words', async () => {
    deps.acceptsNew = vi.fn(async () => false)
    at('/online')
    expect(await screen.findByTestId('not-in-plan')).toBeTruthy()
    expect(screen.getByTestId('not-in-plan').textContent).toBe(NOT_IN_PLAN)
    expect(deps.acceptsNew).toHaveBeenCalledWith(W.STALL)
  })

  it('disables Get code on the amount screen with the same words, and never starts a code', async () => {
    deps.acceptsNew = vi.fn(async () => false)
    const get = await typed()
    expect(await screen.findByText(NOT_IN_PLAN)).toBeTruthy()
    expect(get.disabled).toBe(true)
    fireEvent.click(get)
    expect(deps.start).not.toHaveBeenCalled()
  })

  it.each([
    ['accepts', async () => true],
    ['unknown (503, 404, malformed)', async () => null],
    ['throws', async () => { throw new Error('network') }],
  ])('leaves Get code on when the answer %s, and the lock decides', async (_label, answer) => {
    deps.acceptsNew = vi.fn(answer as () => Promise<boolean | null>)
    const get = await typed()
    await waitFor(() => expect(deps.acceptsNew).toHaveBeenCalled())
    await waitFor(() => expect(get.disabled).toBe(false))
    expect(screen.queryByTestId('not-in-plan')).toBeNull()
    fireEvent.click(get)
    await waitFor(() => expect(deps.start).toHaveBeenCalled())
  })

  it('says nothing in the picker when the answer is not a clear no', async () => {
    deps.acceptsNew = vi.fn(async () => null)
    at('/online')
    expect(await screen.findByText(/shop\.example/)).toBeTruthy()
    expect(screen.queryByTestId('not-in-plan')).toBeNull()
  })
})

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

  it('#644: split, but no code: says nothing was spent, never counts parts, shows the gateway reason', async () => {
    deps.rows = async () => [splittableRow()]
    deps.split = vi.fn(async () => ({ kind: 'split' as const, parts: [{ tokenId: 'p', token: 't', amount: 337, faceValue: 337 }] }))
    deps.start = vi.fn(async (req) => ({ kind: 'refused' as const, why: 'lock_refused', record: record({ amount: req.amount, refusalDetail: 'SHOP_KEY_UNKNOWN' }) }))
    at(`/online?stall=${W.STALL}`)
    await screen.findByText('Usable at shop.example')
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '3.37' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Get code' }))
    expect(await screen.findByText('No code could be made. Nothing was spent and your voucher is still in your wallet. Reason given: SHOP_KEY_UNKNOWN.')).toBeTruthy()
    expect(screen.queryByText(/Both parts|was split/)).toBeNull()
  })

  it('#644: the lock check runs before the split, and a refusal it sees does not split at all', async () => {
    deps.rows = async () => [splittableRow()]
    const order: string[] = []
    deps.checkSource = vi.fn(async () => (order.push('check'), { why: 'lock_refused', detail: 'SHOP_KEY_UNKNOWN' }))
    deps.split = vi.fn(async () => (order.push('split'), { kind: 'refused' as const, why: 'unused' }))
    at(`/online?stall=${W.STALL}`)
    await screen.findByText('Usable at shop.example')
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '3.37' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Get code' }))
    expect(await screen.findByText('No code could be made. Nothing was spent and your voucher is still in your wallet. Reason given: SHOP_KEY_UNKNOWN.')).toBeTruthy()
    expect(order).toEqual(['check'])
    expect(deps.split).not.toHaveBeenCalled()
    expect(deps.start).not.toHaveBeenCalled()
    expect((deps.checkSource as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ stall: W.STALL, unit: 'GBP', token: expect.any(String) })
  })

  it('#644: a lock check that passes goes on to split, then make the code', async () => {
    deps.rows = async () => [splittableRow()]
    const order: string[] = []
    deps.checkSource = vi.fn(async () => (order.push('check'), null))
    deps.split = vi.fn(async () => (order.push('split'), { kind: 'split' as const, parts: [{ tokenId: 'p', token: 't', amount: 337, faceValue: 337 }] }))
    at(`/online?stall=${W.STALL}`)
    await screen.findByText('Usable at shop.example')
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '3.37' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Get code' }))
    await waitFor(() => expect(deps.start).toHaveBeenCalled())
    expect(order).toEqual(['check', 'split'])
  })

  it('#644: a refusal without a split shows the gateway reason too', async () => {
    deps.start = vi.fn(async (req) => ({ kind: 'refused' as const, why: 'lock_refused', record: record({ amount: req.amount, refusalDetail: 'SHOP_KEY_UNKNOWN' }) }))
    at(`/online?stall=${W.STALL}`)
    await screen.findByText('Usable at shop.example')
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '0.08' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Get code' }))
    expect(await screen.findByText('These vouchers cannot be used online right now. Nothing has changed. Reason given: SHOP_KEY_UNKNOWN.')).toBeTruthy()
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

  it('the code screen: display form, Only works at, Copy, and no Cancel (#472: a code is a bearer instrument)', async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    at('/online/code/r1')
    expect(screen.getByTestId('checkout-code').textContent).toMatch(/^IMANI-\w{4}-\w{4}-\w{4}$/)
    expect(screen.getByText('Only works at shop.example')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Copy/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(screen.getByTestId('checkout-code').textContent))
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull()
    expect(screen.getByTestId('bearer-note').textContent).toMatch(/^Anyone with this code can use the rest until .+; whatever is left then comes back to you\.$/)
  })

  it('#472: what is left, and each partial use', () => {
    codes = [record({ amount: 2500, remaining: 1700, redemptions: [{ at: NOW_S * 1000, amount: 800, remaining: 1700 }] })]
    at('/online/code/r1')
    expect(screen.getByText(/17\.00 left of .*25\.00/)).toBeTruthy()
    expect(screen.getByTestId('redemptions').textContent).toMatch(/8\.00 used, .*17\.00 left/)
  })

  it('a legacy cancelling code still says it is on its way back, with no Cancel button', () => {
    codes = [record({ status: 'cancelling' })]
    at('/online/code/r1')
    expect(screen.getByText(/Cancelling\. Your money is back within 24 hours/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull()
  })

  it('the code screen links to the shop in a new tab and shows the stall with the profile component', () => {
    at('/online/code/r1')
    const link = screen.getByTestId('shop-link') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe(SHOP.url)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link.getAttribute('title')).toBe(SHOP.url)
    expect(link.textContent).toMatch(/shop\.example/)
    expect(screen.getByTestId('stall-card').querySelector('[aria-busy], img, svg, span')).toBeTruthy()
  })

  it('the amount screen shows the stall card and the shop link', async () => {
    at(`/online?stall=${W.STALL}`)
    await screen.findByText('Usable at shop.example')
    expect(screen.getByTestId('stall-card')).toBeTruthy()
    const link = screen.getByTestId('shop-link') as HTMLAnchorElement
    expect(link.href).toBe(`${SHOP.url}/`)
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noopener noreferrer')
  })

  it('a code with no shop url and no stall profile still renders, with no link', () => {
    codes = [record({ shopUrl: '' })]
    at('/online/code/r1')
    expect(screen.getByTestId('checkout-code')).toBeTruthy()
    expect(screen.queryByTestId('shop-link')).toBeNull()
    expect(screen.getByText('Not recorded')).toBeTruthy()
    expect(screen.getByTestId('stall-card')).toBeTruthy()
  })

  it('a long shop url shows the host and keeps the full url as href', () => {
    const long = 'https://a-very-long-subdomain.example.co.uk/shop/checkout?ref=imani'
    codes = [record({ shopUrl: long })]
    at('/online/code/r1')
    const link = screen.getByTestId('shop-link') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe(long)
    expect(link.textContent).toContain('a-very-long-subdomain.example.co.uk')
    expect(link.textContent).not.toContain('/shop/checkout')
  })

  it('#405: Shopify gets the hyphenated form too', () => {
    codes = [record({ platform: 'shopify' })]
    at('/online/code/r1')
    expect(screen.getByTestId('checkout-code').textContent).toBe(display(CODE))
  })

  it('#405: a Shopify code is hidden while its shop prepares it, then shown', async () => {
    vi.useFakeTimers()
    try {
      codes = [record({ platform: 'shopify', shopReady: false })]
      let passes = 0
      deps.reconcile = vi.fn(async () => {
        if (++passes === 2) codes = [record({ platform: 'shopify', shopReady: true })]
        return 0
      })
      at('/online/code/r1')
      expect(screen.queryByTestId('checkout-code')).toBeNull()
      expect(screen.queryByText('Copy')).toBeNull()
      expect(screen.getByTestId('shop-preparing').textContent).toContain('Preparing your code for')
      await act(async () => void (await vi.advanceTimersByTimeAsync(3_000)))
      expect(screen.queryByTestId('checkout-code')).toBeNull()
      await act(async () => void (await vi.advanceTimersByTimeAsync(3_000)))
      expect(screen.getByTestId('checkout-code').textContent).toBe(display(CODE))
    } finally {
      vi.useRealTimers()
    }
  })

  it('#405: still not ready after ~2 minutes: says so', async () => {
    vi.useFakeTimers()
    try {
      codes = [record({ platform: 'shopify', shopReady: false })]
      deps.reconcile = vi.fn(async () => 0)
      at('/online/code/r1')
      await act(async () => void (await vi.advanceTimersByTimeAsync(121_000)))
      expect(screen.getByTestId('shop-preparing').textContent).toContain('Still preparing')
      expect(screen.queryByTestId('checkout-code')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('#557: a History row whose code record is not on this device', () => {
  const row = {
    id: 'checkout:gone', type: 'checkout_code', direction: 'out', timestamp: NOW_S * 1000, amount: 75, unit: 'EUR', decimals: 2,
    merchantId: W.STALL, checkoutCode: { id: 'gone', status: 'reserved', shopHost: 'shop.example' },
  }

  it('opens a readable detail from the History row, with the status from /mine', async () => {
    codes = []
    deps.historyRow = vi.fn(async (id: string) => (id === 'checkout:gone' ? row : null))
    deps.mine = vi.fn(async () => [{ idempotency_key: 'gone', status: 'redeemed' }])
    at('/online/code/gone')
    const detail = await screen.findByTestId('code-from-history')
    expect(detail.textContent).toMatch(/0\.75/)
    await waitFor(() => expect(screen.getByTestId('code-from-history').textContent).toContain('Used'))
    expect(screen.getByText('For shop.example')).toBeTruthy()
    expect(screen.queryByText('No such code.')).toBeNull()
  })

  it('falls back to the row status when /mine does not answer', async () => {
    codes = []
    deps.historyRow = async () => row
    deps.mine = async () => null
    at('/online/code/gone')
    expect((await screen.findByTestId('code-from-history')).textContent).toContain('Ready to use')
  })

  it('after a restore the full code screen opens again', async () => {
    // The record as restoreCheckoutCodes writes it back (checkoutCodeBackup557.test.ts).
    codes = [record({ id: 'gone' })]
    at('/online/code/gone')
    expect(screen.getByTestId('checkout-code')).toBeTruthy()
  })
})
