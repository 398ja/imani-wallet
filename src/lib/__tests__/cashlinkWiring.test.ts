/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * #295 phase 4, wired into the wallet: Send by link arms the link (or leaves it exactly as before),
 * the start-up/History reconcile settles locked links by their own rules, "Take it back" takes a
 * locked gift back, the link limit stops counting armed links past their expiry, a merchant's links
 * are never armed, and logout is held while a Cashlink's value is moving.
 *
 * The gateway and mint are `cashlinkWorld`'s; storage, the signer and the relay read are faked at
 * their module boundaries, as in giftLinks.test.ts.
 */

const ID = hexToBytes('33'.repeat(32))

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  wraps: new Map<string, string[]>(),
  signerKey: null as Uint8Array | null,
  merchant: false,
  redeemed: [] as string[],
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
  notifyWalletChanged: () => {},
}))
vi.mock('../txRecords', () => ({ publishTx: async () => {} }))
vi.mock('../nap', () => ({
  getSigner: () => {
    if (!h.signerKey) throw new Error('remote signer')
    return { pubkey: 'a'.repeat(64), withPrivkey: <T,>(f: (k: Uint8Array) => T) => f(h.signerKey!.slice()) }
  },
}))
vi.mock('../legacyBridge', () => ({ legacyApi: async () => ({}), withCorrelation: async (_i: unknown, run: (id: string) => unknown) => run('c') }))
vi.mock('../trustedMint', () => ({ loadTrustedMints: async () => {}, checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))
vi.mock('../cashbackValidation', () => ({ cashbackValidation: () => undefined }))
vi.mock('../merchant', () => ({ loadMerchant: () => (h.merchant ? { name: 'stall' } : null) }))
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
    fetchGiftWraps: async (secret: Uint8Array) => ((h.wraps.get(real.linkPubOf(secret)) ?? []).length ? [{ id: 'w' }] : []),
    giftTokensFrom: async (secret: Uint8Array) => (h.wraps.get(real.linkPubOf(secret)) ?? []).map((token) => ({ token, sentAt: 1_800_000_000 })),
    tokenState: async () => 'UNSPENT',
  }
})
// The send itself: a bearer gift lands on the link, as gateway-core's atomic send does.
const sent = vi.hoisted(() => ({ token: '' }))
vi.mock('../pay', () => ({
  sendVouchers: async (args: { recipient: { pubkey: string }; link: Record<string, unknown> }) => {
    h.rows.push({ id: 'sent:t0', type: 'sent', timestamp: 1, link: args.link })
    h.wraps.set(args.recipient.pubkey, [sent.token])
    return { id: 's1', requested: 100, delivered: 100, parts: 1 }
  },
}))

const { world, at, bearerSecret, tokenOf } = await import('./cashlinkWorld')
const giftLinks = await import('../giftLinks')
const { deriveLinkSecret, linkPubOf, secretToText } = await import('../giftLink')
const { tokenProofs } = await import('../voucherToken')
const { attemptLogout } = await import('../logout')
const { moneyInFlight } = await import('../inFlightMoney')

const PUB = 'a'.repeat(64)
const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
let w: ReturnType<typeof world>

function stubWindow() {
  vi.stubGlobal('window', Object.assign(window, { TokenRedemption: { redeem: async (t: string) => void h.redeemed.push(t) } }))
}

