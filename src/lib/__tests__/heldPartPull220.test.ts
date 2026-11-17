/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DmPollService, type CryptoAdapter, type GiftWrapEvent, type NostrdbAdapter, type StorageAdapter } from '@imani/dm-poll'

import { _resetBundleArrivalsForTests, bundleView, trackArrival } from '../bundleArrival'
import { contentOf, createHeldPartPuller, PULL_MIN_INTERVAL_MS, type IncomingPart } from '../heldPartPull'

/**
 * imani-gateway-core#220 B: the recipient pulls bundle parts the gateway holds for it.
 *
 * A real DmPollService, so a pulled part and a gift-wrapped part go through the same parser, the
 * same received-fingerprint set and the same redeem. The redeem credits a balance and counts the
 * part with the real `trackArrival`, which is what the wallet's arrival path does.
 */

const ME = 'a'.repeat(64)
const OTHER = 'd'.repeat(64)
const SENDER = 'b'.repeat(64)
const BUNDLE = '0123456789abcdef0123456789abcdef'

function row(index: number, overrides: Partial<IncomingPart> = {}): IncomingPart {
  return {
    send_id: `send-${index}`,
    token: `cashuBpart${index}`,
    recipient_pubkey: ME,
    sender_pubkey: SENDER,
    created_at: 1_763_390_000 + index,
    face_value: 300,
    face_unit: 'EUR',
    face_decimals: 2,
    bundle_id: BUNDLE,
    bundle_total: 600,
    bundle_part_index: index,
    bundle_part_count: 2,
    ...overrides,
  }
}

function harness() {
  const received = new Set<string>()
  let balance = 0
  const storage: StorageAdapter = {
    saveVoucher: vi.fn(async () => {}),
    hasTokenBeenReceived: vi.fn(async (f: string) => received.has(f)),
    markTokenAsReceived: vi.fn(async (f: string) => {
      received.add(f)
    }),
    getProcessedEventIds: vi.fn(async () => []),
    saveProcessedEventIds: vi.fn(async () => {}),
  } as unknown as StorageAdapter
  // The same JSON body for both paths: a gift wrap unwraps to it, a pull is rebuilt into it.
  const wraps = new Map<string, string>()
  const crypto: CryptoAdapter = {
    unwrapNip17Dm: vi.fn(async (e: GiftWrapEvent) => ({
      eventId: e.id,
      senderPubkey: SENDER,
      content: wraps.get(e.id) ?? '',
      createdAt: 1,
    })),
    extractToken: (c: string) => {
      try {
        return (JSON.parse(c) as { token?: string }).token ?? null
      } catch {
        return null
      }
    },
    parseTokenTransferMessage: (c: string) => {
      const p = JSON.parse(c) as Record<string, unknown>
      return {
        faceValue: p.face_value as number,
        faceUnit: p.face_unit as string,
        bundleId: p.bundle_id as string,
        bundleTotal: p.bundle_total as number,
        bundlePartIndex: p.bundle_part_index as number,
        bundlePartCount: p.bundle_part_count as number,
      }
    },
    getTokenFingerprint: (t: string) => `fp:${t}`,
  } as unknown as CryptoAdapter
  const redeem = vi.fn(async (token: string, opts?: { metadata?: Record<string, number | string> }) => {
    const md = opts?.metadata ?? {}
    balance += Number(md.faceValue)
    await trackArrival(ME, {
      bundleId: String(md.bundleId),
      declaredTotal: Number(md.bundleTotal),
      declaredCount: Number(md.bundlePartCount),
      partIndex: Number(md.bundlePartIndex),
      amount: Number(md.faceValue),
      unit: String(md.faceUnit),
      decimals: 2,
      senderPubkey: SENDER,
    })
    return { token, face_value: md.faceValue } as never
  })
  const svc = new DmPollService({
    recipientPubkey: ME,
    recipientPrivkey: '',
    nostrdbAdapter: { getProfile: vi.fn(async () => null) } as unknown as NostrdbAdapter,
    cryptoAdapter: crypto,
    storageAdapter: storage,
    redemptionAdapter: { checkBacking: () => ({ outcome: 'accept' as const }), redeem } as never,
    enableAutoRedemption: true,
    fetchRecentOnStart: false,
  } as never)
  const dm = (id: string, r: IncomingPart) => {
    wraps.set(id, contentOf(r))
    return svc.processGiftWrap({ id, kind: 1059, pubkey: '', created_at: 1, tags: [], content: '', sig: '' })
  }
  return { svc, redeem, dm, balance: () => balance }
}

