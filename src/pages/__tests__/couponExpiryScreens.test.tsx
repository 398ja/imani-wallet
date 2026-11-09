/**
 * @vitest-environment jsdom
 */
/**
 * #265: what the coupon screens say about expiry.
 *
 *  - the detail page: absolute date plus a countdown, "Use it before …" inside the week, and an
 *    expired coupon that no longer reads "Status active" over a live QR code;
 *  - the list: badges by tone with text and an accessible label, soonest first by default with
 *    "Newest" kept as an option, and an "Expired (N)" group instead of silent removal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { VoucherRow } from '@imani/wallet-storage'

const STALL = 'a'.repeat(64)
const DAY = 86_400_000
const h = vi.hoisted(() => ({ rows: [] as VoucherRow[] }))

vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,QR' } }))
vi.mock('../../hooks/useBranding', () => ({
  useBranding: () => ({ branding: { organizationName: 'Test Stall' }, loading: false }),
}))
vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  getVoucherRow: async (id: string) => h.rows.find((r) => r.token_id === id) ?? null,
  listVouchers: async () => h.rows,
  onWalletChanged: () => () => {},
}))
vi.mock('../../lib/nap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/nap')>()),
  getSigner: () => ({ pubkey: 'e'.repeat(64) }),
}))

const { CouponPage } = await import('../RecordDetailPages')
const { CouponsPage } = await import('../RecordListPages')
const { formatDate } = await import('../../lib/format')

function row(token_id: string, expiresInMs: number | undefined, over: Partial<VoucherRow> = {}): VoucherRow {
  return {
    token_id,
    voucher_id: `v-${token_id}`,
    token: `cashuB-${token_id}`,
    amount: 250,
    face_value: 250,
    face_unit: 'EUR',
    face_decimals: 2,
    issuer_id: STALL,
    status: 'active',
    expires_at: expiresInMs === undefined ? undefined : Math.floor((Date.now() + expiresInMs) / 1000),
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

const openCoupon = (id: string) =>
  render(
    <MemoryRouter initialEntries={[`/coupon/${id}`]}>
      <Routes>
        <Route path="/coupon/:tokenId" element={<CouponPage />} />
      </Routes>
    </MemoryRouter>,
  )

const openList = () =>
  render(
    <MemoryRouter initialEntries={[`/merchants/${STALL}/vouchers`]}>
      <Routes>
        <Route path="/merchants/:pubkey/vouchers" element={<CouponsPage />} />
      </Routes>
    </MemoryRouter>,
  )

/** The coupon rows' targets, in order. The back link is a link too, and is not a coupon. */
const couponLinks = () =>
  screen
    .getAllByRole('link')
    .map((a) => a.getAttribute('href') ?? '')
    .filter((href) => href.startsWith('/coupon/'))

beforeEach(() => {
  localStorage.clear()
  h.rows = []
})
afterEach(cleanup)

describe('coupon detail (#265)', () => {
  it('a live coupon inside the week: date plus countdown, "Use it before", and no QR (#419)', async () => {
    h.rows = [row('live', 3 * DAY + 3_600_000)]
    openCoupon('live')
    const expires = h.rows[0]!.expires_at!
    await screen.findByText(`${formatDate(expires)} · in 3 days`)
    expect(screen.getByText(`Use it before ${formatDate(expires)}`)).toBeTruthy()
    expect(screen.getByText('active')).toBeTruthy()
    // The code used to render asynchronously (qrcode): give it the chance before saying it did not.
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole('img', { name: /^Redemption code/i })).toBeNull()
  })

  it('beyond the week: the countdown, but no callout', async () => {
    h.rows = [row('far', 30 * DAY + 3_600_000)]
    openCoupon('far')
    await screen.findByText(/· in 30 days$/)
    expect(screen.queryByText(/^Use it before/)).toBeNull()
  })

  it('an expired coupon: "Expired", no QR code, and why', async () => {
    h.rows = [row('gone', -3_600_000)]
    openCoupon('gone')
    const expires = h.rows[0]!.expires_at!
    await screen.findByText(`This voucher expired on ${formatDate(expires)}. It can no longer be spent.`)
    expect(screen.queryByText('active')).toBeNull()
    expect(screen.getByText('Expired')).toBeTruthy()
    expect(screen.getByText(`Expired on ${formatDate(expires)}`)).toBeTruthy()
    // The code renders asynchronously (qrcode), so give it the chance to appear before saying it did not.
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByRole('img', { name: /^Redemption code/i })).toBeNull()
    expect(screen.queryByText(/^Use it before/)).toBeNull()
  })

  it('a coupon already spent another way (swapped back, spent) gets no "Use it before" and keeps its status', async () => {
    // Review of #269: the gate was `isRedeemed`, which only knows 'redeemed', so a swapped-back or
    // spent coupon (reachable from an older bell entry) was told to "use it before" a date, and
    // once past it read "Expired / It can no longer be spent" instead of what happened to it.
    h.rows = [
      row('swapped', 3 * DAY, { status: 'swapped_to_sats' }),
      row('spentOld', -3_600_000, { status: 'spent' }),
    ]
    openCoupon('swapped')
    await screen.findByText('swapped_to_sats')
    expect(screen.queryByText(/^Use it before/)).toBeNull()
    cleanup()
    openCoupon('spentOld')
    await screen.findByText('spent')
    expect(screen.queryByText(/It can no longer be spent\.$/)).toBeNull()
  })

  it('a coupon with no expiry still says so, on the card (#419) and in the list', async () => {
    h.rows = [row('never', undefined)]
    openCoupon('never')
    expect(await screen.findAllByText('No expiry')).toHaveLength(2)
  })
})

