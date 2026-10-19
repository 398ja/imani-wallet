/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Review follow-up to hasStoredKeyWalletKinds (wallet#258): drive the REAL registration path for a
 * merchant, and two accounts registered one after another on the same device, through the real
 * key store. The network is stubbed; the key store and `hasStoredKey` are not.
 */
const signedFetch = vi.fn(async () => new Response(JSON.stringify({ nip05: 'x@imani.local' }), { status: 201 }))
vi.mock('../config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config')>()),
  gatewayConfig: async () => ({ nip05Domain: 'imani.local', blossomServerUrl: null }),
}))
vi.mock('../nip98', async (importOriginal) => ({ ...(await importOriginal<typeof import('../nip98')>()), signedFetch }))
vi.mock('../relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../relay')>()),
  publish: async () => ({ ok: 1, total: 1, errors: [] }),
}))
vi.mock('../onboardingHandoff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../onboardingHandoff')>()),
  stashPendingBackup: vi.fn(),
}))

const { register } = await import('../registration')
const { hasStoredKey, keyStore } = await import('../nap')

beforeEach(() => localStorage.clear())

describe('hasStoredKey after a real registration', () => {
  it('a merchant registration leaves a wallet the claim landing detects', async () => {
    expect(await hasStoredKey()).toBe(false)
    const out = await register('stall', 'merchant-passphrase', async () => {}, {
      active: true,
      categories: ['food'],
      location: undefined,
      issuanceCurrency: 'EUR',
      voucherValidityDays: 30,
    } as Parameters<typeof register>[3])
    expect(out.merchant).toBeDefined()
    expect(await hasStoredKey()).toBe(true)
  })

  // #330: a second account may no longer replace the first one's key while it is still on the
  // device (that orphaned its vouchers). The first wallet is kept and still unlocks.
  it('a second registration on a device holding a wallet is refused, and the first one still unlocks', async () => {
    await register('first', 'pass-one-one', async () => {})
    await expect(register('second', 'pass-two-two', async () => {})).rejects.toThrow(/already holds another wallet/)
    expect(await hasStoredKey()).toBe(true)
    await expect(keyStore.loadKey('pass-one-one')).resolves.toMatch(/^[0-9a-f]{64}$/)
  })
})
