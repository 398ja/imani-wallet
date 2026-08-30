/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { LocationMap } from '../LocationMap'

/**
 * The stall location a merchant sets, finally shown to a customer.
 *
 * `LocationField` has told every merchant "Customers see this as a pin on a
 * map" since onboarding, while nothing outside that edit field rendered it —
 * so the sentence was false and a merchant had no way to discover that. These
 * assert the promise, not the styling.
 */

afterEach(cleanup)

const AT = '51.507400, -0.127800'

describe('LocationMap', () => {
  it('drops a pin at the recorded coordinates', () => {
    render(<LocationMap location={AT} />)
    const frame = screen.getByTitle('Map showing where this stall trades') as HTMLIFrameElement
    // `q=lat,lng` is what places the pin and `output=embed` is the keyless
    // form. Both are the contract with Google's embed, so both are pinned:
    // dropping either renders a map of the wrong thing, or nothing.
    expect(frame.src).toContain('q=51.507400,-0.127800')
    expect(frame.src).toContain('output=embed')
  })

  it('names the merchant in the heading and the frame title', () => {
    // A customer opening a stall they just tapped wants "Find Marlow Books",
    // not a pronoun. The accessible name matters more than the heading here:
    // a screen reader lands on an iframe and needs to know whose map it is.
    render(<LocationMap location={AT} label="Marlow Books" />)
    expect(screen.getByText('Find Marlow Books')).toBeDefined()
    expect(screen.getByTitle('Map showing Marlow Books')).toBeDefined()
  })

  it('renders NOTHING when the stall has no location', () => {
    // A trader who moves around is a normal case, not a missing value to
    // apologise for. An empty map frame would say less than no map.
    const { container } = render(<LocationMap location={undefined} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing for a location that will not parse', () => {
    // The record is a free-text string on an attacker-controllable kind-30078,
    // so it can be anything. Rendering an unparsed value into the embed URL
    // would put whatever it contains into a third-party request.
    for (const bad of ['', 'somewhere nice', '51.5', '51.5, ', 'a, b']) {
      const { container } = render(<LocationMap location={bad} />)
      expect(container.innerHTML, bad).toBe('')
      cleanup()
    }
  })

  it('is lazy and does not leak the full referrer', () => {
    // A map below the fold should not cost a third-party request on load, and
    // the embed does not need the full URL of the page a customer is on.
    render(<LocationMap location={AT} />)
    const frame = screen.getByTitle('Map showing where this stall trades') as HTMLIFrameElement
    expect(frame.getAttribute('loading')).toBe('lazy')
    expect(frame.getAttribute('referrerPolicy')).toBe('no-referrer-when-downgrade')
  })
})
