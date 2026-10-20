/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPublicKey } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * Claiming a handle must be safe to retry (#327 review: "claim is not idempotent").
 *
 * The directory (gateway-core -> bottin `Nip05RecordService.create`) answers 409
 * for ANY existing username@domain, including one that already maps to the very
 * key asking. So a claim whose response was lost, or one that succeeded before a
 * later step failed, came back on retry as "@amina is taken", and the customer
 * went on to claim a second handle for the same key. A 409 is "taken" only once
 * the handle is known to resolve to someone else.
 */

const PRIV = '2'.repeat(64)
const PUBKEY = getPublicKey(hexToBytes(PRIV))
const OTHER = 'b'.repeat(64)

const signedFetch = vi.fn()
const publish = vi.fn(async () => ({ ok: 1, total: 1, errors: [] as string[] }))
const save = vi.fn(async () => undefined)

vi.mock('../config', () => ({ gatewayConfig: async () => ({ nip05Domain: 'imani.local' }) }))
vi.mock('../nip98', () => ({ signedFetch }))
vi.mock('../nap', () => ({ keyStore: { save, hasKey: async () => false } }))
vi.mock('../onboardingHandoff', () => ({ stashPendingBackup: vi.fn() }))
vi.mock('../relay', () => ({ RELAY_URL: 'ws://localhost:27778', publish, allEvents: async () => [] }))

const { claimHandle, register, HandleTakenError, HandleCheckUnavailableError } = await import('../registration')
const { claimProfile, requireProfile, ProfileMissingError } = await import('../profileGate')
const { createWalletSigner } = await import('../signer')

const created = () => new Response('{}', { status: 201 })
const conflict = () => new Response(JSON.stringify({ error: { message: 'NIP-05 already exists' } }), { status: 409 })

/** What `GET /api/v1/resolve/alice@imani.local` answers: whose key, or a status. */
let resolvesTo: string | number
/** What the gateway's kind-0 cache holds for the key. */
let kind0: string | null

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  resolvesTo = 404
  kind0 = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/v1/nostr/query') {
        const events = kind0 ? [{ pubkey: PUBKEY, kind: 0, createdAt: 1, content: kind0 }] : []
        return new Response(JSON.stringify({ events }))
      }
      if (url === `/api/v1/resolve/${encodeURIComponent('alice@imani.local')}`) {
        if (typeof resolvesTo === 'number') return new Response('{}', { status: resolvesTo })
        return new Response(JSON.stringify({ nip05: 'alice@imani.local', hex_pubkey: resolvesTo }))
      }
      return new Response('{}', { status: 404 })
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

describe('claimHandle', () => {
  it('a repeat claim of a handle this key already holds succeeds', async () => {
    signedFetch.mockResolvedValue(conflict())
    resolvesTo = PUBKEY
    await expect(claimHandle('alice', PUBKEY, createWalletSigner(PRIV))).resolves.toBeUndefined()
  })

  it('a handle held by another key is still taken', async () => {
    signedFetch.mockResolvedValue(conflict())
    resolvesTo = OTHER
    await expect(claimHandle('alice', PUBKEY, createWalletSigner(PRIV))).rejects.toBeInstanceOf(HandleTakenError)
  })

  // Failing to check must never turn someone else's handle into ours, nor tell
  // the customer their own handle is taken: it is a "try again".
  it('a 409 whose check gets a server error is a retry, not success and not taken', async () => {
    signedFetch.mockResolvedValue(conflict())
    resolvesTo = 502
    await expect(claimHandle('alice', PUBKEY, createWalletSigner(PRIV))).rejects.toBeInstanceOf(HandleCheckUnavailableError)
  })

  it('a 409 whose check cannot reach the directory is a retry, not success', async () => {
    signedFetch.mockResolvedValue(conflict())
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(claimHandle('alice', PUBKEY, createWalletSigner(PRIV))).rejects.toBeInstanceOf(HandleCheckUnavailableError)
  })

  it('a 409 for a handle that resolves to nobody stays taken', async () => {
    signedFetch.mockResolvedValue(conflict())
    resolvesTo = 404
    await expect(claimHandle('alice', PUBKEY, createWalletSigner(PRIV))).rejects.toBeInstanceOf(HandleTakenError)
  })

  it('the claim and its check are bounded in time', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    signedFetch.mockResolvedValue(conflict())
    resolvesTo = PUBKEY
    await claimHandle('alice', PUBKEY, createWalletSigner(PRIV))
    expect(signedFetch.mock.calls[0][4]).toMatchObject({ signal: expect.anything() })
    expect(timeout).toHaveBeenCalledTimes(2)
    timeout.mockRestore()
  })
})

describe('register, after a lost claim response', () => {
  // The claim landed on the server, the response did not reach the phone. The
  // retry gets 409 for the customer's own handle and must go through.
  it('the retry completes with the same handle and the same key', async () => {
    signedFetch.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(conflict())
    const login = vi.fn(async () => {})

    await expect(register('alice', 'a-passphrase', login)).rejects.toThrow('Failed to fetch')
    expect(save).not.toHaveBeenCalled()
    expect(login).not.toHaveBeenCalled()
    // The server did write it: the handle now resolves to the minted key.
    resolvesTo = signedFetch.mock.calls[0][2].pubkey as string

    const outcome = await register('alice', 'a-passphrase', login)
    expect(outcome.profile.nip05).toBe('alice@imani.local')
    expect(outcome.profile.pubkey).toBe(signedFetch.mock.calls[1][2].pubkey)
    expect(signedFetch.mock.calls[0][2].pubkey).toBe(signedFetch.mock.calls[1][2].pubkey)
    expect(login).toHaveBeenCalledOnce()
  })
})

