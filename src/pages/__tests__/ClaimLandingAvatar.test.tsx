/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/**
 * The Cashlink confirm prompt names the issuing stall with its face as well as its name: the
 * picture from the same kind-0 lookup that already names it, initials when there is none or it
 * fails to load, and a placeholder of the same size while it resolves. None of it gates Add.
 */

const redeemClaimRef = vi.fn()
const fetchClaimSummary = vi.fn()

vi.mock('../../lib/cashback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/cashback')>()),
  redeemClaimRef: (...args: unknown[]) => redeemClaimRef(...args),
  fetchClaimSummary: (...args: unknown[]) => fetchClaimSummary(...args),
}))
vi.mock('../../lib/nap', () => ({ hasStoredKey: async () => true }))
vi.mock('../../lib/terminalEnrol', () => ({ isTerminalDevice: () => false }))
vi.mock('../../lib/merchantVouchers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/merchantVouchers')>()),
  accountRole: async () => 'customer',
}))
vi.mock('../../lib/verificationReader', () => ({
  badgeWindows: async () => [],
  VERIFICATION_CHANGED_EVENT: 'imani:verification-changed',
}))
const identity = vi.hoisted(() => ({
  value: { identity: undefined as { name?: string; picture?: string } | undefined, loading: false },
  calls: 0,
}))
vi.mock('../../lib/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/identity')>()),
  useIdentityState: (pubkey: string | undefined) => {
    if (pubkey) identity.calls++
    return pubkey ? identity.value : { identity: undefined, loading: false }
  },
}))

import { ClaimLandingPage } from '../ClaimLandingPage'

const REF = 'abcd1234efgh5678'
const KEY = 'Q'.repeat(43)
const ISSUER = 'a'.repeat(64)
const PICTURE = 'https://example.com/ngozi.png'

function open() {
  window.history.replaceState(null, '', `/c/${REF}#k=${KEY}`)
  return render(
    <MemoryRouter initialEntries={[`/c/${REF}`]}>
      <Routes>
        <Route path="/c/:ref" element={<ClaimLandingPage authed pubkey={'c'.repeat(64)} />} />
        <Route path="/" element={<p>HOME</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  identity.value = { identity: { name: 'Mama Ngozi Grill', picture: PICTURE }, loading: false }
  identity.calls = 0
  redeemClaimRef.mockReset().mockResolvedValue({ kind: 'ok', amountMinor: 500, unit: 'EUR', memo: null })
  fetchClaimSummary.mockReset().mockResolvedValue({
    kind: 'ok', status: 'Unclaimed', amountMinor: 500, unit: 'EUR', decimals: 2, memo: null,
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    claimedAt: null, revokedAt: null, issuerPubkey: ISSUER, mintTrusted: true,
  })
})
afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})

describe('Cashlink confirm prompt: the stall avatar', () => {
  it('shows the stall picture with its name as alt text, and the name', async () => {
    open()
    await screen.findByRole('button', { name: 'Add to my wallet' })
    const merchant = screen.getByTestId('claim-merchant')
    const img = within(merchant).getByRole('img', { name: 'Mama Ngozi Grill' })
    expect(img.getAttribute('src')).toBe(PICTURE)
    expect(merchant.textContent).toContain('Mama Ngozi Grill')
  })

  it('falls back to initials when the stall published no picture', async () => {
    identity.value = { identity: { name: 'Mama Ngozi Grill' }, loading: false }
    open()
    await screen.findByRole('button', { name: 'Add to my wallet' })
    const merchant = screen.getByTestId('claim-merchant')
    expect(within(merchant).queryByRole('img')).toBeNull()
    expect(merchant.textContent).toContain('MN')
    expect(merchant.textContent).toContain('Mama Ngozi Grill')
  })

  it('falls back to initials when the picture fails to load', async () => {
    open()
    await screen.findByRole('button', { name: 'Add to my wallet' })
    const merchant = screen.getByTestId('claim-merchant')
    fireEvent.error(within(merchant).getByRole('img'))
    expect(within(merchant).queryByRole('img')).toBeNull()
    expect(merchant.textContent).toContain('MN')
    expect(merchant.textContent).toContain('Mama Ngozi Grill')
  })

  it('a slow profile shows a placeholder and never blocks Add', async () => {
    identity.value = { identity: undefined, loading: true }
    open()
    const add = await screen.findByRole('button', { name: 'Add to my wallet' })
    expect((add as HTMLButtonElement).disabled).toBe(false)
    expect(within(screen.getByTestId('claim-merchant')).queryByRole('img')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Checking who issued')
  })

  it('Add still redeems exactly once with the avatar on screen', async () => {
    open()
    const add = await screen.findByRole('button', { name: 'Add to my wallet' })
    fireEvent.click(add)
    fireEvent.click(add)
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
    expect(redeemClaimRef).toHaveBeenCalledTimes(1)
    expect(redeemClaimRef).toHaveBeenCalledWith(REF, KEY)
    expect(await screen.findByText('Voucher added')).toBeTruthy()
  })
})
