/**
 * Spec 049 FR-027a-d: remembering a check across this device and the stall's other devices, with
 * the review's attacks and races (049-check-memory-review.md H1, M1, M2, M4, L3).
 */
import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools'

import { MAX_EVENTS, PAGE, SAME_CHECK_SECONDS, flushCheckOutbox, rememberCheck, type CheckDevice, type KeyValueStore } from '../checkMemory'
import { CHECK_KIND, checkLocator } from '../checks'
import { signOwnerAttestation } from '../../ownerAttestation'

const stallKey = generateSecretKey()
const STALL = getPublicKey(stallKey)
const PAYMENT = 'ab'.repeat(32)
const T0 = 1_795_000_000

function memStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) }
}

/** One shared cache, as the gateway is, honouring `limit` and `until` newest-first like a relay. */
function network() {
  const events: Event[] = []
  let up = true
  const queries: Record<string, unknown>[] = []
  return {
    events,
    queries,
    setUp: (v: boolean) => (up = v),
    publish: async (e: Event) => (up ? (events.push(e), true) : false),
    query: async (filter: Record<string, unknown>) => {
      queries.push(filter)
      if (!up) throw new Error('gateway unreachable')
      const want = (filter.tags as Record<string, string[]>)['#x'][0]
      const until = filter.until as number | undefined
      return events
        .filter((e) => e.tags.some((t) => t[0] === 'x' && t[1] === want) && (until === undefined || e.created_at <= until))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, filter.limit as number)
    },
  }
}

function till(net: ReturnType<typeof network>, clock: { t: number }, store = memStore()): CheckDevice & { pub: string } {
  const key = generateSecretKey()
  const pub = getPublicKey(key)
  const role = 'issue-and-redeem'
  const until = T0 + 30 * 86_400
  return {
    pub,
    device: pub,
    withKey: (use) => use(key),
    terminal: {
      stall_pubkey: STALL,
      lock_key: pub,
      role,
      expires_at: String(until),
      owner_attestation: signOwnerAttestation({ stallPubkey: STALL, lockKey: pub, role, expiresAt: until }, { pubkey: STALL, withPrivkey: (use) => use(stallKey) }),
    },
    publish: net.publish,
    query: net.query,
    store,
    now: () => clock.t,
  }
}

function owner(net: ReturnType<typeof network>, clock: { t: number }, names: Record<string, string> = {}, store = memStore(), revoked: Record<string, number> = {}): CheckDevice {
  return {
    device: STALL,
    withKey: (use) => use(stallKey),
    roster: { keys: new Map(Object.keys(names).map((k) => [k, revoked[k]])), nameOf: (k) => names[k] ?? 'A terminal no longer listed' },
    publish: net.publish,
    query: net.query,
    store,
    now: () => clock.t,
  }
}

const junk = (n: number, at: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => {
    // Cheap stand-ins: unique ids under the locator. Their signatures never get that far.
    const id = i.toString(16).padStart(64, '0')
    return { id, kind: CHECK_KIND, pubkey: 'ee'.repeat(32), created_at: at(i), tags: [['x', checkLocator(STALL, PAYMENT)]], content: 'junk', sig: '00'.repeat(64) } as Event
  })