beforeEach(() => {
  localStorage.clear()
  h.rows = []
  h.wraps.clear()
  h.signerKey = ID
  h.merchant = false
  h.redeemed = []
  w = world(NOW)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout'], shouldAdvanceTime: true })
  vi.setSystemTime(NOW * 1000)
  sent.token = tokenOf([w.mint.issue(bearerSecret(), 64)])
  // The seam: the world's ports, and the real "moving" ledger.
  vi.spyOn(giftLinks.cashlinkSeam, 'ports').mockResolvedValue(w.ports)
  w.ports.deliver = async (secret, token) => {
    h.wraps.set(linkPubOf(secret), [...(h.wraps.get(linkPubOf(secret)) ?? []), token])
    return true
  }
  stubWindow()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const link = () => h.rows[0].link as { status: string; arm?: { s: string; ks?: string }; x: number; k: string }
const send = () => giftLinks.sendGift({ payer: PUB, merchant: { pubkey: PUB } as never, unit: 'GBP', amount: 1000, x: X, settleBudgetMs: 10 })

describe('Send by link arms the Cashlink when the voucher service can', () => {
  it('arms it: the History row says it comes back on its own', async () => {
    const out = await send()
    expect(out.returnsOnItsOwn).toBe(true)
    expect(link().arm?.s).toBe('armed')
    // Nothing is left marked as moving: logout is not held by an armed link.
    expect(moneyInFlight(PUB).cashlinks).toBe(0)
  })

  it('relay off (as it ships): the send succeeds exactly as before, and the link is not armed', async () => {
    w.gateway.relayOn = false
    const out = await send()
    expect(out.returnsOnItsOwn).toBe(false)
    expect(link().arm).toBeUndefined()
    expect(w.mint.log.swaps).toHaveLength(0)
  })

  it('routes missing (gc not released): the send succeeds, nothing is burnt', async () => {
    w.gateway.routes = false
    expect((await send()).returnsOnItsOwn).toBe(false)
    expect(w.mint.log.swaps).toHaveLength(0)
  })

  it('a merchant account never arms (its expired Cashlinks lapse, by design)', async () => {
    h.merchant = true
    expect((await send()).returnsOnItsOwn).toBe(false)
    expect(w.gateway.calls).toHaveLength(0)
  })

  it('a remote-signer account (random link key, no index) is never armed: the refund key cannot be derived', async () => {
    h.signerKey = null
    expect((await send()).returnsOnItsOwn).toBe(false)
    expect(w.gateway.calls).toHaveLength(0)
  })

  it('arming that stops part way (after the burn) is finished by the next reconcile', async () => {
    const call = w.gateway.call.bind(w.gateway)
    let locks = 0
    w.gateway.call = async (m, p, b, s) => {
      if (p.endsWith('/cashlink/lock') && ++locks === 2) throw new Error('page died')
      return call(m, p, b, s)
    }
    expect((await send()).returnsOnItsOwn).toBe(false)
    expect(link().arm?.s).toBe('arming')
    // Logout is held while the value is moving.
    expect(moneyInFlight(PUB).cashlinks).toBe(1)
    w.gateway.call = call
    await giftLinks.reconcileGiftLinks(NOW * 1000)
    expect(link().arm?.s).toBe('armed')
    expect(moneyInFlight(PUB).cashlinks).toBe(0)
  })
})

describe('the reconcile settles a locked link by its own rules', () => {
  it('the burnt bearer gift on the link is never read as "claimed" once the link is armed', async () => {
    // The original bearer wrap is still on the link and its proofs are now SPENT (by our burn).
    await send()
    await giftLinks.reconcileGiftLinks(NOW * 1000)
    expect(link().status).toBe('outstanding')
  })

  it('expires with the app closed; the relay posts; on the next open it is Taken back, as the voucher', async () => {
    await send()
    at(w, X + 61)
    vi.setSystemTime((X + 61) * 1000)
    await w.gateway.runRelay(X + 61)
    const out = await giftLinks.reconcileGiftLinks((X + 61) * 1000)
    expect(out.reclaimed).toBe(1)
    expect(link().status).toBe('reclaimed')
    expect(w.kept).toHaveLength(1)
    expect(moneyInFlight(PUB).cashlinks).toBe(0)
  })

  it('not armed (relay refused after the lock) and past x: the wallet takes it back itself', async () => {
    w.gateway.depositAnswers = [{ status: 422, body: {} }, { status: 503, body: { refusal: 'RELAY_DISABLED' } }]
    await send()
    expect(link().arm?.s).toBe('not_armed')
    at(w, X + 1)
    vi.setSystemTime((X + 1) * 1000)
    expect((await giftLinks.reconcileGiftLinks((X + 1) * 1000)).reclaimed).toBe(1)
    expect(link().status).toBe('reclaimed')
  })

  it('not armed and still before x: the deposit is retried, and arms once the service takes it', async () => {
    w.gateway.depositAnswers = [{ status: 422, body: {} }, { status: 503, body: { refusal: 'RELAY_DISABLED' } }]
    await send()
    await giftLinks.reconcileGiftLinks(NOW * 1000)
    expect(link().arm?.s).toBe('armed')
  })

  it('claimed by the recipient: marked claimed', async () => {
    await send()
    const k = link().k
    const lockedToken = h.wraps.get(linkPubOf(deriveLinkSecret(ID, 0)))!.at(-1)!
    const { claimLockedGift } = await import('../cashlinkFlow')
    await claimLockedGift({ ports: w.ports, pubkey: 'c3'.repeat(32), linkSecret: deriveLinkSecret(ID, 0), k, lockedTokens: [{ token: lockedToken, sentAt: NOW }] })
    w.kept.length = 0
    expect((await giftLinks.reconcileGiftLinks(NOW * 1000)).claimed).toBe(1)
    expect(link().status).toBe('claimed')
  })
})

describe('Take it back', () => {
  it('takes an armed link back before its expiry and closes it as Taken back', async () => {
    await send()
    expect(await giftLinks.takeBack(link().k)).toEqual({ kind: 'ok' })
    expect(link().status).toBe('reclaimed')
    expect(w.kept).toHaveLength(1)
  })
})

describe('the link limit (stays 10)', () => {
  it('an armed link past its expiry no longer counts as expired-unreturned: it is on its way back', () => {
    const rows = [{ id: 'sent:a', row: {} as never, link: { k: secretToText(deriveLinkSecret(ID, 0)), x: NOW - 1, status: 'outstanding' as const, arm: { s: 'armed' as const } } }]
    expect(giftLinks.countLinks(rows, NOW * 1000)).toEqual({ waiting: 0, expiredUnreturned: 0 })
  })

  it('a link that is not armed past its expiry still counts (its gift could still be claimed)', () => {
    const rows = [{ id: 'sent:a', row: {} as never, link: { k: secretToText(deriveLinkSecret(ID, 0)), x: NOW - 1, status: 'outstanding' as const, arm: { s: 'not_armed' as const } } }]
    expect(giftLinks.countLinks(rows, NOW * 1000)).toEqual({ waiting: 0, expiredUnreturned: 1 })
  })

  it('an armed link before its expiry still counts as waiting: the limit is 10 waiting links', () => {
    expect(giftLinks.MAX_OUTSTANDING_LINKS).toBe(10)
    const rows = [{ id: 'sent:a', row: {} as never, link: { k: secretToText(deriveLinkSecret(ID, 0)), x: NOW + 60, status: 'outstanding' as const, arm: { s: 'armed' as const } } }]
    expect(giftLinks.countLinks(rows, NOW * 1000).waiting).toBe(1)
  })
})

describe('logout is held while a Cashlink\u2019s value is moving', () => {
  const okDeps = {
    checkBackups: async () => ({ ok: true as const, confirmed: 0, fingerprint: '' }),
    checkStash: async () => ({ ok: true as const, fingerprint: '', count: 0 }),
    settleInFlight: async () => {},
    writeCount: () => 0,
    heldNow: async () => '',
    // #379: the History rows hold no stranded Cashlink in these cases.
    strandedLinks: async () => 0,
  }

  it('a sender\u2019s Cashlink on its way back (or being locked) refuses the logout, and erases nothing', async () => {
    localStorage.setItem(`imani-wallet:cashlink-moving:${PUB}`, JSON.stringify(['sent:t0']))
    const confirm = vi.fn(() => true)
    const out = await attemptLogout(PUB, confirm, () => {}, okDeps)
    expect(out).toMatchObject({ status: 'blocked', reason: 'in-flight' })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('a recipient\u2019s claim part way refuses the logout', async () => {
    localStorage.setItem(`imani-wallet:cashlink-claims:${PUB}`, JSON.stringify([{ k: 'x', proof: { secret: 's' }, outputs: [] }]))
    expect(await attemptLogout(PUB, () => true, () => {}, okDeps)).toMatchObject({ status: 'blocked', reason: 'in-flight' })
  })

  it('control: with both ledgers empty the same logout is NOT held as in-flight (so the two above are the ledgers)', async () => {
    // Declined at the confirmation, so nothing is torn down; what matters is that it got that far.
    expect(await attemptLogout(PUB, () => false, () => {}, okDeps)).toEqual({ status: 'cancelled' })
  })
})

describe('the words the sender sees (owner rule: no protocol words)', () => {
  it('every new line is free of jargon', async () => {
    const { JARGON } = await import('../userMessage')
    const copy = await import('../cashlinkCopy')
    const { LOGOUT_BLOCKED_COPY } = await import('../logout')
    for (const line of [copy.RETURN_PROMISE_COPY, copy.RETURNS_ON_ITS_OWN_COPY, copy.RETURNS_WHEN_OPENED_COPY, ...Object.values(copy.RETURN_STATUS_COPY), giftLinks.OWN_COUPON_MESSAGE, LOGOUT_BLOCKED_COPY.inFlight]) {
      expect(line).not.toMatch(JARGON)
      expect(line).not.toMatch(/\b(lock(ed)?|refund|witness|relay|locktime|swap|mint|keyset|sats?)\b/i)
    }
  })
})

// --- Reviewer (rev-wallet377 M1): a stranger's lock on the same link ----------------
//
// The link's PUBLIC key is public (the wrap's p tag), and gc's lock route takes any linkPub. So a
// stranger can lock a coupon of their own to this link with THEIR refund key and wrap it onto it.
describe('rev-wallet377 M1: a stranger\u2019s locked coupon on the link freezes nothing', () => {
  async function plantForeignLockFirst() {
    const { armGift } = await import('../cashlinkFlow')
    const linkSecret = deriveLinkSecret(ID, 0)
    const ours = h.wraps.get(linkPubOf(linkSecret))!.slice()
    const foreign = { token: tokenOf([w.mint.issue(bearerSecret({}, 'stranger'), 8)]), sentAt: NOW }
    const out = await armGift({
      ports: w.ports,
      linkSecret,
      refundSecret: hexToBytes('44'.repeat(32)),
      x: NOW + 2 * 3600,
      gifts: [foreign],
      merchant: false,
      onArming: async () => {},
      onLocked: async () => {},
    })
    expect(out.kind).toBe('armed')
    const planted = h.wraps.get(linkPubOf(linkSecret))!.filter((t) => !ours.includes(t))
    h.wraps.set(linkPubOf(linkSecret), [...planted, ...ours])
  }

  it('after expiry, the sender\u2019s own locked gift still comes back', async () => {
    await send()
    expect(link().arm?.s).toBe('armed')
    await plantForeignLockFirst()
    at(w, X + 61)
    vi.setSystemTime((X + 61) * 1000)
    await w.gateway.runRelay(X + 61)
    await giftLinks.reconcileGiftLinks((X + 61) * 1000)
    expect(link().status).toBe('reclaimed')
  })

  it('"Take it back" takes the sender\u2019s own locked gift, not the stranger\u2019s', async () => {
    await send()
    await plantForeignLockFirst()
    expect(await giftLinks.takeBack(link().k)).toEqual({ kind: 'ok' })
    expect(link().status).toBe('reclaimed')
  })

  it('the recipient\u2019s prompt is not shown as expired because the stranger\u2019s lock ends sooner', async () => {
    await send()
    await plantForeignLockFirst()
    const { verifyGift } = await import('../giftLink')
    const linkSecret = deriveLinkSecret(ID, 0)
    const found = h.wraps.get(linkPubOf(linkSecret))!.map((token) => ({ token, sentAt: NOW }))
    const states = async (t: string) => (await w.mint.states('', tokenProofs(t).map((p) => p.secret)))[0]
    const verdict = await verifyGift(found, X, (NOW + 3 * 3600) * 1000, states, linkPubOf(linkSecret))
    expect(verdict.kind).toBe('ok')
  })
})

describe('rev-wallet377 M2: a burn the mint refuses outright is not "arming" for ever', () => {
  it('the link goes back to an ordinary gift and nothing holds the logout', async () => {
    const swap = w.mint.swap.bind(w.mint)
    w.mint.swap = async (m, i, o) => (i[0]?.secret.startsWith('["VOUCHER"') ? { kind: 'refused', code: 11005 } : swap(m, i, o))
    const out = await send()
    expect(out.returnsOnItsOwn).toBe(false)
    expect(link().arm).toBeUndefined()
    expect(moneyInFlight(PUB).cashlinks).toBe(0)
  })
})

describe('rev-wallet377: logout stays held while a return is part way', () => {
  it('off the link, re-sign not answered yet: the link reads on its way back and logout is held', async () => {
    await send()
    expect(moneyInFlight(PUB).cashlinks).toBe(0)
    at(w, X + 61)
    vi.setSystemTime((X + 61) * 1000)
    await w.gateway.runRelay(X + 61)
    w.gateway.override.set('/api/v1/wallet/vouchers/cashlink/resign', { status: 503, body: null })
    await giftLinks.reconcileGiftLinks((X + 61) * 1000)
    expect(link().arm?.s).toBe('returning')
    expect(moneyInFlight(PUB).cashlinks).toBe(1)
  })
})

describe('second check of rev-wallet377: mutant killers', () => {
  it('M1: a stranger\u2019s lock past its own locktime is not offered to the recipient; the real gift is', async () => {
    await send()
    const linkSecret = deriveLinkSecret(ID, 0)
    const ours = h.wraps.get(linkPubOf(linkSecret))!.slice()
    const { armGift } = await import('../cashlinkFlow')
    const foreign = { token: tokenOf([w.mint.issue(bearerSecret({}, 'stranger'), 8)]), sentAt: NOW }
    expect(
      (await armGift({ ports: w.ports, linkSecret, refundSecret: hexToBytes('44'.repeat(32)), x: NOW + 2 * 3600, gifts: [foreign], merchant: false, onArming: async () => {}, onLocked: async () => {} })).kind,
    ).toBe('armed')
    const stranger = h.wraps.get(linkPubOf(linkSecret))!.filter((t) => !ours.includes(t))
    const { verifyGift } = await import('../giftLink')
    const found = [...stranger, ...ours].map((token) => ({ token, sentAt: NOW }))
    const states = async (t: string) => (await w.mint.states('', tokenProofs(t).map((p) => p.secret)))[0]
    const verdict = await verifyGift(found, X, (NOW + 3 * 3600) * 1000, states, linkPubOf(linkSecret))
    expect(verdict.kind).toBe('ok')
    const offered = verdict.kind === 'ok' ? verdict.tokens.map((t) => t.token) : []
    expect(offered.some((t) => stranger.includes(t))).toBe(false)
    expect(offered).toHaveLength(1)
  })

  it('M2: a resumed arm that now reads as a merchant\u2019s (after the burn) never clears arming or the moving ledger', async () => {
    const call = w.gateway.call.bind(w.gateway)
    let locks = 0
    w.gateway.call = async (m, p, b, s) => {
      if (p.endsWith('/cashlink/lock') && ++locks === 2) throw new Error('page died')
      return call(m, p, b, s)
    }
    await send()
    expect(link().arm?.s).toBe('arming')
    w.gateway.call = call
    h.merchant = true
    await giftLinks.reconcileGiftLinks(NOW * 1000)
    expect(link().arm?.s).toBe('arming')
    expect(moneyInFlight(PUB).cashlinks).toBe(1)
  })
})

describe('second check of rev-wallet377: option A, arming dormant (send tokens carry no DLEQ, B1)', () => {
  it('a DLEQ-less send token is never burnt; the link is an ordinary gift, logout is free, and Take it back works as today', async () => {
    const { dleq: _d, ...bare } = w.mint.issue(bearerSecret({}, 'nodleq'), 64)
    void _d
    sent.token = tokenOf([bare])
    const out = await send()
    expect(out.returnsOnItsOwn).toBe(false)
    expect(link().arm).toBeUndefined()
    expect(w.mint.log.swaps).toHaveLength(0)
    expect(w.gateway.calls.filter((c) => c.path.includes('/cashlink/'))).toHaveLength(0)
    expect(moneyInFlight(PUB).cashlinks).toBe(0)
    await giftLinks.reconcileGiftLinks(NOW * 1000)
    expect(link().status).toBe('outstanding')
    expect(await giftLinks.takeBack(link().k)).toEqual({ kind: 'ok' })
    expect(h.redeemed).toEqual([sent.token])
  })
})
