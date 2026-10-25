/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'
import { hashToCurve } from '@cashu/crypto/modules/common'

/**
 * imani-wallet#379: a Cashlink whose arm failed AFTER the burn must never read "claimed", its row's
 * expiry must be the lock's locktime, and the sender's wallet must take the gift back itself after
 * the expiry with its return key, whatever the row says. Logout stays off until it has.
 *
 * What happened on staging (R52, 0.39.0): the Send page reloads the app, so start-up's restore scan
 * and settle run WHILE the send is arming. The scan, which read the rows before the send's row was
 * written, adopted the link a second time with "30 days from now" as its expiry. The settle, which
 * read the rows before the arm marked them, then found the bearer gift SPENT (by our own burn) and
 * closed the link as "claimed". The deposit was refused (422 MALFORMED), but "not armed" could no
 * longer be written on a closed row, and the reconcile skips closed rows: the locked gift stayed
 * UNSPENT at the mint past its locktime, and never came back.
 *
 * The gateway and mint are `cashlinkWorld`'s, as in cashlinkWiring.test.ts.
 */

const ID = hexToBytes('33'.repeat(32))

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  wraps: new Map<string, string[]>(),
  redeemed: [] as string[],
  /** NUT-07 for the bearer gift as the app's tokenState reads it (default: unspent). */
  state: (async () => 'UNSPENT') as (t: string) => Promise<string>,
  /** Make the identity key unreadable (a locked or lapsed session). */
  noKey: false,
  /** Make the relay query fail (cannot ask), as opposed to answering with no wrap. */
  relayDown: false,
  /** The relay answers with events, none of which unwrap to a gift (malformed or partial). */
  relayMalformed: false,
}))

