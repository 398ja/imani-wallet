/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { IdentityInline } from '../IdentityInline'

/**
 * Reaching a stall by tapping its name or picture.
 *
 * Reported twice from the app: "there is no link on avatar. I cannot view their
 * profile." The first fix linked the pass on the voucher DETAIL screen, which
 * was the wrong screen — a stall is named through `IdentityInline` in a dozen
 * places (the coupons list header, the Merchant row, receipts), and none of
 * them went anywhere. The route existed the whole time; nothing pointed at it
 * unless you had arrived from the stall and could press Back.
 *
 * ## Why a merchant check gates the link
 *
 * This component names CUSTOMERS too — Pay and Send both use it, and
 * MerchantRecordPages names the person who bought something. `/merchants/{key}`
 * renders for any pubkey, so linking a customer opens an empty stall page for
 * someone who has none. That reads as a broken merchant rather than a person
 * who is not one, which is worse than no link at all.
 *
 * The gate is the same hook that decides the merchant badge, so a row showing
 * the badge is exactly a row that links.
 */

const STALL = 'a'.repeat(64)
const CUSTOMER = 'b'.repeat(64)

// The real lookup asks a relay. Stubbed at the module boundary the component
// actually depends on, so these tests exercise the component's decision rather
// than the network.
vi.mock('../../../lib/merchant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/merchant')>()),
  isMerchantPubkey: (pubkey: string) => Promise.resolve(pubkey === STALL),
}))

const draw = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

afterEach(cleanup)

describe('a stall’s row on any screen', () => {
  it('links to the stall’s profile', async () => {
    draw(<IdentityInline pubkey={STALL} />)

    await waitFor(() =>
      expect(screen.getByRole('link').getAttribute('href')).toBe(`/profile/${STALL}`),
    )
  })

  /*
   * The avatar specifically, since that is what was reported tapped twice. It
   * must be INSIDE the anchor, not merely next to it.
   */
  it('puts the avatar inside the link', async () => {
    draw(<IdentityInline pubkey={STALL} />)

    await waitFor(() => expect(screen.queryByRole('link')).not.toBeNull())
    const link = screen.getByRole('link')
    // No picture published, so the Avatar renders initials — either way it is
    // the first child, and it must be within the link's subtree.
    expect(link.firstElementChild).not.toBeNull()
  })

  /**
   * A CUSTOMER MUST NOT LINK. `/merchants/{pubkey}` renders for any key, so
   * this would open an empty stall page for a person who has no stall — a
   * broken-looking merchant instead of an ordinary customer.
   */
  it('leaves a customer inert', async () => {
    draw(<IdentityInline pubkey={CUSTOMER} label="Customer" />)

    // Waiting for the lookup to settle, so this cannot pass merely by being
    // faster than the answer — which is how a test of an async gate lies.
    await waitFor(() => expect(screen.getByText('Customer')).toBeTruthy())
    expect(screen.queryByRole('link')).toBeNull()
  })

  /**
   * Screens holding work in progress opt out. Pay names the stall being paid,
   * and a tap meaning "who is this?" that abandons a half-finished payment is a
   * worse answer than no link.
   */
  it('stays inert where a caller turns the link off', async () => {
    draw(<IdentityInline pubkey={STALL} linkToProfile={false} />)

    await waitFor(() => expect(screen.getByText('Someone')).toBeTruthy())
    expect(screen.queryByRole('link')).toBeNull()
  })
})
