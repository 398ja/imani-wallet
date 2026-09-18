/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { RemoteImage } from '../RemoteImage'

/**
 * A picture on its way is not the same as no picture.
 *
 * Banners and coupon strips are fetched from hosts the issuer controls, over
 * whatever connection the phone has. Every one of them rendered as a blank band
 * until the bytes landed and then snapped into place. The band was the right
 * SIZE — the caller fixes the height, so nothing reflowed — but an empty grey
 * rectangle asserts "this stall published no banner", which is a different claim
 * from "it is loading" and, while the request is in flight, a false one.
 */

const SRC = 'https://example.test/banner.webp'

afterEach(cleanup)

const skeleton = () => document.querySelector('.animate-pulse')
const img = () => document.querySelector('img')

describe('a remote image', () => {
  it('shows a placeholder until the bytes arrive', () => {
    render(<RemoteImage src={SRC} className="h-24 w-full" />)

    expect(skeleton()).not.toBeNull()
    // The img is in the tree the whole time — it has to be, or the load would
    // never start — but it is transparent until it can be seen.
    expect(img()?.className).toContain('opacity-0')
  })

  it('fades the picture in once it loads', async () => {
    const { container } = render(<RemoteImage src={SRC} className="h-24 w-full" />)
    const image = container.querySelector('img') as HTMLImageElement

    image.dispatchEvent(new Event('load'))

    // React processes the state update; the placeholder goes, the picture shows.
    await new Promise((r) => setTimeout(r, 0))
    expect(skeleton()).toBeNull()
    expect(img()?.className).toContain('opacity-100')
  })

  /**
   * A DEAD LINK MUST SETTLE. These URLs are self-published and dying is
   * ordinary; a placeholder that pulses forever over a picture that is never
   * coming is worse than the blank band this replaced, because it promises
   * something.
   */
  it('falls back to a plain band when the image fails', async () => {
    const { container } = render(<RemoteImage src={SRC} className="h-24 w-full" />)
    const image = container.querySelector('img') as HTMLImageElement

    image.dispatchEvent(new Event('error'))

    await new Promise((r) => setTimeout(r, 0))
    expect(skeleton()).toBeNull()
    expect(img()).toBeNull()
  })

  /** No src is the caller's own "there is no image" case, not a wait. */
  it('renders nothing at all without a src', () => {
    const { container } = render(<RemoteImage className="h-24 w-full" />)

    expect(container.firstChild).toBeNull()
  })

  /**
   * PRIVACY, not tuning. `imageUrl` in branding.ts spells it out: fetching one
   * of these hands the issuer the customer's IP and the moment they opened their
   * wallet. So an image is requested when it is actually looked at, and never
   * carries the wallet route that asked for it.
   */
  it('keeps the lazy and no-referrer rules', () => {
    render(<RemoteImage src={SRC} className="h-24 w-full" />)

    expect(img()?.getAttribute('loading')).toBe('lazy')
    expect(img()?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  /**
   * A NEW URL STARTS PENDING AGAIN. The loaded state is keyed to the src rather
   * than held as a boolean, so this needs no effect to reset a flag — and
   * without it, switching stalls would show the previous stall's banner as
   * "loaded" while the new one was still arriving.
   */
  it('waits again when the src changes', async () => {
    const { container, rerender } = render(<RemoteImage src={SRC} className="h-24 w-full" />)
    ;(container.querySelector('img') as HTMLImageElement).dispatchEvent(new Event('load'))
    await new Promise((r) => setTimeout(r, 0))
    expect(skeleton()).toBeNull()

    rerender(<RemoteImage src="https://example.test/other.webp" className="h-24 w-full" />)

    expect(skeleton()).not.toBeNull()
  })

  it('has no accessible name for a decorative banner', () => {
    render(<RemoteImage src={SRC} className="h-24 w-full" />)

    // alt="" keeps a decorative band out of the screen reader's way, and the
    // placeholder is aria-hidden for the same reason.
    expect(img()?.getAttribute('alt')).toBe('')
    expect(screen.queryByRole('img')).toBeNull()
  })
})
