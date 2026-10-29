/**
 * @vitest-environment jsdom
 *
 * #410: Settings → Card payments → "Your gifting page": the link (by handle, never by key), the QR,
 * and the indexing opt-in (G1), which only ever publishes a literal true.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

let identity: { nip05?: string } | undefined
vi.mock('../../lib/identity', async (orig) => ({
  ...(await orig<typeof import('../../lib/identity')>()),
  useIdentity: () => identity,
}))

import { GiftingPageSection } from '../GiftingPageSection'
import { giftingPageUrl } from '../../lib/giftingPage'
import { buildMerchantEvent, emptyMerchant, mergeMerchantEvent, type MerchantProfile } from '../../lib/merchant'

const STALL = 'a'.repeat(64)
const merchant = (over: Partial<MerchantProfile> = {}): MerchantProfile => ({ ...emptyMerchant(STALL), acceptsCards: true, ...over })

afterEach(() => cleanup())

describe('giftingPageUrl', () => {
  it('bare on the default domain, full handle elsewhere, nothing without a handle', () => {
    expect(giftingPageUrl('Alice@imani.casa')).toBe('https://gifting.imani.casa/shop/alice')
    expect(giftingPageUrl('alice@example.com')).toBe('https://gifting.imani.casa/shop/alice%40example.com')
    expect(giftingPageUrl('_@imani.casa')).toBe('https://gifting.imani.casa/shop/_%40imani.casa')
    expect(giftingPageUrl(undefined)).toBeNull()
    expect(giftingPageUrl('not a handle')).toBeNull()
  })
})

describe('GiftingPageSection', () => {
  it('shows the link by handle and a QR button', () => {
    identity = { nip05: 'alice@imani.casa' }
    render(<GiftingPageSection merchant={merchant()} onToggleIndexing={async () => {}} />)
    expect(screen.getByTestId('gifting-url').textContent).toBe('https://gifting.imani.casa/shop/alice')
    expect(screen.getByRole('button', { name: /Show QR/ })).toBeTruthy()
  })
  it('asks for a handle when there is none (no hexpub link)', () => {
    identity = undefined
    render(<GiftingPageSection merchant={merchant()} onToggleIndexing={async () => {}} />)
    expect(screen.getByText(/Add a handle to your profile/)).toBeTruthy()
    expect(screen.queryByTestId('gifting-url')).toBeNull()
  })
  it('the indexing switch is off by default and calls back with the new value', () => {
    identity = { nip05: 'alice@imani.casa' }
    const toggle = vi.fn(async () => {})
    render(<GiftingPageSection merchant={merchant()} onToggleIndexing={toggle} />)
    const sw = screen.getByRole('switch', { name: /search engines/ }) as HTMLInputElement
    expect(sw.getAttribute('aria-checked') ?? String(sw.checked)).toBe('false')
    fireEvent.click(sw)
    expect(toggle).toHaveBeenCalledWith(true)
  })
})

describe('giftingIndexable in the stall record (G1)', () => {
  it('published only when true, and only a literal true is read back', () => {
    expect(JSON.parse(buildMerchantEvent(merchant()).content).giftingIndexable).toBeUndefined()
    expect(JSON.parse(buildMerchantEvent(merchant({ giftingIndexable: true })).content).giftingIndexable).toBe(true)
    const m = emptyMerchant(STALL)
    expect(mergeMerchantEvent(m, JSON.stringify({ giftingIndexable: true }), 10).giftingIndexable).toBe(true)
    expect(mergeMerchantEvent(m, JSON.stringify({ giftingIndexable: 'true' }), 10).giftingIndexable).toBe(false)
    expect(mergeMerchantEvent(m, JSON.stringify({}), 10).giftingIndexable).toBe(false)
  })
})
