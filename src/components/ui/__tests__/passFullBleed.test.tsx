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
  it('prints the voucher description', () => {
    const { getByText } = draw(coupon())
    expect(getByText('Coffee card')).toBeTruthy()
  })

  it('prints no empty line when there is no description', () => {
    const { container } = draw(coupon({ description: '' }))
    expect(container.querySelectorAll('p.truncate.text-xs')).toHaveLength(0)
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
