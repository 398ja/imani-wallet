/**
 * @vitest-environment jsdom
 *
 * The transport's failure paths, which are where the real bugs were.
 *
 * Both cases below were found by driving a REAL browser, not by reading the
 * code: the first enable in a fresh profile raced the service worker's
 * activation, and the resulting message told the user nothing they could act
 * on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WebPushTransport } from '../webPush'

describe('WebPushTransport', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('waiting for the worker to activate', () => {
    it('waits when the registration has no active worker yet', async () => {
      // `register()` resolves as soon as the REGISTRATION exists, which is not
      // the same as a worker running. Subscribing then fails with
      // "no active Service Worker" — observed on a first enable in a real
      // browser, where the user taps and nothing happens for no visible reason.
      const subscribe = vi.fn().mockResolvedValue(null)
      const registration = {
        active: null,
        pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe },
      }
      let readyResolved = false

      vi.stubGlobal('navigator', {
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120',
        serviceWorker: {
          getRegistration: vi.fn().mockResolvedValue(registration),
          register: vi.fn().mockResolvedValue(registration),
          get ready() {
            readyResolved = true
            return Promise.resolve(registration)
          },
        },
      })

      await new WebPushTransport().subscribe('BJIZ')

      expect(readyResolved).toBe(true)
    })

    it('does not wait when a worker is already active', async () => {
      // The common case: waiting again would add latency to every later enable.
      const registration = {
        active: {},
        pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe: vi.fn().mockResolvedValue(null) },
      }
      let readyTouched = false

      vi.stubGlobal('navigator', {
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120',
        serviceWorker: {
          getRegistration: vi.fn().mockResolvedValue(registration),
          register: vi.fn(),
          get ready() {
            readyTouched = true
            return Promise.resolve(registration)
          },
        },
      })

      await new WebPushTransport().subscribe('BJIZ')

      expect(readyTouched).toBe(false)
    })
  })

  describe('explaining a refusal', () => {
    it.each([
      [
        'Registration failed - permission denied',
        /private window/i,
        // Chrome refuses Push in a private window with a bare permission error
        // even when permission IS granted, and documents that there is
        // deliberately no way to feature-detect it (crbug.com/41124656).
      ],
      ['Subscription failed - no active Service Worker', /still starting up/i],
      ['AbortError: push service not available', /notification service/i],
    ])('turns %s into words a user can act on', (message, expected) => {
      const transport = new WebPushTransport() as unknown as {
        lastError: Error
        describeLastFailure(): string | null
      }
      transport.lastError = new Error(message)

      expect(transport.describeLastFailure()).toMatch(expected)
    })

    it('says nothing rather than guessing at an unrecognised failure', () => {
      // The caller falls back to its own generic sentence. Inventing an
      // explanation for an error we do not understand would be worse.
      const transport = new WebPushTransport() as unknown as {
        lastError: Error
        describeLastFailure(): string | null
      }
      transport.lastError = new Error('something nobody has seen before')

      expect(transport.describeLastFailure()).toBeNull()
    })
  })
})