describe('coupon list (#265)', () => {
  it('soonest first by default, with badges carrying text, tone and an accessible label', async () => {
    h.rows = [
      row('far', 30 * DAY, { created_at: '2026-10-12T00:00:00Z' }),
      row('week', 5 * DAY + 3_600_000, { created_at: '2026-10-01T00:00:00Z' }),
      row('day', 12 * 3_600_000 + 60_000, { created_at: '2026-10-05T00:00:00Z' }),
    ]
    openList()
    await screen.findAllByRole('link')
    const order = couponLinks()
    expect(order).toEqual(['/coupon/day', '/coupon/week', '/coupon/far'])

    const amber = screen.getByRole('img', { name: /^Expires in 5 days, on / })
    expect(amber.getAttribute('data-expiry-tone')).toBe('soon')
    expect(amber.textContent).toBe('Expires in 5 days')
    const red = screen.getByRole('img', { name: /^Expires in 12 hours, on / })
    expect(red.getAttribute('data-expiry-tone')).toBe('urgent')
    // Beyond the week: no badge at all.
    expect(screen.queryByRole('img', { name: /Expires in 30 days/ })).toBeNull()
  })

  it('"Newest" restores the received-date order, and is remembered', async () => {
    h.rows = [
      row('far', 30 * DAY, { created_at: '2026-10-12T00:00:00Z' }),
      row('week', 5 * DAY, { created_at: '2026-10-01T00:00:00Z' }),
    ]
    openList()
    await screen.findAllByRole('link')
    fireEvent.click(screen.getByRole('button', { name: 'Newest' }))
    await waitFor(() =>
      expect(couponLinks()).toEqual(['/coupon/far', '/coupon/week']),
    )
    expect(localStorage.getItem('imani-wallet:coupon-sort')).toBe('newest')
  })

  it('expired coupons sit in a collapsed "Expired (N)" group, not counted, not silently gone', async () => {
    h.rows = [row('live', 5 * DAY), row('x1', -DAY), row('x2', -2 * DAY)]
    openList()
    await screen.findByText('1 voucher')
    const summary = screen.getByText('Expired (2)')
    const group = summary.closest('details')!
    expect(group.hasAttribute('open')).toBe(false)
    const rows = within(group).getAllByRole('link')
    expect(rows.map((a) => a.getAttribute('href'))).toEqual(['/coupon/x1', '/coupon/x2'])
    expect(within(group).getAllByText(/^Expired /).length).toBeGreaterThanOrEqual(2)
  })

  it('with only expired coupons, the list says why it is empty', async () => {
    h.rows = [row('x1', -DAY)]
    openList()
    await screen.findByText('No vouchers you can still use.')
    expect(screen.getByText('Expired (1)')).toBeTruthy()
  })
})

describe('one voucher held as several rows reads as ONE voucher', () => {
  // A checkout code's change, a Cashlink take-back: one voucher, one row per proof (faceSplit.ts).
  const sixPieces = () =>
    [566, 283, 35, 9, 4, 1].map((face, i) =>
      row(`piece-${i}`, 30 * DAY, { voucher_id: 'v-one', face_value: face, amount: face }),
    )

  it('the list counts it once, shows its whole value, and links to one row', async () => {
    h.rows = sixPieces()
    openList()
    await screen.findByText('1 voucher')
    expect(screen.queryByText('6 vouchers')).toBeNull()
    expect(couponLinks()).toEqual(['/coupon/piece-0'])
    expect(screen.getByText('€8.98')).toBeTruthy()
  })

  it('still lists two different vouchers as two', async () => {
    h.rows = [...sixPieces(), row('other', 30 * DAY)]
    openList()
    await screen.findByText('2 vouchers')
    expect(couponLinks()).toHaveLength(2)
  })

  it('the detail screen shows the whole voucher, opened from any of its rows', async () => {
    h.rows = sixPieces()
    openCoupon('piece-3')
    await waitFor(() => expect(screen.getAllByText('€8.98').length).toBeGreaterThan(0))
  })
})
