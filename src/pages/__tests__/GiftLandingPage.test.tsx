/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/**
 * Claim links phase 4: the gift prompt at `/g` (docs/spec-claim-links.md 3.3 claim, 4.3, 5.3, 5.4).
 *
 * - The fragment is scrubbed in the first render, before any await, parked or not.
 * - Without a session the gift is parked (kind `gift`, keyed by the link's PUBLIC key) and the
 *   visitor goes to Login or onboarding. Nothing is fetched.
 * - With a session nothing is spent until **Add**, and a second tap is one spend.
 * - Every refusal state in 4.3 for a gift, and no link secret in any log line or request URL.
 */

const readGift = vi.fn()
const redeemGiftTokens = vi.fn()
vi.mock('../../lib/giftLinks', async (orig) => ({
  ...(await orig<typeof import('../../lib/giftLinks')>()),
  readGift: (...a: unknown[]) => readGift(...a),
  redeemGiftTokens: (...a: unknown[]) => redeemGiftTokens(...a),
}))
const storedKey = { value: false }
vi.mock('../../lib/nap', () => ({ hasStoredKey: async () => storedKey.value }))
vi.mock('../../lib/terminalEnrol', () => ({ isTerminalDevice: () => false }))
vi.mock('../../lib/identity', async (orig) => ({
  ...(await orig<typeof import('../../lib/identity')>()),
  useIdentityState: (pubkey: string | undefined) => ({
    identity: pubkey === ISSUER ? { name: "Ana's Bakery" } : pubkey === SENDER ? { name: 'Bob' } : undefined,
    loading: false,
  }),
}))

import { GiftLandingPage } from '../GiftLandingPage'
import { ResumeParkedClaim } from '../ClaimLandingPage'
import { deriveLinkSecret, linkPubOf, secretToText } from '../../lib/giftLink'
import { listPendingClaims, resetPendingClaimOffers } from '../../lib/pendingClaim'
import { hexToBytes } from '@noble/hashes/utils'

const SECRET = deriveLinkSecret(hexToBytes('44'.repeat(32)), 3)
const K = secretToText(SECRET)
const LINK_PUB = linkPubOf(SECRET)
const X = Math.floor(Date.UTC(2026, 9, 20) / 1000)
const ISSUER = 'a'.repeat(64)
const SENDER = 'b'.repeat(64)
const ME = 'c'.repeat(64)
const TOKENS = [{ token: 'cashuBgift', sentAt: 1 }]
const SUMMARY = { issuer: ISSUER, faceMinor: 500, unit: 'EUR', decimals: 2, senderPubkey: SENDER }

