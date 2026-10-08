/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, getPublicKey, nip44, type Event, type EventTemplate } from 'nostr-tools'
import type { VoucherRow } from '@imani/wallet-storage'

/**
 * #203: a coupon backup too large for one relay event.
 *
 * Real NIP-44 and real signatures, so the sizes measured here are the sizes a
 * relay would see. The relay is a stub that behaves like strfry: it refuses
 * any event over 65,536 bytes with `OK false "invalid: event too large: n"`.
 */
const sk = new Uint8Array(32).fill(7)
const pk = getPublicKey(sk)
const key = nip44.getConversationKey(sk, pk)

const relay = vi.hoisted(() => ({
  events: [] as Event[],
  refused: [] as number[],
  /** Drop the n-th accepted publish (0-based) without storing it. */
  dropIndex: -1,
  publishes: 0,
}))

vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: pk,
    nip44Encrypt: (_to: string, plain: string) => nip44.encrypt(plain, key),
    nip44Decrypt: (_from: string, cipher: string) => nip44.decrypt(cipher, key),
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
  }),
}))
vi.mock('../relay', () => ({
  allEvents: async () => relay.events,
  publish: async (event: Event) => {
    const size = new TextEncoder().encode(JSON.stringify(event)).length
    if (size > 65_536) {
      relay.refused.push(size)
      return { ok: 0, total: 1, errors: [`invalid: event too large: ${size}`] }
    }
    if (relay.publishes++ !== relay.dropIndex) relay.events.push(event)
    return { ok: 1, total: 1, errors: [] }
  },
}))
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({ validateToken: async () => ({ state: 'UNSPENT' }) }),
}))
const store = vi.hoisted(() => ({ restored: [] as VoucherRow[], held: [] as VoucherRow[] }))
vi.mock('../wallet', () => ({
  addRestoredVoucher: async (row: VoucherRow) => {
    store.restored.push(row)
  },
  getWallet: () => ({ getAllVouchers: async () => store.held }),
  notifyWalletChanged: () => undefined,
}))

import { backfillVouchers, publishVoucher, restoreVouchers } from '../voucherRecords'
import {
  EVENT_BUDGET_BYTES,
  RELAY_MAX_EVENT_BYTES,
  buildRecordEvents,
  estimateEventBytes,
  nip44PayloadLength,
} from '../chunkedRecord'

/** The real 7-proof, 5,405-sat terminal coupon from the 2026-10-08 gate run (#203). */
const TERMINAL_TOKEN = readFileSync(
  new URL('./fixtures/terminal-coupon-7-proofs.txt', import.meta.url),
  'utf8',
).trim()

const row = (token: string, tokenId = 'ab'.repeat(32)): VoucherRow =>
  ({
    token_id: tokenId,
    token,
    amount: 5405,
    face_value: 400,
    face_unit: 'EUR',
    face_decimals: 2,
    issuer_id: 'cd'.repeat(32),
    created_at: '2026-10-08T06:18:36.000Z',
    updated_at: '2026-10-08T06:18:36.000Z',
  }) as VoucherRow

/** Random base64url, which gzip cannot shrink. */
function noise(n: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let out = ''
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(Math.min(60_000, n - out.length)))) out += alphabet[b % 64]
  }
  return out
}

const bytes = (e: Event) => new TextEncoder().encode(JSON.stringify(e)).length
const sealer = {
  encrypt: (p: string) => nip44.encrypt(p, key),
  decrypt: (c: string) => nip44.decrypt(c, key),
}

beforeEach(() => {
  relay.events = []
  relay.refused = []
  relay.dropIndex = -1
  relay.publishes = 0
  store.restored = []
  store.held = []
})

