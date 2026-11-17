import { describe, expect, it } from 'vitest'

import { connectedShop, onlineShopAccess } from '../onlineShopAccess'
import type { LicenceStatus } from '../licenceStatus'
import type { TerminalRecord } from '../terminalRoster'
import { TERMINAL_ROLES } from '../terminalRole'

/**
 * Who sees Settings › Online shop unlocked (#402): the plan decides, a connected shop is never
 * hidden behind the lock.
 */

const NOW = 1_800_000_000

const status = (features: string[] | null, expiresAt = NOW + 86_400): LicenceStatus =>
  ({
    checkedAt: NOW,
    decision: features ? { granted: true, source: 'verified', grant: { features, expiresAt } } : { granted: false, reason: 'no-licence' },
    grants: features ? [{ features, expiresAt }] : [],
  }) as unknown as LicenceStatus

const shopRow = (over: Partial<TerminalRecord> = {}): TerminalRecord => ({
  terminalPubkey: 'c'.repeat(64),
  name: 'shop.example',
  role: TERMINAL_ROLES.REDEEM_ONLY,
  enrolledAt: 1_000,
  status: 'in-service',
  shop: { url: 'https://shop.example', platform: 'woocommerce' },
  ...over,
})
const till = (): TerminalRecord => ({ terminalPubkey: 'd'.repeat(64), name: 'Front', role: TERMINAL_ROLES.ISSUE_AND_REDEEM, enrolledAt: 2_000 })

describe('onlineShopAccess', () => {
  it('is available on a plan with ecommerce', () => {
    expect(onlineShopAccess(status(['terminals', 'api', 'ecommerce']), [])).toBe('available')
  })

  it('is locked on Basic, and with no licence at all', () => {
    expect(onlineShopAccess(status(['terminals']), [till()])).toBe('locked')
    expect(onlineShopAccess(status(null), [])).toBe('locked')
  })

  it('is lapsed, not locked, while a shop is still connected', () => {
    expect(onlineShopAccess(status(['terminals']), [shopRow()])).toBe('lapsed')
    // A waiting shop counts too: it has a credential the owner may want to cancel.
    expect(onlineShopAccess(status(null), [shopRow({ status: 'waiting' })])).toBe('lapsed')
  })

  it('reads an expired grant as no ecommerce', () => {
    expect(onlineShopAccess(status(['ecommerce'], NOW - 1), [])).toBe('locked')
  })

  it('ignores a disconnected shop', () => {
    expect(onlineShopAccess(status(['terminals']), [shopRow({ revokedAt: 5 })])).toBe('locked')
  })
})

describe('connectedShop', () => {
  it('is the newest live shop row, never a till or a revoked shop', () => {
    const older = shopRow({ terminalPubkey: 'e'.repeat(64), enrolledAt: 10 })
    const newer = shopRow({ terminalPubkey: 'f'.repeat(64), enrolledAt: 20 })
    expect(connectedShop([till(), older, newer, shopRow({ terminalPubkey: '1'.repeat(64), enrolledAt: 30, revokedAt: 31 })])).toBe(newer)
    expect(connectedShop([till()])).toBeNull()
  })
})