function open(authed: boolean, hash = `#v=1&k=${K}&x=${X}`) {
  window.history.replaceState(null, '', '/g' + hash)
  return render(
    <MemoryRouter initialEntries={['/g']}>
      <Routes>
        <Route path="/g" element={<GiftLandingPage authed={authed} pubkey={authed ? ME : undefined} />} />
        <Route path="/" element={<p>HOME</p>} />
        <Route path="/login" element={<p>LOGIN</p>} />
        <Route path="/onboarding" element={<p>ONBOARDING</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

const logged: string[] = []
const requested: string[] = []

beforeEach(() => {
  localStorage.clear()
  resetPendingClaimOffers()
  storedKey.value = false
  readGift.mockReset().mockResolvedValue({ verdict: { kind: 'ok', summary: SUMMARY, tokens: TOKENS }, tokens: TOKENS })
  redeemGiftTokens.mockReset().mockResolvedValue({ kind: 'ok' })
  logged.length = 0
  requested.length = 0
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')))
  }
  vi.stubGlobal('fetch', vi.fn(async (u: unknown) => {
    requested.push(String(u))
    return new Response('{}')
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('opening a gift link', () => {
  it('scrubs the fragment in the first render, before any await', () => {
    readGift.mockReturnValue(new Promise(() => {}))
    open(true)
    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain(K)
  })

  it('never spends on open, however long it waits', async () => {
    open(true)
    await screen.findByRole('button', { name: 'Add to my wallet' })
    await settle()
    expect(redeemGiftTokens).not.toHaveBeenCalled()
  })

  it('shows the token-verified summary: stall, face, sender, claim-by (spec 4.3)', async () => {
    open(true)
    await screen.findByTestId('gift-prompt')
    const text = screen.getByTestId('gift-prompt').textContent ?? ''
    expect(text).toContain("Ana's Bakery")
    expect(text).toContain('✓ verified stall')
    expect(text).toMatch(/5[.,]00/)
    expect(text).toContain('Sent by Bob via link')
    expect(text).toContain('Claim by')
  })

  it('Add redeems only the coupons verifyGift passed, never everything found at the link (review of #247, F1)', async () => {
    const junk = { token: 'cashuBjunk-wrapped-by-someone-else', sentAt: 0 }
    readGift.mockResolvedValue({ verdict: { kind: 'ok', summary: SUMMARY, tokens: TOKENS }, tokens: [...TOKENS, junk] })
    open(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Add to my wallet' }))
    await settle()
    expect(redeemGiftTokens).toHaveBeenCalledWith(TOKENS, 'gift_link')
  })

  it('spends once on Add, however many taps, with source gift_link', async () => {
    let finish!: (v: unknown) => void
    redeemGiftTokens.mockReturnValue(new Promise((r) => (finish = r)))
    open(true)
    const add = await screen.findByRole('button', { name: 'Add to my wallet' })
    // Both taps land before React re-renders, as a fast double tap on a phone does.
    act(() => {
      add.click()
      add.click()
    })
    finish({ kind: 'ok' })
    await screen.findByText('Voucher added')
    expect(redeemGiftTokens).toHaveBeenCalledTimes(1)
    expect(redeemGiftTokens).toHaveBeenCalledWith(TOKENS, 'gift_link')
  })

  // Third check of #247 (5798be4): `failed` can now come back after a genuine coupon WAS added (a
  // refused decoy beside it). The page must keep the claim parked and offer Retry, and a retry reads
  // the link again (the added coupon reads spent there) and redeems only what verifyGift returns.
  it('a failed Add keeps the gift parked and offers Retry, which reads the link again', async () => {
    redeemGiftTokens.mockResolvedValueOnce({ kind: 'failed', message: 'mint: could not verify proofs (10003)' })
    open(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Add to my wallet' }))
    await screen.findByText('Voucher waiting')
    expect(listPendingClaims()).toEqual([expect.objectContaining({ kind: 'gift', ref: LINK_PUB, key: K, x: X })])
    expect(readGift).toHaveBeenCalledTimes(1)
    readGift.mockResolvedValueOnce({ verdict: { kind: 'claimed' }, tokens: TOKENS })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText(/already added to a wallet/)
    expect(readGift).toHaveBeenCalledTimes(2)
    expect(redeemGiftTokens).toHaveBeenCalledTimes(1)
  })

  it('Decline spends nothing and forgets it on this device', async () => {
    open(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }))
    await screen.findByText('HOME')
    expect(redeemGiftTokens).not.toHaveBeenCalled()
  })
})

describe('the refusal states (spec 4.3)', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['already claimed', { kind: 'claimed' }, /already added to a wallet/],
    ['expired', { kind: 'expired', at: X, summary: SUMMARY }, /expired on .*Ask Bob to send it again/],
    ['not money', { kind: 'not_money' }, /does not contain a voucher/],
    ['untrusted mint', { kind: 'untrusted_mint' }, /mint this wallet does not use/],
    ['network', { kind: 'unreachable' }, /could not reach the voucher service.*still waiting/],
  ]
  for (const [name, verdict, copy] of cases) {
    it(`${name}: says so, offers no Add, spends nothing`, async () => {
      readGift.mockResolvedValue({ verdict, tokens: TOKENS })
      open(true)
      await screen.findByText(copy)
      expect(screen.queryByRole('button', { name: 'Add to my wallet' })).toBeNull()
      expect(redeemGiftTokens).not.toHaveBeenCalled()
    })
  }

  it('a broken link is incomplete, parks nothing and fetches nothing', async () => {
    open(true, `#v=1&k=${K.slice(2)}&x=${X}`)
    await screen.findByText(/This link is incomplete/)
    expect(readGift).not.toHaveBeenCalled()
    expect(listPendingClaims()).toEqual([])
  })
})

describe('with no session (journey C)', () => {
  it('parks the gift under its PUBLIC key and goes to onboarding, fetching nothing', async () => {
    open(false)
    await screen.findByText('ONBOARDING')
    expect(readGift).not.toHaveBeenCalled()
    expect(listPendingClaims()).toEqual([expect.objectContaining({ kind: 'gift', ref: LINK_PUB, key: K, x: X })])
  })

  it('a device with a stored key goes to Login', async () => {
    storedKey.value = true
    open(false)
    await screen.findByText('LOGIN')
  })

  it('`/` resumes a parked gift on /g, and the prompt reads it from the store', async () => {
    open(false)
    await screen.findByText('ONBOARDING')
    cleanup()
    window.history.replaceState(null, '', '/')
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<ResumeParkedClaim pubkey={ME}><p>HOME</p></ResumeParkedClaim>} />
          <Route path="/g" element={<GiftLandingPage authed pubkey={ME} />} />
          <Route path="/c" element={<p>CASHBACK</p>} />
        </Routes>
      </MemoryRouter>,
    )
    await screen.findByRole('button', { name: 'Add to my wallet' })
    expect(readGift).toHaveBeenCalledWith(K, X)
  })
})

describe('fragment hygiene (spec 2.4, 7)', () => {
  it('the secret never reaches a log line or a request URL on any path', async () => {
    open(false)
    await screen.findByText('ONBOARDING')
    cleanup()
    open(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Add to my wallet' }))
    await screen.findByText('Voucher added')
    expect(logged.filter((l) => l.includes(K))).toEqual([])
    expect(requested.filter((u) => u.includes(K))).toEqual([])
  })
})