describe('the size model', () => {
  it('matches what NIP-44 and signing actually produce', async () => {
    for (const len of [1, 32, 33, 300, 4_000, 30_000, 40_961, 49_000]) {
      const [t] = await buildRecordEvents(7375, 'x', 'a'.repeat(len), [['spent', 'false']], sealer, {
        budget: 1e9,
      })
      expect(t.content.length).toBe(nip44PayloadLength(len))
      const signed = finalizeEvent(t, sk)
      // The estimate may round up, never down.
      const est = estimateEventBytes(len, t.tags)
      expect(est).toBeGreaterThanOrEqual(bytes(signed))
      expect(est - bytes(signed)).toBeLessThan(16)
    }
  })

  it('keeps the budget clear of the relay limit', () => {
    expect(EVENT_BUDGET_BYTES).toBeLessThan(RELAY_MAX_EVENT_BYTES)
  })
})

describe('publishVoucher with the real 7-proof terminal coupon', () => {
  it('is accepted by a 65,536-byte relay, every event, and restores intact', async () => {
    const coupon = row(TERMINAL_TOKEN)
    await publishVoucher(coupon)

    expect(relay.refused).toEqual([])
    expect(relay.events.length).toBeGreaterThan(0)
    for (const e of relay.events) expect(bytes(e)).toBeLessThanOrEqual(EVENT_BUDGET_BYTES)

    const restored = await restoreVouchers(pk)
    expect(restored).toBe(1)
    expect(store.restored[0]).toEqual(coupon)
  })

  it('needs fewer events than the record would fill uncompressed (gzip pays)', async () => {
    await publishVoucher(row(TERMINAL_TOKEN))
    // 41 KB of JSON, 7 KB gzipped: one chunk.
    expect(relay.events).toHaveLength(1)
    expect(relay.events[0].tags).toContainEqual(['compressed', 'gzip'])
  })
})

describe('the threshold', () => {
  /** A token whose plain record estimates at exactly `target` bytes. */
  async function tokenSizedTo(target: number): Promise<string> {
    let lo = 1
    let hi = 60_000
    const sizeFor = async (n: number) => {
      const r = row('cashuB' + 'A'.repeat(n))
      const [t] = await buildRecordEvents(7375, r.token_id!, JSON.stringify({ voucher: r }), [['spent', 'false']], sealer, {
        budget: 1e9,
      })
      return estimateEventBytes(new TextEncoder().encode(JSON.stringify({ voucher: r })).length, t.tags)
    }
    // NIP-44 padding makes the size a step function; find the largest n at or under target.
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if ((await sizeFor(mid)) <= target) lo = mid
      else hi = mid - 1
    }
    return 'cashuB' + 'A'.repeat(lo)
  }

  it('publishes a record at the limit as ONE plain NIP-60 event', async () => {
    const coupon = row(await tokenSizedTo(EVENT_BUDGET_BYTES))
    await publishVoucher(coupon)

    expect(relay.events).toHaveLength(1)
    const [e] = relay.events
    expect(e.kind).toBe(7375)
    expect(e.tags.find(([n]) => n === 'd')?.[1]).toBe(coupon.token_id)
    expect(e.tags.some(([n]) => n === 'chunk')).toBe(false)
    // Plain JSON inside, as any NIP-60 reader expects.
    expect(JSON.parse(nip44.decrypt(e.content, key))).toEqual({ voucher: coupon })
  })

  it('chunks a record just over the limit', async () => {
    const small = await tokenSizedTo(EVENT_BUDGET_BYTES)
    // The next NIP-44 padding step up.
    const coupon = row(small + 'A'.repeat(2_000))
    await publishVoucher(coupon)

    expect(relay.refused).toEqual([])
    expect(relay.events.every((e) => e.tags.some(([n]) => n === 'chunk'))).toBe(true)
    expect(await restoreVouchers(pk)).toBe(1)
    expect(store.restored[0]).toEqual(coupon)
  })

  it('splits into several chunks when gzip cannot shrink it, each under budget', async () => {
    const coupon = row('cashuB' + noise(90_000))
    await publishVoucher(coupon)

    expect(relay.refused).toEqual([])
    expect(relay.events.length).toBeGreaterThan(1)
    const totals = relay.events.map((e) => e.tags.find(([n]) => n === 'chunk')?.[2])
    expect(new Set(totals).size).toBe(1)
    for (const e of relay.events) expect(bytes(e)).toBeLessThanOrEqual(EVENT_BUDGET_BYTES)
    expect(await restoreVouchers(pk)).toBe(1)
    expect(store.restored[0]).toEqual(coupon)
  })
})

