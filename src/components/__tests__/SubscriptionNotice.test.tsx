/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { VoucherRow } from '@imani/wallet-storage'

/**
 * The banner, rendered.
 *
 * `expiryNotice.ts` decides WHETHER to say something and is tested on its own.
 * What only a rendered component can be wrong about is the ticket's third
 * requirement — "neither blocks, modals over, or interrupts anything in
 * progress" — which is a claim about the DOM, not about a boolean.
 */

const CUSTOMER = 'b'.repeat(64)
const SOLD_AT = 1_800_000_000
const DAY = 86_400
const YEAR = 365 * DAY

let rows: VoucherRow[] = []
let walletListeners: Array<() => void> = []

vi.mock('../../lib/wallet', () => ({
  listVouchers: async () => rows,
  onWalletChanged: (listener: () => void) => {
    walletListeners.push(listener)
    return () => {
      walletListeners = walletListeners.filter((l) => l !== listener)
    }
  },
}))

import type { LicenceTerms } from '../../lib/licenceIssue'

const { SubscriptionNotice } = await import('../SubscriptionNotice')
const { licenceIssueParams } = await import('../../lib/licenceIssue')
const { buildVoucherToken } = await import('../../lib/__tests__/voucherFixtures')
const { forgetLicenceParses } = await import('../../lib/licences')
const { forgetVerification } = await import('../../lib/licenceStatus')

function terms(over: Partial<LicenceTerms> = {}): LicenceTerms {
  return {
    lockKey: CUSTOMER,
    subscriptionId: 'sub_9f2c11',
    paidAmountMinor: 4000,
    paidCurrency: 'GBP',
    ...over,
  }
}

function idFor(token: string): string {
  let hash = 0
  for (let i = 0; i < token.length; i += 1) {
    hash = (Math.imul(hash, 31) + token.charCodeAt(i)) | 0
  }
  return `id-${hash}`
}

function mint(t: LicenceTerms, expiresAt: number) {
  const params = licenceIssueParams(t)
  const built = buildVoucherToken({
    merchantMetadata: params.merchantMetadata,
    faceValue: params.faceValueMinor,
    unit: params.currency,
    expiresAt,
  })
  const row: VoucherRow = {
    token_id: idFor(built.token),
    token: built.token,
    amount: 1782,
    face_value: params.faceValueMinor,
    face_unit: params.currency,
    face_decimals: 2,
    token_amount: 1782,
    issuer_id: built.voucher.issuerPublicKey,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
  return { row, issuerPublicKey: built.voucher.issuerPublicKey }
}

function renderNotice() {
  return render(
    <MemoryRouter>
      {/* A sibling that must stay reachable: the banner is not allowed to
          cover, disable or intercept anything on the page it joins. */}
      <button type="button">Sell</button>
      <SubscriptionNotice pubkey={CUSTOMER} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  rows = []
  walletListeners = []
  forgetLicenceParses()
  forgetVerification(CUSTOMER)
})

afterEach(() => {
  cleanup()
  forgetVerification(CUSTOMER)
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('the expiry banner', () => {
  it('is absent when there is nothing to say', async () => {
    const expiresAt = SOLD_AT + YEAR
    const { row, issuerPublicKey } = mint(terms(), expiresAt)
    rows = [row]
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', issuerPublicKey)
    vi.setSystemTime((expiresAt - 30 * DAY) * 1000)

    renderNotice()

    // Nothing at all — not an empty container, not a hidden node.
    await waitFor(() => expect(screen.getByText('Sell')).toBeTruthy())
    expect(screen.queryByText(/subscription ends/i)).toBeNull()
  })

  it('names the days remaining once inside the window', async () => {
    const expiresAt = SOLD_AT + YEAR
    const { row, issuerPublicKey } = mint(terms(), expiresAt)
    rows = [row]
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', issuerPublicKey)
    vi.setSystemTime((expiresAt - 5 * DAY) * 1000)

    renderNotice()

    expect(await screen.findByText(/ends in 5 days/)).toBeTruthy()
  })

  it('does not block, cover or disable what is already on the page', async () => {
    const expiresAt = SOLD_AT + YEAR
    const { row, issuerPublicKey } = mint(terms(), expiresAt)
    rows = [row]
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', issuerPublicKey)
    vi.setSystemTime((expiresAt - 2 * DAY) * 1000)

    renderNotice()
    const banner = await screen.findByText(/ends in 2 days/)

    // The Sell button is still there and still enabled: a merchant mid-sale
    // must never lose a press to a billing message.
    const sell = screen.getByText('Sell') as HTMLButtonElement
    expect(sell.disabled).toBe(false)

    // Structural, not cosmetic. A dialog, a portal or a fixed overlay are the
    // three ways this could interrupt trade, and none of them is present.
    const strip = banner.closest('a')!
    expect(strip.getAttribute('role')).not.toBe('dialog')
    expect(strip.getAttribute('aria-modal')).toBeNull()
    // Rendered in the normal flow, as a sibling — not lifted out to body.
    expect(strip.closest('body > div')).toBeTruthy()
    for (const el of [strip, ...Array.from(strip.querySelectorAll('*'))]) {
      const cls = (el as HTMLElement).className
      const s = typeof cls === 'string' ? cls : ''
      expect(s).not.toMatch(/\bfixed\b|\babsolute\b|\bz-\d/)
    }
  })

  it('offers no way to dismiss it', async () => {
    // Dismissing would hide the one warning before a lapse, and the person who
    // dismisses on day seven is the one who needs it on day one.
    const expiresAt = SOLD_AT + YEAR
    const { row, issuerPublicKey } = mint(terms(), expiresAt)
    rows = [row]
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', issuerPublicKey)
    vi.setSystemTime((expiresAt - 3 * DAY) * 1000)

    renderNotice()
    await screen.findByText(/ends in 3 days/)

    expect(screen.queryByLabelText(/dismiss|close/i)).toBeNull()
    // The only button on the page is the one that was there before.
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('disappears when a renewal arrives, without a reload', async () => {
    const expiresAt = SOLD_AT + YEAR
    const original = mint(terms(), expiresAt)
    rows = [original.row]
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', original.issuerPublicKey)
    vi.setSystemTime((expiresAt - 2 * DAY) * 1000)

    renderNotice()
    await screen.findByText(/ends in 2 days/)

    forgetLicenceParses()
    const renewal = mint(terms(), expiresAt + YEAR)
    rows = [original.row, renewal.row]
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', renewal.issuerPublicKey)
    walletListeners.forEach((l) => l())

    await waitFor(() => expect(screen.queryByText(/ends in 2 days/)).toBeNull())
  })

  it('says nothing at all once the subscription has lapsed', async () => {
    const expiresAt = SOLD_AT + YEAR
    const { row, issuerPublicKey } = mint(terms(), expiresAt)
    rows = [row]
    vi.stubEnv('VITE_LICENCE_ISSUER_PUBKEY', issuerPublicKey)
    vi.setSystemTime((expiresAt + DAY) * 1000)

    renderNotice()

    await waitFor(() => expect(screen.getByText('Sell')).toBeTruthy())
    expect(screen.queryByText(/subscription ends/i)).toBeNull()
  })
})
