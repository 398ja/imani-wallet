/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #342: a handle with stray whitespace (or capitals) passed the form's check,
 * which trims, but was SENT untrimmed, so the gateway's `^[a-z0-9_]+$` rejected
 * it with a bare "Request validation failed". Owner rule: a handle is always
 * trimmed and lowercased wherever it is sent, published or stored.
 */

const PRIV = '3'.repeat(64)

const signedFetch = vi.fn()
const publish = vi.fn<(e: { content: string }) => Promise<{ ok: number; total: number; errors: string[] }>>(async () => ({ ok: 1, total: 1, errors: [] as string[] }))

vi.mock('../config', () => ({ gatewayConfig: async () => ({ nip05Domain: 'imani.local' }) }))
vi.mock('../nip98', () => ({ signedFetch }))
// The key slot, as the #330 guard (`refuseIfAnotherWallet`) reads it: empty
// until `save`, so a fresh device registers and a held slot refuses.
const slot = vi.hoisted(() => ({ held: false }))
vi.mock('../nap', () => ({
  keyStore: {
    save: vi.fn(async () => {
      slot.held = true
    }),
    hasKey: async () => slot.held,
  },
}))
vi.mock('../onboardingHandoff', () => ({ stashPendingBackup: vi.fn() }))
vi.mock('../relay', () => ({ RELAY_URL: 'ws://localhost:27778', publish, allEvents: async () => [] }))

const { claimHandle, register, isHandleAvailable } = await import('../registration')
const { claimProfile } = await import('../profileGate')
const { createWalletSigner } = await import('../signer')
const { loadProfile, mergeKind0, emptyProfile, buildProfileEvent } = await import('../profile')
const { userMessage } = await import('../userMessage')

// #357: register refuses without an accepted Terms and Conditions, so every call here brings one.
vi.stubEnv('VITE_WEBSITE_BASE_URL', 'https://www.imani.casa')
const TERMS = { terms: { url: 'https://www.imani.casa/terms.html', acceptedAt: 1 } }

/** The gateway's own rule for `username`, so the mock answers as staging does. */
function gateway(_path: string, _method: string, body: { username: string }) {
  if (/^[a-z0-9_]+$/.test(body.username)) return Promise.resolve(new Response('{}', { status: 201 }))
  return Promise.resolve(validationFailed())
}

const validationFailed = (field = 'username', message = 'Username must contain only lowercase alphanumeric characters and underscores') =>
  new Response(
    JSON.stringify({
      error: {
        code: 'VALIDATION_001',
        message: 'Request validation failed',
        field_errors: [{ field, message, rejected_value: 'alice ' }],
      },
    }),
    { status: 400 },
  )

const sentUsernames = () => signedFetch.mock.calls.map((c) => (c[2] as { username: string }).username)
const publishedNip05 = () => publish.mock.calls.map((c) => (JSON.parse(c[0].content) as { nip05?: string }).nip05)

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  slot.held = false
  signedFetch.mockImplementation(gateway)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
})
afterEach(() => vi.unstubAllGlobals())

describe('register normalises the typed handle (#342)', () => {
  it.each(['alice ', ' alice', 'Alice ', ' ALICE\t'])('%j is claimed, published and cached as "alice"', async (typed) => {
    const outcome = await register(typed, 'correct horse battery staple', async () => {}, TERMS)
    expect(sentUsernames()).toEqual(['alice'])
    expect(publishedNip05()).toEqual(['alice@imani.local'])
    expect(outcome.profile.nip05).toBe('alice@imani.local')
    expect(outcome.profile.displayName).toBe('alice')
    expect(loadProfile(outcome.profile.pubkey)?.nip05).toBe('alice@imani.local')
  })
})

describe('register with a padded handle still honours the one-wallet guard (#330 with #342)', () => {
  it('another wallet in the slot: " Alice " is refused before anything is claimed, published or cached', async () => {
    const { OtherWalletOnDeviceError } = await import('../keySlotGuard')
    const other = 'b'.repeat(64)
    slot.held = true
    localStorage.setItem(`imani-wallet:profile:${other}`, JSON.stringify({ pubkey: other }))
    await expect(register(' Alice ', 'correct horse battery staple', async () => {}, TERMS)).rejects.toBeInstanceOf(
      OtherWalletOnDeviceError,
    )
    expect(signedFetch).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(Object.keys(localStorage)).toEqual([`imani-wallet:profile:${other}`])
  })
})

describe('claimProfile (Finish your profile) normalises the typed handle (#342)', () => {
  it('"Alice " is claimed, published and cached as "alice"', async () => {
    const profile = await claimProfile(PRIV, 'Alice ', null, TERMS.terms)
    expect(sentUsernames()).toEqual(['alice'])
    expect(publishedNip05()).toEqual(['alice@imani.local'])
    expect(profile.nip05).toBe('alice@imani.local')
    expect(loadProfile(profile.pubkey)?.nip05).toBe('alice@imani.local')
  })
})

describe('claimHandle', () => {
  it('normalises on its own, for any caller', async () => {
    await claimHandle(' Bob_1 ', 'a'.repeat(64), createWalletSigner(PRIV))
    expect(sentUsernames()).toEqual(['bob_1'])
  })

  it('shows the field-level reason of a 400 VALIDATION_001, in plain words about the handle', async () => {
    signedFetch.mockResolvedValue(validationFailed())
    const err = await claimHandle('alice', 'a'.repeat(64), createWalletSigner(PRIV)).catch((e: unknown) => e)
    const shown = userMessage(err)
    expect(shown).not.toBe('Request validation failed')
    expect(shown).toMatch(/handle/i)
    expect(shown).toMatch(/lowercase letters, numbers and underscores/i)
    expect(shown).not.toMatch(/username|alphanumeric/i)
  })

  it('falls back to the top-level message when there are no field errors', async () => {
    signedFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'DOMAIN_NOT_VERIFIED', message: 'Domain is not verified' } }), { status: 400 }),
    )
    await expect(claimHandle('alice', 'a'.repeat(64), createWalletSigner(PRIV))).rejects.toThrow('Domain is not verified')
  })
})

describe('the availability probe', () => {
  it('asks about the normalised handle', async () => {
    await isHandleAvailable(' Alice ')
    const url = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toBe(`/api/v1/resolve/${encodeURIComponent('alice@imani.local')}`)
  })
})

describe('the profile cache and the kind-0', () => {
  it('a kind-0 read with a mixed-case padded nip05 is cached lowercased', () => {
    const merged = mergeKind0(emptyProfile('a'.repeat(64)), JSON.stringify({ nip05: ' Alice@Imani.Local ' }))
    expect(merged.nip05).toBe('alice@imani.local')
  })

  it('a kind-0 the wallet builds always carries a lowercased nip05', () => {
    const event = buildProfileEvent({ ...emptyProfile('a'.repeat(64)), nip05: 'Alice@Imani.Local' })
    expect(JSON.parse(event.content).nip05).toBe('alice@imani.local')
  })
})
