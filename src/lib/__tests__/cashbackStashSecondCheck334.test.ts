/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools'

/**
 * Second check of #334 (the reviewer's D1 in e417588).
 *
 * D1 made logout REPLACE the stash record whenever it named more than this
 * device's stash: with [] when the stash was empty, with the stash otherwise.
 * "Names more" was read as "banked since". It is not always: the record is the
 * ONLY copy of cashback another device backed up before it was wiped, and this
 * device may never have restored it (the login restore is fire-and-forget, and
 * a read that failed restores nothing). Replacing the record then erased value
 * that was nowhere else. A token is dropped from the record now only when its
 * mint says it is SPENT.
 *
 * And a clear that outlived its 5 s bound kept running, so it could land after
 * a later check had backed up a freshly stashed token.
 */

const sk = generateSecretKey()
const PK = getPublicKey(sk)
const relay = vi.hoisted(() => ({ events: [] as Event[], gate: null as null | Promise<void>, published: 0, failReads: 0 }))

vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: PK,
    hasKey: () => true,
    nip44Encrypt: (to: string, plain: string) => `enc:${to}:` + btoa(plain),
    nip44Decrypt: (from: string, cipher: string) => {
      const prefix = `enc:${from}:`
      if (!cipher.startsWith(prefix)) throw new Error('not ours')
      return atob(cipher.slice(prefix.length))
    },
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
  }),
}))
vi.mock('../relay', () => ({
  allEventsWithGateway: async () => {
    if (relay.failReads > 0) {
      relay.failReads--
      throw new Error('unreachable')
    }
    const snapshot = [...relay.events]
    if (relay.gate) await relay.gate
    return snapshot
  },
  publish: async (e: Event) => {
    relay.published++
    relay.events.push(e)
    return { ok: 1 }
  },
}))
vi.mock('../transferSignature', () => ({ mirrorToGateway: async () => true }))

const stash = await import('../cashbackStash')

function record(at: number, tokens: string[]): Event {
  return finalizeEvent(
    { kind: 30078, created_at: at, tags: [['d', stash.STASH_D_TAG]], content: `enc:${PK}:` + btoa(JSON.stringify({ v: 1, tokens })) },
    sk,
  )
}

const states = (map: Record<string, 'SPENT' | 'UNSPENT' | 'PENDING' | 'UNKNOWN' | 'THROW'>) => async (t: string) => {
  const s = map[t] ?? 'UNKNOWN'
  if (s === 'THROW') throw new Error('mint down')
  return s
}

async function restoredOnCleanDevice(): Promise<string[]> {
  localStorage.clear()
  await stash.restoreCashbackStash(PK)
  return JSON.parse(localStorage.getItem(stash.PENDING_KEY) ?? '[]')
}

beforeEach(() => {
  relay.events = []
  relay.gate = null
  relay.published = 0
  relay.failReads = 0
  localStorage.clear()
})

