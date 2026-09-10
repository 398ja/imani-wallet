/**
 * @vitest-environment jsdom
 *
 * The service worker duplicates `render.ts` because a worker cannot import from
 * the app's module graph (see the header of public/sw.js). Duplication drifts
 * silently, so these tests execute the REAL worker file and hold it to the same
 * answers the shared renderer gives.
 *
 * If someone changes one and not the other, this fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { toRenderable } from '../render'

interface WorkerScope {
  listeners: Record<string, (event: unknown) => void>
  registration: { showNotification: ReturnType<typeof vi.fn> }
  clients: {
    matchAll: ReturnType<typeof vi.fn>
    openWindow: ReturnType<typeof vi.fn>
    claim: ReturnType<typeof vi.fn>
  }
  location: { origin: string }
  skipWaiting: ReturnType<typeof vi.fn>
}

/**
 * Run public/sw.js in a scope that looks enough like a ServiceWorkerGlobalScope,
 * and hand back the handlers it registered.
 */
function loadWorker(): WorkerScope {
  const source = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8')

  const scope: WorkerScope = {
    listeners: {},
    registration: { showNotification: vi.fn() },
    clients: {
      matchAll: vi.fn().mockResolvedValue([]),
      openWindow: vi.fn().mockResolvedValue(undefined),
      claim: vi.fn().mockResolvedValue(undefined),
    },
    location: { origin: 'https://wallet.example' },
    skipWaiting: vi.fn(),
  }

  const self = {
    ...scope,
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      scope.listeners[type] = handler
    },
  }

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('self', source)(self)
  return scope
}

/** A push event whose waitUntil we can await. */
function pushEvent(payload: unknown) {
  const pending: Promise<unknown>[] = []
  return {
    event: {
      data: payload === undefined ? null : { json: () => payload, text: () => String(payload) },
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    },
    settled: () => Promise.all(pending),
  }
}

describe('service worker', () => {
  let worker: WorkerScope

  beforeEach(() => {
    worker = loadWorker()
  })

  it('registers the handlers push delivery depends on', () => {
    expect(Object.keys(worker.listeners).sort()).toEqual([
      'activate',
      'install',
      'notificationclick',
      'push',
    ])
  })

  it.each([
    ['voucher_received', '/receive'],
    ['voucher_claimed', '/merchant/transactions'],
    ['voucher_expiring', '/'],
  ])('routes a %s push exactly as the shared renderer does', async (type, expected) => {
    const { event, settled } = pushEvent({ type, title: 'T', body: 'B' })
    worker.listeners.push(event)
    await settled()

    const [, options] = worker.registration.showNotification.mock.calls[0]
    expect(options.data.url).toBe(expected)
    // The contract that matters: worker and app agree.
    expect(options.data.url).toBe(toRenderable({ type, title: 'T', body: 'B' }).url)
  })

  it('refuses the imani-apps URL the gateway actually sends', async () => {
    const payload = { type: 'voucher_claimed', data: { url: '/voucher/home.html' } }
    const { event, settled } = pushEvent(payload)
    worker.listeners.push(event)
    await settled()

    const [, options] = worker.registration.showNotification.mock.calls[0]
    expect(options.data.url).toBe('/merchant/transactions')
    expect(options.data.url).toBe(toRenderable(payload).url)
  })

  it('refuses an absolute URL rather than opening a foreign origin', async () => {
    const payload = { type: 'voucher_received', data: { url: 'https://evil.example' } }
    const { event, settled } = pushEvent(payload)
    worker.listeners.push(event)
    await settled()

    const [, options] = worker.registration.showNotification.mock.calls[0]
    expect(options.data.url).toBe('/receive')
  })

  it('still shows something when the push carries no data at all', async () => {
    const { event, settled } = pushEvent(undefined)
    worker.listeners.push(event)
    await settled()

    const [title, options] = worker.registration.showNotification.mock.calls[0]
    expect(title).toBe('Imani')
    expect(options.body).toBeTruthy()
  })

  it('renders a non-JSON push instead of dropping it', async () => {
    const pending: Promise<unknown>[] = []
    worker.listeners.push({
      data: {
        json: () => {
          throw new SyntaxError('not json')
        },
        text: () => 'something happened',
      },
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    })
    await Promise.all(pending)

    const [, options] = worker.registration.showNotification.mock.calls[0]
    expect(options.body).toBe('something happened')
  })

  it('collapses same-type notifications onto one tag', async () => {
    for (const sender of ['Alice', 'Bob']) {
      const { event, settled } = pushEvent({ type: 'voucher_received', data: { sender } })
      worker.listeners.push(event)
      await settled()
    }

    const [[, first], [, second]] = worker.registration.showNotification.mock.calls
    expect(first.tag).toBe(second.tag)
  })

  it('focuses the wallet already open rather than opening a second one', async () => {
    const client = {
      url: 'https://wallet.example/send',
      focus: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(undefined),
    }
    worker.clients.matchAll.mockResolvedValue([client])

    const pending: Promise<unknown>[] = []
    worker.listeners.notificationclick({
      notification: { close: vi.fn(), data: { url: '/receive' } },
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    })
    await Promise.all(pending)

    expect(client.focus).toHaveBeenCalled()
    expect(client.navigate).toHaveBeenCalledWith('/receive')
    expect(worker.clients.openWindow).not.toHaveBeenCalled()
  })

  it('opens a window when no wallet is running', async () => {
    const pending: Promise<unknown>[] = []
    worker.listeners.notificationclick({
      notification: { close: vi.fn(), data: { url: '/receive' } },
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    })
    await Promise.all(pending)

    expect(worker.clients.openWindow).toHaveBeenCalledWith('/receive')
  })

  it('keeps the user in the wallet when navigate is refused', async () => {
    // A discarded client can reject navigate; losing the route is better than
    // losing the tap.
    const client = {
      url: 'https://wallet.example/',
      focus: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockRejectedValue(new Error('discarded')),
    }
    worker.clients.matchAll.mockResolvedValue([client])

    const pending: Promise<unknown>[] = []
    worker.listeners.notificationclick({
      notification: { close: vi.fn(), data: { url: '/receive' } },
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    })

    await expect(Promise.all(pending)).resolves.toBeTruthy()
    expect(client.focus).toHaveBeenCalled()
  })

  it('ignores a window on another origin', async () => {
    const foreign = {
      url: 'https://evil.example/',
      focus: vi.fn(),
      navigate: vi.fn(),
    }
    worker.clients.matchAll.mockResolvedValue([foreign])

    const pending: Promise<unknown>[] = []
    worker.listeners.notificationclick({
      notification: { close: vi.fn(), data: { url: '/receive' } },
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    })
    await Promise.all(pending)

    expect(foreign.focus).not.toHaveBeenCalled()
    expect(worker.clients.openWindow).toHaveBeenCalledWith('/receive')
  })

  it('takes over immediately instead of waiting for old tabs to close', () => {
    worker.listeners.install({})
    expect(worker.skipWaiting).toHaveBeenCalled()
  })

  it('caches nothing: a wallet must not serve a stale build', () => {
    // The absence of a fetch handler IS the feature.
    expect(worker.listeners.fetch).toBeUndefined()
  })
})
