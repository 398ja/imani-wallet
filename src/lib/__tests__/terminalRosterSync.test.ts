/**
 * @vitest-environment jsdom
 */
/**
 * The owner's terminal list, synced across the owner's devices (#160 phase 6, plan 2.2, R1).
 *
 * The roster is the only off-device copy of the stall's revocation handles, and logout used to
 * wipe it (F4). So the merge is property-tested over thousands of seeded random rosters:
 * commutative, associative, idempotent, a revoked credential is never un-revoked, status only
 * moves forward for the same credential, and no unrevoked credential ever loses its token.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  mergeRosters,
  rosterFromPayload,
  rosterPayload,
  visibleRows,
  type Roster,
} from '../terminalRosterSync'
import {
  allTerminals,
  forgetTerminal,
  recordTerminal,
  revokeTerminal,
  updateTerminal,
  type TerminalCredentialEntry,
  type TerminalRecord,
} from '../terminalRoster'

/** mulberry32: a small seeded PRNG, so a failing case can be replayed from its seed. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const KEYS = ['a', 'b', 'c'].map((c) => c.repeat(64))
const VOUCHERS = ['v1', 'v2', 'v3', 'v4']
const STATUSES = [undefined, 'minting', 'waiting', 'in-service'] as const
const GATEWAY = [undefined, 'unconfirmed', 'confirmed', 'lapsed'] as const

/** A random roster: rows over a small key space, so the merge meets real collisions. */
function randomRoster(r: () => number): Roster {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
  const rows: TerminalRecord[] = []
  for (const key of KEYS) {
    if (r() < 0.3) continue
    const credentials: TerminalCredentialEntry[] = VOUCHERS.filter(() => r() < 0.4).map((voucherId) => ({
      voucherId,
      issuedAt: 1000 + Math.floor(r() * 4) * 100,
      ...(r() < 0.5 ? { nonce: pick(['n1', 'n2']) } : {}),
      ...(r() < 0.5 ? { expiresAt: pick([5_000, 6_000]) } : {}),
      ...(r() < 0.3 ? { revokedAt: pick([2_000, 3_000]) } : r() < 0.6 ? { token: `tok-${voucherId}` } : {}),
    }))
    const current = credentials.length > 0 && r() < 0.8 ? pick(credentials) : undefined
    rows.push({
      terminalPubkey: key,
      name: pick(['Front', 'Back']),
      role: pick(['redeem-only', 'issue-and-redeem'] as const),
      enrolledAt: current?.issuedAt ?? 1000 + Math.floor(r() * 4) * 100,
      status: pick(STATUSES),
      gatewayState: pick(GATEWAY),
      ...(r() < 0.5 ? { lastUsedAt: Math.floor(r() * 10) } : {}),
      ...(current ? { voucherId: current.voucherId } : {}),
      ...(current && current.revokedAt === undefined && r() < 0.8 ? { token: `tok-${current.voucherId}` } : {}),
      ...(current?.revokedAt !== undefined ? { revokedAt: current.revokedAt } : {}),
      credentials,
    })
  }
  const forgotten = r() < 0.2 ? [{ terminalPubkey: pick(KEYS), enrolledAt: 1100 }] : []
  return { rows, forgotten }
}

/** Canonical form for equality: rows by key, credentials by id, no undefined fields. */
function canon(roster: Roster): string {
  const rows = [...roster.rows]
    .map((row) => ({ ...row, credentials: [...(row.credentials ?? [])].sort((a, b) => a.voucherId.localeCompare(b.voucherId)) }))
    .sort((a, b) => a.terminalPubkey.localeCompare(b.terminalPubkey))
  const forgotten = [...roster.forgotten].sort((a, b) =>
    `${a.terminalPubkey}${a.enrolledAt}`.localeCompare(`${b.terminalPubkey}${b.enrolledAt}`),
  )
  // Keys sorted at every depth: equal rosters, however their objects were built.
  const sorted = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sorted)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, sorted(x)]))
      : v
  return JSON.stringify(sorted({ rows, forgotten }))
}

