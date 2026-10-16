/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { PublicProfilePage } from '../PublicProfilePage'

/**
 * A stall's own profile: who they are, and how to buy from them.
 *
 * ## The distinction this page exists to make
 *
 * `/merchants/:pubkey` already looked like a profile and is not one. It is MY
 * RELATIONSHIP with a stall — the coupons I hold from them, our transactions, a
 * Send button for spending what I have. Tapping someone's face and landing on
 * my own holdings answers a question nobody asked. This page renders the same
 * for a stranger as for their best customer, because none of that is about
 * them.
 *
 * ## Merchants only
 *
 * A customer gets a refusal, not an empty version of this page. There is
 * nothing to show — they publish no stall record — and, more to the point, an
 * ordinary person's kind-0 is not an invitation to a profile page inside
 * somebody else's wallet. Enforced on the PAGE rather than only on the link,
 * because a URL can be typed, shared or deep-linked.
 */

const STALL = 'a'.repeat(64)
const CUSTOMER = 'b'.repeat(64)
const UNREACHABLE = 'c'.repeat(64)

vi.mock('../../lib/branding', () => ({
  merchantBranding: (pubkey: string) =>
    Promise.resolve(
      pubkey === STALL
        ? {
            organizationName: 'Rosa Green Farm',
            storeDescription: 'Coffee and cake',
            nip05: 'rosa@example.test',
          }
        : {},
    ),
}))

// The URL may carry a handle instead of a key. Resolution goes through the same
// helper the scanner and paste box use; stubbed here so these tests stay about
// the PAGE rather than about the gateway's resolver.
vi.mock('../../lib/issue', () => ({
  toRecipientPubkey: (input: string) =>
    Promise.resolve(input === 'cocoa' || input === 'cocoa@imani.local' ? STALL : null),
}))

vi.mock('../../lib/merchant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/merchant')>()),
  merchantStatus: (pubkey: string) =>
    Promise.resolve(
      pubkey === STALL ? 'merchant' : pubkey === CUSTOMER ? 'customer' : 'unknown',
    ),
  fetchMerchantRecord: (pubkey: string) =>
    Promise.resolve(
      pubkey === STALL
        ? {
            pubkey,
            active: true,
            categories: ['Food', 'Drink'],
            issuanceCurrency: 'gbp',
            voucherValidityDays: 365,
            acceptsCards: true,
            updatedAt: 0,
          }
        : null,
    ),
}))

const draw = (pubkey: string) =>
  render(
    <MemoryRouter initialEntries={[`/profile/${pubkey}`]}>
      <Routes>
        <Route path="/profile/:pubkey" element={<PublicProfilePage />} />
      </Routes>
    </MemoryRouter>,
  )

afterEach(cleanup)

/**
 * A profile is reachable by handle, not only by key.
 *
 * `/profile/cocoa` is the form a person can say out loud, write on a card, or
 * put in a message — a 64-character hex string is none of those. Resolution
 * reuses `toRecipientPubkey`, so a handle typed into the URL behaves exactly as
 * one typed into the scanner: a bare local part is completed against the
 * gateway's own domain, and a leading `@` is stripped.
 *
 * Verified against the live gateway before being stubbed here: hex, npub,
 * `cocoa@imani.local`, `cocoa` and `@cocoa` all resolved to the same key, and
 * an unknown name resolved to null.
 */
describe('reaching a profile by handle', () => {
  it.each(['cocoa', 'cocoa@imani.local'])('resolves %s to the stall', async (form) => {
    render(
      <MemoryRouter initialEntries={[`/profile/${encodeURIComponent(form)}`]}>
        <Routes>
          <Route path="/profile/:pubkey" element={<PublicProfilePage />} />
        </Routes>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Rosa Green Farm')).toBeTruthy())
  })

  /*
   * A name that resolves to nobody must SAY so. Rendering an empty profile
   * instead would look like a stall that has published nothing, which sends the
   * reader looking for a problem at the stall's end rather than at their typing.
   */
  it('says so when a handle resolves to nobody', async () => {
    render(
      <MemoryRouter initialEntries={['/profile/nobody']}>
        <Routes>
          <Route path="/profile/:pubkey" element={<PublicProfilePage />} />
        </Routes>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText(/No profile found/)).toBeTruthy())
    expect(screen.getByText(/nobody/)).toBeTruthy()
  })
})

