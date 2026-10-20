/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools'

/**
 * Fourth check of #334: the stash backup's edges the PR's own tests left open.
 *
 * D1 (defect): a record from an earlier logout still named tokens banked since,
 * and nothing ever replaced it. A logout with an empty stash returned ok without
 * touching it, and one whose record merely COVERED the stash kept it as it was.
 * The next login's restore then put the banked tokens back in the stash: phantom
 * "cashback waiting" that blocks every later logout and is retried for ever.
 *
 * Plus the survivors of the mutation battery: the author check, encryption to
 * SELF (not merely "some" key), a partly backed-up stash, and the deadline.
 */

const sk = generateSecretKey()
const PK = getPublicKey(sk)
const relay = vi.hoisted(() => ({ events: [] as Event[], down: false, hang: false, drop: false, encryptedTo: [] as string[] }))
const lock = vi.hoisted(() => ({ locked: false }))

vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: PK,
    hasKey: () => !lock.locked,
    // Reversible, and keyed: only a cipher sealed to THIS account's own key opens.
    nip44Encrypt: (to: string, plain: string) => {
      relay.encryptedTo.push(to)
      return `enc:${to}:` + btoa(unescape(encodeURIComponent(plain)))
    },
    nip44Decrypt: (from: string, cipher: string) => {
      const prefix = `enc:${from}:`
      if (!cipher.startsWith(prefix) || from !== PK) throw new Error('not ours')
      return decodeURIComponent(escape(atob(cipher.slice(prefix.length))))
    },
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
  }),
}))
vi.mock('../relay', () => ({
  allEventsWithGateway: async () => {
    if (relay.down) throw new Error('down')
    if (relay.hang) return new Promise<never>(() => {})
    return [...relay.events]
  },
  publish: async (e: Event) => {
    if (!relay.drop) relay.events.push(e)
    return { ok: 1 }
  },
}))
vi.mock('../transferSignature', () => ({ mirrorToGateway: async () => true }))

const stash = await import('../cashbackStash')
// A banked token's proofs are spent at the mint; that is what lets logout drop it
// from the record (second check of #334). Any other token's state is unknown.
const spentWhenBanked = async (t: string) => (t === 'cashuBbanked' ? ('SPENT' as const) : ('UNKNOWN' as const))
const FAST = { settleMs: 0, deadlineMs: 2_000, tokenState: spentWhenBanked }

function record(at: number, tokens: string[], key = sk, to = PK): Event {
  return finalizeEvent(
    {
      kind: 30078,
      created_at: at,
      tags: [['d', stash.STASH_D_TAG]],
      content: `enc:${to}:` + btoa(JSON.stringify({ v: 1, tokens })),
    },
    key,
  )
}

beforeEach(() => {
  relay.events = []
  relay.down = false
  relay.hang = false
  relay.drop = false
  relay.encryptedTo = []
  lock.locked = false
  localStorage.clear()
})

describe('D1: a banked token is not brought back by the next login', () => {
  it('logout with an EMPTY stash replaces a stale record, so restore adds nothing', async () => {
    // Logout 1 backed up a token; it was banked after the next login.
    relay.events.push(record(100, ['cashuBbanked']))
    // Logout 2: nothing waiting.
    await expect(stash.confirmStashBackup(PK, FAST)).resolves.toMatchObject({ ok: true, count: 0 })
    // Login 3 on a clean device.
    localStorage.clear()
    await expect(stash.restoreCashbackStash(PK)).resolves.toBe(0)
    expect(localStorage.getItem(stash.PENDING_KEY)).toBeNull()
  })

  it('logout whose record COVERS the stash but names more republishes the exact stash', async () => {
    relay.events.push(record(100, ['cashuBbanked', 'cashuBwaiting']))
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBwaiting']))
    await expect(stash.confirmStashBackup(PK, FAST)).resolves.toMatchObject({ ok: true, count: 1 })
    localStorage.clear()
    await expect(stash.restoreCashbackStash(PK)).resolves.toBe(1)
    expect(JSON.parse(localStorage.getItem(stash.PENDING_KEY)!)).toEqual(['cashuBwaiting'])
  })

  it('an empty stash never BLOCKS, even when the relay cannot be reached or hangs', async () => {
    relay.down = true
    await expect(stash.confirmStashBackup(PK, FAST)).resolves.toMatchObject({ ok: true, count: 0 })
    relay.down = false
    relay.hang = true
    await expect(stash.confirmStashBackup(PK, { settleMs: 0, deadlineMs: 50 })).resolves.toMatchObject({
      ok: true,
      count: 0,
    })
  })

  it('a covered stash whose republish never lands is still CONFIRMED (the money is backed up)', async () => {
    relay.events.push(record(100, ['cashuBbanked', 'cashuBwaiting']))
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBwaiting']))
    relay.drop = true
    await expect(stash.confirmStashBackup(PK, FAST)).resolves.toMatchObject({ ok: true, count: 1 })
  })
})

