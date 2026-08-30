/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { ProfilePage } from '../ProfilePage'
import type { Profile } from '../../lib/profile'
import type { MerchantProfile } from '../../lib/merchant'

/**
 * The stall location on YOUR OWN profile — `/profile`, the page the header
 * links to.
 *
 * This exists because I got the surface wrong. The first cut put `LocationMap`
 * only on `/merchants/:pubkey`, a CUSTOMER's view of a stall they hold coupons
 * from, and reported the feature as done. A merchant opening their own profile
 * from the header still saw nothing, which is exactly where they would look to
 * check what they have published.
 *
 * Worse, `/merchants/:pubkey` returns "No vouchers from this merchant" before
 * rendering anything when you hold no coupons — so the one page that did have
 * the map was unreachable for most stalls.
 *
 * Asserting the page rather than the component is the point: `LocationMap` was
 * already tested and already correct. What was missing was it being CALLED
 * anywhere a merchant would see it, and only a page-level test catches that.
 */

// The QR the identity card draws needs a canvas jsdom does not provide, and it
// is not what this file is about.
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,' } }))

afterEach(cleanup)

const profile = {
  pubkey: 'a'.repeat(64),
  displayName: 'The Copper Kettle',
  nip05: 'copperkettle@staging.398ja.xyz',
  updatedAt: Date.now(),
} as unknown as Profile

const withPitch = {
  pubkey: 'a'.repeat(64),
  location: '51.507400, -0.127800',
} as unknown as MerchantProfile

const show = (merchant: MerchantProfile | null) =>
  render(
    <MemoryRouter>
      <ProfilePage profile={profile} merchant={merchant} />
    </MemoryRouter>,
  )

describe('/profile shows where the stall trades', () => {
  it('renders the map for a merchant with a pitch', () => {
    show(withPitch)
    const frame = screen.getByTitle('Map showing where this stall trades') as HTMLIFrameElement
    expect(frame.src).toContain('q=51.507400,-0.127800')
  })

  it('uses the owner-facing wording, not the customer-facing one', () => {
    // "Where to find them" is right on a stall you are visiting and wrong on
    // your own page. The unlabelled form is the one meant for the owner.
    show(withPitch)
    expect(screen.queryByText(/Where to find them/)).toBeNull()
    expect(screen.queryByText(/Find The Copper Kettle/)).toBeNull()
    // And it matches what the edit field calls the same thing, so a merchant
    // reads one phrase for one concept across both screens.
    expect(screen.getByText('Where you trade')).toBeDefined()
  })

  it('renders NOTHING for a customer, who has no stall record', () => {
    // Not an empty heading over a missing map: a customer has no pitch to show
    // and should not be told about one.
    show(null)
    expect(screen.queryByTitle(/Map showing/)).toBeNull()
  })

  it('renders nothing for a merchant who trades no fixed pitch', () => {
    // A trader who moves around leaves this blank deliberately. `LocationField`
    // says so: "Leave it blank if you move around."
    show({ pubkey: 'a'.repeat(64) } as unknown as MerchantProfile)
    expect(screen.queryByTitle(/Map showing/)).toBeNull()
  })

  it('still renders the rest of the profile either way', () => {
    // Guards against the map throwing and taking the page with it — the name
    // is the thing this screen exists for.
    show(null)
    expect(screen.getByText('The Copper Kettle')).toBeDefined()
    cleanup()
    show(withPitch)
    expect(screen.getByText('The Copper Kettle')).toBeDefined()
  })
})
