/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

/**
 * Claim links, phase 1: the confirm prompt (docs/spec-claim-links.md, section 4.3 and phase 1).
 * This is the security fix: opening a claim link must NEVER redeem it.
 *
 * Before this, `/c/:ref` with a session called `redeemClaimRef` on load, so anything that rendered
 * the link in a logged-in browser (a prefetch, a link preview, a tab restore, a mis-tap) spent the
 * voucher. Now the page reads the public metadata (non-destructive), shows who issued it, its face
 * value and expiry, checks the issuer and the mint against the trusted allow-lists, and redeems
 * only on Accept, exactly once. Decline leaves the voucher unclaimed.
 *
 * The claim key is read from the fragment, held in memory, scrubbed from the address bar with
 * history.replaceState before the first await, and never sent anywhere: not in a URL query, not in
 * a log line, not in a request.
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
// Identity resolution reads the relay and the gateway; the prompt only needs a name.
const identityLoading = { value: false }
vi.mock('../../lib/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/identity')>()),
  useIdentityState: (pubkey: string | undefined) =>
    identityLoading.value
      ? { identity: undefined, loading: true }
      : { identity: pubkey === ISSUER ? { name: 'Mama Ngozi Grill' } : {}, loading: false },
}))

import { ClaimLandingPage, ResumeParkedClaim } from '../ClaimLandingPage'
import { peekPendingClaim, resetPendingClaimOffers, stashPendingClaim } from '../../lib/pendingClaim'

const REF = 'abcd1234efgh5678'
const KEY = 'Q'.repeat(43)
const ISSUER = 'a'.repeat(64)
const CUSTOMER = 'c'.repeat(64)
const OTHER_CUSTOMER = 'd'.repeat(64)

function summary(over: Record<string, unknown> = {}) {
  return {
    kind: 'ok',
    status: 'Unclaimed',
    amountMinor: 500,
    unit: 'EUR',
    decimals: 2,
    memo: null,
    expiresAt: '2026-11-10T12:00:00Z',
    claimedAt: null,
    revokedAt: null,
    issuerPubkey: ISSUER,
    mintTrusted: true,
    ...over,
  }
}

function open(pubkey = CUSTOMER, path = `/c/${REF}`, hash = `#k=${KEY}`) {
  window.history.replaceState(null, '', path + hash)
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/c/:ref" element={<ClaimLandingPage authed pubkey={pubkey} />} />
        <Route path="/c" element={<ClaimLandingPage authed pubkey={pubkey} />} />
        <Route path="/" element={<p>HOME</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

/** Let every pending promise and effect settle. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  identityLoading.value = false
  localStorage.clear()
  resetPendingClaimOffers()
  redeemClaimRef.mockReset().mockResolvedValue({ kind: 'ok', amountMinor: 500, unit: 'EUR', memo: null })
  fetchClaimSummary.mockReset().mockResolvedValue(summary())
})
afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})

describe('opening a claim link never redeems', () => {
  it('shows the prompt and does not redeem on load, however long it waits', async () => {
    open()
    await settle()
    await screen.findByRole('button', { name: 'Add to my wallet' })

    expect(redeemClaimRef).not.toHaveBeenCalled()
    // Re-rendering (StrictMode, a tab restore) is still not a spend.
    await settle()
    expect(redeemClaimRef).not.toHaveBeenCalled()
  })

  it('a resumed claim (parked before login) also waits for Accept', async () => {
    stashPendingClaim(REF, KEY)
    open(CUSTOMER, '/c', '')
    await screen.findByRole('button', { name: 'Add to my wallet' })

    expect(redeemClaimRef).not.toHaveBeenCalled()
    expect(fetchClaimSummary).toHaveBeenCalledWith(REF)
  })

  it('shows the stall name resolved from the issuer, the face value and the expiry', async () => {
    open()
    await screen.findByRole('button', { name: 'Add to my wallet' })

    const body = document.body.textContent ?? ''
    expect(body).toContain('Mama Ngozi Grill')
    expect(body).toMatch(/€5\.00|5\.00\s*EUR|EUR\s*5\.00/)
    expect(body).toMatch(/Claim by .*2026/)
  })

  it('reads only the non-destructive metadata before Accept', async () => {
    open()
    await screen.findByRole('button', { name: 'Add to my wallet' })
    expect(fetchClaimSummary).toHaveBeenCalledTimes(1)
    expect(fetchClaimSummary).toHaveBeenCalledWith(REF)
    expect(redeemClaimRef).not.toHaveBeenCalled()
  })
})

describe('Accept and Decline', () => {
  it('Accept redeems exactly once, however often it is tapped', async () => {
    let finish: (v: unknown) => void = () => {}
    redeemClaimRef.mockReturnValue(new Promise((ok) => (finish = ok)))
    open()
    const accept = await screen.findByRole('button', { name: 'Add to my wallet' })

    fireEvent.click(accept)
    fireEvent.click(accept)
    fireEvent.click(accept)
    await act(async () => finish({ kind: 'ok', amountMinor: 500, unit: 'EUR', memo: null }))

    expect(redeemClaimRef).toHaveBeenCalledTimes(1)
    expect(redeemClaimRef).toHaveBeenCalledWith(REF, KEY)
    expect(await screen.findByText('Voucher added')).toBeTruthy()
    // Spent: nothing is left parked to resume.
    expect(peekPendingClaim()).toBeNull()
  })

  it('two taps in the same task, before React re-renders, still redeem once (the ref guard, not the re-render)', async () => {
    redeemClaimRef.mockReturnValue(new Promise(() => {}))
    open()
    const accept = await screen.findByRole('button', { name: 'Add to my wallet' })
    // Native clicks outside act(): React has not yet swapped the button for "Adding…" when the
    // second lands. Review of phase 1: `fireEvent` alone could not see the guard go missing.
    accept.click()
    accept.click()
    await settle()
    expect(redeemClaimRef).toHaveBeenCalledTimes(1)
  })

  it('Decline does not redeem, forgets the parked claim, and goes home', async () => {
    stashPendingClaim(REF, KEY)
    open()
    await screen.findByRole('button', { name: 'Add to my wallet' })

    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(await screen.findByText('HOME')).toBeTruthy()

    expect(redeemClaimRef).not.toHaveBeenCalled()
    // On this device only: the voucher itself is untouched at the server.
    expect(peekPendingClaim()).toBeNull()
  })
})

describe('closed links show their state and offer no Accept', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['already claimed', { status: 'Claimed', claimedAt: '2026-10-11T10:00:00Z' }, /already added to a wallet/i],
    ['expired', { status: 'Expired' }, /expired/i],
    ['revoked', { status: 'Revoked', revokedAt: '2026-10-11T10:00:00Z' }, /cancelled this voucher/i],
  ]
  for (const [name, over, copy] of cases) {
    it(`${name}`, async () => {
      fetchClaimSummary.mockResolvedValue(summary(over))
      open()
      await settle()
      await screen.findByText(copy)

      expect(screen.queryByRole('button', { name: 'Add to my wallet' })).toBeNull()
      expect(redeemClaimRef).not.toHaveBeenCalled()
    })
  }

  it('an unclaimed record past its expiry reads expired', async () => {
    fetchClaimSummary.mockResolvedValue(summary({ expiresAt: '2020-01-01T00:00:00Z' }))
    open()
    await screen.findByText(/expired/i)
    expect(screen.queryByRole('button', { name: 'Add to my wallet' })).toBeNull()
  })

  it('a link with no key is incomplete, and nothing is fetched', async () => {
    open(CUSTOMER, `/c/${REF}`, '')
    await screen.findByText(/incomplete/i)
    expect(fetchClaimSummary).not.toHaveBeenCalled()
    expect(redeemClaimRef).not.toHaveBeenCalled()
  })

  it('an unknown ref says so, with nothing to accept', async () => {
    fetchClaimSummary.mockResolvedValue({ kind: 'not_found' })
    open()
    await screen.findByText(/could not find this voucher/i)
    expect(screen.queryByRole('button', { name: 'Add to my wallet' })).toBeNull()
  })

  it('an unreachable service says the voucher is still waiting, and offers Retry', async () => {
    fetchClaimSummary.mockResolvedValueOnce({ kind: 'unreachable' })
    open()
    await screen.findByText(/still waiting/i)
    expect(redeemClaimRef).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: 'Add to my wallet' })).toBeTruthy()
  })
})

describe('who the prompt is for', () => {
  it('a different logged-in account sees the prompt for itself', async () => {
    // The link was meant for someone else; whoever opens it is offered it, as their own account.
    open(OTHER_CUSTOMER)
    await screen.findByRole('button', { name: 'Add to my wallet' })
    expect(document.body.textContent).toMatch(/Adding to your wallet/)
    expect(redeemClaimRef).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Add to my wallet' }))
    await screen.findByText('Voucher added')
    expect(redeemClaimRef).toHaveBeenCalledWith(REF, KEY)
  })

  it('a merchant opening its OWN cashback link is refused, and nothing is redeemed', async () => {
    open(ISSUER)
    await screen.findByText(/your stall's own cashback/i)

    expect(screen.queryByRole('button', { name: 'Add to my wallet' })).toBeNull()
    expect(redeemClaimRef).not.toHaveBeenCalled()
  })
})

describe('issuer and mint verification', () => {
  // Before the tap the ciphertext cannot be read without spending the claim, so the prompt checks
  // what it can (spec 4.3): the metadata came from this deployment's portal, the issuer is a
  // well-formed key that resolves to a published stall, and this wallet trusts a mint. The voucher's
  // own signature (against VITE_VOUCHER_ISSUER_PUBKEYS, the gateway's signing key) and its mint
  // (against the trusted-mint list) are checked on Accept, by the existing redeem.
  it('an issuer that resolves to a published stall reads verified', async () => {
    open()
    await screen.findByRole('button', { name: 'Add to my wallet' })
    expect(document.body.textContent).toMatch(/verified stall/i)
  })

  it('while the stall is still resolving it says so, and flashes no unverified warning', async () => {
    identityLoading.value = true
    open()
    await screen.findByRole('button', { name: 'Add to my wallet' })
    expect(document.body.textContent).toMatch(/Checking who issued this voucher/)
    expect(document.body.textContent).not.toMatch(/could not verify/i)
    expect(document.body.textContent).not.toMatch(/Unknown stall/)
  })

  it('an issuer that resolves to no stall reads Unknown stall and unverified', async () => {
    const stranger = 'e'.repeat(64)
    fetchClaimSummary.mockResolvedValue(summary({ issuerPubkey: stranger }))
    open()
    await screen.findByText(/could not verify this voucher/i)
    expect(document.body.textContent).toMatch(/Unknown stall/)
    expect(document.body.textContent).not.toMatch(/verified stall/i)
    // Labelled, not refused: the voucher's own checks still run on Accept.
    const add = screen.getByRole('button', { name: 'Add to my wallet' }) as HTMLButtonElement
    expect(add.disabled).toBe(false)
  })

  it('a malformed issuer key in the metadata disables Add', async () => {
    fetchClaimSummary.mockResolvedValue(summary({ issuerPubkey: 'not-a-key' }))
    open()
    await screen.findByText(/could not verify this voucher/i)
    const add = screen.getByRole('button', { name: 'Add to my wallet' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    fireEvent.click(add)
    expect(redeemClaimRef).not.toHaveBeenCalled()
  })

  it('a wallet with no trusted mint cannot claim, and Add is disabled', async () => {
    fetchClaimSummary.mockResolvedValue(summary({ mintTrusted: false }))
    open()
    await screen.findByText(/no trusted mint/i)
    const add = screen.getByRole('button', { name: 'Add to my wallet' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    fireEvent.click(add)
    expect(redeemClaimRef).not.toHaveBeenCalled()
  })

  it('a deployment that cannot claim vouchers says so', async () => {
    fetchClaimSummary.mockResolvedValue({ kind: 'disabled' })
    open()
    await screen.findByText(/cannot claim vouchers yet/i)
    expect(screen.queryByRole('button', { name: 'Add to my wallet' })).toBeNull()
  })

  it('a voucher held by the mint gate after Accept is reported as kept, not added', async () => {
    redeemClaimRef.mockResolvedValue({ kind: 'held', reason: 'untrusted-mint' })
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Add to my wallet' }))
    await screen.findByText(/saved on this phone/i)
    expect(screen.queryByText('Voucher added')).toBeNull()
  })
})

describe('the claim key stays in memory', () => {
  it('is scrubbed from the address bar before the first await', () => {
    fetchClaimSummary.mockReturnValue(new Promise(() => {}))
    open()
    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain(KEY)
  })

  it('never appears in a log line or a request URL', async () => {
    const lines: string[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '))
      }),
    )
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      urls.push(String(input))
      return new Response('{}', { status: 404 })
    }))
    try {
      open()
      const accept = await screen.findByRole('button', { name: 'Add to my wallet' })
      fireEvent.click(accept)
      await screen.findByText('Voucher added')

      expect(lines.join('\n')).not.toContain(KEY)
      expect(urls.join('\n')).not.toContain(KEY)
      expect(window.location.href).not.toContain(KEY)
    } finally {
      spies.forEach((s) => s.mockRestore())
      vi.unstubAllGlobals()
    }
  })
})

/**
 * Review of phases 0 and 1: `/` sends a device holding a parked claim to `/c`, so every way home
 * from the prompt used to bounce straight back to it. A dead claim (claimed, revoked, expired, own,
 * unknown, a truncated key) held the customer on this screen for up to 24 h, and a claim still
 * waiting (unreachable, disabled) did the same until it was claimed.
 */
