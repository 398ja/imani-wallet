/**
 * @vitest-environment jsdom
 *
 * The native (FCM) transport.
 *
 * Untestable end to end without an Android device and a Firebase project, so
 * what IS pinned here is the contract the rest of the system depends on: the
 * shape it hands the gateway, the scheme that marks a row as native, and the
 * behaviours that only show up when something is wrong — no Play Services, a
 * refused registration, a plugin that is not there at all.
 *
 * That last group matters most. Every one of them is a state a real phone
 * reaches, and each must fail as "not subscribed" rather than as a throw that
 * takes the settings screen down with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listeners: Record<string, (payload: unknown) => void> = {}
// Hoisted: nativePush.ts calls registerPlugin() at module load.
const support = vi.hoisted(() => ({ status: vi.fn() }))
const capacitor = {
  isNativePlatform: vi.fn(),
  isPluginAvailable: vi.fn(),
  getPlatform: vi.fn(),
  registerPlugin: vi.fn(() => support),
}
const push = {
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  addListener: vi.fn((event: string, handler: (payload: unknown) => void) => {
    listeners[event] = handler
    return Promise.resolve({ remove: vi.fn() })
  }),
}

vi.mock('@capacitor/core', () => ({ Capacitor: capacitor, registerPlugin: capacitor.registerPlugin }))
vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: push }))

const { NativePushTransport } = await import('../nativePush')

describe('NativePushTransport', () => {
  beforeEach(() => {
    localStorage.clear()
    for (const key of Object.keys(listeners)) delete listeners[key]
    capacitor.isNativePlatform.mockReturnValue(true)
    capacitor.isPluginAvailable.mockReturnValue(true)
    capacitor.getPlatform.mockReturnValue('android')
    support.status.mockResolvedValue({ configured: true })
    push.register.mockResolvedValue(undefined)
    push.unregister.mockResolvedValue(undefined)
    push.addListener.mockClear()
  })

  afterEach(() => vi.clearAllMocks())

  /**
   * Registration resolves before the token arrives; the token comes by event.
   * A macrotask, not a microtask: subscribe() first asks the APK whether
   * Firebase is configured, so the listener is attached a few ticks later.
   */
  function deliverToken(value: string) {
    setTimeout(() => listeners.registration?.({ value }), 0)
  }

  describe('what it hands the gateway', () => {
    it('marks the row native with the fcm: scheme', async () => {
      const transport = new NativePushTransport()
      const pending = transport.subscribe(null)
      deliverToken('token-abc')

      const subscription = await pending

      // The prefix is the whole contract with the server: WebPushService
      // matches on it to refuse delivery it cannot perform. A row without it
      // would be attempted as Web Push and fail forever.
      expect(subscription?.endpoint).toBe('fcm:token-abc')
    })

    it('fills the key fields the gateway requires but FCM does not use', async () => {
      // Both are @NotBlank on PushSubscriptionRequest, so they cannot be empty;
      // a readable marker beats a random string nobody can interpret.
      const transport = new NativePushTransport()
      const pending = transport.subscribe(null)
      deliverToken('token-abc')

      const subscription = await pending

      expect(subscription?.p256dh).toBe('fcm-no-key')
      expect(subscription?.auth).toBe('fcm-no-key')
    })

    it('names the device so a user can tell it apart in the list', async () => {
      const transport = new NativePushTransport()
      const pending = transport.subscribe(null)
      deliverToken('token-abc')

      expect((await pending)?.deviceName).toBe('Imani app on android')
    })
  })

  describe('when it cannot work', () => {
    it('says so plainly off a native platform', async () => {
      capacitor.isNativePlatform.mockReturnValue(false)

      const availability = await new NativePushTransport().describe()

      expect(availability.usable).toBe(false)
      expect(availability.reason).toMatch(/Imani app/i)
    })

    it('tells the user to update when the plugin is missing', async () => {
      // An older build of the app: the wallet is fine, the shell is not.
      capacitor.isPluginAvailable.mockReturnValue(false)

      const availability = await new NativePushTransport().describe()

      expect(availability.usable).toBe(false)
      expect(availability.reason).toMatch(/update/i)
    })

    describe('an APK built without Firebase (google-services.json)', () => {
      // PushNotifications.register()/unregister() throw natively in that APK and
      // Capacitor rethrows on a native thread: the app crashes the moment the
      // user approves the permission prompt. Calling them is never safe there.

      it('is not usable when the APK says Firebase is missing', async () => {
        support.status.mockResolvedValue({ configured: false })

        const availability = await new NativePushTransport().describe()

        expect(availability.usable).toBe(false)
        expect(availability.reason).toMatch(/not available in the Imani app/i)
      })

      it('is not usable on an older APK that cannot answer', async () => {
        // Every APK before NativePushSupport was built without Firebase.
        capacitor.isPluginAvailable.mockImplementation((name: string) => name !== 'NativePushSupport')

        const availability = await new NativePushTransport().describe()

        expect(availability.usable).toBe(false)
      })

      it('is not usable when the APK check itself fails', async () => {
        support.status.mockRejectedValue(new Error('bridge gone'))

        expect((await new NativePushTransport().describe()).usable).toBe(false)
      })

      it('never calls register()', async () => {
        support.status.mockResolvedValue({ configured: false })

        const subscription = await new NativePushTransport().subscribe(null)

        expect(subscription).toBeNull()
        expect(push.register).not.toHaveBeenCalled()
      })

      it('never calls unregister()', async () => {
        support.status.mockResolvedValue({ configured: false })

        await new NativePushTransport().unsubscribe()

        expect(push.unregister).not.toHaveBeenCalled()
      })
    })

    it('gives up rather than hanging when no token ever arrives', async () => {
      // A device with no Play Services fires NEITHER event. Waiting forever
      // would leave the settings screen spinning with nothing to say.
      vi.useFakeTimers()
      const transport = new NativePushTransport()
      const pending = transport.subscribe(null)

      await vi.advanceTimersByTimeAsync(11_000)

      expect(await pending).toBeNull()
      vi.useRealTimers()
    })

    it('returns null when registration is refused', async () => {
      const transport = new NativePushTransport()
      const pending = transport.subscribe(null)
      setTimeout(() => listeners.registrationError?.({ error: 'SERVICE_NOT_AVAILABLE' }), 0)

      expect(await pending).toBeNull()
    })

    it('returns null when the register call itself throws', async () => {
      push.register.mockRejectedValue(new Error('no google play services'))

      expect(await new NativePushTransport().subscribe(null)).toBeNull()
    })

    it('reports permission as unsupported rather than throwing', async () => {
      push.checkPermissions.mockRejectedValue(new Error('no plugin'))

      expect(await new NativePushTransport().permission()).toBe('unsupported')
    })

    it('treats a failed permission request as a denial', async () => {
      push.requestPermissions.mockRejectedValue(new Error('boom'))

      expect(await new NativePushTransport().requestPermission()).toBe('denied')
    })
  })

  describe('remembering the registration', () => {
    it('answers current() without registering again', async () => {
      const transport = new NativePushTransport()
      const pending = transport.subscribe(null)
      deliverToken('token-abc')
      await pending

      push.register.mockClear()
      const current = await transport.current()

      expect(current?.endpoint).toBe('fcm:token-abc')
      expect(push.register).not.toHaveBeenCalled()
    })

    it('forgets the token on unsubscribe', async () => {
      const transport = new NativePushTransport()
      const pending = transport.subscribe(null)
      deliverToken('token-abc')
      await pending

      await transport.unsubscribe()

      expect(push.unregister).toHaveBeenCalled()
      expect(await transport.current()).toBeNull()
    })

    it('holds nothing before a first subscribe', async () => {
      expect(await new NativePushTransport().current()).toBeNull()
    })
  })

  describe('mapping Capacitor permission states', () => {
    it.each([
      ['granted', 'granted'],
      ['denied', 'denied'],
      ['prompt', 'prompt'],
      // Capacitor reports this when Android wants a rationale shown first.
      // It still means askable, so conflating it with `denied` would hide a
      // switch the user could have turned on.
      ['prompt-with-rationale', 'prompt'],
    ])('reads %s as %s', async (receive, expected) => {
      push.checkPermissions.mockResolvedValue({ receive })

      expect(await new NativePushTransport().permission()).toBe(expected)
    })
  })
})
