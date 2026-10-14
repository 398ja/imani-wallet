/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * Owner report 2026-10-14: a returning device lands on Login (it holds a key), and the banner there
 * said "Create an account". Login says "Log in" (spec 4.4). Onboarding keeps "Create an account".
 */
const fetchClaimSummary = vi.fn()
vi.mock('../../lib/cashback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/cashback')>()),
  fetchClaimSummary: (...args: unknown[]) => fetchClaimSummary(...args),
}))
const ISSUER = 'a'.repeat(64)
const SENDER = 'b'.repeat(64)
vi.mock('../../lib/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/identity')>()),
  useIdentityState: (pubkey: string | undefined) => ({
    identity: pubkey === ISSUER ? { name: "Ana's Bakery" } : pubkey === SENDER ? { name: 'Bob' } : undefined,
    loading: false,
  }),
}))
const readGift = vi.fn()
vi.mock('../../lib/giftLinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/giftLinks')>()),
  readGift: (...a: unknown[]) => readGift(...a),
}))
let stored = true
vi.mock('../../lib/nap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/nap')>()),
  hasStoredKey: async () => stored,
}))

import { ParkedClaimBanner } from '../ParkedClaimBanner'
import { OnboardingPage } from '../../pages/OnboardingPage'
import { stashPendingClaim } from '../../lib/pendingClaim'

const REF = 'abcd1234efgh5678'
const KEY = 'Z'.repeat(43)
const ok = { kind: 'ok', status: 'Unclaimed', amountMinor: 200, unit: 'EUR', decimals: 2, memo: null,
  expiresAt: '2026-10-16T12:00:00Z', claimedAt: null, revokedAt: null, issuerPubkey: ISSUER, mintTrusted: true }

beforeEach(() => {
  localStorage.clear()
  stored = true
  fetchClaimSummary.mockReset().mockResolvedValue(ok)
  readGift.mockReset().mockResolvedValue({ verdict: { kind: 'ok', summary: { issuer: ISSUER, faceMinor: 500, unit: 'EUR', decimals: 2, senderPubkey: SENDER } } })
})
afterEach(cleanup)

describe('banner copy follows the page', () => {
  it('Login (returning device): "Log in to redeem the voucher from {stall}", no "right here"', async () => {
    stashPendingClaim(REF, KEY)
    render(<ParkedClaimBanner mode="unlock" />)
    expect(await screen.findByText("Log in to redeem the voucher from Ana's Bakery")).toBeTruthy()
    const text = screen.getByTestId('claim-banner').textContent ?? ''
    expect(text).not.toMatch(/Create an account/)
    expect(text).toContain('Nothing is claimed until you add it.')
    expect(text).not.toContain('right here')
  })

  it('Login fallback: "Log in to redeem your voucher"', async () => {
    fetchClaimSummary.mockResolvedValue({ kind: 'unreachable' })
    stashPendingClaim(REF, KEY)
    render(<ParkedClaimBanner mode="unlock" />)
    expect(await screen.findByText('Log in to redeem your voucher')).toBeTruthy()
  })

  it('Login gift: "{Sender} sent you a voucher from {stall}. Log in to add it to your wallet."', async () => {
    stashPendingClaim('gift-'+REF, KEY, { kind: 'gift', x: 1 })
    render(<ParkedClaimBanner mode="unlock" />)
    expect(await screen.findByText("Bob sent you a voucher from Ana's Bakery. Log in to add it to your wallet.")).toBeTruthy()
  })

  it('onboarding (fresh device) is unchanged: "Create an account"', async () => {
    stashPendingClaim(REF, KEY)
    render(<ParkedClaimBanner />)
    expect(await screen.findByText("Create an account to redeem the voucher from Ana's Bakery")).toBeTruthy()
  })

  it('onboarding gift is unchanged', async () => {
    stashPendingClaim('gift-'+REF, KEY, { kind: 'gift', x: 1 })
    render(<ParkedClaimBanner />)
    expect(await screen.findByText("Bob sent you a voucher from Ana's Bakery. Create an account to add it to your wallet.")).toBeTruthy()
  })
})

describe('onboarding with a parked claim', () => {
  const page = () => render(
    <MemoryRouter initialEntries={['/onboarding']}><OnboardingPage onUnlock={async () => {}} /></MemoryRouter>,
  )

  it('on a device with a wallet, "I already have an account" comes before Register', async () => {
    stashPendingClaim(REF, KEY)
    page()
    const have = await screen.findByRole('button', { name: 'I already have an account' })
    const register = screen.getByRole('button', { name: 'Register' })
    expect(have.compareDocumentPosition(register) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('on a fresh device, Register stays primary and there is no extra button', async () => {
    stored = false
    stashPendingClaim(REF, KEY)
    page()
    await screen.findByTestId('claim-banner')
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole('button', { name: 'I already have an account' })).toBeNull()
  })
})
