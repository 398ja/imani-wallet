/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { Pass } from '../Pass'
import type { PassJson } from '../../../lib/pass'
import { isLightText, printShadow } from '../../../lib/printShadow'

/**
 * The voucher redesign (#419): the stall's banner fills the card instead of a
 * cropped strip, the avatar stays beside the name, and every printed character
 * has a shadow so the text reads on any picture, a white one included.
 */

const LOGO = 'https://example.test/logo.png'
const BANNER = 'https://example.test/banner.png'

function coupon(over: Partial<PassJson> = {}, info: Record<string, string> = {}): PassJson {
  return {
    organizationName: 'Rosa Green Farm',
    description: 'Coffee card',
    backgroundColor: 'rgb(20,20,20)',
    foregroundColor: 'rgb(255,255,255)',
    labelColor: 'rgb(255,255,255)',
    storeCard: { primaryFields: [{ key: 'balance', label: 'Balance', value: 5 }] },
    userInfo: { issuer: 'a'.repeat(64), ...info },
    ...over,
  } as unknown as PassJson
}

const draw = (pass: PassJson, loadingIssuer?: boolean) =>
  render(
    <MemoryRouter>
      <Pass pass={pass} loadingIssuer={loadingIssuer} />
    </MemoryRouter>,
  )

const card = (c: HTMLElement) => c.querySelector('.rounded-2xl') as HTMLElement
const backdrop = (c: HTMLElement) => card(c).querySelector(':scope > [aria-hidden="true"]')

afterEach(cleanup)

describe('the stall banner fills the voucher', () => {
  it('draws the banner behind the whole card', () => {
    const { container } = draw(coupon({}, { logoUrl: LOGO, stripUrl: BANNER }))
    const layer = backdrop(container)
    expect(layer?.className).toMatch(/absolute inset-0/)
    expect(layer?.querySelector('img')?.getAttribute('src')).toBe(BANNER)
  })

  it('does not use the avatar as the background', () => {
    const { container } = draw(coupon({}, { logoUrl: LOGO }))
    expect(backdrop(container)).toBeNull()
  })

  it('without a banner, keeps the plain background colour', () => {
    const { container } = draw(coupon())
    expect(backdrop(container)).toBeNull()
    expect(card(container).style.backgroundColor).toBe('rgb(20, 20, 20)')
  })

  it('waits for the profile like the avatar does', () => {
    const { container } = draw(coupon({ organizationName: 'b'.repeat(64) }, { stripUrl: BANNER }), true)
    expect(backdrop(container)).toBeNull()
  })
})

describe('the line under the name', () => {
  it('prints no description, not even the "Gift Card" placeholder', () => {
    const { queryByText } = draw(coupon({ description: 'Gift Card' }))
    expect(queryByText('Gift Card')).toBeNull()
  })
})

describe('no redemption QR on the card (#419)', () => {
  it('does not draw a code even when the pass carries one', async () => {
    const pass = coupon({
      barcodes: [{ format: 'PKBarcodeFormatQR', message: 'voucher:x', messageEncoding: 'UTF-8', altText: 'x' }],
    } as Partial<PassJson>)
    const { container, queryByText } = draw(pass)
    await new Promise((r) => setTimeout(r, 50))
    expect(container.querySelector('img[alt^="Redemption code"]')).toBeNull()
    expect(queryByText('x')).toBeNull()
  })
})

describe('the avatar on the card', () => {
  it('wears a white circular frame with a shadow', () => {
    const { getByAltText } = draw(coupon({}, { logoUrl: LOGO, stripUrl: BANNER }))
    const circle = getByAltText('Rosa Green Farm').parentElement as HTMLElement
    expect(circle.className).toMatch(/rounded-full/)
    expect(circle.className).toMatch(/ring-white/)
    expect(circle.className).toMatch(/shadow-md/)
  })

  it('frames the initials too, when there is no picture', () => {
    const { getByText } = draw(coupon())
    expect(getByText('RG').className).toMatch(/ring-white/)
  })
})

describe('the imani mark', () => {
  it('is a white mark with a black border on its own edges, no circle, no wordmark', () => {
    const { getByRole } = draw(coupon())
    const mark = getByRole('img', { name: 'imani' })
    expect(mark.className).toMatch(/absolute right-5 top-5/)
    expect(mark.className).toMatch(/text-white/)
    expect(mark.className).not.toMatch(/rounded-full|ring-|bg-/)
    const path = mark.querySelector('svg path') as SVGPathElement
    expect(path.getAttribute('stroke')).toBe('black')
    expect(path.getAttribute('paint-order')).toBe('stroke')
    expect((mark.querySelector('svg') as SVGElement).style.filter).toMatch(/drop-shadow/)
    expect(mark.querySelector('svg')).not.toBeNull()
    expect(mark.textContent).toBe('')
  })
})

describe('the expiry on a coupon card', () => {
  it('prints the date', () => {
    const pass = coupon({
      storeCard: {
        primaryFields: [{ key: 'balance', label: 'BALANCE', value: 5 }],
        auxiliaryFields: [{ key: 'expires', label: 'EXPIRES', value: '2026-11-10T21:37:19.000Z', dateStyle: 'PKDateStyleMedium' }],
      },
    })
    const { getByText } = draw(pass)
    expect(getByText('EXPIRES')).toBeTruthy()
    expect(getByText(/2026/)).toBeTruthy()
  })

  it('prints "No expiry" when there is none', () => {
    const pass = coupon({
      storeCard: {
        primaryFields: [{ key: 'balance', label: 'BALANCE', value: 5 }],
        auxiliaryFields: [{ key: 'expires', label: 'EXPIRES', value: 'No expiry' }],
      },
    })
    expect(draw(pass).getByText('No expiry')).toBeTruthy()
  })
})

describe('the balance', () => {
  it('prints the face value it is given, without the "Balance" label', () => {
    const pass = coupon({
      storeCard: {
        primaryFields: [{ key: 'balance', label: 'BALANCE', value: 500, unit: 'USD', decimals: 2 }],
      },
    })
    const { container, queryByText } = draw(pass)
    expect(queryByText(/balance/i)).toBeNull()
    expect(container.querySelector('.text-amount')?.textContent).toBe('$5.00')
  })
})

describe('every printed character has a shadow', () => {
  it('is set once on the card, so every field inherits it', () => {
    const { container } = draw(coupon({}, { stripUrl: BANNER }))
    expect(card(container).style.textShadow).not.toBe('')
    expect(card(container).style.textShadow).not.toBe('none')
  })

  it('is dark under light text and light under dark text', () => {
    expect(isLightText('rgb(255,255,255)')).toBe(true)
    expect(isLightText('#fff')).toBe(true)
    expect(isLightText('rgb(20,20,20)')).toBe(false)
    expect(isLightText('#000000')).toBe(false)
    expect(printShadow('rgb(255,255,255)')).toContain('rgba(0,0,0')
    expect(printShadow('rgb(0,0,0)')).toContain('rgba(255,255,255')
  })

  it('treats a colour it cannot read as the default light text', () => {
    expect(isLightText('papayawhip')).toBe(true)
  })

  it('is left off the status pills, which have their own background', () => {
    const { getByText } = draw(coupon({ voided: true }))
    expect((getByText('This voucher has been used') as HTMLElement).style.textShadow).toBe('none')
  })
})