describe('a stall’s public profile', () => {
  it('shows who they are', async () => {
    draw(STALL)

    await waitFor(() => expect(screen.getByText('Rosa Green Farm')).toBeTruthy())
    expect(screen.getByText('Coffee and cake')).toBeTruthy()
    expect(screen.getByText('Food · Drink')).toBeTruthy()
  })

  /*
   * The reason a shopper opened someone's profile. Gated on `acceptsCards`,
   * which is the only channel a stranger has — imani-merchant is self-scoped,
   * so nobody can ask about somebody else's charges_enabled.
   */
  it('offers to buy from a stall that takes cards', async () => {
    draw(STALL)

    await waitFor(() => expect(screen.getByRole('button', { name: /Buy a voucher/ })).toBeTruthy())
  })

  /**
   * NO RAW PUBKEY. An earlier draft printed all 64 characters as "the only
   * unforgeable thing here" — true, and not a reason. Nobody compares two
   * 64-character strings by eye, so it bought no safety and spent the bottom of
   * a shopper's screen on noise.
   */
  it('does not print the raw pubkey at a shopper', async () => {
    draw(STALL)

    await waitFor(() => expect(screen.getByText('Rosa Green Farm')).toBeTruthy())
    expect(screen.queryByText(STALL)).toBeNull()
  })

  /**
   * Copying the handle takes the stall away with you — into a message, a note,
   * or the wallet's own search.
   *
   * The assertion is on WHAT LANDS ON THE CLIPBOARD, not that a button exists.
   * `handleLabel` strips the domain for display ("@rosa"), and copying that
   * would produce a string that resolves to nobody — a copy button that
   * silently yields half an address is worse than none, because the failure
   * shows up in someone else's app.
   */
  it('copies the full nip05, domain included', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    draw(STALL)
    await waitFor(() => expect(screen.getByLabelText(/Copy rosa@example.test/)).toBeTruthy())
    screen.getByLabelText(/Copy rosa@example.test/).click()

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('rosa@example.test'))
  })

  /**
   * A stall with no NIP-05 still has something to hand over: the npub.
   *
   * This test previously asserted NO button, which was right when the only
   * shareable value was a handle. Falling back to the npub is better — a shopper
   * can still take the stall away with them, and every key has one — so the
   * assertion moved to what gets copied rather than whether the control exists.
   */
  it('falls back to the npub when a stall publishes no handle', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    draw(UNREACHABLE)
    await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull())
    screen.getByLabelText(/^Copy npub1/).click()

    // The FULL npub, not the shortened display form: an ellipsis in the middle
    // pastes as a string that resolves to nobody.
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^npub1[a-z0-9]{58}$/)),
    )
  })

  /**
   * A stall owner is not offered a purchase of their own voucher.
   *
   * It would charge their own Stripe account and mint them a coupon they
   * already back, and the gateway would probably allow it. Everything else on
   * the page stays: checking how you look to a shopper is a reasonable errand,
   * which is why the whole page is not hidden.
   */
  it('offers the owner no way to buy from themselves', async () => {
    render(
      <MemoryRouter initialEntries={[`/profile/${STALL}`]}>
        <Routes>
          <Route path="/profile/:pubkey" element={<PublicProfilePage viewerPubkey={STALL} />} />
        </Routes>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Rosa Green Farm')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Buy a voucher/ })).toBeNull()
    // Said, rather than silently absent: this is the page they check to see
    // what shoppers see, so an unexplained gap is a question.
    expect(screen.getByText(/how your stall looks/)).toBeTruthy()
  })

  /**
   * A CUSTOMER IS REFUSED. Not a blank profile — that reads as a broken
   * merchant rather than a person who is not one.
   */
  it('refuses a personal account', async () => {
    draw(CUSTOMER)

    await waitFor(() => expect(screen.getByText(/personal account/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Buy a voucher/ })).toBeNull()
  })

  /**
   * "Could not check" IS NOT "not a merchant", and conflating them is the
   * failure worth guarding. An unreachable relay telling a shopper a real stall
   * does not exist is a lie the app cannot take back — they go elsewhere. So an
   * unknown status renders whatever kind-0 arrived, degraded rather than wrong,
   * and simply offers no purchase.
   */
  it('degrades rather than denying the stall exists when the relay is unreachable', async () => {
    draw(UNREACHABLE)

    await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull())
    expect(screen.queryByText(/personal account/)).toBeNull()
    // #280: drawn but disabled, with the reason, rather than hidden. Still
    // fails closed: no record means no card offer that can be taken.
    const buy = screen.getByRole('button', { name: 'Buy a voucher with card' }) as HTMLButtonElement
    expect(buy.disabled).toBe(true)
    expect(screen.getByText("Card payments aren't set up for this merchant")).toBeTruthy()
  })

  /** #280: Pay is drawn too, and a visitor with no wallet cannot use it. */
  it('shows Pay disabled to a visitor with no session', async () => {
    draw(STALL)

    const pay = (await screen.findByRole('button', { name: 'Pay with your vouchers' })) as HTMLButtonElement
    expect(pay.disabled).toBe(true)
    expect(pay.getAttribute('aria-describedby')).toBeTruthy()
  })
})
