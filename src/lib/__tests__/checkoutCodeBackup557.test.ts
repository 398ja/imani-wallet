/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #348: the key backup gate is pinned in logoutKeyBackup348.test.ts. Here the key is backed up.
vi.mock('../keyBackups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../keyBackups')>()),
  checkKeyBackup: async () => ({ ok: true, backups: [] }),
}))
import { hexToBytes } from '@noble/hashes/utils'
import { finalizeEvent, getPublicKey, type Event, type EventTemplate } from 'nostr-tools'

/**
 * #557: checkout codes backed up on the relay. Round trip through the real flow (a code is made
 * against `cashlinkWorld`, published, localStorage is swept as logout does, restored, and the refund
 * at `x` works from the restored record), logout's read-back gate, the plaintext never holding a
 * bearer token, and the refund counter restored past every index.
 */

const ID = hexToBytes('33'.repeat(32))
const ME = getPublicKey(ID)
const relay = vi.hoisted(() => ({ events: [] as Event[], down: false, dropPublishes: false, plaintexts: [] as string[] }))

vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: ME,
    hasKey: () => true,
    nip44Encrypt: (_pk: string, plain: string) => {
      relay.plaintexts.push(plain)
      return 'enc:' + btoa(unescape(encodeURIComponent(plain)))
    },
    nip44Decrypt: (_pk: string, cipher: string) => {
      if (!cipher.startsWith('enc:')) throw new Error('not ours')
      return decodeURIComponent(escape(atob(cipher.slice(4))))
    },
    signEvent: async (t: EventTemplate) => finalizeEvent(t, ID),
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
vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))

const backup = await import('../checkoutCodeBackup')
const flow = await import('../checkoutCodeFlow')
const records = await import('../checkoutCodeRecords')
const { attemptLogout } = await import('../logout')
const { blockedMessage } = await import('../logoutBlockedCopy')
const { parseVoucherToken, creditableFaceValue } = await import('../voucherToken')
const W = await import('./cashlinkWorld')
await W.loadTokenReader()

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
const S = 'd4'.repeat(32)
const SHOP = { url: 'https://shop.example', redeemKey: S, platform: 'woocommerce' as const, since: 1 }
const FAST = { settleMs: 0, deadlineMs: 2_000 }

type Rec = import('../checkoutCodeRecords').CheckoutCodeRecord
const rec = (extra: Partial<Rec> = {}): Rec => ({
  id: 'c1', stall: W.STALL, shopKey: S, shopUrl: SHOP.url, platform: 'woocommerce', unit: 'EUR', decimals: 2,
  amount: 75, x: X, createdAt: 1, status: 'reserved', code: 'IMANIX',
  parts: [{ i: 4, amount: 75, state: 'locked', lockedToken: 'cashuBlocked4', token: 'cashuBbearer4' }],
  ...extra,
})

let w: ReturnType<typeof W.world>
let ports: import('../checkoutCodeFlow').CheckoutPorts

beforeEach(() => {
  relay.events = []
  relay.plaintexts = []
  relay.down = false
  relay.dropPublishes = false
  localStorage.clear()
  w = W.world(NOW)
  ports = {
    ...w.ports,
    store: new W.FakeCodeStore(w.mint),
    identitySecret: () => Uint8Array.from(ID),
    carve: async () => {
      throw new Error('no split')
    },
    consume: async () => undefined,
    activity: async () => undefined,
  }
})

/** What logout's sweep does to this ledger. */
const sweep = () => {
  for (const k of Object.keys(localStorage)) if (k.startsWith('imani-wallet:')) localStorage.removeItem(k)
}

/** Logout with every other check passing, so the code check is what decides. */
const logoutWith = (extra = {}, confirm = () => true) =>
  attemptLogout(ME, confirm, () => {}, {
    checkBackups: async () => ({ ok: true, fingerprint: '' }) as never,
    checkStash: async () => ({ ok: true, fingerprint: '', count: 0 }),
    checkCodes: (pk) => backup.confirmCheckoutCodeBackup(pk, FAST),
    settleInFlight: async () => undefined,
    strandedLinks: async () => 0,
    restartWriters: () => {},
    drainWriters: async () => true,
    drainReceives: async () => true,
    receivesNow: () => 0,
    heldNow: async () => '',
    writeCount: () => 0,
    pauseTabs: async () => ({ ok: true, tabs: { resume: () => {}, done: () => {}, stillPaused: async () => true } }),
    ...extra,
  })

