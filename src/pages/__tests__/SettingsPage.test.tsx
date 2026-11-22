/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import { SettingsPage } from '../SettingsPage'
import type { LicenceStatus } from '../../lib/licenceStatus'
import { recordTerminal } from '../../lib/terminalRoster'
import { TERMINAL_ROLES } from '../../lib/terminalRole'

/**
 * Settings › Merchant › Online shop (#402): listed for every merchant, locked below the plan that
 * includes online shops, never shown to a customer.
 */

const STALL = 'a'.repeat(64)
const withFeatures = (features: string[]) => async () =>
  ({
    checkedAt: Math.floor(Date.now() / 1000),
    decision: { granted: true, source: 'verified', grant: { features, expiresAt: Math.floor(Date.now() / 1000) + 86_400 } },
    grants: [{ features, expiresAt: Math.floor(Date.now() / 1000) + 86_400 }],
  }) as unknown as LicenceStatus

function renderSettings(status: () => Promise<LicenceStatus>, merchant = true) {
  render(
    <MemoryRouter>
      <SettingsPage merchant={merchant} stallPubkey={STALL} status={status} />
    </MemoryRouter>,
  )
}
const row = () => screen.getByRole('link', { name: /Online shop/ })

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('the Online shop row', () => {
  it('is locked, and says which plan unlocks it, on Basic', async () => {
    // Arrange / Act
    renderSettings(withFeatures(['terminals']))

    // Assert
    await waitFor(() => expect(row().textContent).toMatch(/Available on Pro/))
    expect(row().getAttribute('href')).toBe('/settings/online-shop')
    expect(screen.getByTestId('setting-locked')).toBeTruthy()
  })

  it('is unlocked on Pro', async () => {
    // Arrange / Act
    renderSettings(withFeatures(['terminals', 'api', 'ecommerce']))

    // Assert
    await waitFor(() => expect(row().textContent).toMatch(/pay with your coupons on your website/))
    expect(screen.queryByTestId('setting-locked')).toBeNull()
  })

  it('shows no lock until the plan check answers', () => {
    // Arrange / Act
    renderSettings(() => new Promise(() => {}))

    // Assert
    expect(row()).toBeTruthy()
    expect(screen.queryByTestId('setting-locked')).toBeNull()
  })

  it('names the connected shop, unlocked, even after the plan lapsed', async () => {
    // Arrange
    recordTerminal(STALL, {
      terminalPubkey: 'c'.repeat(64), name: 'shop.example', role: TERMINAL_ROLES.REDEEM_ONLY, enrolledAt: 1,
      status: 'in-service', shop: { url: 'https://shop.example', platform: 'woocommerce' },
    })

    // Act
    renderSettings(withFeatures(['terminals']))

    // Assert
    await waitFor(() => expect(row().textContent).toMatch(/Connected: shop\.example/))
    expect(screen.queryByTestId('setting-locked')).toBeNull()
  })

  it('is absent for a customer', () => {
    // Arrange / Act
    renderSettings(withFeatures(['ecommerce']), false)

    // Assert
    expect(screen.queryByRole('link', { name: /Online shop/ })).toBeNull()
  })
})

describe('the Card payments row', () => {
  const cardRow = () => screen.getByRole('link', { name: /Card payments/ })

  it('is locked on Starter and names the plan that unlocks it', async () => {
    // Arrange / Act
    renderSettings(async () => ({ checkedAt: Math.floor(Date.now() / 1000), decision: { granted: false, reason: 'absent' }, grants: [] }) as unknown as LicenceStatus)

    // Assert
    await waitFor(() => expect(cardRow().textContent).toMatch(/Available on Essentials$/))
    expect(cardRow().getAttribute('href')).toBe('/settings/payments')
    expect(cardRow().querySelector('[data-testid="setting-locked"]')).toBeTruthy()
  })

  it('is unlocked on Essentials', async () => {
    // Arrange / Act
    renderSettings(withFeatures(['terminals']))

    // Assert
    await waitFor(() => expect(row().textContent).toMatch(/Available on Pro/))
    expect(cardRow().textContent).toMatch(/Take card payments/)
    expect(cardRow().querySelector('[data-testid="setting-locked"]')).toBeNull()
  })
})
