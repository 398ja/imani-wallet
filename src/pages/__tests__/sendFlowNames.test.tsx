/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

/**
 * The send flow names people, not keys.
 *
 * Reported from the app: "on all pages/views of the send flow, the wallet only
 * displays hexpubs instead of displaynames and nip-05s."
 *
 * The recipient was already named through `useIdentity`, which fetches kind-0.
 * The MERCHANT was not: `merchantLabel` read `Merchant.name`, which
 * `VoucherGrouper` fills with `merchant_metadata.merchant_name || merchantId`.
 * A coupon issued without that optional metadata therefore carried a
 * 64-character hex id as its "name", and `identityLabel`'s `humanName` guard
 * rejected it straight down to `shortPubkey`. So the voucher picker, the
 * amount screen's "available from", and the confirm screen's "From your
 * vouchers with" all printed a key for a merchant whose kind-0 was sitting on
 * the relay the whole time.
 *
 * These cover the merchant side specifically, since that is the leg that never
 * asked the network.
 */

const MERCHANT = 'a'.repeat(64)

// The relay/gateway lookup, stubbed at the boundary the component depends on.
// `merchantBranding` is what `useIdentity` calls.
vi.mock('../../lib/branding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/branding')>()),
  merchantBranding: (pubkey: string) =>
    Promise.resolve(
      pubkey.toLowerCase() === MERCHANT
        ? {
            organizationName: 'Cocoa Roasters',
            nip05: 'cocoa@staging.398ja.xyz',
            logoUrl: undefined,
            bannerUrl: undefined,
            storeDescription: undefined,
          }
        : {
            organizationName: undefined,
            nip05: undefined,
            logoUrl: undefined,
            bannerUrl: undefined,
            storeDescription: undefined,
          },
    ),
}))

import { useMerchantLabel } from '../../lib/identity'

afterEach(cleanup)
beforeEach(() => localStorage.clear())

function Label({ pubkey, name }: { pubkey: string; name: string }) {
  const label = useMerchantLabel({ pubkey, name } as never)
  return <span data-testid="label">{label}</span>
}

const draw = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

describe('the merchant’s name in the send flow', () => {
  /**
   * The reported bug. An unbranded coupon's "name" IS the hex id, so the old
   * `identityLabel(pubkey, { name })` had nothing real to show and fell to a
   * short key. It must reach kind-0 instead.
   */
  it('shows the display name when the coupon carries no merchant name', async () => {
    draw(<Label pubkey={MERCHANT} name={MERCHANT} />)

    await waitFor(() => expect(screen.getByTestId('label').textContent).toBe('Cocoa Roasters'))
  })

  /**
   * kind-0 is the merchant's own current profile; the coupon's copy was taken
   * whenever it was issued and never updates. A renamed stall must read as its
   * new name everywhere, so the fetched answer wins over the stored one.
   */
  it('prefers the published profile over a stale name baked into the coupon', async () => {
    draw(<Label pubkey={MERCHANT} name="Old Trading Name" />)

    await waitFor(() => expect(screen.getByTestId('label').textContent).toBe('Cocoa Roasters'))
  })

  /**
   * Nothing regresses for a merchant with no kind-0: the stored name is still
   * better than a key, and a key is still better than a blank.
   */
  it('falls back to the coupon’s name when no profile is published', async () => {
    const other = 'b'.repeat(64)
    draw(<Label pubkey={other} name="Corner Shop" />)

    await waitFor(() => expect(screen.getByTestId('label').textContent).toBe('Corner Shop'))
  })

  it('falls back to a neutral word, never a short key, when nothing names them (#324)', async () => {
    const other = 'c'.repeat(64)
    draw(<Label pubkey={other} name={other} />)

    await waitFor(() => expect(screen.getByTestId('label').textContent).toBe('Someone'))
  })
})

/**
 * The OTHER half of the report: the person being sent to.
 *
 * The recipient already went through `useIdentity`, so a published kind-0 was
 * shown. The gap was everyone else. A recipient reached by typing
 * `cocoa@staging.398ja.xyz` who has published no profile had their handle
 * thrown away by `toRecipientPubkey`, leaving the flow with a hex key to print
 * — for a person the user had just named out loud. `resolveRecipient` keeps it
 * and `IdentityInline` renders it as `fallbackHandle`.
 */
describe('the recipient’s name when they published no profile', () => {
  it('shows the handle they were reached through', async () => {
    const { IdentityInline } = await import('../../components/ui/IdentityInline')
    const stranger = 'd'.repeat(64)

    draw(
      <IdentityInline
        pubkey={stranger}
        label="To"
        fallbackHandle="cocoa@staging.398ja.xyz"
        linkToProfile={false}
      />,
    )

    await waitFor(() => expect(screen.getByText('@cocoa')).toBeTruthy())
  })

  /**
   * A published profile still wins. The handle is a floor, not an override —
   * otherwise a renamed stall would keep reading as whatever was typed.
   */
  it('prefers the published profile over the typed handle', async () => {
    const { IdentityInline } = await import('../../components/ui/IdentityInline')

    draw(
      <IdentityInline
        pubkey={MERCHANT}
        label="To"
        fallbackHandle="typed@elsewhere.test"
        linkToProfile={false}
      />,
    )

    await waitFor(() => expect(screen.getByText('Cocoa Roasters')).toBeTruthy())
    expect(screen.queryByText('@typed')).toBeNull()
  })
})
