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
  /** #540 F6: every full read of the kind (`allEvents`). */
  fullReads: 0,
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
  allEvents: async () => {
    relay.fullReads++
    return relay.events
  },
  allEventsWithGateway: async () => relay.events,
  // #540 F6: a `#d` read, filtered as the gateway filters it.
  eventsByD: async (_pk: string, kind: number, ds: string[]) =>
    relay.events.filter((e) => e.kind === kind && e.tags.some(([n, v]) => n === 'd' && ds.includes(v))),
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

import { backfillVouchers, publishVoucher, restoreVouchers, tombstoneVoucher } from '../voucherRecords'
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

  it('#532: kind-7375 token events share the one wrap budget, 55,121 bytes', () => {
    expect(EVENT_BUDGET_BYTES).toBe(55_121)
  })

  it('#532: a record the size of the 65,381-byte 7375 found on staging is no longer one event', async () => {
    // Plaintext whose single NIP-44 event would be ~65.4 KB: under the relay limit, over the budget.
    const plain = noise(48_000)
    expect(estimateEventBytes(plain.length, [['d', 'x'], ['spent', 'false']])).toBeGreaterThan(EVENT_BUDGET_BYTES)
    const templates = await buildRecordEvents(7375, 'ab'.repeat(32), plain, [['spent', 'false']], sealer)
    expect(templates.length).toBeGreaterThan(1)
    for (const t of templates) expect(bytes(finalizeEvent(t, sk))).toBeLessThanOrEqual(EVENT_BUDGET_BYTES)
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

/** Re-sign an event with new tags/content, as a different writer or a retry would. */
const resign = (e: Event, patch: Partial<EventTemplate>) =>
  finalizeEvent({ kind: e.kind, created_at: e.created_at, tags: e.tags, content: e.content, ...patch }, sk)

describe('relay order (review M1)', () => {
  it('restores when the relay returns chunks newest-first, shuffled and duplicated', async () => {
    const coupon = row('cashuB' + noise(150_000))
    await publishVoucher(coupon)
    expect(relay.events.length).toBeGreaterThan(2)
    // strfry: created_at desc, then id. All chunks share created_at, so the
    // order is by event id, i.e. random. Reverse AND shuffle AND replay one.
    const sorted = [...relay.events].sort((a, b) => (a.id < b.id ? 1 : -1))
    let shuffled = [sorted[sorted.length - 1], ...sorted.slice(0, -1)].reverse()
    // Event ids are random, so that permutation can land on the publish order
    // by chance (it flaked in a full run, #326 review). Rotate until it differs.
    while (shuffled.map((e) => e.id).join() === relay.events.map((e) => e.id).join()) {
      shuffled = [...shuffled.slice(1), shuffled[0]]
    }
    expect(shuffled.map((e) => e.id)).not.toEqual(relay.events.map((e) => e.id))
    relay.events = [...shuffled, shuffled[1]]
    expect(await restoreVouchers(pk)).toBe(1)
    expect(store.restored[0]).toEqual(coupon)
  })
})

describe('a misconfigured chunk size is loud (review L1)', () => {
  it('throws rather than build a chunk event over the budget', async () => {
    await expect(
      buildRecordEvents(7375, 'ab'.repeat(32), noise(200_000), [['spent', 'false']], sealer, { chunkSize: 60_000 }),
    ).rejects.toThrow(new RegExp(`over the ${EVENT_BUDGET_BYTES} budget`))
  })
})

describe('v0.3.0 chunk shapes (review V1, V2)', () => {
  it('restores chunks that carry no d tag, by their record_id tag', async () => {
    const coupon = row('cashuB' + noise(90_000))
    await publishVoucher(coupon)
    expect(relay.events.every((e) => e.tags.some(([n, v]) => n === 'record_id' && v === coupon.token_id))).toBe(true)
    relay.events = relay.events.map((e) => resign(e, { tags: e.tags.filter(([n]) => n !== 'd') }))
    expect(await restoreVouchers(pk)).toBe(1)
    expect(store.restored[0]).toEqual(coupon)
    store.held = [coupon]
    expect(await backfillVouchers(pk)).toBe(0)
  })

  it('still restores chunks written with only d=<id>-chunk-n (pre-record_id)', async () => {
    const coupon = row('cashuB' + noise(90_000))
    await publishVoucher(coupon)
    relay.events = relay.events.map((e) => resign(e, { tags: e.tags.filter(([n]) => n !== 'record_id') }))
    expect(await restoreVouchers(pk)).toBe(1)
    expect(store.restored[0]).toEqual(coupon)
  })

  it('reports, never silently drops, a chunk set with no record id at all', async () => {
    await publishVoucher(row('cashuB' + noise(90_000)))
    relay.events = relay.events.map((e) => resign(e, { tags: e.tags.filter(([n]) => n !== 'record_id' && n !== 'd') }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await restoreVouchers(pk)).toBe(0)
    expect(warn.mock.calls.some(([m]) => String(m).includes('unreadable'))).toBe(true)
  })

  it('accepts a retried chunk: same plaintext, new nonce, new event id', async () => {
    const coupon = row('cashuB' + noise(90_000))
    await publishVoucher(coupon)
    const first = relay.events[0]
    relay.events.push(resign(first, { content: nip44.encrypt(nip44.decrypt(first.content, key), key) }))
    expect(await restoreVouchers(pk)).toBe(1)
    expect(store.restored[0]).toEqual(coupon)
  })
})

describe('back-fill trusts only a verified chunk set (review L4)', () => {
  it('republishes a coupon whose complete chunk set fails the payload hash', async () => {
    const coupon = row('cashuB' + noise(90_000))
    await publishVoucher(coupon)
    const victim = relay.events[0]
    const plain = nip44.decrypt(victim.content, key)
    relay.events[0] = resign(victim, {
      content: nip44.encrypt((plain[0] === 'A' ? 'B' : 'A') + plain.slice(1), key),
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    store.held = [coupon]
    expect(await backfillVouchers(pk)).toBe(1)
  })
})

describe('orphan chunks do not warn on every login (review L3)', () => {
  it('is quiet about an orphan once a complete snapshot of the same coupon exists', async () => {
    const coupon = row('cashuB' + noise(90_000))
    await publishVoucher(coupon)
    relay.events.splice(1) // orphan: only chunk 0 of snapshot A landed
    await publishVoucher(coupon) // back-fill's republish: snapshot B, complete
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await restoreVouchers(pk)).toBe(1)
    expect(await restoreVouchers(pk)).toBe(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns about a genuinely unrecoverable set once per session, not per login', async () => {
    await publishVoucher(row('cashuB' + noise(90_000), 'f1'.repeat(32)))
    relay.events.splice(1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await restoreVouchers(pk)
    await restoreVouchers(pk)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('NIP-09 cleanup of dead chunks (review L2)', () => {
  const deletions = () => relay.events.filter((e) => e.kind === 5)
  const deleted = () => new Set(deletions().flatMap((e) => e.tags.filter(([n]) => n === 'e').map(([, v]) => v)))

  it('asks the relay to delete the chunks of a tombstoned coupon', async () => {
    const coupon = row('cashuB' + noise(90_000))
    await publishVoucher(coupon)
    const chunkIds = relay.events.map((e) => e.id)
    await tombstoneVoucher(coupon.token_id!)
    expect([...deleted()].sort()).toEqual([...chunkIds].sort())
    expect(deletions().every((e) => e.tags.some(([n, v]) => n === 'k' && v === '7375'))).toBe(true)
    expect(await restoreVouchers(pk)).toBe(0)
  })

  it('#540 F7: a tombstone this device writes is in the warm spent set at once', async () => {
    const { spentTokenIds, forgetSpentIds } = await import('../spentCoupons')
    forgetSpentIds()
    const coupon = row('cashuB' + noise(10))
    await publishVoucher(coupon)
    expect((await spentTokenIds(pk)).ids.has(coupon.token_id!)).toBe(false)
    const reads = relay.fullReads
    await tombstoneVoucher(coupon.token_id!)
    expect((await spentTokenIds(pk)).ids.has(coupon.token_id!)).toBe(true)
    expect(relay.fullReads).toBe(reads)
    forgetSpentIds()
  })

  it('#540 F6: finds the chunks by their d tags, never by reading every 7375 event', async () => {
    const coupon = row('cashuB' + noise(90_000))
    const other = row('cashuB' + noise(90_000), 'e2'.repeat(32))
    await publishVoucher(coupon)
    const chunkIds = relay.events.map((e) => e.id)
    await publishVoucher(other)
    relay.fullReads = 0
    await tombstoneVoucher(coupon.token_id!)
    expect(relay.fullReads).toBe(0)
    // Only this coupon's chunks, not the other coupon's.
    expect([...deleted()].sort()).toEqual([...chunkIds].sort())
  })

  it('back-fill deletes superseded snapshots and keeps the newest complete one', async () => {
    const coupon = row('cashuB' + noise(90_000))
    await publishVoucher(coupon)
    const old = relay.events.map((e) => resign(e, { created_at: e.created_at - 10 }))
    relay.events = [...old]
    await publishVoucher(coupon)
    const fresh = relay.events.slice(old.length).map((e) => e.id)
    store.held = [coupon]
    expect(await backfillVouchers(pk)).toBe(0)
    expect([...deleted()].sort()).toEqual(old.map((e) => e.id).sort())
    for (const id of fresh) expect(deleted().has(id)).toBe(false)
  })

  it('never deletes the only copy of a coupon', async () => {
    const coupon = row(TERMINAL_TOKEN)
    await publishVoucher(coupon)
    store.held = [coupon]
    await backfillVouchers(pk)
    expect(deletions()).toEqual([])
  })
})
