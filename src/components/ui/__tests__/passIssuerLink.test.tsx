/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { Pass } from '../Pass'
import type { PassJson } from '../../../lib/pass'

/**
 * Getting from a coupon to the stall that issued it.
 *
 * Reported from the app: "there is no link on avatar. I cannot view their
 * profile." The card showed the stall's name and picture — the two things that
 * look tappable on any phone — and nothing happened.
 *
 * It was reachable only by the back arrow, which points at the stall solely
 * when the customer ARRIVED from it. Open a coupon from a notification, a
 * search or a deep link and the issuer had no route at all, while their avatar
 * sat there inviting a tap. A dead affordance is worse than none: it costs a
 * try, and then trust in every other picture in the app.
 *
 * These render the real component and assert on a real anchor, because "the
 * avatar is a link" is a DOM fact. A test that checked props would have passed
 * against the broken version.
 */

const ISSUER = 'a'.repeat(64)

function coupon(): PassJson {
  return {
    organizationName: 'Rosa Green Farm',
    description: 'Coffee card',
    backgroundColor: '#fff',
    foregroundColor: '#000',
    labelColor: '#333',
    storeCard: { primaryFields: [{ key: 'balance', label: 'Balance', value: 5 }] },
    userInfo: { issuer: ISSUER },
  } as unknown as PassJson
}

const draw = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

afterEach(cleanup)

describe('reaching the stall from its coupon', () => {
  it('makes the stall’s name a link when given somewhere to go', () => {
    draw(<Pass pass={coupon()} issuerTo={`/profile/${ISSUER}`} />)

    // getAttribute rather than a jest-dom matcher: this repo does not install
    // @testing-library/jest-dom, and one assertion is not worth a dependency.
    expect(
      screen.getByRole('link', { name: /Rosa Green Farm/ }).getAttribute('href'),
    ).toBe(`/profile/${ISSUER}`)
  })

  /*
   * The AVATAR specifically, since that is what was reported tapped. Asserted
   * with a real logo url so the <img> exists: without one the Avatar falls back
   * to initials, and a test that accepted either would pass while the picture
   * sat outside the link — exactly the bug.
   */
  it('puts the avatar inside that link, not beside it', () => {
    const pass = coupon()
    pass.userInfo.logoUrl = 'https://example.test/logo.png'
    draw(<Pass pass={pass} issuerTo={`/profile/${ISSUER}`} />)

    const link = screen.getByRole('link', { name: /Rosa Green Farm/ })
    expect(link.querySelector('img')?.getAttribute('src')).toBe('https://example.test/logo.png')
  })

  /*
   * A coupon whose issuer is unknown must not render a link to nowhere.
   * `/merchants/undefined` is a real page that loads and finds nothing.
   */
  it('stays inert when there is no issuer to link to', () => {
    draw(<Pass pass={coupon()} />)

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('Rosa Green Farm')).toBeTruthy()
  })

  /**
   * NO LINK INSIDE A LINK. `to` makes the whole card an anchor; nesting a
   * second one inside is invalid HTML, and browsers resolve it by guessing —
   * which means a tap on the stall's name might follow either, unpredictably.
   *
   * The outer one wins, so the card keeps the stronger promise it already made.
   */
  it('never nests the issuer link inside a whole-card link', () => {
    draw(<Pass pass={coupon()} to="/merchants/x/coupons" issuerTo={`/profile/${ISSUER}`} />)

    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute('href')).toBe('/merchants/x/coupons')
  })
})