const STATUS_RANK = { minting: 1, waiting: 2, 'in-service': 3 } as Record<string, number>
const rank = (s: string | undefined) => (s ? STATUS_RANK[s] : 0)

function entries(roster: Roster) {
  return roster.rows.flatMap((row) => (row.credentials ?? []).map((c) => ({ row, c })))
}

const CASES = 3000

describe('mergeRosters is a join (property tests, R1)', () => {
  it('is commutative', () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const r = rng(seed)
      const a = randomRoster(r)
      const b = randomRoster(r)
      expect(canon(mergeRosters(a, b)), `seed ${seed}`).toBe(canon(mergeRosters(b, a)))
    }
  })

  it('is associative', () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const r = rng(seed)
      const [a, b, c] = [randomRoster(r), randomRoster(r), randomRoster(r)]
      expect(canon(mergeRosters(mergeRosters(a, b), c)), `seed ${seed}`).toBe(
        canon(mergeRosters(a, mergeRosters(b, c))),
      )
    }
  })

  it('is idempotent: merging again changes nothing', () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const r = rng(seed)
      const a = randomRoster(r)
      const b = randomRoster(r)
      const ab = mergeRosters(a, b)
      expect(canon(mergeRosters(ab, b)), `seed ${seed}`).toBe(canon(ab))
      expect(canon(mergeRosters(ab, ab)), `seed ${seed}`).toBe(canon(ab))
    }
  })

  it('never un-revokes a credential, and keeps the earliest revocation (mutant: un-revoke)', () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const r = rng(seed)
      const a = randomRoster(r)
      const b = randomRoster(r)
      const out = mergeRosters(a, b)
      for (const { row, c } of [...entries(a), ...entries(b)]) {
        if (c.revokedAt === undefined) continue
        if (out.forgotten.some((f) => f.terminalPubkey === row.terminalPubkey && f.enrolledAt >= row.enrolledAt)) continue
        const merged = entries(out).find((e) => e.row.terminalPubkey === row.terminalPubkey && e.c.voucherId === c.voucherId)
        expect(merged?.c.revokedAt, `seed ${seed} ${c.voucherId}`).toBeDefined()
        expect(merged!.c.revokedAt!, `seed ${seed}`).toBeLessThanOrEqual(c.revokedAt)
        expect(merged!.c.token, `seed ${seed}: a revoked credential keeps no token`).toBeUndefined()
      }
    }
  })

  it('moves status only forward for the same current credential', () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const r = rng(seed)
      const a = randomRoster(r)
      const b = randomRoster(r)
      const out = mergeRosters(a, b)
      for (const side of [a, b]) {
        for (const row of side.rows) {
          const merged = out.rows.find((o) => o.terminalPubkey === row.terminalPubkey)
          if (!merged || merged.voucherId !== row.voucherId || merged.enrolledAt !== row.enrolledAt) continue
          expect(rank(merged.status), `seed ${seed}`).toBeGreaterThanOrEqual(rank(row.status))
        }
      }
    }
  })

  it('never loses the token of an unrevoked credential (mutant: last-writer-wins)', () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const r = rng(seed)
      const a = randomRoster(r)
      const b = randomRoster(r)
      const out = mergeRosters(a, b)
      for (const { row, c } of [...entries(a), ...entries(b)]) {
        if (!c.token) continue
        if (out.forgotten.some((f) => f.terminalPubkey === row.terminalPubkey && f.enrolledAt >= row.enrolledAt)) continue
        const merged = entries(out).find((e) => e.row.terminalPubkey === row.terminalPubkey && e.c.voucherId === c.voucherId)
        expect(merged, `seed ${seed}`).toBeDefined()
        if (merged!.c.revokedAt === undefined) expect(merged!.c.token, `seed ${seed} ${c.voucherId}`).toBe(c.token)
      }
      // And a live row keeps the token of its current credential.
      for (const row of out.rows) {
        const current = row.credentials?.find((c) => c.voucherId === row.voucherId)
        if (current && current.revokedAt === undefined && current.token) expect(row.token, `seed ${seed}`).toBe(current.token)
      }
    }
  })

  it('loses no terminal either side knows, unless it was forgotten after', () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const r = rng(seed)
      const a = randomRoster(r)
      const b = randomRoster(r)
      const out = mergeRosters(a, b)
      for (const row of [...a.rows, ...b.rows]) {
        const gone = out.forgotten.some((f) => f.terminalPubkey === row.terminalPubkey && f.enrolledAt >= row.enrolledAt)
        if (!gone) expect(visibleRows(out).some((o) => o.terminalPubkey === row.terminalPubkey), `seed ${seed}`).toBe(true)
      }
    }
  })
})

