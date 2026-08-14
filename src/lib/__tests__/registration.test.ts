import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The ordering property, which is the whole correctness argument for
 * registration: nothing is persisted and no session is started until the handle
 * is actually claimed.
 *
 * Get this wrong and the browser holds a key asserting a NIP-05 that belongs to
 * somebody else — or, as an earlier version of this file actually did, logs in
 * mid-registration and remounts the app past the one screen that shows the
 * unrecoverable backup key.
 */

const save = vi.fn(async () => undefined)
const signedFetch = vi.fn()
const publish = vi.fn(async () => ({ ok: 1, total: 1, errors: [] }))
const saveProfile = vi.fn()
const stashPendingBackup = vi.fn()

vi.mock('../config', () => ({
  gatewayConfig: async () => ({ nip05Domain: 'imani.local', blossomServerUrl: null }),
}))
vi.mock('../nap', () => ({ keyStore: { save } }))
vi.mock('../nip98', () => ({ signedFetch }))
vi.mock('../relay', () => ({ RELAY_URL: 'ws://localhost:27778', publish }))
vi.mock('../onboardingHandoff', () => ({ stashPendingBackup }))
vi.mock('../profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../profile')>()),
  saveProfile,
}))

const { register, HandleTakenError } = await import('../registration')

const ok = () => new Response(JSON.stringify({ nip05: 'alice@imani.local' }), { status: 201 })
const conflict = () =>
  new Response(JSON.stringify({ error: { message: 'NIP-05 already exists' } }), { status: 409 })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('register', () => {
  it('claims the handle before storing the key', async () => {
    const order: string[] = []
    signedFetch.mockImplementation(() => {
      order.push('claim')
      return Promise.resolve(ok())
    })
    save.mockImplementation(async () => {
      order.push('save')
    })
    const login = vi.fn(async () => {
      order.push('login')
    })

    await register('alice', 'a-passphrase', login)

    expect(order).toEqual(['claim', 'save', 'login'])
  })

  it('logs in last, so the app does not remount before the backup key is stashed', async () => {
    signedFetch.mockResolvedValue(ok())
    const order: string[] = []
    stashPendingBackup.mockImplementation(() => order.push('stash'))
    const login = vi.fn(async () => {
      order.push('login')
    })

    await register('alice', 'a-passphrase', login)

    expect(order).toEqual(['stash', 'login'])
  })

  it('stores nothing and starts no session when the handle is taken', async () => {
    signedFetch.mockResolvedValue(conflict())
    const login = vi.fn()

    await expect(register('alice', 'a-passphrase', login)).rejects.toBeInstanceOf(HandleTakenError)

    expect(save).not.toHaveBeenCalled()
    expect(saveProfile).not.toHaveBeenCalled()
    expect(stashPendingBackup).not.toHaveBeenCalled()
    expect(login).not.toHaveBeenCalled()
  })

  it('reuses the same key when a failed claim is retried', async () => {
    // Every abandoned key is one the user might already have written down.
    signedFetch.mockResolvedValueOnce(conflict()).mockResolvedValueOnce(ok())
    const login = vi.fn(async () => undefined)

    await expect(register('taken', 'a-passphrase', login)).rejects.toBeInstanceOf(HandleTakenError)
    await register('free', 'a-passphrase', login)

    const pubkeys = signedFetch.mock.calls.map((c) => (c[2] as { pubkey: string }).pubkey)
    expect(pubkeys[0]).toBe(pubkeys[1])
  })

  it('succeeds even when no relay accepts the profile', async () => {
    // The handle is claimed and the key is safe; an unpublished kind-0 is
    // reported, not thrown.
    signedFetch.mockResolvedValue(ok())
    publish.mockRejectedValueOnce(new Error('no relay'))

    const outcome = await register('alice', 'a-passphrase', vi.fn(async () => undefined))

    expect(outcome.published).toBe(0)
    expect(outcome.nsec).toMatch(/^nsec1/)
    expect(save).toHaveBeenCalled()
  })

  it('does not re-claim a handle this key already holds', async () => {
    // The only step that can fail after the claim is the login. Retrying used
    // to re-send the claim, get a 409 caused by the user's OWN successful
    // claim, and tell them their handle was taken — so they would pick another
    // and burn a second handle on one key.
    signedFetch.mockResolvedValue(ok())
    const login = vi
      .fn<(hex: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('gateway down'))
      .mockResolvedValueOnce(undefined)

    await expect(register('alice', 'a-passphrase', login)).rejects.toThrow('gateway down')
    const afterFirst = signedFetch.mock.calls.length

    await expect(register('alice', 'a-passphrase', login)).resolves.toMatchObject({
      profile: { nip05: 'alice@imani.local' },
    })
    expect(signedFetch.mock.calls.length).toBe(afterFirst)
  })

  it('surfaces the gateway message on other failures', async () => {
    signedFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Domain not verified: imani.local' } }), {
        status: 412,
      }),
    )

    await expect(register('alice', 'a-passphrase', vi.fn())).rejects.toThrow(
      'Domain not verified: imani.local',
    )
  })
})