describe('round trip', () => {
  it('save, publish, sweep, restore: the refund at x works from the restored record', async () => {
    const proofs = [w.mint.issue(W.bearerSecret({ nonce: 'aaaaaaaa' }, 'a0'), 64)]
    const token = W.tokenOf(proofs)
    const face = creditableFaceValue(parseVoucherToken(token)).faceValue
    const out = await flow.startCheckoutCode({
      ports, pubkey: ME, stall: W.STALL, shop: SHOP, unit: 'GBP', decimals: 2, amount: face, x: X,
      parts: [{ tokenId: 'row-a', token, amount: face, faceValue: face }],
    })
    expect(out.kind).toBe('issued')
    const made = records.loadCheckoutCodes(ME)[0]
    expect(await backup.syncCheckoutCodes(ME)).toBe(true)

    sweep()
    expect(records.loadCheckoutCodes(ME)).toEqual([])
    expect(await backup.restoreCheckoutCodes(ME)).toBe(1)
    const back = records.loadCheckoutCodes(ME)[0]
    expect(back.id).toBe(made.id)
    expect(back.parts[0].lockedToken).toBe(made.parts[0].lockedToken)
    expect(records.nextCheckoutRefundIndex(ME)).toBeGreaterThan(made.parts[0].i)

    W.at(w, X + 120)
    await w.gateway.runRelay(X + 120)
    await flow.reconcileCheckoutCodes(ports, ME)
    expect(records.loadCheckoutCodes(ME)[0].done).toBe(true)
    const kept = w.kept.reduce((n, k) => n + (k.satsToken ? (k.sats ?? 0) : parseVoucherToken(k.token).tokenAmount), 0)
    expect(kept).toBe(64)
  })

  it('never puts a bearer token in the published plaintext', async () => {
    records.saveCheckoutCode(ME, rec())
    records.saveCheckoutCode(ME, rec({ id: 'c2', status: 'locking', parts: [{ i: 5, amount: 1, state: 'arming', token: 'cashuBsecretbearer' }] }))
    await backup.syncCheckoutCodes(ME)
    await backup.confirmCheckoutCodeBackup(ME, FAST)
    expect(relay.plaintexts.length).toBeGreaterThan(0)
    for (const p of relay.plaintexts) {
      expect(p).not.toContain('cashuBbearer4')
      expect(p).not.toContain('cashuBsecretbearer')
      expect(p).not.toContain('"token"')
    }
    expect(relay.plaintexts.at(-1)).toContain('cashuBlocked4')
  })

  it('restores the counter past every restored i, and the backed counter', async () => {
    records.saveCheckoutCode(ME, rec({ parts: [{ i: 9, amount: 1, state: 'locked', lockedToken: 'cashuBl9' }] }))
    records.saveCheckoutCode(ME, rec({ id: 'c2', done: true, status: 'redeemed', parts: [{ i: 3, amount: 1, state: 'settled', lockedToken: 'cashuBl3' }] }))
    await backup.syncCheckoutCodes(ME)
    sweep()
    expect(records.nextCheckoutRefundIndex(ME)).toBe(0)
    expect(await backup.restoreCheckoutCodes(ME)).toBe(2)
    expect(records.nextCheckoutRefundIndex(ME)).toBe(10)
    expect(records.reserveCheckoutRefundIndices(ME, 1)[0]).toBeGreaterThan(9)
  })

  it('keeps a local record over the backed one, and done codes come back too', async () => {
    records.saveCheckoutCode(ME, rec({ status: 'reserved' }))
    await backup.syncCheckoutCodes(ME)
    records.saveCheckoutCode(ME, rec({ status: 'redeemed', done: true }))
    await backup.restoreCheckoutCodes(ME)
    expect(records.loadCheckoutCodes(ME)).toHaveLength(1)
    expect(records.loadCheckoutCodes(ME)[0].status).toBe('redeemed')
  })

  it('a save schedules a debounced publish', async () => {
    vi.useFakeTimers()
    try {
      backup.startCheckoutCodeBackup()
      records.saveCheckoutCode(ME, rec())
      records.saveCheckoutCode(ME, rec({ remaining: 50 }))
      expect(relay.events).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(backup.PUBLISH_DEBOUNCE_MS + 10)
      expect(relay.events).toHaveLength(1)
    } finally {
      backup.stopCheckoutCodesPublish()
      vi.useRealTimers()
    }
  })
})

describe('logout', () => {
  it('blocks before the read-back, with the checkout-code backing-up message', async () => {
    records.saveCheckoutCode(ME, rec())
    relay.dropPublishes = true
    const out = await logoutWith()
    expect(out).toMatchObject({ status: 'blocked', reason: 'checkout-code-unconfirmed', code: { id: 'c1', amount: 75 } })
    const words = blockedMessage(out as never)
    expect(words).toContain('shop.example')
    expect(words).toContain('Backing up your checkout code')
    expect(words).not.toContain('Cashlink')
  })

  it('is allowed once a read-back holds the code and every locked token', async () => {
    records.saveCheckoutCode(ME, rec())
    // The confirmation is asked only once every check has passed; declining it stops short of the wipe.
    let asked = false
    expect(await logoutWith({}, () => ((asked = true), false))).toEqual({ status: 'cancelled' })
    expect(asked).toBe(true)
  })

  it('a read-back missing a locked token does not confirm', async () => {
    records.saveCheckoutCode(ME, rec())
    await backup.publishCheckoutCodes({ codes: [rec({ parts: [{ i: 4, amount: 75, state: 'locked', lockedToken: 'cashuBother' }] })], next: 5 })
    relay.dropPublishes = true
    expect(await backup.confirmCheckoutCodeBackup(ME, FAST)).toMatchObject({ ok: false, reason: 'unconfirmed' })
  })

  it('a forged record confirms nothing', async () => {
    records.saveCheckoutCode(ME, rec())
    relay.dropPublishes = true
    const forged = finalizeEvent(
      { kind: 30078, created_at: 5, tags: [['d', backup.CODES_D_TAG]], content: 'enc:' + btoa(JSON.stringify({ codes: [rec()], next: 5 })) },
      ID,
    )
    relay.events.push({ ...forged, sig: '00'.repeat(64) })
    expect(await backup.confirmCheckoutCodeBackup(ME, FAST)).toMatchObject({ ok: false, reason: 'unconfirmed' })
  })

  it('a code still being made keeps blocking, with its own words', async () => {
    records.saveCheckoutCode(ME, rec({ status: 'locking', parts: [{ i: 1, amount: 75, state: 'arming' }] }))
    const out = await logoutWith()
    expect(out).toMatchObject({ status: 'blocked', reason: 'checkout-code' })
    expect(blockedMessage(out as never)).toContain('still being made')
  })

  it('a send in flight still shows its own message', async () => {
    const out = await logoutWith({ inFlight: () => ({ sends: 1, swaps: 0, cashlinks: 0, codes: 0 }) })
    expect(out).toMatchObject({ status: 'blocked', reason: 'in-flight' })
  })
})
