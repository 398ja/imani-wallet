/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/**
 * #295 phase 0 on the Send by link screen: the limit is settled before it is counted, a coupon that
 * cannot go in a Cashlink yet is left out with plain words, and expiry choices that would end
 * within a day of the coupon are shown disabled with the reason.
 */

const COCOA = 'a'.repeat(64)
const ME = 'e'.repeat(64)
const DAY = 86_400_000

const h = vi.hoisted(() => ({
  counts: { waiting: 0, expiredUnreturned: 0 },
  exclude: null as null | string,
  expiresAt: undefined as number | undefined,
  settled: 0,
}))

vi.mock('../../lib/branding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/branding')>()),
  merchantBranding: () =>
    Promise.resolve({ organizationName: 'Shop', nip05: undefined, logoUrl: undefined, bannerUrl: undefined, storeDescription: undefined }),
}))
vi.mock('../../lib/merchant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/merchant')>()),
  merchantStatus: () => Promise.resolve('customer'),
  isMerchantPubkey: () => Promise.resolve(false),
}))
vi.mock('../../lib/giftLink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/giftLink')>()),
  giftExclusion: () => h.exclude,
}))
vi.mock('../../lib/giftLinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/giftLinks')>()),
  settleAndCountLinks: () => {
    h.settled += 1
    return Promise.resolve(h.counts)
  },
}))
vi.mock('../../lib/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wallet')>()),
  listVouchers: () =>
    Promise.resolve([
      {
        token_id: 't1',
        merchant_id: COCOA,
        issuer_id: COCOA,
        token: 'cashuBfake',
        face_value: 1000,
        face_unit: 'EUR',
        face_decimals: 2,
        token_amount: 1000,
        status: 'active',
        created_at: new Date().toISOString(),
        ...(h.expiresAt !== undefined ? { expires_at: h.expiresAt } : {}),
      },
    ]),
}))

import { SendLinkPage } from '../SendLinkPage'
import { GIFT_NOT_YET_COPY } from '../../lib/giftLink'
import { tooManyExpiredMessage } from '../../lib/giftLinks'

afterEach(() => {
  cleanup()
  h.counts = { waiting: 0, expiredUnreturned: 0 }
  h.exclude = null
  h.expiresAt = undefined
  h.settled = 0
})

const draw = () =>
  render(
    <MemoryRouter initialEntries={['/send/link']}>
      <Routes>
        <Route path="/send/link" element={<SendLinkPage pubkey={ME} />} />
      </Routes>
    </MemoryRouter>,
  )

describe('Send by link, #295 phase 0', () => {
  it('settles the links on open, and refuses only on what is left', async () => {
    h.counts = { waiting: 0, expiredUnreturned: 10 }
    draw()
    await waitFor(() => expect(screen.getByText(tooManyExpiredMessage())).toBeTruthy())
    expect(h.settled).toBe(1)
  })

  it('opens normally once expired links have come back', async () => {
    draw()
    await waitFor(() => expect(screen.getByText('How much?')).toBeTruthy())
    expect(h.settled).toBe(1)
  })

  it('leaves out a coupon that cannot go in a Cashlink yet, and says so plainly', async () => {
    h.exclude = 'not_yet'
    draw()
    await waitFor(() => expect(screen.getByText(GIFT_NOT_YET_COPY)).toBeTruthy())
    expect(screen.queryByText('How much?')).toBeNull()
  })

  it('offers every choice for a coupon far from its expiry', async () => {
    h.expiresAt = Date.now() + 100 * DAY
    draw()
    await waitFor(() => expect(screen.getByText('How much?')).toBeTruthy())
    for (const name of ['1 day', '7 days', '30 days']) {
      expect((screen.getByRole('radio', { name }) as HTMLButtonElement).disabled).toBe(false)
    }
    expect(screen.queryByText(/has to end at least a day before/)).toBeNull()
  })

  it('disables the choices that would end within a day of the coupon, and says why', async () => {
    h.expiresAt = Date.now() + 5 * DAY
    draw()
    await waitFor(() => expect(screen.getByText('How much?')).toBeTruthy())
    expect((screen.getByRole('radio', { name: '1 day' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('radio', { name: '7 days' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('radio', { name: '30 days' }) as HTMLButtonElement).disabled).toBe(true)
    // The default (7 days) is not allowed, so the longest allowed choice is the one selected.
    expect(screen.getByRole('radio', { name: '1 day' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(/has to end at least a day before that, so you have time to take it back/)).toBeTruthy()
  })
})
