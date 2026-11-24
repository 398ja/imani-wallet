/**
 * Spec 049 FR-027a-d: remembering a check across this device and the stall's other devices.
 */
import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools'

import { SAME_CHECK_SECONDS, flushCheckOutbox, rememberCheck, type CheckDevice, type KeyValueStore } from '../checkMemory'
import { signOwnerAttestation } from '../../ownerAttestation'

const stallKey = generateSecretKey()
const STALL = getPublicKey(stallKey)
const PAYMENT = 'ab'.repeat(32)
const T0 = 1_795_000_000

function memStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) }
}

/** One shared cache, as the gateway is: every device publishes into it and reads from it. */
function network() {
  const events: Event[] = []
  let up = true
  return {
    events,
    setUp: (v: boolean) => (up = v),
    publish: async (e: Event) => (up ? (events.push(e), true) : false),
    query: async (filter: Record<string, unknown>) => {
      if (!up) throw new Error('gateway unreachable')
      const want = (filter.tags as Record<string, string[]>)['#x'][0]
      return events.filter((e) => e.tags.some((t) => t[0] === 'x' && t[1] === want))
    },
  }
}

function till(net: ReturnType<typeof network>, clock: { t: number }, store = memStore()): CheckDevice & { pub: string } {
  const key = generateSecretKey()
  const pub = getPublicKey(key)
  const role = 'ISSUE_AND_REDEEM'
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
      owner_attestation: signOwnerAttestation(
        { stallPubkey: STALL, lockKey: pub, role, expiresAt: until },
        { pubkey: STALL, withPrivkey: (use) => use(stallKey) },
      ),
    },
    publish: net.publish,
    query: net.query,
    store,
    now: () => clock.t,
  }
}

function owner(net: ReturnType<typeof network>, clock: { t: number }, names: Record<string, string> = {}): CheckDevice {
  return {
    device: STALL,
    withKey: (use) => use(stallKey),
    roster: { keys: new Set(Object.keys(names)), nameOf: (k) => names[k] ?? 'A terminal no longer listed' },
    publish: net.publish,
    query: net.query,
    store: memStore(),
    now: () => clock.t,
  }
}

describe('rememberCheck', () => {
  it('first check: nothing earlier, and it is published', async () => {
    const net = network()
    const clock = { t: T0 }
    const m = await rememberCheck(till(net, clock), STALL, PAYMENT)
    expect(m).toEqual({ prior: [], known: true, record: 'published' })
    expect(net.events).toHaveLength(1)
  })

  it('a second till sees the first one’s check as "another till", never by name', async () => {
    const net = network()
    const clock = { t: T0 }
    await rememberCheck(till(net, clock), STALL, PAYMENT)
    clock.t += 120
    const m = await rememberCheck(till(net, clock), STALL, PAYMENT)
    expect(m.prior).toEqual([{ at: T0, by: { kind: 'another_till' } }])
  })

  it('the owner sees which till checked, by its roster name', async () => {
    const net = network()
    const clock = { t: T0 }
    const t = till(net, clock)
    await rememberCheck(t, STALL, PAYMENT)
    clock.t += 60
    const m = await rememberCheck(owner(net, clock, { [t.pub]: 'Till 2' }), STALL, PAYMENT)
    expect(m.prior).toEqual([{ at: T0, by: { kind: 'named_till', name: 'Till 2' } }])
  })

  it('a till sees the owner’s check as the owner’s', async () => {
    const net = network()
    const clock = { t: T0 }
    await rememberCheck(owner(net, clock), STALL, PAYMENT)
    clock.t += 60
    expect((await rememberCheck(till(net, clock), STALL, PAYMENT)).prior).toEqual([{ at: T0, by: { kind: 'owner' } }])
  })

  it('the same device a minute later: "this device", listed once', async () => {
    const net = network()
    const clock = { t: T0 }
    const t = till(net, clock)
    await rememberCheck(t, STALL, PAYMENT)
    clock.t += 60
    const m = await rememberCheck(t, STALL, PAYMENT)
    expect(m.prior).toEqual([{ at: T0, by: { kind: 'this_device' } }])
  })

  it('a re-render within seconds is the same check: not a repeat, not published twice', async () => {
    const net = network()
    const clock = { t: T0 }
    const t = till(net, clock)
    await rememberCheck(t, STALL, PAYMENT)
    clock.t += SAME_CHECK_SECONDS - 1
    const m = await rememberCheck(t, STALL, PAYMENT)
    expect(m).toEqual({ prior: [], known: true, record: null })
    expect(net.events).toHaveLength(1)
  })

  it('offline: says it cannot know, still remembers its own checks, and sends later', async () => {
    const net = network()
    const clock = { t: T0 }
    const t = till(net, clock)
    net.setUp(false)
    const first = await rememberCheck(t, STALL, PAYMENT)
    expect(first).toEqual({ prior: [], known: false, record: 'deferred' })
    clock.t += 60
    const again = await rememberCheck(t, STALL, PAYMENT)
    expect(again.known).toBe(false)
    expect(again.prior).toEqual([{ at: T0, by: { kind: 'this_device' } }])
    net.setUp(true)
    expect(await flushCheckOutbox(t)).toBe(0)
    expect(net.events).toHaveLength(2)
    // Another till now sees both, once each.
    clock.t += 60
    expect((await rememberCheck(till(net, clock), STALL, PAYMENT)).prior).toHaveLength(2)
  })

  it('another payment’s checks are not this one’s', async () => {
    const net = network()
    const clock = { t: T0 }
    await rememberCheck(till(net, clock), STALL, 'cd'.repeat(32))
    clock.t += 60
    expect((await rememberCheck(till(net, clock), STALL, PAYMENT)).prior).toEqual([])
  })

  it('a stranger’s event under the right locator does not count', async () => {
    const net = network()
    const clock = { t: T0 }
    const strangerKey = generateSecretKey()
    const stranger: CheckDevice = { ...owner(net, clock), device: getPublicKey(strangerKey), withKey: (use) => use(strangerKey), roster: undefined }
    await rememberCheck(stranger, STALL, PAYMENT)
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
    expect((await rememberCheck(t, STALL, PAYMENT)).record).toBe('published')
  })
})