describe('Finish your profile (claimProfile)', () => {
  it('a retry after a timeout claims nothing new and finishes', async () => {
    signedFetch.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError')).mockResolvedValueOnce(conflict())
    resolvesTo = PUBKEY

    await expect(claimProfile(PRIV, 'alice')).rejects.toThrow('timed out')
    expect(localStorage.getItem(`imani-wallet:profile:${PUBKEY}`)).toBeNull()

    const profile = await claimProfile(PRIV, 'alice')
    expect(profile).toMatchObject({ nip05: 'alice@imani.local', displayName: 'alice' })
  })

  it('claiming the same handle twice with the same key succeeds both times', async () => {
    signedFetch.mockResolvedValueOnce(created()).mockResolvedValueOnce(conflict())
    resolvesTo = PUBKEY
    await claimProfile(PRIV, 'alice')
    await expect(claimProfile(PRIV, 'alice')).resolves.toMatchObject({ nip05: 'alice@imani.local' })
  })

  it('a handle taken by another key writes nothing', async () => {
    signedFetch.mockResolvedValue(conflict())
    resolvesTo = OTHER
    await expect(claimProfile(PRIV, 'alice')).rejects.toBeInstanceOf(HandleTakenError)
    expect(localStorage.getItem(`imani-wallet:profile:${PUBKEY}`)).toBeNull()
    expect(publish).not.toHaveBeenCalled()
  })

  // The claim held but the kind-0 never reached the relay. The profile is
  // still saved on the device (display name = handle), and the next login,
  // here or on a device that has only the backup, verifies the handle the
  // directory holds instead of asking for a second one.
  it('a kind-0 publish that fails after the claim still leaves a loggable-in account', async () => {
    signedFetch.mockResolvedValue(created())
    publish.mockRejectedValueOnce(new Error('relay down'))
    const profile = await claimProfile(PRIV, 'alice')
    expect(profile).toMatchObject({ nip05: 'alice@imani.local', displayName: 'alice' })

    // No kind-0 anywhere, but the directory holds alice -> this key.
    kind0 = null
    resolvesTo = PUBKEY
    await expect(requireProfile(PRIV)).resolves.toBe('alice@imani.local')

    // A fresh device with only the backup's profile snapshot.
    localStorage.clear()
    await expect(requireProfile(PRIV, 'alice@imani.local')).resolves.toBe('alice@imani.local')
    await expect(requireProfile(PRIV)).rejects.toBeInstanceOf(ProfileMissingError)
  })

  // The extra candidates are verified forwards like the kind-0's: a backup
  // naming someone else's handle does not let a key in.
  it('a known handle that resolves to another key does not verify', async () => {
    resolvesTo = OTHER
    await expect(requireProfile(PRIV, 'alice@imani.local')).rejects.toBeInstanceOf(ProfileMissingError)
  })
})

describe('Finish your profile from the logged-in card (claimProfileWith, #332)', () => {
  it('uses the session signer, keeps the display name, and is idempotent on retry', async () => {
    const { claimProfileWith } = await import('../profileGate')
    const signer = createWalletSigner(PRIV)
    signedFetch.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError')).mockResolvedValueOnce(conflict())
    resolvesTo = PUBKEY
    const { emptyProfile } = await import('../profile')
    const base = { ...emptyProfile(PUBKEY), displayName: 'Amina', updatedAt: 1 }

    await expect(claimProfileWith(signer, 'alice', base)).rejects.toThrow('timed out')
    const profile = await claimProfileWith(signer, 'alice', base)
    expect(profile).toMatchObject({ nip05: 'alice@imani.local', displayName: 'Amina' })
    expect(signedFetch.mock.calls[0][3]).toBe(signer)
    // The failed attempt published nothing, the finished one exactly one kind-0.
    expect(publish).toHaveBeenCalledOnce()
  })

  // The key claimed for is the signer's, never one named by the profile passed
  // in: a stale or foreign record cannot steer the claim to another account.
  it('claims for the signer\'s own key, whatever key the base profile names', async () => {
    const { claimProfileWith } = await import('../profileGate')
    const { emptyProfile } = await import('../profile')
    signedFetch.mockResolvedValue(created())
    const profile = await claimProfileWith(createWalletSigner(PRIV), 'alice', { ...emptyProfile(OTHER), displayName: 'Mallory', updatedAt: 1 })
    expect(signedFetch.mock.calls[0][2]).toMatchObject({ username: 'alice', pubkey: PUBKEY })
    expect(profile).toMatchObject({ pubkey: PUBKEY, nip05: 'alice@imani.local', displayName: 'alice' })
    expect(localStorage.getItem(`imani-wallet:profile:${OTHER}`)).toBeNull()
  })

  it('a handle held by someone else is HandleTakenError and writes nothing', async () => {
    const { claimProfileWith } = await import('../profileGate')
    signedFetch.mockResolvedValue(conflict())
    resolvesTo = OTHER
    await expect(claimProfileWith(createWalletSigner(PRIV), 'alice')).rejects.toBeInstanceOf(HandleTakenError)
    expect(localStorage.getItem(`imani-wallet:profile:${PUBKEY}`)).toBeNull()
    expect(publish).not.toHaveBeenCalled()
  })
})