describe('specific merges an owner meets', () => {
  const live = (over: Partial<TerminalRecord> = {}): TerminalRecord => ({
    terminalPubkey: KEYS[0],
    name: 'Front counter',
    role: 'issue-and-redeem',
    enrolledAt: 1000,
    status: 'in-service',
    voucherId: 'v1',
    token: 'tok-v1',
    credentials: [{ voucherId: 'v1', issuedAt: 1000, token: 'tok-v1' }],
    ...over,
  })

  it('a revocation on one phone wins over the same credential live on the other', () => {
    const revoked = live({ revokedAt: 2000, credentials: [{ voucherId: 'v1', issuedAt: 1000, revokedAt: 2000 }] })
    const out = mergeRosters({ rows: [live()], forgotten: [] }, { rows: [revoked], forgotten: [] })
    expect(out.rows[0].revokedAt).toBe(2000)
  })

  it('a fresh enrolment of the same device wins over its old, revoked credential', () => {
    const old = live({ revokedAt: 2000, credentials: [{ voucherId: 'v1', issuedAt: 1000, revokedAt: 2000 }] })
    const fresh = live({ enrolledAt: 3000, voucherId: 'v2', token: 'tok-v2', status: 'waiting',
      credentials: [{ voucherId: 'v2', issuedAt: 3000, token: 'tok-v2' }] })
    const out = mergeRosters({ rows: [old], forgotten: [] }, { rows: [fresh], forgotten: [] })
    expect(out.rows[0].voucherId).toBe('v2')
    expect(out.rows[0].revokedAt).toBeUndefined()
    expect(out.rows[0].credentials!.map((c) => [c.voucherId, c.revokedAt])).toEqual([['v1', 2000], ['v2', undefined]])
  })

  it('a row forgotten on one phone (a refused mint) does not come back from the other', () => {
    const minting = live({ status: 'minting', voucherId: undefined, token: undefined, credentials: [], mintKey: 'k' })
    const out = mergeRosters({ rows: [minting], forgotten: [] }, { rows: [], forgotten: [{ terminalPubkey: KEYS[0], enrolledAt: 1000 }] })
    expect(visibleRows(out)).toEqual([])
    // ...but the same device added again later is back.
    const again = mergeRosters(out, { rows: [live({ enrolledAt: 5000, voucherId: 'v5', token: 't5', credentials: [] })], forgotten: [] })
    expect(visibleRows(again).map((r) => r.voucherId)).toEqual(['v5'])
  })

  it('keeps the minting key and attestation from whichever phone has them, so the other can resume', () => {
    const attestation = { v: '1', expires_at: '5000', nonce: 'n'.repeat(64), sig: 's'.repeat(128) }
    const minting = live({ status: 'minting', voucherId: undefined, token: undefined, credentials: [], mintKey: 'k-1', attestation })
    const bare = live({ status: 'minting', voucherId: undefined, token: undefined, credentials: [] })
    const out = mergeRosters({ rows: [bare], forgotten: [] }, { rows: [minting], forgotten: [] })
    expect(out.rows[0].mintKey).toBe('k-1')
    expect(out.rows[0].attestation).toEqual(attestation)
  })

  it('confirmed beats unconfirmed, and lapsed sticks', () => {
    const out = mergeRosters({ rows: [live({ gatewayState: 'unconfirmed' })], forgotten: [] }, { rows: [live({ gatewayState: 'confirmed' })], forgotten: [] })
    expect(out.rows[0].gatewayState).toBe('confirmed')
    const lapsed = mergeRosters({ rows: [live({ gatewayState: 'lapsed' })], forgotten: [] }, { rows: [live({ gatewayState: 'confirmed' })], forgotten: [] })
    expect(lapsed.rows[0].gatewayState).toBe('lapsed')
  })
})

