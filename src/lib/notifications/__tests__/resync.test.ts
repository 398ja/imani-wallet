/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { _setTransportForTests, resyncPushSubscription, setPreferences } from '../manager'
import type { PushTransport, TransportSubscription } from '../transport'
import type { PermissionState } from '../types'

/**
 * Repairing a push registration that has gone stale without saying so.
 *
 * A Web Push subscription is not permanent: browsers rotate the endpoint,
 * expire it, or drop it when storage is cleared, and the
 * `pushsubscriptionchange` event meant to announce that is unreliable and
 * missing from several engines. The resulting state is silent in the worst
 * way — the settings screen still reads "on", the browser still holds a
 * subscription, and the gateway is pushing at an endpoint that now 410s. The
 * user's phone stops ringing and nothing on screen admits it.
 *
 * The resync is one POST on startup against an endpoint that upserts, so these
 * tests are mostly about what it must NOT do: prompt, subscribe, or throw.
 */

const PUBKEY = 'a'.repeat(64)

const SUBSCRIPTION: TransportSubscription = {
  endpoint: 'https://push.example/abc',
  p256dh: 'key',
  auth: 'auth',
  deviceName: 'Test device',
}

const subscribe = vi.fn(async () => SUBSCRIPTION)
const requestPermission = vi.fn(async () => 'granted' as PermissionState)

/** A transport holding a live subscription unless the test says otherwise. */
function fakeTransport(overrides: Partial<PushTransport> = {}): PushTransport {
  return {
    kind: 'web',
    describe: async () => ({ usable: true }),
    permission: async () => 'granted' as PermissionState,
    requestPermission,
    subscribe,
    unsubscribe: async () => {},
    current: async () => SUBSCRIPTION,
    ...overrides,
  }
}

// The gateway call the resync makes. signedFetch signs with the session
// signer, which no unit test has.
const signedFetch = vi.fn(async () => new Response(null, { status: 200 }))
vi.mock('../../nip98', () => ({
  signedFetch: (...args: unknown[]) => signedFetch(...(args as [])),
}))

/** Registration POSTs the resync made, by path. */
function registerCalls(): string[] {
  return signedFetch.mock.calls
    .map((call) => String((call as unknown as unknown[])[0]))
    .filter((path) => path.includes('/subscriptions/'))
}

describe('resyncing this device with the gateway', () => {
  beforeEach(() => {
    localStorage.clear()
    signedFetch.mockClear()
    signedFetch.mockResolvedValue(new Response(null, { status: 200 }))
    subscribe.mockClear()
    requestPermission.mockClear()
    _setTransportForTests(fakeTransport())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    _setTransportForTests(null)
    vi.restoreAllMocks()
  })

  /** Turn push on in storage without going through the permission flow. */
  async function enablePush(): Promise<void> {
    await setPreferences(PUBKEY, {
      enabled: true,
      couponReceived: true,
      couponClaimed: true,
      couponExpiring: true,
    })
    signedFetch.mockClear()
  }

  it('re-registers the live subscription when push is on', async () => {
    await enablePush()

    await expect(resyncPushSubscription(PUBKEY)).resolves.toBe(true)
    expect(registerCalls()).toContain(`/api/v1/push/subscriptions/${PUBKEY}`)
  })

  it('does nothing when the user never turned push on', async () => {
    // Re-registering here would resurrect a subscription the user switched off.
    await setPreferences(PUBKEY, {
      enabled: false,
      couponReceived: true,
      couponClaimed: true,
      couponExpiring: true,
    })
    signedFetch.mockClear()

    await expect(resyncPushSubscription(PUBKEY)).resolves.toBe(false)
    expect(registerCalls()).toHaveLength(0)
  })

  it('treats a wallet that has never chosen as off', async () => {
    // No stored preferences: DEFAULT_PREFERENCES has enabled false, because
    // enabling needs an OS permission prompt.
    await expect(resyncPushSubscription(PUBKEY)).resolves.toBe(false)
    expect(registerCalls()).toHaveLength(0)
  })

  /**
   * The line between repairing and prompting. If the browser holds no
   * subscription, creating one would raise a permission prompt from a startup
   * path the user did not initiate — and a denial cannot be undone in-app.
   */
  it('never subscribes or prompts when the browser holds nothing', async () => {
    await enablePush()
    _setTransportForTests(fakeTransport({ current: async () => null }))

    await expect(resyncPushSubscription(PUBKEY)).resolves.toBe(false)
    expect(subscribe).not.toHaveBeenCalled()
    expect(requestPermission).not.toHaveBeenCalled()
    expect(registerCalls()).toHaveLength(0)
  })

  it('reports a refusal without throwing', async () => {
    await enablePush()
    signedFetch.mockResolvedValue(new Response(null, { status: 500 }))

    await expect(resyncPushSubscription(PUBKEY)).resolves.toBe(false)
  })

  /**
   * Called from App startup with `void`, so a rejection would be unhandled and
   * would surface as a broken session rather than a missing notification.
   */
  it('never throws when the transport itself fails', async () => {
    await enablePush()
    _setTransportForTests(
      fakeTransport({
        current: async () => {
          throw new Error('service worker gone')
        },
      }),
    )

    await expect(resyncPushSubscription(PUBKEY)).resolves.toBe(false)
  })
})
