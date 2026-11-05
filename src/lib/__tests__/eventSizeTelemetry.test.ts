/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, type Event } from 'nostr-tools'
import { secp256k1 } from '@noble/curves/secp256k1.js'

import { createReporter, eventBytes, FLUSH_AT, MAX_QUEUE, type EventSizeEntry } from '../eventSizeTelemetry'

const sign = (content: string, kind = 1): Event =>
  finalizeEvent({ kind, created_at: 1_700_000_000, tags: [], content }, secp256k1.utils.randomSecretKey())

class FakeDoc extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible'
}

describe('eventSizeTelemetry (#532)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doUnmock('nostr-tools')
    vi.doUnmock('../nap')
    vi.doUnmock('../nip98')
  })

  it('counts UTF-8 bytes of the JSON, not UTF-16 length', () => {
    const e = sign('Pay 5000 XAF \u20ac \u{1F600} caf\u00e9')
    expect(eventBytes(e)).toBe(new TextEncoder().encode(JSON.stringify(e)).length)
    expect(eventBytes(e)).toBeGreaterThan(JSON.stringify(e).length)
  })

  it('sends exactly {events:[{kind,bytes,path}]} and nothing else', async () => {
    const sent: EventSizeEntry[][] = []
    const r = createReporter({ send: async (b) => (sent.push(b), true), doc: null })
    const e = sign('x', 1059)
    r.record(e)
    await r.flush()
    expect(sent).toEqual([[{ kind: 1059, bytes: eventBytes(e), path: 'relay' }]])
    expect(Object.keys(sent[0][0]).sort()).toEqual(['bytes', 'kind', 'path'])
    r.stop()
  })

  it('flushes on the 30 s timer', async () => {
    const send = vi.fn(async () => true)
    const r = createReporter({ send, doc: null })
    r.record(sign('a'))
    expect(send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(send).toHaveBeenCalledTimes(1)
    r.stop()
  })

  it('flushes at 50 queued', async () => {
    const send = vi.fn(async () => true)
    const r = createReporter({ send, doc: null })
    for (let i = 0; i < FLUSH_AT - 1; i++) r.record(sign('a'))
    await vi.advanceTimersByTimeAsync(0)
    expect(send).not.toHaveBeenCalled()
    r.record(sign('a'))
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(1)
    expect((send.mock.calls[0] as unknown as [EventSizeEntry[]])[0]).toHaveLength(FLUSH_AT)
    r.stop()
  })

  it('flushes when the page goes hidden', async () => {
    const send = vi.fn(async () => true)
    const doc = new FakeDoc()
    const r = createReporter({ send, doc: doc as unknown as Document })
    r.record(sign('a'))
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(1)
    r.stop()
  })

  it('drops a batch on failure, never retries', async () => {
    const send = vi.fn(async () => {
      throw new Error('down')
    })
    const r = createReporter({ send, doc: null })
    r.record(sign('a'))
    await r.flush()
    expect(r.pending()).toBe(0)
    await r.flush()
    expect(send).toHaveBeenCalledTimes(1)
    r.stop()
  })

  it('caps the queue, dropping the oldest', () => {
    // A sender that never settles keeps the flush loop parked, so the queue can grow to the cap.
    const blocked = createReporter({ send: () => new Promise(() => {}), doc: null })
    const e = sign('a')
    for (let i = 0; i < MAX_QUEUE * 3; i++) blocked.record(e)
    expect(blocked.pending()).toBeLessThanOrEqual(MAX_QUEUE)
    blocked.stop()
  })

  it('sends nothing without a signer', async () => {
    vi.doMock('../nap', () => ({ getSigner: () => { throw new Error('No signer') } }))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { defaultSender } = await import('../eventSizeTelemetry')
    expect(await defaultSender([{ kind: 1, bytes: 10, path: 'relay' }])).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends nothing while the signer is locked', async () => {
    vi.doMock('../nap', () => ({ getSigner: () => ({ hasKey: () => false, signEvent: vi.fn() }) }))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { defaultSender } = await import('../eventSizeTelemetry')
    expect(await defaultSender([{ kind: 1, bytes: 10, path: 'relay' }])).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('signs with NIP-98 and posts the contract body with keepalive', async () => {
    const signer = { hasKey: () => true, signEvent: vi.fn() }
    const signedFetch = vi.fn(async () => new Response(null, { status: 204 }))
    vi.doMock('../nap', () => ({ getSigner: () => signer }))
    vi.doMock('../nip98', () => ({ signedFetch }))
    const { defaultSender } = await import('../eventSizeTelemetry')
    const events: EventSizeEntry[] = [{ kind: 1059, bytes: 55121, path: 'relay' }]
    expect(await defaultSender(events)).toBe(true)
    expect(signedFetch).toHaveBeenCalledWith('/api/v1/telemetry/event-sizes', 'POST', { events }, signer, { keepalive: true })
  })

  describe('relay.publish', () => {
    const mockPool = (outcomes: Array<Promise<string>>) => {
      vi.doMock('nostr-tools', async (orig) => ({
        ...(await orig<typeof import('nostr-tools')>()),
        SimplePool: class {
          publish = () => outcomes
          close() {}
        },
      }))
    }

    it('measures once per publish, however many relays', async () => {
      mockPool([Promise.resolve(''), Promise.resolve(''), Promise.resolve('')])
      const record = vi.fn()
      vi.doMock('../eventSizeTelemetry', () => ({ recordRelayPublish: record }))
      vi.doMock('../nip98', () => ({ signedFetch: vi.fn(async () => new Response(null)) }))
      const { publish } = await import('../relay')
      const e = sign('a')
      const r = await publish(e, ['ws://a', 'ws://b', 'ws://c'])
      expect(r.total).toBe(3)
      expect(record).toHaveBeenCalledTimes(1)
      expect(record).toHaveBeenCalledWith(e)
      vi.doUnmock('../eventSizeTelemetry')
    })

    it('still resolves when telemetry throws', async () => {
      mockPool([Promise.resolve('')])
      vi.doMock('../eventSizeTelemetry', () => ({
        recordRelayPublish: () => {
          throw new Error('boom')
        },
      }))
      vi.doMock('../nip98', () => ({ signedFetch: vi.fn(async () => new Response(null)) }))
      const { publish } = await import('../relay')
      // recordRelayPublish never throws in production; even if it did, publish must not fail.
      await expect(publish(sign('a'), ['ws://a'])).resolves.toMatchObject({ ok: 1 })
      vi.doUnmock('../eventSizeTelemetry')
    })
  })
})