describe('the event payload', () => {
  it('round-trips, and carries no token for a revoked credential (mutant: token kept for revoked)', () => {
    const roster: Roster = {
      rows: [{
        terminalPubkey: KEYS[0], name: 'Front', role: 'issue-and-redeem', enrolledAt: 1000, status: 'in-service',
        voucherId: 'v2', token: 'tok-v2', revokedAt: undefined,
        credentials: [
          { voucherId: 'v1', issuedAt: 900, revokedAt: 950, token: 'tok-v1' },
          { voucherId: 'v2', issuedAt: 1000, token: 'tok-v2', nonce: 'n', expiresAt: 5000 },
        ],
      }, {
        terminalPubkey: KEYS[1], name: 'Back', role: 'redeem-only', enrolledAt: 800, status: 'in-service',
        voucherId: 'v9', token: 'tok-v9', revokedAt: 990, credentials: [{ voucherId: 'v9', issuedAt: 800, revokedAt: 990 }],
      }],
      forgotten: [],
    }
    const json = rosterPayload(roster)
    expect(json).not.toContain('tok-v1')
    expect(json).not.toContain('tok-v9')
    expect(json).toContain('tok-v2')
    const back = rosterFromPayload(json)!
    expect(back.rows.find((r) => r.terminalPubkey === KEYS[0])!.credentials!.find((c) => c.voucherId === 'v2')).toMatchObject({
      token: 'tok-v2', nonce: 'n', expiresAt: 5000,
    })
    expect(back.rows.find((r) => r.terminalPubkey === KEYS[1])!.token).toBeUndefined()
  })

  it('refuses a payload it does not understand', () => {
    expect(rosterFromPayload('{"v":2,"rows":[]}')).toBeNull()
    expect(rosterFromPayload('not json')).toBeNull()
  })
})

describe('the local roster keeps a credential history (plan 2.2, migration)', () => {
  const STALL = 'f'.repeat(64)
  beforeEach(() => localStorage.clear())

  it('migrates an old row: its voucher id and attestation become credentials[0]', () => {
    localStorage.setItem(`imani-wallet:terminals:${STALL}`, JSON.stringify([{
      terminalPubkey: KEYS[0], name: 'Old', role: 'redeem-only', enrolledAt: 1234, status: 'in-service',
      voucherId: 'v-old', token: 'tok-old',
      attestation: { v: '1', expires_at: '99999', nonce: 'ab'.repeat(32), sig: 'cd'.repeat(64) },
    }]))
    const [row] = allTerminals(STALL)
    expect(row.credentials).toEqual([
      { voucherId: 'v-old', issuedAt: 1234, nonce: 'ab'.repeat(32), expiresAt: 99999, token: 'tok-old' },
    ])
  })

  it('records each credential a row ever held, and revoking it strips its token', () => {
    recordTerminal(STALL, { terminalPubkey: KEYS[0], name: 'F', role: 'redeem-only', enrolledAt: 1, status: 'minting' })
    updateTerminal(STALL, KEYS[0], (r) => ({ ...r, status: 'waiting', voucherId: 'v1', token: 't1', enrolledAt: 2 }))
    revokeTerminal(STALL, KEYS[0], 3)
    const [row] = allTerminals(STALL)
    expect(row.credentials).toEqual([{ voucherId: 'v1', issuedAt: 2, revokedAt: 3 }])
  })

  it('remembers a forgotten row, so a sync cannot bring it back', () => {
    recordTerminal(STALL, { terminalPubkey: KEYS[0], name: 'F', role: 'redeem-only', enrolledAt: 7, status: 'minting' })
    forgetTerminal(STALL, KEYS[0])
    expect(JSON.parse(localStorage.getItem(`imani-wallet:terminals-forgotten:${STALL}`)!)).toEqual([
      { terminalPubkey: KEYS[0], enrolledAt: 7 },
    ])
  })
})

