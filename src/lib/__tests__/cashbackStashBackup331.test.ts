/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools'

/**
 * #331: the cashback stash's backup. Published as an encrypted record, read
 * BACK (signature-checked, decrypted), and restored at login.
 */

const sk = generateSecretKey()
const PK = getPublicKey(sk)
const relay = vi.hoisted(() => ({ events: [] as Event[], down: false, dropPublishes: false }))
const lock = vi.hoisted(() => ({ locked: false }))

vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: PK,
    hasKey: () => !lock.locked,
    // A reversible stand-in for NIP-44: the test is about the read-back, not the cipher.
    nip44Encrypt: (_pk: string, plain: string) => 'enc:' + btoa(unescape(encodeURIComponent(plain))),
    nip44Decrypt: (_pk: string, cipher: string) => {
      if (!cipher.startsWith('enc:')) throw new Error('not ours')
      return decodeURIComponent(escape(atob(cipher.slice(4))))
    },
    signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
  }),
}))
vi.mock('../relay', () => ({
  allEventsWithGateway: async () => {
    if (relay.down) throw new Error('down')
    return [...relay.events]
  },
  publish: async (e: Event) => {
    if (!relay.dropPublishes) relay.events.push(e)
    return { ok: 1 }
  },
}))
vi.mock('../transferSignature', () => ({ mirrorToGateway: async () => true }))

const stash = await import('../cashbackStash')
const FAST = { settleMs: 0, deadlineMs: 2_000 }

beforeEach(() => {
  relay.events = []
  relay.down = false
  relay.dropPublishes = false
  lock.locked = false
  localStorage.clear()
})

describe('confirmStashBackup', () => {
  it('an empty stash is confirmed without a network call', async () => {
    relay.down = true
    await expect(stash.confirmStashBackup(PK, FAST)).resolves.toMatchObject({ ok: true, count: 0 })
  })

  it('publishes the stash and confirms it by reading it back', async () => {
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBone', 'cashuBtwo']))
    await expect(stash.confirmStashBackup(PK, FAST)).resolves.toMatchObject({ ok: true, count: 2 })
    expect(relay.events).toHaveLength(1)
    await expect(stash.readBackStash(PK)).resolves.toEqual(['cashuBone', 'cashuBtwo'])
  })

  it('a publish that never lands is NOT confirmed', async () => {
    relay.dropPublishes = true
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBone']))
    await expect(stash.confirmStashBackup(PK, FAST)).resolves.toMatchObject({ ok: false, reason: 'unconfirmed', count: 1 })
  })

  it('an unreachable relay and gateway is NOT confirmed', async () => {
    relay.down = true
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBone']))
    await expect(stash.confirmStashBackup(PK, FAST)).resolves.toMatchObject({ ok: false, reason: 'unconfirmed' })
  })

  it('a locked key is NOT confirmed', async () => {
    lock.locked = true
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBone']))
    await expect(stash.confirmStashBackup(PK, FAST)).resolves.toMatchObject({ ok: false, reason: 'locked' })
  })

  it('a forged record (bad signature) confirms nothing', async () => {
    relay.dropPublishes = true
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBone']))
    const real = finalizeEvent(
      { kind: 30078, created_at: 1, tags: [['d', stash.STASH_D_TAG]], content: 'enc:' + btoa('{"tokens":["cashuBone"]}') },
      sk,
    )
    relay.events.push({ ...real, sig: '0'.repeat(128) })
    await expect(stash.confirmStashBackup(PK, FAST)).resolves.toMatchObject({ ok: false })
  })

  it('garbage entries are not value and never block', async () => {
    relay.down = true
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['', 'junk', 7, null]))
    await expect(stash.confirmStashBackup(PK, FAST)).resolves.toMatchObject({ ok: true, count: 0 })
  })

  it('the legacy single-token value is backed up too', async () => {
    localStorage.setItem(stash.PENDING_KEY, 'cashuBlegacy')
    await expect(stash.confirmStashBackup(PK, FAST)).resolves.toMatchObject({ ok: true, count: 1 })
  })

  it('unreadable storage is NOT confirmed', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    try {
      await expect(stash.confirmStashBackup(PK, FAST)).resolves.toMatchObject({ ok: false, reason: 'store-unreadable' })
    } finally {
      spy.mockRestore()
    }
  })
})

describe('restoreCashbackStash', () => {
  it('brings a backed-up stash back after logout', async () => {
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBone']))
    await stash.confirmStashBackup(PK, FAST)
    localStorage.clear()
    await expect(stash.restoreCashbackStash(PK)).resolves.toBe(1)
    expect(JSON.parse(localStorage.getItem(stash.PENDING_KEY)!)).toEqual(['cashuBone'])
  })

  it('merges, never removes a local entry, and is idempotent', async () => {
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBone']))
    await stash.confirmStashBackup(PK, FAST)
    localStorage.setItem(stash.PENDING_KEY, JSON.stringify(['cashuBlocal']))
    await expect(stash.restoreCashbackStash(PK)).resolves.toBe(1)
    await expect(stash.restoreCashbackStash(PK)).resolves.toBe(0)
    expect(JSON.parse(localStorage.getItem(stash.PENDING_KEY)!)).toEqual(['cashuBlocal', 'cashuBone'])
  })

  it('reads only the NEWEST record, so a banked token is not brought back', async () => {
    const mk = (at: number, tokens: string[]) =>
      finalizeEvent(
        { kind: 30078, created_at: at, tags: [['d', stash.STASH_D_TAG]], content: 'enc:' + btoa(JSON.stringify({ tokens })) },
        sk,
      )
    relay.events.push(mk(100, ['cashuBold']), mk(200, []))
    await expect(stash.restoreCashbackStash(PK)).resolves.toBe(0)
  })

  it('never throws when nothing answers', async () => {
    relay.down = true
    await expect(stash.restoreCashbackStash(PK)).resolves.toBe(0)
  })
})
