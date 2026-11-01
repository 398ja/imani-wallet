/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * imani-wallet#401 (staging R58): "Take it back" on an ARMED Cashlink before its locktime sat at
 * "Coming back" past the e2e's wait, though the value did come back at the mint later.
 *
 * Reproduced on the local gate only with staging's network latency. On the tap, the row turns
 * `returning` BEFORE the mint swap (so a page that dies finishes it on the next run). Two things
 * then slowed or stopped it:
 *  1. Every History open (and start-up) runs a check over ALL the sender's links, one after another,
 *     and a started take-back was finished only when the walk reached it. With many links and a slow
 *     network, the sender left the page before then, and each reload started the walk again.
 *  2. That same check ran a second copy of the take-back the tap was already running, so the two
 *     raced each other at the mint and the gateway.
 * The fix: a started take-back is finished FIRST, and a check leaves a link to the tap that is
 * taking it back.
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
    h.rows.push({ id: `sent:t${h.rows.length}`, type: 'sent', timestamp: h.rows.length + 1, link: args.link })
    return { id: 's1', requested: 100, delivered: 100, parts: 1 }
  },
}))

const { world, bearerSecret, tokenOf } = await import('./cashlinkWorld')
const giftLinks = await import('../giftLinks')
const { deriveLinkSecret, linkPubOf, secretToText } = await import('../giftLink')
const { tokenProofs } = await import('../voucherToken')
const { readLinkLock } = await import('../cashlinkLock')

const PUB = 'a'.repeat(64)
const NOW = 1_800_000_000
const X = NOW + 7 * 86_400

let w: ReturnType<typeof world>
type Link = { status: string; arm?: { s: string }; x: number; k: string; i?: number }
const links = () => h.rows.map((r) => r.link as Link)
const lockedOn = (secret: Uint8Array) => (h.wraps.get(linkPubOf(secret)) ?? []).filter((t) => readLinkLock(tokenProofs(t)[0].secret))
const mintState = async (t: string) => (await w.mint.states('', tokenProofs(t).map((p) => p.secret)))[0]