describe('restore refuses a damaged chunk set', () => {
  async function publishNoise(): Promise<VoucherRow> {
    const coupon = row('cashuB' + noise(90_000))
    await publishVoucher(coupon)
    expect(relay.events.length).toBeGreaterThan(1)
    return coupon
  }

  it('skips a coupon with a missing chunk, and back-fill publishes it again', async () => {
    const coupon = await publishNoise()
    relay.events.splice(1, 1)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await restoreVouchers(pk)).toBe(0)

    store.held = [coupon]
    expect(await backfillVouchers(pk)).toBe(1)
    store.held = []
    expect(await restoreVouchers(pk)).toBe(1)
    expect(store.restored[0]).toEqual(coupon)
  })

  it('skips a coupon whose chunk was tampered with (payload hash)', async () => {
    await publishNoise()
    const victim = relay.events[0]
    const plain = nip44.decrypt(victim.content, key)
    const flipped = (plain[10] === 'A' ? 'B' : 'A')
    relay.events[0] = finalizeEvent(
      { ...victim, content: nip44.encrypt(plain.slice(0, 10) + flipped + plain.slice(11), key) },
      sk,
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await restoreVouchers(pk)).toBe(0)
    expect(warn.mock.calls.some(([m]) => String(m).includes('chunked coupon record unreadable'))).toBe(true)
  })

  it('does not count a half-published coupon as backed up', async () => {
    relay.dropIndex = 0
    const coupon = await publishNoise()
    store.held = [coupon]
    expect(await backfillVouchers(pk)).toBe(1)
  })
})

describe('legacy and tombstones', () => {
  it('still restores a single-event record written before #203', async () => {
    const coupon = row('cashuBsmall')
    relay.events.push(
      finalizeEvent(
        {
          kind: 7375,
          created_at: 100,
          tags: [
            ['d', coupon.token_id!],
            ['spent', 'false'],
          ],
          content: nip44.encrypt(JSON.stringify({ voucher: coupon }), key),
        },
        sk,
      ),
    )
    expect(await restoreVouchers(pk)).toBe(1)
    expect(store.restored[0]).toEqual(coupon)
  })

  it('lets a plain tombstone beat a chunked record', async () => {
    const coupon = row(TERMINAL_TOKEN)
    await publishVoucher(coupon)
    relay.events.push(
      finalizeEvent(
        {
          kind: 7375,
          created_at: 1,
          tags: [
            ['d', coupon.token_id!],
            ['spent', 'true'],
          ],
          content: nip44.encrypt(JSON.stringify({ spent: true }), key),
        },
        sk,
      ),
    )
    expect(await restoreVouchers(pk)).toBe(0)
  })

  it('back-fill treats a complete chunked record as known', async () => {
    const coupon = row(TERMINAL_TOKEN)
    await publishVoucher(coupon)
    store.held = [coupon]
    expect(await backfillVouchers(pk)).toBe(0)
  })
})

describe('a relay refusal is not silent', () => {
  it('logs the relay reason when the record is refused', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // Force a single event far past the relay limit by lifting our own budget.
    const { VOUCHER_CHUNKING } = await import('../voucherRecords')
    VOUCHER_CHUNKING.budget = 1e9
    try {
      await publishVoucher(row('cashuB' + 'A'.repeat(70_000)))
    } finally {
      delete VOUCHER_CHUNKING.budget
    }
    expect(relay.refused.length).toBe(1)
    expect(String(error.mock.calls[0]?.[1])).toMatch(/event too large/)
  })
})