describe('rememberCheck', () => {
  it('first check: nothing earlier, and it is published', async () => {
    const net = network()
    const clock = { t: T0 }
    expect(await rememberCheck(till(net, clock), STALL, PAYMENT)).toEqual({ prior: [], known: true, record: 'published' })
    expect(net.events).toHaveLength(1)
  })

  it('a second till sees the first one’s check as "another till", never by name', async () => {
    const net = network()
    const clock = { t: T0 }
    await rememberCheck(till(net, clock), STALL, PAYMENT)
    clock.t += 120
    expect((await rememberCheck(till(net, clock), STALL, PAYMENT)).prior).toEqual([{ at: T0, by: { kind: 'another_till' } }])
  })

  it('the owner sees which till checked, by its roster name', async () => {
    const net = network()
    const clock = { t: T0 }
    const t = till(net, clock)
    await rememberCheck(t, STALL, PAYMENT)
    clock.t += 60
    expect((await rememberCheck(owner(net, clock, { [t.pub]: 'Till 2' }), STALL, PAYMENT)).prior).toEqual([{ at: T0, by: { kind: 'named_till', name: 'Till 2' } }])
  })

  it('the owner does not count a revoked till’s later checks', async () => {
    const net = network()
    const clock = { t: T0 }
    const t = till(net, clock)
    await rememberCheck(t, STALL, PAYMENT)
    clock.t += 60
    const m = await rememberCheck(owner(net, clock, { [t.pub]: 'Till 2' }, memStore(), { [t.pub]: T0 - 1 }), STALL, PAYMENT)
    expect(m.prior).toEqual([])
  })

  it('a till sees the owner’s check as the owner’s', async () => {
    const net = network()
    const clock = { t: T0 }
    await rememberCheck(owner(net, clock), STALL, PAYMENT)
    clock.t += 60
    expect((await rememberCheck(till(net, clock), STALL, PAYMENT)).prior).toEqual([{ at: T0, by: { kind: 'owner' } }])
  })

  it('the owner’s phone and laptop are told apart (M4)', async () => {
    const net = network()
    const clock = { t: T0 }
    const phone = owner(net, clock)
    await rememberCheck(phone, STALL, PAYMENT)
    clock.t += 60
    expect((await rememberCheck(owner(net, clock), STALL, PAYMENT)).prior).toEqual([{ at: T0, by: { kind: 'owner_other_device' } }])
    clock.t += 60
    const again = await rememberCheck(phone, STALL, PAYMENT)
    expect(again.prior.map((p) => p.by.kind)).toEqual(['this_device', 'owner_other_device'])
  })

  it('the same device a minute later: "this device", listed once', async () => {
    const net = network()
    const clock = { t: T0 }
    const t = till(net, clock)
    await rememberCheck(t, STALL, PAYMENT)
    clock.t += 60
    expect((await rememberCheck(t, STALL, PAYMENT)).prior).toEqual([{ at: T0, by: { kind: 'this_device' } }])
  })

  it('a re-render within seconds is the same check: not a repeat, not published twice', async () => {
    const net = network()
    const clock = { t: T0 }
    const t = till(net, clock)
    await rememberCheck(t, STALL, PAYMENT)
    clock.t += SAME_CHECK_SECONDS - 1
    expect(await rememberCheck(t, STALL, PAYMENT)).toEqual({ prior: [], known: true, record: null })
    expect(net.events).toHaveLength(1)
  })

  it('a clock stepped back stays the same check (L3)', async () => {
    const net = network()
    const clock = { t: T0 }
    const t = till(net, clock)
    await rememberCheck(t, STALL, PAYMENT)
    clock.t -= 5
    expect((await rememberCheck(t, STALL, PAYMENT)).record).toBeNull()
    expect(net.events).toHaveLength(1)
  })

  it('two overlapping checks publish once (M2)', async () => {
    const net = network()
    const clock = { t: T0 }
    const t = till(net, clock)
    const [a, b] = await Promise.all([rememberCheck(t, STALL, PAYMENT), rememberCheck(t, STALL, PAYMENT)])
    expect([a.record, b.record].sort()).toEqual([null, 'published'].sort())
    expect(net.events).toHaveLength(1)
  })

  it('offline: unknown, remembers its own checks, and the outbox sends them later', async () => {
    const net = network()
    const clock = { t: T0 }
    const t = till(net, clock)
    net.setUp(false)
    expect(await rememberCheck(t, STALL, PAYMENT)).toEqual({ prior: [], known: false, record: 'deferred' })
    clock.t += 60
    const again = await rememberCheck(t, STALL, PAYMENT)
    expect(again.known).toBe(false)
    expect(again.prior).toEqual([{ at: T0, by: { kind: 'this_device' } }])
    net.setUp(true)
    expect(await flushCheckOutbox(t)).toBe(0)
    expect(net.events).toHaveLength(2)
    clock.t += 60
    expect((await rememberCheck(till(net, clock), STALL, PAYMENT)).prior).toHaveLength(2)
  })

  it('back online, this device lists its own check once, not twice', async () => {
    const net = network()
    const clock = { t: T0 }
    const t = till(net, clock)
    await rememberCheck(t, STALL, PAYMENT)
    clock.t += 60
    expect((await rememberCheck(t, STALL, PAYMENT)).prior).toHaveLength(1)
  })

  it('overlapping flushes send each event once', async () => {
    const net = network()
    const clock = { t: T0 }
    const t = till(net, clock)
    net.setUp(false)
    await rememberCheck(t, STALL, PAYMENT)
    net.setUp(true)
    const sent: string[] = []
    const counting = { ...t, publish: async (e: Event) => (sent.push(e.id), net.publish(e)) }
    await Promise.all([flushCheckOutbox(counting), flushCheckOutbox(counting)])
    expect(sent).toHaveLength(1)
  })

  it('a flood of junk under the locator cannot hide a real check (H1)', async () => {
    const net = network()
    const clock = { t: T0 }
    await rememberCheck(till(net, clock), STALL, PAYMENT)
    // Newer than the real check, spread over seconds, more than a page of them.
    net.events.push(...junk(PAGE + 200, (i) => T0 + 1 + i))
    clock.t += 3600
    const m = await rememberCheck(till(net, clock), STALL, PAYMENT)
    expect(m.known).toBe(true)
    expect(m.prior).toEqual([{ at: T0, by: { kind: 'another_till' } }])
    expect(net.queries.filter((q) => q.until !== undefined).length).toBeGreaterThan(0)
  })

  it('a flood packed into one second makes the history unknown, never first (H1)', async () => {
    const net = network()
    const clock = { t: T0 }
    await rememberCheck(till(net, clock), STALL, PAYMENT)
    net.events.push(...junk(PAGE + 1, () => T0 + 30))
    clock.t += 60
    const m = await rememberCheck(till(net, clock), STALL, PAYMENT)
    expect(m).toMatchObject({ known: false, prior: [] })
  })

  it('past the cap the history is unknown, never first', async () => {
    const net = network()
    const clock = { t: T0 + 86_400 }
    net.events.push(...junk(MAX_EVENTS + 1, (i) => T0 + i))
    expect((await rememberCheck(till(net, clock), STALL, PAYMENT)).known).toBe(false)
  })

  it('a check dated before the payment does not count (M6)', async () => {
    const net = network()
    const clock = { t: T0 }
    await rememberCheck(till(net, clock), STALL, PAYMENT)
    clock.t += 60
    expect((await rememberCheck(till(net, clock), STALL, PAYMENT, T0 + 3600)).prior).toEqual([])
  })

  it('another payment’s checks are not this one’s', async () => {
    const net = network()
    const clock = { t: T0 }
    await rememberCheck(till(net, clock), STALL, 'cd'.repeat(32))
    clock.t += 60
    expect((await rememberCheck(till(net, clock), STALL, PAYMENT)).prior).toEqual([])
  })

  it('a corrupt local record is ignored, not fatal', async () => {
    const net = network()
    const clock = { t: T0 }
    const store = memStore()
    const t = till(net, clock, store)
    store.data.set(`imani:receipt-checks:${t.pub}`, '{not json')
    store.data.set(`imani:receipt-check-outbox:${t.pub}`, '[1,2,{"id":3}]')
    store.data.set('imani:receipt-check-device', 'not-hex')
    expect((await rememberCheck(t, STALL, PAYMENT)).record).toBe('published')
  })
})
