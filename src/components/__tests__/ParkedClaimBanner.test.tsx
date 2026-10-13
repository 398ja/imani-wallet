/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * Claim links phase 3 (spec 4.4, 5.2): the voucher banner on onboarding's start step and on Login.
 */
const fetchClaimSummary = vi.fn()
vi.mock('../../lib/cashback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/cashback')>()),
  fetchClaimSummary: (...args: unknown[]) => fetchClaimSummary(...args),
}))
const ISSUER = 'a'.repeat(64)
vi.mock('../../lib/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/identity')>()),
  useIdentityState: (pubkey: string | undefined) => ({
    identity: pubkey === ISSUER ? { name: "Ana's Bakery" } : undefined,
    loading: false,
  }),
}))
vi.mock('../../lib/nap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/nap')>()),
  hasStoredKey: async () => true,
  keyStore: { load: vi.fn(async () => null), list: vi.fn(async () => []) },
}))

import { ParkedClaimBanner } from '../ParkedClaimBanner'
import { OnboardingPage } from '../../pages/OnboardingPage'
import { stashPendingClaim, peekPendingClaim } from '../../lib/pendingClaim'

const REF = 'abcd1234efgh5678'
const KEY = 'Z'.repeat(43)

function ok(over: Record<string, unknown> = {}) {
  return {
    kind: 'ok', status: 'Unclaimed', amountMinor: 200, unit: 'EUR', decimals: 2, memo: null,
    expiresAt: '2026-10-16T12:00:00Z', claimedAt: null, revokedAt: null, issuerPubkey: ISSUER, mintTrusted: true,
    ...over,
  }
}

beforeEach(() => {
  localStorage.clear()
  fetchClaimSummary.mockReset().mockResolvedValue(ok())
})
afterEach(cleanup)

describe('the parked-claim banner', () => {
  it('names the stall, the face and the claim-by date, in the spec words', async () => {
    stashPendingClaim(REF, KEY)
    render(<ParkedClaimBanner />)
    expect(await screen.findByText("Create an account to redeem the voucher from Ana's Bakery")).toBeTruthy()
    const banner = screen.getByTestId('claim-banner').textContent ?? ''
    expect(banner).toMatch(/2\.00/)
    expect(banner).toMatch(/Claim by (16 Oct|Oct 16)/)
    expect(banner).toContain('Nothing is claimed until you add it. You can do that in a minute, right here.')
  })

  it('asks the portal by ref only, never sending or showing the key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m))
    stashPendingClaim(REF, KEY)
    const { container } = render(<ParkedClaimBanner />)
    await screen.findByText(/Ana's Bakery/)
    expect(fetchClaimSummary).toHaveBeenCalledWith(REF)
    expect(JSON.stringify(fetchClaimSummary.mock.calls)).not.toContain(KEY)
    expect(container.innerHTML).not.toContain(KEY)
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY)
    expect(JSON.stringify(fetchSpy.mock.calls)).not.toContain(KEY)
  })

  it('falls back when the summary cannot be fetched, and never blocks', async () => {
    fetchClaimSummary.mockResolvedValue({ kind: 'unreachable' })
    stashPendingClaim(REF, KEY)
    render(<ParkedClaimBanner />)
    expect(await screen.findByText('Create an account to redeem your voucher')).toBeTruthy()
  })

  it('does not consume the parked claim', async () => {
    stashPendingClaim(REF, KEY)
    render(<ParkedClaimBanner />)
    await screen.findByText(/Ana's Bakery/)
    expect(peekPendingClaim()?.ref).toBe(REF)
  })

  it('is absent with nothing parked', () => {
    const { container } = render(<ParkedClaimBanner />)
    expect(container.textContent).toBe('')
    expect(fetchClaimSummary).not.toHaveBeenCalled()
  })

  it('says to open the link again once the parked claim has aged out (spec 5.2)', () => {
    localStorage.setItem('imani-wallet:pending-claim', JSON.stringify([{ kind: 'cashback', ref: REF, key: KEY, at: 0 }]))
    render(<ParkedClaimBanner />)
    expect(screen.getByText('Open your voucher link again to add it.')).toBeTruthy()
  })

  it('sits above Register on onboarding, Register still primary', async () => {
    stashPendingClaim(REF, KEY)
    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingPage onUnlock={async () => {}} />
      </MemoryRouter>,
    )
    const banner = await screen.findByTestId('claim-banner')
    const register = screen.getByRole('button', { name: 'Register' })
    expect(banner.compareDocumentPosition(register) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

/** Review of #245, F1: an aged-out claim is said once, then erased (its key with it). */
describe('an aged-out parked claim', () => {
  const STALE = JSON.stringify([{ kind: 'cashback', ref: REF, key: KEY, at: 0 }])

  it('is erased from storage once the banner has said so', () => {
    localStorage.setItem('imani-wallet:pending-claim', STALE)
    render(<ParkedClaimBanner />)
    expect(screen.getByText('Open your voucher link again to add it.')).toBeTruthy()
    expect(localStorage.getItem('imani-wallet:pending-claim')).toBeNull()
  })

  it('is said once, not on every later visit', () => {
    localStorage.setItem('imani-wallet:pending-claim', STALE)
    render(<ParkedClaimBanner />)
    cleanup()
    const { container } = render(<ParkedClaimBanner />)
    expect(container.textContent).toBe('')
  })

  it('erasing it leaves a live claim alone', async () => {
    localStorage.setItem('imani-wallet:pending-claim', JSON.stringify([
      { kind: 'cashback', ref: 'oldoldoldoldold1', key: KEY, at: 0 },
      { kind: 'cashback', ref: REF, key: KEY, at: Date.now() },
    ]))
    render(<ParkedClaimBanner />)
    await screen.findByText("Create an account to redeem the voucher from Ana's Bakery")
    const left = JSON.parse(localStorage.getItem('imani-wallet:pending-claim') ?? '[]') as { ref: string }[]
    expect(left.map((e) => e.ref)).toEqual([REF])
  })
})