function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe('recipient pull of held parts (gateway-core#220 B)', () => {
  beforeEach(() => _resetBundleArrivalsForTests(ME))

  it('a pulled part completes a bundle that is on its way', async () => {
    const h = harness()
    await h.dm('wrap-0', row(0))
    expect((await bundleView(ME, BUNDLE))?.state).toBe('in_flight')
    const ack = vi.fn(async () => ({ state: 'COMPLETED' }))
    const puller = createHeldPartPuller({
      recipientPubkey: ME,
      getIncoming: async () => ({ items: [row(1)], next_since: null }),
      ack,
      receive: (i) => h.svc.processPulledToken(i),
      hasOpenBundle: () => true,
      storage: memoryStorage(),
    })
    await puller.poke('bundle_open')
    const view = await bundleView(ME, BUNDLE)
    expect(view?.state).toBe('complete')
    expect(view?.receivedCount).toBe(2)
    expect(h.balance()).toBe(600)
    expect(ack).toHaveBeenCalledWith('send-1')
    expect(puller.pendingAcks()).toEqual([])
  })

  it('the same part by DM and by pull is credited once, and still acked', async () => {
    const h = harness()
    await h.dm('wrap-0', row(0))
    const ack = vi.fn(async () => ({}))
    const puller = createHeldPartPuller({
      recipientPubkey: ME,
      getIncoming: async () => ({ items: [row(0)], next_since: null }),
      ack,
      receive: (i) => h.svc.processPulledToken(i),
      hasOpenBundle: () => true,
      storage: memoryStorage(),
    })
    await puller.poke('login')
    // And the DM arriving again after the pull changes nothing either.
    await h.dm('wrap-0b', row(0))
    expect(h.redeem).toHaveBeenCalledTimes(1)
    expect(h.balance()).toBe(300)
    expect((await bundleView(ME, BUNDLE))?.receivedCount).toBe(1)
    expect(ack).toHaveBeenCalledWith('send-0')
  })

  it('a pull first, then the DM, is credited once', async () => {
    const h = harness()
    const puller = createHeldPartPuller({
      recipientPubkey: ME,
      getIncoming: async () => ({ items: [row(0)], next_since: null }),
      ack: async () => ({}),
      receive: (i) => h.svc.processPulledToken(i),
      hasOpenBundle: () => true,
      storage: memoryStorage(),
    })
    await puller.poke('login')
    await h.dm('wrap-0', row(0))
    expect(h.redeem).toHaveBeenCalledTimes(1)
    expect((await bundleView(ME, BUNDLE))?.receivedCount).toBe(1)
  })

  it('a gateway without the route (404 or 405) is skipped silently and not asked again', async () => {
    for (const status of [404, 405]) {
      const getIncoming = vi.fn(async () => {
        throw Object.assign(new Error('Not Found'), { status })
      })
      let t = 0
      const puller = createHeldPartPuller({
        recipientPubkey: ME,
        getIncoming,
        ack: vi.fn(),
        receive: vi.fn(),
        hasOpenBundle: () => true,
        now: () => t,
        storage: memoryStorage(),
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await expect(puller.poke('login')).resolves.toBeUndefined()
      t += 10 * PULL_MIN_INTERVAL_MS
      await puller.poke('resume')
      expect(getIncoming).toHaveBeenCalledTimes(1)
      expect(puller.unsupported).toBe(true)
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
    }
  })

  it('an ack that fails is kept and retried on the next pull, without a second swap', async () => {
    const h = harness()
    let t = 0
    const ack = vi
      .fn<(id: string) => Promise<unknown>>()
      .mockRejectedValueOnce(Object.assign(new Error('down'), { status: 503 }))
      .mockResolvedValue({ state: 'COMPLETED' })
    const storage = memoryStorage()
    const deps = {
      recipientPubkey: ME,
      // The gateway still lists it, because the ack never landed.
      getIncoming: async () => ({ items: [row(0)], next_since: null }),
      ack,
      receive: (i: Parameters<typeof h.svc.processPulledToken>[0]) => h.svc.processPulledToken(i),
      hasOpenBundle: () => true,
      now: () => t,
      storage,
    }
    const puller = createHeldPartPuller(deps)
    await puller.poke('login')
    expect(h.balance()).toBe(300)
    expect(puller.pendingAcks()).toEqual(['send-0'])

    // Kept across a reload too.
    const reloaded = createHeldPartPuller(deps)
    expect(reloaded.pendingAcks()).toEqual(['send-0'])

    // Once a minute at most.
    t += 1_000
    await reloaded.poke('resume')
    expect(ack).toHaveBeenCalledTimes(2)
    expect(reloaded.pendingAcks()).toEqual([])
    t += 1_000
    await reloaded.poke('resume')
    expect(ack).toHaveBeenCalledTimes(2)
    expect(h.redeem).toHaveBeenCalledTimes(1)
    expect(h.balance()).toBe(300)
  })

  it('never accepts a part addressed to another key', async () => {
    const h = harness()
    const ack = vi.fn()
    const puller = createHeldPartPuller({
      recipientPubkey: ME,
      getIncoming: async () => ({ items: [row(0, { recipient_pubkey: OTHER }), row(1, { recipient_pubkey: undefined as never })], next_since: null }),
      ack,
      receive: (i) => h.svc.processPulledToken(i),
      hasOpenBundle: () => true,
      storage: memoryStorage(),
    })
    await puller.poke('login')
    expect(h.redeem).not.toHaveBeenCalled()
    expect(ack).not.toHaveBeenCalled()
    expect(h.balance()).toBe(0)
  })

  it('backs off after a failed pull, and is never more than once a minute', async () => {
    let t = 0
    const getIncoming = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { status: 502 })
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const puller = createHeldPartPuller({
      recipientPubkey: ME,
      getIncoming,
      ack: vi.fn(),
      receive: vi.fn(),
      hasOpenBundle: () => true,
      now: () => t,
      storage: memoryStorage(),
    })
    await puller.poke('login')
    t += PULL_MIN_INTERVAL_MS
    await puller.poke('resume')
    expect(getIncoming).toHaveBeenCalledTimes(1)
    t += PULL_MIN_INTERVAL_MS
    await puller.poke('resume')
    expect(getIncoming).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
