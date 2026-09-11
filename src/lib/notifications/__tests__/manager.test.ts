/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  _setTransportForTests,
  disableNotifications,
  enableNotifications,
  loadPreferences,
  readStatus,
  setPreferences,
} from '../manager'
import type { PushTransport, TransportSubscription } from '../transport'
import type { PermissionState } from '../types'

const PUBKEY = 'a'.repeat(64)

const SUBSCRIPTION: TransportSubscription = {
  endpoint: 'https://push.example/abc',
  p256dh: 'key',
  auth: 'auth',
  deviceName: 'Test device',
}

/** A transport whose every answer the test controls. */
function fakeTransport(overrides: Partial<PushTransport> = {}): PushTransport {
  let subscribed: TransportSubscription | null = null
  return {
    kind: 'web',
    describe: async () => ({ usable: true }),
    permission: async () => 'granted' as PermissionState,
    requestPermission: async () => 'granted' as PermissionState,
    subscribe: async () => {
      subscribed = SUBSCRIPTION
      return subscribed
    },
    unsubscribe: async () => {
      subscribed = null
    },
    current: async () => subscribed,
    ...overrides,
  }
}

/** Gateway responses, keyed by the path fragment they answer. */
function mockGateway(options: { vapid?: string | null; register?: number } = {}) {
  const { vapid = 'BLtestkey', register = 200 } = options

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/vapid-key')) {
        return vapid === null
          ? new Response(null, { status: 503 })
          : new Response(JSON.stringify({ publicKey: vapid }), { status: 200 })
      }
      return new Response(null, { status: register })
    }),
  )
}

// signedFetch signs with the session signer, which no unit test has.
vi.mock('../../nip98', () => ({
  signedFetch: vi.fn(async () => new Response(null, { status: 200 })),
}))

describe('notification manager', () => {
  beforeEach(() => {
    localStorage.clear()
    _setTransportForTests(fakeTransport())
    mockGateway()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    _setTransportForTests(null)
  })

  it('defaults to off, so nothing prompts before the user asks', () => {
    // A prompt the user did not ask for is the fastest route to a permanent
    // denial, which cannot be undone from inside the app.
    expect(loadPreferences(PUBKEY).enabled).toBe(false)
  })

  it('subscribes and remembers, when everything works', async () => {
    const result = await enableNotifications(PUBKEY)

    expect(result.ok).toBe(true)
    expect(result.reason).toBeNull()
    expect(result.status.subscribed).toBe(true)
    expect(loadPreferences(PUBKEY).enabled).toBe(true)
  })

  it('says where to fix it when permission was refused', async () => {
    _setTransportForTests(
      fakeTransport({
        permission: async () => 'prompt',
        requestPermission: async () => 'denied',
      }),
    )

    const result = await enableNotifications(PUBKEY)

    expect(result.ok).toBe(false)
    // In-app UI cannot re-prompt once denied; the text has to point at the
    // browser or system settings or the user is simply stuck.
    expect(result.reason).toMatch(/browser or system settings/i)
  })

  it('refuses to subscribe when the server has no VAPID key', async () => {
    // The 503 the gateway returns when PUSH_VAPID_* is unset. Subscribing
    // anyway would produce a subscription nothing can ever push to.
    mockGateway({ vapid: null })

    const result = await enableNotifications(PUBKEY)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/not switched on for this server/i)
    expect(result.status.subscribed).toBe(false)
  })

  it('undoes the local subscription when the gateway will not store it', async () => {
    // Otherwise the browser holds a subscription the server never heard of,
    // and the settings screen shows "on" for something that cannot deliver.
    const transport = fakeTransport()
    const unsubscribe = vi.spyOn(transport, 'unsubscribe')
    _setTransportForTests(transport)

    const { signedFetch } = await import('../../nip98')
    vi.mocked(signedFetch).mockResolvedValueOnce(new Response(null, { status: 500 }))

    const result = await enableNotifications(PUBKEY)

    expect(result.ok).toBe(false)
    expect(unsubscribe).toHaveBeenCalled()
    expect(await transport.current()).toBeNull()
  })

  it('reports an unusable transport in words a person can act on', async () => {
    _setTransportForTests(
      fakeTransport({
        describe: async () => ({
          usable: false,
          reason: 'On iPhone and iPad, add Imani to your Home Screen first.',
        }),
      }),
    )

    const result = await enableNotifications(PUBKEY)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/Home Screen/)
  })

  it('tells the gateway before dropping the local subscription', async () => {
    // The endpoint identifies the row; unsubscribing first destroys the only
    // handle on it and orphans a row that keeps being pushed to.
    await enableNotifications(PUBKEY)

    const { signedFetch } = await import('../../nip98')
    vi.mocked(signedFetch).mockClear()

    await disableNotifications(PUBKEY)

    const deleteCall = vi.mocked(signedFetch).mock.calls.find((call) => call[1] === 'DELETE')
    expect(deleteCall).toBeTruthy()
    // The DELETE MUST carry a body, even an empty one. Nip98AuthFilter counts
    // DELETE as a write and requires a `payload` tag; signedFetch only adds
    // that tag when there is a body to hash. Without it the gateway answers
    // 401 AUTH_002 and unsubscribe silently never works — the settings screen
    // would say notifications are off while the server kept pushing. Verified
    // against the live gateway: bodyless 401, with {} 204.
    expect(deleteCall?.[2]).toBeDefined()
    expect(loadPreferences(PUBKEY).enabled).toBe(false)
  })

  it('pushes an event switch to the server, not just to localStorage', async () => {
    // The server filters before sending: a flag kept only locally would let the
    // push arrive and merely hide it.
    await enableNotifications(PUBKEY)

    const { signedFetch } = await import('../../nip98')
    vi.mocked(signedFetch).mockClear()

    await setPreferences(PUBKEY, { ...loadPreferences(PUBKEY), couponClaimed: false })

    const put = vi.mocked(signedFetch).mock.calls.find((call) => call[1] === 'PUT')
    expect(put).toBeTruthy()
    expect(put?.[2]).toMatchObject({ notifyVoucherClaimed: false })
    expect(loadPreferences(PUBKEY).couponClaimed).toBe(false)
  })

  it('maps our "expiring" onto the server\'s "expired" flag', async () => {
    await enableNotifications(PUBKEY)
    const { signedFetch } = await import('../../nip98')
    vi.mocked(signedFetch).mockClear()

    await setPreferences(PUBKEY, { ...loadPreferences(PUBKEY), couponExpiring: false })

    const put = vi.mocked(signedFetch).mock.calls.find((call) => call[1] === 'PUT')
    expect(put?.[2]).toMatchObject({ notifyVoucherExpired: false })
  })

  it('reports status without changing anything', async () => {
    const status = await readStatus(PUBKEY)

    expect(status.subscribed).toBe(false)
    expect(status.permission).toBe('granted')
    expect(status.availability.usable).toBe(true)
  })

  it('keeps a preference added by a later build usable on an older record', () => {
    // A stored shape from an earlier version must not lose the new default.
    localStorage.setItem(
      `imani-wallet:notification-prefs:${PUBKEY}`,
      JSON.stringify({ enabled: true }),
    )

    const prefs = loadPreferences(PUBKEY)
    expect(prefs.enabled).toBe(true)
    expect(prefs.couponReceived).toBe(true)
  })

  it('falls back to defaults on a corrupt record', () => {
    localStorage.setItem(`imani-wallet:notification-prefs:${PUBKEY}`, 'not json')
    expect(loadPreferences(PUBKEY).enabled).toBe(false)
  })
})
