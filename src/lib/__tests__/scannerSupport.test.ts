import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetScannerSupportCache, scannerBlocked } from '../scannerSupport'

/**
 * The probe must catch the failure that actually happened.
 *
 * Its first version asked `new Worker(blobUrl)` to throw. Chromium does not
 * throw — the constructor returns and the refusal arrives as an `error` event —
 * so that version reported "scanning works" on the exact CSP that broke every
 * scan in the app. Verified in a real browser against the real deployment with
 * the header rewritten, which is why the cases below are the ones they are.
 */

class FakeWorker {
  onmessage: (() => void) | null = null
  onerror: (() => void) | null = null
  terminated = false
  constructor(private behaviour: 'reply' | 'error' | 'silent') {}
  postMessage() {
    if (this.behaviour === 'reply') queueMicrotask(() => this.onmessage?.())
    if (this.behaviour === 'error') queueMicrotask(() => this.onerror?.())
  }
  terminate() {
    this.terminated = true
  }
}

function install(behaviour: 'reply' | 'error' | 'silent' | 'throw') {
  const created: FakeWorker[] = []
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        if (behaviour === 'throw') throw new DOMException('blocked', 'SecurityError')
        const w = new FakeWorker(behaviour)
        created.push(w)
        return w as unknown as Worker
      }
    },
  )
  vi.stubGlobal('Blob', class {})
  vi.stubGlobal('URL', {
    createObjectURL: () => 'blob:probe',
    revokeObjectURL: () => {},
  })
  return created
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetScannerSupportCache()
})

describe('scannerBlocked', () => {
  it('reports nothing wrong when the worker answers', async () => {
    install('reply')
    await expect(scannerBlocked()).resolves.toBeNull()
  })

  it('reports blocked when the worker errors rather than throwing', async () => {
    // THE REGRESSION. Chromium's actual behaviour under `worker-src 'self'`.
    install('error')
    await expect(scannerBlocked()).resolves.toMatch(/worker-src blob:/)
  })

  it('reports blocked when the worker never answers', async () => {
    vi.useFakeTimers()
    install('silent')
    const answer = scannerBlocked()
    await vi.advanceTimersByTimeAsync(2000)
    await expect(answer).resolves.toMatch(/worker-src blob:/)
  })

  it('reports blocked when construction throws, as Firefox and Safari do', async () => {
    install('throw')
    await expect(scannerBlocked()).resolves.toMatch(/worker-src blob:/)
  })

  it('terminates the worker even when it never replied', async () => {
    vi.useFakeTimers()
    const created = install('silent')
    const answer = scannerBlocked()
    await vi.advanceTimersByTimeAsync(2000)
    await answer
    expect(created[0].terminated).toBe(true)
  })

  it('probes once however many screens ask', async () => {
    const created = install('reply')
    await Promise.all([scannerBlocked(), scannerBlocked(), scannerBlocked()])
    expect(created).toHaveLength(1)
  })

  it('stays quiet where Worker does not exist, which is not this bug', async () => {
    vi.stubGlobal('Worker', undefined)
    await expect(scannerBlocked()).resolves.toBeNull()
  })
})