describe('leaving the prompt reaches the wallet', () => {
  function withHomeRule(pubkey = CUSTOMER, path = '/', hash = '') {
    window.history.replaceState(null, '', path + hash)
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<ResumeParkedClaim pubkey={pubkey}><p>HOME</p></ResumeParkedClaim>} />
          <Route path="/c/:ref" element={<ClaimLandingPage authed pubkey={pubkey} />} />
          <Route path="/c" element={<ClaimLandingPage authed pubkey={pubkey} />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  for (const [label, answer] of [
    ['claimed', () => summary({ status: 'Claimed', claimedAt: '2026-10-01T00:00:00Z' })],
    ['revoked', () => summary({ status: 'Revoked' })],
    ['expired', () => summary({ status: 'Expired' })],
    ['own cashback', () => summary({ issuerPubkey: CUSTOMER })],
    ['not found', () => ({ kind: 'not_found' })],
  ] as const) {
    it(`a resumed ${label} claim goes home and is forgotten`, async () => {
      stashPendingClaim(REF, KEY)
      fetchClaimSummary.mockResolvedValue(answer())
      withHomeRule()
      fireEvent.click(await screen.findByRole('button', { name: 'Open my wallet' }))
      await screen.findByText('HOME')
      expect(peekPendingClaim()).toBeNull()
      expect(redeemClaimRef).not.toHaveBeenCalled()
    })
  }

  it('a claim still waiting (unreachable) goes home and stays parked for the next visit', async () => {
    stashPendingClaim(REF, KEY)
    fetchClaimSummary.mockResolvedValue({ kind: 'unreachable' })
    withHomeRule()
    fireEvent.click(await screen.findByRole('button', { name: 'Open my wallet' }))
    await screen.findByText('HOME')
    expect(peekPendingClaim()?.ref).toBe(REF)
  })

  it('a truncated key is incomplete: no Add, nothing parked, nothing fetched', async () => {
    withHomeRule(CUSTOMER, `/c/${REF}`, '#k=abc')
    await screen.findByText('This link is incomplete. Ask for it again, or scan the whole QR.')
    expect(screen.queryByRole('button', { name: 'Add to my wallet' })).toBeNull()
    expect(peekPendingClaim()).toBeNull()
    expect(fetchClaimSummary).not.toHaveBeenCalled()
  })
})

describe('after Accept, home is home', () => {
  it('a resumed claim, accepted, then "Open my wallet" reaches the wallet, not the prompt again', async () => {
    stashPendingClaim(REF, KEY)
    window.history.replaceState(null, '', '/')
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<ResumeParkedClaim pubkey={CUSTOMER}><p>HOME</p></ResumeParkedClaim>} />
          <Route path="/c" element={<ClaimLandingPage authed pubkey={CUSTOMER} />} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Add to my wallet' }))
    await screen.findByText('Voucher added')
    fireEvent.click(screen.getByRole('button', { name: 'Open my wallet' }))
    await screen.findByText('HOME')
    expect(redeemClaimRef).toHaveBeenCalledTimes(1)
  })
})