describe('syncRoster: fetch, merge into local, publish, then ask the mint', () => {
  const STALL = 'f'.repeat(64)
  beforeEach(() => localStorage.clear())

  it('restores a roster after logout wiped it (F4), and then runs markSpentElsewhere', async () => {
    const { syncRoster } = await import('../terminalRosterSync')
    const remote = rosterPayload({
      rows: [{ terminalPubkey: KEYS[0], name: 'Front', role: 'issue-and-redeem', enrolledAt: 10, status: 'in-service',
        voucherId: 'v1', token: 'tok-v1', credentials: [{ voucherId: 'v1', issuedAt: 10, token: 'tok-v1' }] }],
      forgotten: [],
    })
    const order: string[] = []
    let published = ''
    const out = await syncRoster(STALL, {
      fetch: async () => (order.push('fetch'), remote),
      publish: async (json) => (order.push('publish'), (published = json), true),
      afterMerge: async () => void order.push('mint'),
    })
    // Nothing this phone knows that the published copy does not: no write to the relay.
    expect(out).toEqual({ fetched: true, published: false })
    expect(order).toEqual(['fetch', 'mint'])
    expect(published).toBe('')
    expect(allTerminals(STALL).map((r) => [r.name, r.token])).toEqual([['Front', 'tok-v1']])
  })

  it('never overwrites local blind: a row only this phone has is kept and published', async () => {
    const { syncRoster } = await import('../terminalRosterSync')
    recordTerminal(STALL, { terminalPubkey: KEYS[1], name: 'Back', role: 'redeem-only', enrolledAt: 5, status: 'waiting', voucherId: 'v9', token: 't9' })
    let published = ''
    await syncRoster(STALL, {
      fetch: async () => rosterPayload({ rows: [], forgotten: [] }),
      publish: async (json) => ((published = json), true),
    })
    expect(allTerminals(STALL).map((r) => r.terminalPubkey)).toEqual([KEYS[1]])
    expect(published).toContain('t9')
  })

  it('a relay that could not be read is not an empty roster: nothing is published over it', async () => {
    const { syncRoster } = await import('../terminalRosterSync')
    recordTerminal(STALL, { terminalPubkey: KEYS[1], name: 'Back', role: 'redeem-only', enrolledAt: 5 })
    let publishedCalls = 0
    const out = await syncRoster(STALL, {
      fetch: async () => { throw new Error('offline') },
      publish: async () => ((publishedCalls += 1), true),
    })
    expect(out.fetched).toBe(false)
    expect(publishedCalls).toBe(0)
    expect(allTerminals(STALL)).toHaveLength(1)
  })

  it('records that this device has synced once, which the home-coming check waits for', async () => {
    const { syncRoster, rosterSyncedOnce } = await import('../terminalRosterSync')
    expect(rosterSyncedOnce(STALL)).toBe(false)
    await syncRoster(STALL, { fetch: async () => null, publish: async () => true })
    expect(rosterSyncedOnce(STALL)).toBe(true)
  })
})
