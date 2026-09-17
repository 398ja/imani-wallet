import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The gate the in-app surfaces had never consulted.
 *
 * Push preferences are enforced server-side — `setPreferences` sends the flags
 * to the gateway and an off switch stops the push being SENT. The toasts and
 * the bell are raised from inside the running app, with no server in the loop,
 * so until `wants.ts` they announced regardless of what the settings screen
 * said.
 *
 * The property that matters most here is the FAILURE direction: every call site
 * is a completed redemption, and a preference lookup that cannot answer must
 * not be the thing that hides someone's money.
 */

const PUBKEY = 'a'.repeat(64)

// No parameter: the tests assert the account scoping with
// `toHaveBeenCalledWith` rather than by reading it here, and this repo's lint
// config exempts no name from the unused-argument rule.
const loadPreferences = vi.fn(() => ({
  enabled: false,
  couponReceived: true,
  couponClaimed: true,
  couponExpiring: true,
}))

vi.mock('../manager', () => ({
  loadPreferences: (...args: Parameters<typeof loadPreferences>) => loadPreferences(...args),
}))

const { wantsInApp } = await import('../wants')

beforeEach(() => {
  loadPreferences.mockClear()
  loadPreferences.mockReturnValue({
    enabled: false,
    couponReceived: true,
    couponClaimed: true,
    couponExpiring: true,
  })
})

describe('whether an in-app notification should surface', () => {
  it('announces what the user left switched on', () => {
    expect(wantsInApp(PUBKEY, 'voucher_received')).toBe(true)
    expect(wantsInApp(PUBKEY, 'voucher_claimed')).toBe(true)
  })

  it('suppresses only the event actually switched off', () => {
    loadPreferences.mockReturnValue({
      enabled: true,
      couponReceived: true,
      couponClaimed: false,
      couponExpiring: true,
    })

    expect(wantsInApp(PUBKEY, 'voucher_claimed')).toBe(false)
    expect(wantsInApp(PUBKEY, 'voucher_received')).toBe(true)
  })

  /**
   * The trap this module exists to avoid. `enabled` means "we hold a push
   * subscription" and is FALSE by default, because turning it on needs an OS
   * permission prompt. Reading it here would leave every wallet that never
   * granted permission — the majority — with no toasts and an empty bell while
   * money moved in and out.
   */
  it('announces even when push is off, because that is a different question', () => {
    loadPreferences.mockReturnValue({
      enabled: false,
      couponReceived: true,
      couponClaimed: true,
      couponExpiring: true,
    })

    expect(wantsInApp(PUBKEY, 'voucher_received')).toBe(true)
  })

  it('treats a preference never chosen as yes', () => {
    // An older stored shape is missing the flag entirely. Undefined means "not
    // chosen", which is not the same as "no".
    loadPreferences.mockReturnValue({ enabled: true } as never)
    expect(wantsInApp(PUBKEY, 'voucher_received')).toBe(true)
  })

  it('announces when there is no identity to look a preference up against', () => {
    expect(wantsInApp(undefined, 'voucher_received')).toBe(true)
  })

  it('announces when the preference store itself fails', () => {
    // Denied or corrupt localStorage. Showing a notification the user switched
    // off is a nuisance; hiding money movement is not an acceptable failure.
    loadPreferences.mockImplementation(() => {
      throw new Error('localStorage denied')
    })

    expect(wantsInApp(PUBKEY, 'voucher_received')).toBe(true)
  })

  it('scopes the lookup to the account asking', () => {
    // Two people on one device must not read each other's switches.
    wantsInApp(PUBKEY, 'voucher_received')
    expect(loadPreferences).toHaveBeenCalledWith(PUBKEY)
  })
})