vi.mock('../wallet', () => ({
  getWallet: () => ({
    getAllTransactions: async () => h.rows,
    updateTransaction: async (id: string, patch: Record<string, unknown>) => {
      const row = h.rows.find((r) => r.id === id)
      if (!row) return null
      Object.assign(row, patch)
      return row
    },
    addTransaction: async (row: Record<string, unknown>) => {
      h.rows.push(row)
      return row
    },
  }),
  // Logout's own read of the History rows.
  openWallet: async () => ({ getAllVouchers: async () => [], getAllTransactions: async () => h.rows }),
  voucherWriteCount: () => 0,
  wipeWallet: async () => {},
  notifyWalletChanged: () => {},
}))
vi.mock('../txRecords', () => ({ publishTx: async () => {} }))
vi.mock('../nap', () => ({
  getSigner: () => ({ pubkey: 'a'.repeat(64), withPrivkey: <T,>(f: (k: Uint8Array) => T) => {
      if (h.noKey) throw new Error('locked')
      return f(ID.slice())
    } }),
  // Logout's side (the confirmation is declined or never reached in these tests).
  getSession: () => ({ logout: async () => {} }),
  keyStore: { clear: async () => {} },
  resetSession: () => {},
}))
vi.mock('../legacyBridge', () => ({ legacyApi: async () => ({}), withCorrelation: async (_i: unknown, run: (id: string) => unknown) => run('c') }))
vi.mock('../trustedMint', () => ({ loadTrustedMints: async () => {}, checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))
vi.mock('../cashbackValidation', () => ({ cashbackValidation: () => undefined }))
vi.mock('../merchant', () => ({ loadMerchant: () => null }))
vi.mock('../merchantVouchers', () => ({
  ForeignVoucherRefusedError: class extends Error {},
  isServerForeignRefusal: () => false,
  refuseForeignIssuer: async () => {},
  refuseForeignVouchers: async () => {},
  sessionAccount: () => 'a'.repeat(64),
}))
vi.mock('../giftLink', async (orig) => {
  const real = await orig<typeof import('../giftLink')>()
  return {
    ...real,
    fetchGiftWraps: async (secret: Uint8Array) => {
      if (h.relayDown) throw new real.GiftUnreachableError('nostr/query answered 503')
      return (h.wraps.get(real.linkPubOf(secret)) ?? []).length ? [{ id: 'w' }] : []
    },
    // #381: the relay's raw answer. `malformed` stands for a reply with wraps this wallet cannot read.
    fetchGiftWrapsAnswer: async (secret: Uint8Array) => {
      if (h.relayDown) throw new real.GiftUnreachableError('nostr/query answered 503')
      const n = (h.wraps.get(real.linkPubOf(secret)) ?? []).length
      return { wraps: n ? [{ id: 'w' }] : [], emptyAnswer: n === 0 && !h.relayMalformed }
    },
    giftTokensFrom: async (secret: Uint8Array) => (h.wraps.get(real.linkPubOf(secret)) ?? []).map((token) => ({ token, sentAt: 1_800_000_000 })),
    tokenState: async (t: string) => h.state(t),
  }
})
const sent = vi.hoisted(() => ({ token: '', beforeRow: undefined as undefined | (() => Promise<void>) }))
vi.mock('../pay', () => ({
  sendVouchers: async (args: { recipient: { pubkey: string }; link: Record<string, unknown> }) => {
    // The gift wrap reaches the relay first; the row is written once the send settles.
    h.wraps.set(args.recipient.pubkey, [sent.token])
    await sent.beforeRow?.()
    h.rows.push({ id: 'sent:t0', type: 'sent', timestamp: 1, link: args.link })
    return { id: 's1', requested: 100, delivered: 100, parts: 1 }
  },
}))

const { world, at, bearerSecret, tokenOf } = await import('./cashlinkWorld')
const giftLinks = await import('../giftLinks')
const { deriveLinkSecret, linkPubOf, secretToText } = await import('../giftLink')
const { tokenProofs } = await import('../voucherToken')
const { readLinkLock, deriveRefundSecret, derivedOutputs, sigAllWitness } = await import('../cashlinkLock')
const { claimLockedGift } = await import('../cashlinkFlow')
const { strandedCashlinks } = await import('../transactions')
const { moneyInFlight } = await import('../inFlightMoney')
const { markMoving } = await import('../cashlinkPorts')
const { attemptLogout } = await import('../logout')

const PUB = 'a'.repeat(64)
const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
/** A NUT-02 v2 keyset id (66 hex), as staging's mint has. */
const V2_KEYSET = '01' + 'f0'.repeat(32)
const LINK = deriveLinkSecret(ID, 0)
let w: ReturnType<typeof world>

type Link = { status: string; arm?: { s: string; ks?: string }; x: number; k: string; verifiedAt?: number }
const links = () => h.rows.map((r) => r.link as Link)
const lockedOnLink = () => (h.wraps.get(linkPubOf(LINK)) ?? []).filter((t) => readLinkLock(tokenProofs(t)[0].secret))
const locktimeOnLink = () => readLinkLock(tokenProofs(lockedOnLink()[0]).at(0)!.secret)!.locktime
const mintState = async (t: string) => (await w.mint.states('', tokenProofs(t).map((p) => p.secret)))[0]
const send = () => giftLinks.sendGift({ payer: PUB, merchant: { pubkey: PUB } as never, unit: 'GBP', amount: 1000, x: X, settleBudgetMs: 10 })

beforeEach(() => {
  localStorage.clear()
  h.rows = []
  h.wraps.clear()
  h.redeemed = []
  h.state = async () => 'UNSPENT'
  h.noKey = false
  h.relayDown = false
  h.relayMalformed = false
  sent.beforeRow = undefined
  w = world(NOW)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout'], shouldAdvanceTime: true })
  vi.setSystemTime(NOW * 1000)
  // Staging's mint signs under a v2 keyset id.
  w.mint.keysets[0].id = V2_KEYSET
  sent.token = tokenOf([w.mint.issue(bearerSecret(), 64)])
  vi.spyOn(giftLinks.cashlinkSeam, 'ports').mockResolvedValue(w.ports)
  w.ports.deliver = async (secret, token) => {
    h.wraps.set(linkPubOf(secret), [...(h.wraps.get(linkPubOf(secret)) ?? []), token])
    return true
  }
  vi.stubGlobal('window', Object.assign(window, { TokenRedemption: { redeem: async (t: string) => void h.redeemed.push(t) } }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function afterExpiry(): Promise<{ claimed: number; reclaimed: number }> {
  at(w, X + 61)
  vi.setSystemTime((X + 61) * 1000)
  return giftLinks.reconcileGiftLinks((X + 61) * 1000, mintState)
}

// ─── Review of #380 (adversarial, money path): mutant killers ────────────────────────────────

const K = () => secretToText(LINK)

/**
 * An ordinary (unarmed) link whose bearer gift was burnt by THIS wallet's arm, with the record of
 * that arm lost (a second tab, or a crash before the row was marked): the row says `outstanding`,
 * no `arm`, and the mint says the bearer gift is SPENT.
 */
async function ourBurnWithoutRecord(): Promise<void> {
  w.gateway.relayOn = false
  const out = await send()
  expect(out.returnsOnItsOwn).toBe(false)
  expect(links()).toEqual([expect.objectContaining({ status: 'outstanding' })])
  expect(links()[0].arm).toBeUndefined()
  w.gateway.relayOn = true
  const refundSecret = deriveRefundSecret(ID, 0)
  const [proof] = tokenProofs(sent.token)
  const outs = derivedOutputs(refundSecret, 'burn', proof.secret, proof.amount, proof.id)
  expect((await w.mint.swap('', [{ ...proof, witness: sigAllWitness(refundSecret, proof.secret, proof.C, outs) }], outs)).kind).toBe('signed')
  h.state = mintState
  expect(await mintState(sent.token)).toBe('SPENT')
}

/** A stranger claimed the ordinary link: the bearer gift is spent, into nothing of ours. */
function strangerSpendsBearer(): void {
  const [proof] = tokenProofs(sent.token)
  w.mint.spent.set(hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true), {})
  h.state = mintState
}

describe('review #380: our own burn is never read as a stranger\'s claim', () => {
  it('reconcile: a bearer gift spent into OUR burn outputs resumes the arm, never "claimed"', async () => {
    await ourBurnWithoutRecord()
    await giftLinks.reconcileGiftLinks(NOW * 1000, h.state as never)
    expect(links().some((l) => l.status === 'claimed')).toBe(false)
    expect(links().every((l) => l.status === 'outstanding' && l.arm?.s === 'armed')).toBe(true)
    expect(lockedOnLink()).toHaveLength(1)
  })

  it('reconcile: the mint cannot answer the restore, so nothing is written', async () => {
    await ourBurnWithoutRecord()
    w.mint.restore = async () => {
      throw new Error('restore HTTP 503')
    }
    await giftLinks.reconcileGiftLinks(NOW * 1000, h.state as never)
    expect(links()).toEqual([expect.objectContaining({ status: 'outstanding' })])
    expect(links()[0].arm).toBeUndefined()
    expect(links()[0].verifiedAt).toBeUndefined()
  })

  it('reconcile: this session cannot read the key that derives the burn, so nothing is written', async () => {
    await ourBurnWithoutRecord()
    h.noKey = true
    await giftLinks.reconcileGiftLinks(NOW * 1000, h.state as never)
    expect(links().some((l) => l.status === 'claimed')).toBe(false)
    // Once the key is readable again, the same link is finished.
    h.noKey = false
    await giftLinks.reconcileGiftLinks(NOW * 1000, h.state as never)
    expect(links().every((l) => l.status === 'outstanding' && l.arm?.s === 'armed')).toBe(true)
  })

  it('Take it back: a bearer gift spent into our burn is "not now", never "claimed", and holds logout', async () => {
    await ourBurnWithoutRecord()
    const out = await giftLinks.takeBack(K())
    expect(out.kind).toBe('failed')
    expect(links().some((l) => l.status === 'claimed')).toBe(false)
    expect(links()[0].arm?.s).toBe('arming')
    expect(moneyInFlight(PUB).cashlinks).toBe(1)
  })

  it('control: a stranger\'s spend of the ordinary gift IS claimed, with verifiedAt, and holds nothing', async () => {
    w.gateway.relayOn = false
    await send()
    strangerSpendsBearer()
    await giftLinks.reconcileGiftLinks(NOW * 1000, h.state as never)
    expect(links()).toEqual([expect.objectContaining({ status: 'claimed', verifiedAt: NOW * 1000 })])
    expect(strandedCashlinks(h.rows, NOW * 1000)).toBe(0)
  })
})

describe('review #380: a claim decided by the mint is recorded as checked', () => {
  it('an armed link claimed by the recipient closes "claimed" WITH verifiedAt, so it is never re-checked or holding logout', async () => {
    const out = await send()
    expect(out.returnsOnItsOwn).toBe(true)
    await claimLockedGift({ ports: w.ports, pubkey: 'c3'.repeat(32), linkSecret: LINK, k: K(), lockedTokens: [{ token: lockedOnLink()[0], sentAt: NOW }] })
    w.kept.length = 0
    await giftLinks.reconcileGiftLinks(NOW * 1000, mintState)
    expect(links()).toEqual([expect.objectContaining({ status: 'claimed', verifiedAt: expect.any(Number), arm: expect.objectContaining({ s: 'armed' }) })])
    expect(strandedCashlinks(h.rows, NOW * 1000)).toBe(0)
  })
})

/** The row an older build closed as claimed while it was locking, with NO lock on the link yet. */
function olderBuildClaimedNoLock(): void {
  h.rows = [{ id: 'sent:t0', type: 'sent', timestamp: 1, link: { k: K(), i: 0, x: X, status: 'claimed', closedAt: NOW * 1000, arm: { s: 'arming' } } }]
  h.wraps.set(linkPubOf(LINK), [sent.token])
}

describe('review #380: repair of an older build\'s "claimed" row whose lock never reached the link', () => {
  it('bearer still UNSPENT (nothing burnt): opened again as the ordinary gift, and comes back after x', async () => {
    olderBuildClaimedNoLock()
    h.state = mintState
    await giftLinks.reconcileGiftLinks(NOW * 1000, mintState)
    expect(links()).toEqual([expect.objectContaining({ status: 'outstanding' })])
    expect(links()[0].arm).toBeUndefined()
    expect(moneyInFlight(PUB).cashlinks).toBe(0)
  })

  it('bearer spent by a stranger: stays claimed, now checked', async () => {
    olderBuildClaimedNoLock()
    strangerSpendsBearer()
    await giftLinks.reconcileGiftLinks(NOW * 1000, mintState)
    expect(links()).toEqual([expect.objectContaining({ status: 'claimed', verifiedAt: expect.any(Number) })])
  })

  it('bearer burnt by us, the mint\'s restore unreadable: left as it is (never confirmed as claimed)', async () => {
    olderBuildClaimedNoLock()
    const refundSecret = deriveRefundSecret(ID, 0)
    const [proof] = tokenProofs(sent.token)
    const outs = derivedOutputs(refundSecret, 'burn', proof.secret, proof.amount, proof.id)
    await w.mint.swap('', [{ ...proof, witness: sigAllWitness(refundSecret, proof.secret, proof.C, outs) }], outs)
    const restore = w.mint.restore.bind(w.mint)
    w.mint.restore = async () => {
      throw new Error('restore HTTP 503')
    }
    await giftLinks.reconcileGiftLinks(NOW * 1000, mintState)
    expect(links()[0].verifiedAt).toBeUndefined()
    expect(strandedCashlinks(h.rows, NOW * 1000)).toBe(1)
    // Readable again: reopened and the arm finished.
    w.mint.restore = restore
    await giftLinks.reconcileGiftLinks(NOW * 1000, mintState)
    expect(links().every((l) => l.status === 'outstanding' && l.arm?.s === 'armed')).toBe(true)
  })
})

describe('review #380: a link still marked "arming" whose lock is already on the link', () => {
  it('before x: becomes not_armed, the deposit is retried and arms it, and logout is freed', async () => {
    await send()
    for (const r of h.rows) (r.link as Record<string, unknown>).arm = { s: 'arming' }
    w.gateway.deposits.clear()
    markMoving(PUB, 'sent:t0')
    expect(moneyInFlight(PUB).cashlinks).toBe(1)
    await giftLinks.reconcileGiftLinks(NOW * 1000, mintState)
    expect(links()[0].arm?.s).toBe('armed')
    expect(w.gateway.deposits.size).toBe(1)
    expect(moneyInFlight(PUB).cashlinks).toBe(0)
  })
})

describe('review #380: the send\'s own row decides the expiry, never an adopted guess', () => {
  /** The send's row (x = locktime) and a restore-scan duplicate (30 days), the duplicate first. */
  async function withAdoptedDuplicate(): Promise<void> {
    w.gateway.depositAnswers = [{ status: 422, body: {} }, { status: 422, body: { refusal: 'MALFORMED' } }]
    await send()
    expect(links()[0].arm?.s).toBe('not_armed')
    const own = h.rows[0]
    h.rows = [
      { id: 'sent:gift-dup', type: 'sent', timestamp: 0, link: { ...(own.link as object), x: NOW + 30 * 86_400 } },
      own,
    ]
  }

  it('reconcile writes the locktime on every row, the duplicate included', async () => {
    await withAdoptedDuplicate()
    w.gateway.relayOn = false
    await giftLinks.reconcileGiftLinks(NOW * 1000, mintState)
    expect(links().map((l) => l.x)).toEqual([locktimeOnLink(), locktimeOnLink()])
  })

  it('the link counts as expired (not waiting) once the send\'s own x has passed', async () => {
    await withAdoptedDuplicate()
    expect(giftLinks.countLinks(await giftLinks.linkRows(), (X + 10) * 1000)).toEqual({ waiting: 0, expiredUnreturned: 1 })
  })
})

describe('review #380: the in-flight guard', () => {
  it('a restore scan that runs while the send is still going (its row not yet written) never adopts the link', async () => {
    let scanned = -1
    sent.beforeRow = async () => {
      scanned = await giftLinks.restoreScan(PUB, async (secret) => (h.wraps.get(linkPubOf(secret)) ?? []).map((token) => ({ token, sentAt: NOW })), mintState, NOW * 1000)
    }
    await send()
    expect(scanned).toBe(0)
    expect(h.rows.map((r) => r.id)).toEqual(['sent:t0'])
  })

  it('a reload mid-send leaves nothing skipped: a fresh module run settles the link normally', async () => {
    w.gateway.relayOn = false
    await send()
    strangerSpendsBearer()
    // The guard is per tab and in memory; a send that returned has released it.
    await giftLinks.reconcileGiftLinks(NOW * 1000, h.state as never)
    expect(links()[0].status).toBe('claimed')
  })
})

describe('review #380: logout', () => {
  it('a link being locked or on its way back holds logout; one armed and waiting does not', () => {
    const row = (arm: Record<string, unknown> | undefined, status = 'outstanding') => [{ type: 'sent', link: { k: K(), i: 0, x: NOW + 100, status, ...(arm ? { arm } : {}) } }]
    expect(strandedCashlinks(row({ s: 'arming' }), NOW * 1000)).toBe(1)
    expect(strandedCashlinks(row({ s: 'returning' }), NOW * 1000)).toBe(1)
    expect(strandedCashlinks(row({ s: 'armed' }), NOW * 1000)).toBe(0)
    expect(strandedCashlinks(row({ s: 'not_armed' }), NOW * 1000)).toBe(0)
  })

  it('History rows that cannot be read block the logout', async () => {
    const deps = {
      checkBackups: async () => ({ ok: true as const, confirmed: 0, fingerprint: '' }),
      checkStash: async () => ({ ok: true as const, fingerprint: '', count: 0 }),
      settleInFlight: async () => {},
      writeCount: () => 0,
      heldNow: async () => '',
      strandedLinks: async () => {
        throw new Error('IndexedDB unreadable')
      },
    }
    const confirm = vi.fn(() => true)
    expect(await attemptLogout(PUB, confirm, () => {}, deps)).toMatchObject({ status: 'blocked', reason: 'in-flight' })
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('review #380: x for an ordinary (unlocked) link with an adopted duplicate from 0.39.0', () => {
  it('after the send\'s own x, the gift comes back, even when the adopted row (30 days) sorts first', async () => {
    w.gateway.relayOn = false
    await send()
    const own = h.rows[0]
    h.rows = [{ id: 'sent:gift-dup', type: 'sent', timestamp: 0, link: { ...(own.link as object), x: NOW + 30 * 86_400 } }, own]
    vi.setSystemTime((X + 61) * 1000)
    await giftLinks.reconcileGiftLinks((X + 61) * 1000, mintState)
    expect(h.redeemed).toEqual([sent.token])
    expect(links().every((l) => l.status === 'reclaimed')).toBe(true)
  })
})

describe('review #380: repair when the older row sorts its adopted duplicate first', () => {
  it('after x: still taken back, every row carries the locktime', async () => {
    w.gateway.depositAnswers = [{ status: 422, body: {} }, { status: 422, body: { refusal: 'MALFORMED' } }]
    await send()
    const k = K()
    h.rows = [
      { id: 'sent:gift-ede7f5162e888768e11f7d310859f127', type: 'sent', timestamp: 0, link: { k, i: 0, x: NOW + 30 * 86_400, status: 'claimed', closedAt: NOW * 1000, arm: { s: 'arming' } } },
      { id: 'sent:t0', type: 'sent', timestamp: 1, link: { k, i: 0, x: X, status: 'claimed', closedAt: NOW * 1000, arm: { s: 'arming' } } },
    ]
    localStorage.clear()
    expect((await afterExpiry()).reclaimed).toBe(1)
    expect(links().every((l) => l.status === 'reclaimed' && l.x === locktimeOnLink())).toBe(true)
  })

  // #381 (owner, option a; review of #388). An old 0.39.0 row (claimed, with an arm) whose gift
  // wraps the relay no longer holds. It stops holding logout only when nothing can be brought back:
  // the relay's answer is really empty, the coupon is a week past its OWN expiry (read from the lock
  // this device kept), and the mint says the locked gift is spent.
  const COUPON_EXP = 1_900_000_000 // bearerSecret's expiry: months after X
  const HARD = giftLinks.COUPON_LAPSE_HARD_S
  const lockedSecret = () => tokenProofs(lockedOnLink()[0])[0].secret
  /** A real armed send (its lock kept on this device), then turned into the 0.39.0 row, wraps gone. */
  const wrapless = async ({ spent }: { spent: boolean }) => {
    await send()
    const secret = lockedSecret()
    if (spent) w.mint.spent.set(hashToCurve(new TextEncoder().encode(secret)).toHex(true), {})
    h.rows = [{ id: 'sent:t0', type: 'sent', timestamp: 1, link: { k: K(), i: 0, x: X, status: 'claimed', closedAt: NOW * 1000, arm: { s: 'arming' } } }]
    h.wraps.clear()
    Object.assign(giftLinks.cashlinkSeam, { mintUrl: async () => 'https://mint.example' })
  }
  const reconcileAt = async (s: number) => {
    at(w, s)
    vi.setSystemTime(s * 1000)
    await giftLinks.reconcileGiftLinks(s * 1000, mintState)
  }

  it('#381: wraps gone, past x + one week but the coupon still live: left as it is, logout stays held', async () => {
    // x + one week is not the coupon's expiry. This coupon lasts months longer and the locked gift
    // can still be taken back with R, so the row must keep logout off.
    await wrapless({ spent: true })
    const t = X + HARD + 1
    await reconcileAt(t)
    expect(links()[0].verifiedAt).toBeUndefined()
    expect(strandedCashlinks(h.rows, t * 1000)).toBe(1)
  })

  it('#381: wraps gone, one second short of the coupon\'s own expiry + one week: logout stays held', async () => {
    await wrapless({ spent: true })
    const t = COUPON_EXP + HARD
    await reconcileAt(t)
    expect(links()[0].verifiedAt).toBeUndefined()
    expect(strandedCashlinks(h.rows, t * 1000)).toBe(1)
  })

  it('#381: wraps gone, a week past the coupon\'s own expiry, the mint says spent: settled, logout freed', async () => {
    // Nothing can come back any more, and the mint confirms it, so the row stops blocking.
    await wrapless({ spent: true })
    const t = COUPON_EXP + HARD + 1
    await reconcileAt(t)
    expect(links()[0]).toMatchObject({ status: 'claimed', verifiedAt: t * 1000 })
    expect(strandedCashlinks(h.rows, t * 1000)).toBe(0)
  })

  it('#381: wraps gone, past the coupon\'s expiry, but the locked gift is UNSPENT: logout stays held', async () => {
    // The mint still holds the locked gift unspent: its value may be recoverable, so no confirm.
    await wrapless({ spent: false })
    const t = COUPON_EXP + HARD + 1
    await reconcileAt(t)
    expect(links()[0].verifiedAt).toBeUndefined()
    expect(strandedCashlinks(h.rows, t * 1000)).toBe(1)
  })

  it('#381: wraps gone, past the coupon\'s expiry, the mint cannot answer: nothing is written', async () => {
    await wrapless({ spent: true })
    w.mint.down = true
    const t = COUPON_EXP + HARD + 1
    await reconcileAt(t)
    expect(links()[0].verifiedAt).toBeUndefined()
    expect(strandedCashlinks(h.rows, t * 1000)).toBe(1)
  })

  it('#381: the relay answers with wraps this wallet cannot read: never "no wraps", nothing is written', async () => {
    // A malformed or partial reply is not an empty one: the gift may still be there.
    await wrapless({ spent: true })
    h.relayMalformed = true
    const t = COUPON_EXP + HARD + 1
    await reconcileAt(t)
    expect(links()[0].verifiedAt).toBeUndefined()
    expect(strandedCashlinks(h.rows, t * 1000)).toBe(1)
  })

  it('#381: no lock kept on this device, so no expiry can be read: never confirmed', async () => {
    await wrapless({ spent: true })
    localStorage.clear()
    const t = COUPON_EXP + HARD + 1
    await reconcileAt(t)
    expect(links()[0].verifiedAt).toBeUndefined()
    expect(strandedCashlinks(h.rows, t * 1000)).toBe(1)
  })

  it('#381: the relay cannot be read past the final expiry: nothing is written, logout stays held', async () => {
    // "Could not ask" is not "no wrap": a relay that errors must never unblock the row.
    await wrapless({ spent: true })
    h.relayDown = true
    const t = COUPON_EXP + HARD + 1
    await reconcileAt(t)
    expect(links()[0].verifiedAt).toBeUndefined()
    expect(strandedCashlinks(h.rows, t * 1000)).toBe(1)
  })

  it('#381: wraps readable past the final expiry: unchanged, a still-unspent gift opens again', async () => {
    // The new rule is only for wrap-less rows. A readable, unspent bearer gift is re-opened as before.
    h.rows = [{ id: 'sent:t0', type: 'sent', timestamp: 1, link: { k: K(), i: 0, x: X, status: 'claimed', closedAt: NOW * 1000, arm: { s: 'arming' } } }]
    h.wraps.set(linkPubOf(LINK), [sent.token])
    const t = (X + HARD + 1) * 1000
    await giftLinks.reconcileGiftLinks(t, mintState)
    expect(links()[0].status).not.toBe('claimed')
    expect(links()[0].verifiedAt).toBeUndefined()
  })

  it('#381: wraps readable past the final expiry, the mint answers unknown: left as it is, logout stays held', async () => {
    // The final expiry is no reason to stop asking: with wraps to check and a mint that cannot say,
    // the row is left unconfirmed and keeps logout off.
    h.rows = [{ id: 'sent:t0', type: 'sent', timestamp: 1, link: { k: K(), i: 0, x: X, status: 'claimed', closedAt: NOW * 1000, arm: { s: 'arming' } } }]
    h.wraps.set(linkPubOf(LINK), [sent.token])
    w.mint.down = true
    const t = (X + HARD + 1) * 1000
    await giftLinks.reconcileGiftLinks(t, async () => 'UNKNOWN' as never)
    expect(links()[0]).toMatchObject({ status: 'claimed' })
    expect(links()[0].verifiedAt).toBeUndefined()
    expect(strandedCashlinks(h.rows, t)).toBe(1)
  })
})