describe('the read-back trusts only this account, sealed to itself (survivors S1, S12)', () => {
  it('a validly signed record by ANOTHER key confirms nothing', async () => {
    const other = generateSecretKey()
    relay.events.push(record(100, ['cashuBone'], other))
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBone']))
    // Publishing is the part under test elsewhere; here only what is READ counts.
    relay.drop = true
    await expect(stash.confirmStashBackup(PK, FAST)).resolves.toMatchObject({ ok: false, reason: 'unconfirmed' })
  })

  it('the stash is sealed to the account itself', async () => {
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBone']))
    await expect(stash.confirmStashBackup(PK, FAST)).resolves.toMatchObject({ ok: true })
    expect(relay.encryptedTo.length).toBeGreaterThan(0)
    expect(new Set(relay.encryptedTo)).toEqual(new Set([PK]))
    expect(relay.events.every((e) => !e.content.includes('cashuBone'))).toBe(true)
  })
})

describe('partial and slow answers (survivors S9, S13)', () => {
  it('a record holding only SOME of the stash is NOT confirmed', async () => {
    relay.events.push(record(100, ['cashuBone']))
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBone', 'cashuBtwo']))
    relay.drop = true
    await expect(stash.confirmStashBackup(PK, FAST)).resolves.toMatchObject({
      ok: false,
      reason: 'unconfirmed',
      count: 1,
    })
  })

  it('a read that never answers is bounded by the deadline and does NOT confirm', async () => {
    relay.hang = true
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBone']))
    const outcome = await Promise.race([
      stash.confirmStashBackup(PK, { settleMs: 0, deadlineMs: 50 }),
      new Promise((resolve) => setTimeout(() => resolve('HUNG'), 1_000)),
    ])
    expect(outcome).toMatchObject({ ok: false, reason: 'unconfirmed' })
  })
})

describe('the restore at login skips a token proven spent (#335 item 1)', () => {
  // An offline logout could not clear the record, so it still names a token banked
  // before. Brought back, it would show as cashback "waiting" for ever.
  it('a SPENT token is not brought back; every other answer, or none, brings it back', async () => {
    relay.events = [record(100, ['cashuBbanked', 'cashuBunspent', 'cashuBunknown', 'cashuBthrows'])]
    const state = async (t: string) => {
      if (t === 'cashuBthrows') throw new Error('mint down')
      return t === 'cashuBbanked' ? ('SPENT' as const) : t === 'cashuBunspent' ? ('UNSPENT' as const) : ('UNKNOWN' as const)
    }
    expect(await stash.restoreCashbackStash(PK, state)).toBe(3)
    expect(JSON.parse(localStorage.getItem(stash.PENDING_KEY)!)).toEqual(['cashuBthrows', 'cashuBunknown', 'cashuBunspent'])
  })

  it('an entry stashed while the mint was being asked is kept', async () => {
    relay.events = [record(100, ['cashuBrestored'])]
    const state = async () => {
      localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBarrived']))
      return 'UNSPENT' as const
    }
    expect(await stash.restoreCashbackStash(PK, state)).toBe(1)
    expect(JSON.parse(localStorage.getItem(stash.PENDING_KEY)!)).toEqual(['cashuBarrived', 'cashuBrestored'])
  })
})