/**
 * Fix verification of the review: the parked claim is cleared on every terminal state and on
 * Decline, ONLY for the claim on screen, and never before a successful claim. A device can hold a
 * parked claim B while its customer opens another link A; finishing A must not drop B.
 */
describe('the parked claim is only ever forgotten for the claim on screen', () => {
  const OTHER_REF = 'zzzz9999yyyy8888'

  for (const [label, result] of [
    ['added', { kind: 'ok', amountMinor: 500, unit: 'EUR', memo: null }],
    ['already claimed', { kind: 'terminal', code: 'claimed' }],
    ['held by the mint gate', { kind: 'held', reason: 'untrusted-mint' }],
    ['undecryptable after the spend', { kind: 'invalid', reason: 'decrypt_failure' }],
  ] as const) {
    it(`accepting another link (${label}) leaves a different parked claim alone`, async () => {
      stashPendingClaim(OTHER_REF, KEY)
      redeemClaimRef.mockResolvedValue(result)
      open()
      fireEvent.click(await screen.findByRole('button', { name: 'Add to my wallet' }))
      await screen.findByRole('button', { name: 'Open my wallet' })
      expect(peekPendingClaim()?.ref).toBe(OTHER_REF)
    })
  }

  it('declining another link leaves a different parked claim alone', async () => {
    stashPendingClaim(OTHER_REF, KEY)
    open()
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }))
    await screen.findByText('HOME')
    expect(peekPendingClaim()?.ref).toBe(OTHER_REF)
  })

  for (const [label, result] of [
    ['unreachable', { kind: 'unreachable', reason: 'network' }],
    ['throttled', { kind: 'throttled', retryAfterSeconds: 30 }],
    ['disabled', { kind: 'disabled' }],
    ['a deployment with no claim host (nothing spent)', { kind: 'invalid', reason: 'untrusted_claim_url' }],
  ] as const) {
    it(`a resumed claim that fails before the spend (${label}) stays parked`, async () => {
      stashPendingClaim(REF, KEY)
      redeemClaimRef.mockResolvedValue(result)
      open(CUSTOMER, '/c', '')
      fireEvent.click(await screen.findByRole('button', { name: 'Add to my wallet' }))
      await screen.findByRole('button', { name: 'Open my wallet' })
      expect(peekPendingClaim()?.ref).toBe(REF)
    })
  }

  it('a terminal answer after Accept forgets the claim on screen', async () => {
    stashPendingClaim(REF, KEY)
    redeemClaimRef.mockResolvedValue({ kind: 'terminal', code: 'revoked' })
    open(CUSTOMER, '/c', '')
    fireEvent.click(await screen.findByRole('button', { name: 'Add to my wallet' }))
    await screen.findByRole('button', { name: 'Open my wallet' })
    expect(peekPendingClaim()).toBeNull()
  })
})