describe('an EMPTY stash drops only what the mint proves spent', () => {
  it('another device\'s cashback this device never restored survives the logout', async () => {
    relay.events.push(record(100, ['cashuBfromA']))
    const opts = { settleMs: 0, deadlineMs: 2_000, tokenState: states({ cashuBfromA: 'UNSPENT' }) }
    await expect(stash.confirmStashBackup(PK, opts)).resolves.toMatchObject({ ok: true, count: 0 })
    expect(await restoredOnCleanDevice()).toEqual(['cashuBfromA'])
  })

  it.each(['PENDING', 'UNKNOWN', 'THROW'] as const)('a token whose state is %s is kept', async (s) => {
    relay.events.push(record(100, ['cashuBfromA']))
    const opts = { settleMs: 0, deadlineMs: 2_000, tokenState: states({ cashuBfromA: s }) }
    await expect(stash.confirmStashBackup(PK, opts)).resolves.toMatchObject({ ok: true, count: 0 })
    expect(await restoredOnCleanDevice()).toEqual(['cashuBfromA'])
  })

  it('a SPENT token is dropped and an unspent one beside it is kept (D1 still fixed)', async () => {
    relay.events.push(record(100, ['cashuBbanked', 'cashuBfromA']))
    const opts = { settleMs: 0, deadlineMs: 2_000, tokenState: states({ cashuBbanked: 'SPENT', cashuBfromA: 'UNSPENT' }) }
    await expect(stash.confirmStashBackup(PK, opts)).resolves.toMatchObject({ ok: true, count: 0 })
    expect(await restoredOnCleanDevice()).toEqual(['cashuBfromA'])
  })

  it('a clear still running at its bound never publishes afterwards', async () => {
    vi.useFakeTimers()
    try {
      relay.events.push(record(100, ['cashuBbanked']))
      let release!: () => void
      relay.gate = new Promise<void>((r) => (release = r))
      const opts = { settleMs: 0, deadlineMs: 60_000, tokenState: states({ cashuBbanked: 'SPENT' }) }
      const done = stash.confirmStashBackup(PK, opts)
      await vi.advanceTimersByTimeAsync(5_001)
      await expect(done).resolves.toMatchObject({ ok: true, count: 0 })
      // The read answers only now, after logout went on.
      release()
      await vi.advanceTimersByTimeAsync(10)
      expect(relay.published).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a clear whose MINT answers after its bound never publishes afterwards', async () => {
    vi.useFakeTimers()
    try {
      relay.events.push(record(100, ['cashuBbanked']))
      let release!: () => void
      const slow = new Promise<void>((r) => (release = r))
      const opts = {
        settleMs: 0,
        deadlineMs: 60_000,
        tokenState: async () => {
          await slow
          return 'SPENT' as const
        },
      }
      const done = stash.confirmStashBackup(PK, opts)
      await vi.advanceTimersByTimeAsync(5_001)
      await expect(done).resolves.toMatchObject({ ok: true, count: 0 })
      release()
      await vi.advanceTimersByTimeAsync(10)
      expect(relay.published).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a NON-empty stash never publishes less than the record holds', () => {
  it('a COVERED stash keeps the record\'s unspent extra', async () => {
    relay.events.push(record(100, ['cashuBfromA', 'cashuBmine']))
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBmine']))
    const opts = { settleMs: 0, deadlineMs: 2_000, tokenState: states({ cashuBfromA: 'UNSPENT' }) }
    await expect(stash.confirmStashBackup(PK, opts)).resolves.toMatchObject({ ok: true, count: 1 })
    expect((await restoredOnCleanDevice()).sort()).toEqual(['cashuBfromA', 'cashuBmine'])
  })

  it('a stash the record does NOT cover is published with the record\'s unspent tokens', async () => {
    relay.events.push(record(100, ['cashuBfromA']))
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBmine']))
    const opts = { settleMs: 0, deadlineMs: 2_000, tokenState: states({}) }
    await expect(stash.confirmStashBackup(PK, opts)).resolves.toMatchObject({ ok: true, count: 1 })
    expect((await restoredOnCleanDevice()).sort()).toEqual(['cashuBfromA', 'cashuBmine'])
  })

  it('a covered stash drops a SPENT extra and keeps an unknown one beside it', async () => {
    relay.events.push(record(100, ['cashuBbanked', 'cashuBfromA', 'cashuBmine']))
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBmine']))
    const opts = { settleMs: 0, deadlineMs: 2_000, tokenState: states({ cashuBbanked: 'SPENT' }) }
    await expect(stash.confirmStashBackup(PK, opts)).resolves.toMatchObject({ ok: true, count: 1 })
    expect((await restoredOnCleanDevice()).sort()).toEqual(['cashuBfromA', 'cashuBmine'])
  })

  it('a first read that FAILS is not followed by a blind publish over the record', async () => {
    relay.events.push(record(100, ['cashuBfromA']))
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBmine']))
    relay.failReads = 1
    const opts = { settleMs: 0, deadlineMs: 2_000, tokenState: states({}) }
    await expect(stash.confirmStashBackup(PK, opts)).resolves.toMatchObject({ ok: true, count: 1 })
    expect((await restoredOnCleanDevice()).sort()).toEqual(['cashuBfromA', 'cashuBmine'])
  })

  it('a SPENT extra is still dropped from a covered stash (D1 still fixed)', async () => {
    relay.events.push(record(100, ['cashuBbanked', 'cashuBmine']))
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBmine']))
    const opts = { settleMs: 0, deadlineMs: 2_000, tokenState: states({ cashuBbanked: 'SPENT' }) }
    await expect(stash.confirmStashBackup(PK, opts)).resolves.toMatchObject({ ok: true, count: 1 })
    expect(await restoredOnCleanDevice()).toEqual(['cashuBmine'])
  })
})

describe('the newest record is the latest write, even in the same second', () => {
  it('a publish in the same second as an earlier one still wins', async () => {
    const now = Math.floor(Date.now() / 1000)
    // A record already stamped this second (or later: a clock ahead), naming a spent token.
    relay.events.push(record(now + 5, ['cashuBbanked', 'cashuBmine']))
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBmine']))
    const opts = { settleMs: 0, deadlineMs: 2_000, tokenState: states({ cashuBbanked: 'SPENT' }) }
    await expect(stash.confirmStashBackup(PK, opts)).resolves.toMatchObject({ ok: true, count: 1 })
    const newest = Math.max(...relay.events.map((e) => e.created_at))
    expect(newest).toBeGreaterThan(now + 5)
    expect(await restoredOnCleanDevice()).toEqual(['cashuBmine'])
  })
})
