/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #357: `register` itself refuses to create an account without an acceptance of the Terms and
 * Conditions, so no caller (the onboarding form, a claim-driven registration, anything added
 * later) can skip it. The acceptance is stored on the profile record, which is what the backup
 * file and the Drive backup carry, so a restored account still shows it.
 *
 * The REAL key store, profile store and backup code; only the network is stubbed.
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
const { acceptTerms, TermsNotAcceptedError, TermsNotConfiguredError } = await import('../terms')
const { loadProfile, clearProfile, sanitiseProfile } = await import('../profile')
const { createBackup, parseBackup, applyBackup } = await import('../backup')
const { hasStoredKey } = await import('../nap')

const login = async () => {}

beforeEach(() => {
  localStorage.clear()
  signedFetch.mockClear()
  vi.stubEnv('VITE_WEBSITE_BASE_URL', 'https://www.imani.casa')
})
afterEach(() => vi.unstubAllEnvs())

describe('register requires the Terms and Conditions (#357)', () => {
  it('refuses without an acceptance, before claiming a handle or storing a key', async () => {
    // @ts-expect-error: the argument is required; the runtime refuses its absence too.
    await expect(register('alice', 'a-passphrase', login)).rejects.toBeInstanceOf(TermsNotAcceptedError)
    await expect(
      register('alice', 'a-passphrase', login, { terms: undefined as never }),
    ).rejects.toBeInstanceOf(TermsNotAcceptedError)
    await expect(
      register('alice', 'a-passphrase', login, { terms: { url: 'https://evil.test/terms.html', acceptedAt: 1 } }),
    ).rejects.toBeInstanceOf(TermsNotAcceptedError)
    expect(signedFetch).not.toHaveBeenCalled()
    expect(await hasStoredKey()).toBe(false)
  })

  it('refuses with plain copy when the build names no terms page', async () => {
    const terms = acceptTerms(1)
    vi.stubEnv('VITE_WEBSITE_BASE_URL', '')
    await expect(register('alice', 'a-passphrase', login, { terms })).rejects.toBeInstanceOf(TermsNotConfiguredError)
    expect(signedFetch).not.toHaveBeenCalled()
  })

  it('records which terms were accepted and when on the profile', async () => {
    const terms = acceptTerms(1_760_000_000_000)
    const out = await register('alice', 'a-passphrase', login, { terms })
    expect(out.profile.termsAccepted).toEqual({
      url: 'https://www.imani.casa/terms.html',
      acceptedAt: 1_760_000_000_000,
    })
    expect(loadProfile(out.profile.pubkey)?.termsAccepted).toEqual(out.profile.termsAccepted)
  })

  it('records it for a merchant too', async () => {
    const out = await register('stall', 'a-passphrase', login, {
      terms: acceptTerms(7),
      merchant: { active: true, categories: ['food'], issuanceCurrency: 'EUR', voucherValidityDays: 30 },
      profileFields: { displayName: 'Bridge Street Coffee' },
    })
    expect(out.merchant).toBeDefined()
    expect(out.profile.displayName).toBe('Bridge Street Coffee')
    expect(out.profile.termsAccepted?.acceptedAt).toBe(7)
  })

  it('the acceptance survives a backup and restore', async () => {
    const out = await register('alice', 'a-passphrase', login, { terms: acceptTerms(42) })
    const file = createBackup(out.profile.pubkey)
    expect(JSON.parse(file).profile.termsAccepted).toEqual({ url: 'https://www.imani.casa/terms.html', acceptedAt: 42 })

    // A different device: nothing but the file.
    const pubkey = out.profile.pubkey
    clearProfile(pubkey)
    const key = localStorage.getItem('imani-wallet-key')
    localStorage.clear()
    const parsed = parseBackup(file)
    await applyBackup(parsed, async () => {
      expect(localStorage.getItem('imani-wallet-key')).toBe(key)
      return 'f'.repeat(64)
    })
    expect(loadProfile(pubkey)?.termsAccepted).toEqual({ url: 'https://www.imani.casa/terms.html', acceptedAt: 42 })
  })

  it('a backup from before #357 (no field) still restores, with no acceptance', () => {
    const p = sanitiseProfile({ pubkey: 'a'.repeat(64), npub: 'npub1x', updatedAt: 1 })
    expect(p.termsAccepted).toBeUndefined()
    expect('termsAccepted' in p).toBe(false)
  })

  it('a hand-edited acceptance in a backup file is dropped, not trusted', () => {
    const p = sanitiseProfile({
      pubkey: 'a'.repeat(64),
      npub: 'npub1x',
      updatedAt: 1,
      termsAccepted: { url: 'javascript:alert(1)', acceptedAt: 1 },
    })
    expect(p.termsAccepted).toBeUndefined()
  })
})