beforeEach(() => {
  localStorage.clear()
  h.rows = []
  h.wraps.clear()
  h.redeemed = []
  h.state = async () => 'UNSPENT'
  w = world(NOW)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout'], shouldAdvanceTime: true })
  vi.setSystemTime(NOW * 1000)
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

/** Send one armed Cashlink (the newest row). */
async function sendArmed(): Promise<void> {
  sent.token = tokenOf([w.mint.issue(bearerSecret(), 64)])
  await giftLinks.sendGift({ payer: PUB, merchant: { pubkey: PUB } as never, unit: 'GBP', amount: 1000, x: X, settleBudgetMs: 10 })
  expect(links().at(-1)?.arm?.s).toBe('armed')
}

describe('#401 a started take-back is finished first, and only once', () => {
  it('History opens with a take-back started on the NEWEST link: it is finished before the older links are looked at', async () => {
    // Two older, ordinary Cashlinks (outstanding, never armed), sent before it.
    for (const i of [7, 8]) {
      const s = deriveLinkSecret(ID, i)
      const older = tokenOf([w.mint.issue(bearerSecret(), 64)])
      h.wraps.set(linkPubOf(s), [older])
      h.rows.push({ id: `sent:old${i}`, type: 'sent', timestamp: -10 + i, link: { k: secretToText(s), i, x: X, status: 'outstanding' } })
    }
    await sendArmed()
    h.rows.sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
    const takeBackRow = h.rows[2]
    const linkSecret = deriveLinkSecret(ID, (takeBackRow.link as Link).i!)
    // The tap marked it `returning`, then the page went away before the swap.
    ;(takeBackRow.link as Link).arm = { s: 'returning' }
    // The older links' mint checks hang, as on a slow network, until we let them go.
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const run = giftLinks.reconcileGiftLinks(NOW * 1000, async (t) => {
      await held
      return mintState(t) as never
    })
    // RED on v0.39.4: the walk went oldest first, one link at a time, so the take-back waited
    // behind the hung checks of the older links and never finished while the sender looked on.
    await vi.waitFor(() => expect((takeBackRow.link as Link).status).toBe('reclaimed'))
    release()
    await run
    expect(await mintState(lockedOn(linkSecret)[0])).toBe('SPENT')
  })

  it('a History check while the tap is still taking the link back leaves that link alone: one take-back, not two racing', async () => {
    await sendArmed()
    const k = (h.rows[0].link as Link).k
    h.state = mintState
    // Hold the take-back's mint swap until the History check has run.
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const swap = w.mint.swap.bind(w.mint)
    let swaps = 0
    w.mint.swap = async (m, i, o) => {
      swaps += 1
      if (swaps === 1) await held
      return swap(m, i, o)
    }
    const tap = giftLinks.takeBack(k)
    await vi.waitFor(() => expect(swaps).toBe(1))
    expect((h.rows[0].link as Link).arm?.s).toBe('returning')
    await giftLinks.reconcileGiftLinks(NOW * 1000, h.state as never)
    // RED on v0.39.4: the check ran its own take-back of the same link (a second swap of the same proof).
    expect(swaps).toBe(1)
    release()
    expect((await tap).kind).toBe('ok')
    expect((h.rows[0].link as Link).status).toBe('reclaimed')
  })

  it('a claim on another link is still seen while a take-back is held up at the mint', async () => {
    // The armed link the sender started taking back (sent first, so v0.39.4's walk reached it first).
    await sendArmed()
    const takeBackRow = h.rows[0]
    ;(takeBackRow.link as Link).arm = { s: 'returning' }
    // A later, ordinary Cashlink that the receiver has ALREADY claimed (its gift is spent).
    const s7 = deriveLinkSecret(ID, 7)
    const older = tokenOf([w.mint.issue(bearerSecret(), 64)])
    h.wraps.set(linkPubOf(s7), [older])
    h.rows.push({ id: 'sent:new7', type: 'sent', timestamp: 99, link: { k: secretToText(s7), i: 7, x: X, status: 'outstanding' } })
    // The take-back's mint swap hangs, as on a slow network, until we let it go.
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const swap = w.mint.swap.bind(w.mint)
    w.mint.swap = async (m, i, o) => {
      await held
      return swap(m, i, o)
    }
    const run = giftLinks.reconcileGiftLinks(NOW * 1000, async (t) => (t === older ? 'SPENT' : 'UNSPENT') as never)
    // RED on v0.39.4 and on the first draft: the check waited on the take-back (or walked in order)
    // and the claimed link stayed "Waiting to be claimed" until the slow swap was done.
    await vi.waitFor(() => expect((h.rows[1].link as Link).status).toBe('claimed'))
    expect((takeBackRow.link as Link).status).toBe('outstanding')
    release()
    await run
    expect((takeBackRow.link as Link).status).toBe('reclaimed')
  })
})

/**
 * Staging, 2026-10-30 05:08: "Take it back" tapped seconds after "Cashlink ready". The tap made no
 * mint swap and no gateway call, and said only "Could not take it back just now. Try again." while
 * the row stayed "Waiting to be claimed". The link was armed a moment later. A take-back tapped
 * while its own arm is still running must wait for that arm, then take the gift back.
 */
describe('a take-back tapped while the link is still being armed', () => {
  it('waits for the arm it overlaps, then takes the gift back', async () => {
    let releaseDeposit!: () => void
    const deposited = new Promise<void>((r) => (releaseDeposit = r))
    const call = w.ports.gateway.call.bind(w.ports.gateway)
    w.ports.gateway.call = async (method, path, body) => {
      if (path.includes('/cashlink/refunds')) await deposited
      return call(method, path, body)
    }
    sent.token = tokenOf([w.mint.issue(bearerSecret(), 64)])
    const sending = giftLinks.sendGift({ payer: PUB, merchant: { pubkey: PUB } as never, unit: 'GBP', amount: 1000, x: X, settleBudgetMs: 10_000 })
    await vi.waitFor(() => expect(h.rows).toHaveLength(1))
    const k = (h.rows[0].link as Link).k
    h.state = mintState
    // The sender taps while the arm is still waiting on its deposit.
    const tap = giftLinks.takeBack(k)
    releaseDeposit()
    await sending
    // RED before the fix: the tap ran beside the arm and answered "failed" with nothing taken back.
    expect((await tap).kind).toBe('ok')
    expect((h.rows[0].link as Link).status).toBe('reclaimed')
    const secret = deriveLinkSecret(ID, (h.rows[0].link as Link).i!)
    expect(await mintState(lockedOn(secret)[0])).toBe('SPENT')
  })
})
