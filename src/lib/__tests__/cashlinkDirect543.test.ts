/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools'

/**
 * #543 spec section 6: a Cashlink locked from the start, against `cashlinkWorld` (a mint that really
 * signs and enforces NUT-11, the gateway's lock, split and refund-relay rules). Every test that moves
 * value counts where it is at the end.
 */

vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))

const direct = await import('../cashlinkDirect')
const intents = await import('../cashlinkIntents')
const split = await import('../voucherSplit')
const { deriveLinkSecret, linkPubOf } = await import('../giftLink')
const { deriveRefundSecret, readLinkLock, xOnlyPub } = await import('../cashlinkLock')
const { LINK_WRAP_BUDGET, linkWrapBytes, cashlinkBundleId } = await import('../cashlinkFlow')
const { creditableFaceValue, parseVoucherToken, tokenProofs } = await import('../voucherToken')
const { moneyInFlight } = await import('../inFlightMoney')
const { directRows } = await import('../cashlinkDirectPorts')
const W = await import('./cashlinkWorld')
await W.loadTokenReader()

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
const ID = hexToBytes('33'.repeat(32))
const ME = getPublicKey(ID)
const I = 4
const L = deriveLinkSecret(ID, I)
const R = deriveRefundSecret(ID, I)

let w: ReturnType<typeof W.world>
let rows: Map<string, string>
let published: string[]
let recorded: Array<{ intent: import('../cashlinkIntents').CashlinkIntent; arm: { s: string } }>
let publishOk: (token: string) => boolean
let ports: import('../cashlinkDirect').DirectPorts & import('../voucherSplit').SplitPorts

function coupon(amounts: number[], nonce: string, terms: Record<string, unknown> = {}) {
  const proofs = amounts.map((a, n) => w.mint.issue(W.bearerSecret({ nonce: nonce.padEnd(8, 'n'), ...terms }, `${nonce}${n}`), a))
  const token = W.tokenOf(proofs)
  rows.set(`row-${nonce}`, token)
  const faceValue = creditableFaceValue(parseVoucherToken(token)).faceValue
  return { tokenId: `row-${nonce}`, token, amount: faceValue, faceValue }
}

const sats = (token: string) => tokenProofs(token).reduce((n, p) => n + p.amount, 0)
const onLink = () => published.reduce((n, t) => n + sats(t), 0)
const inRows = () => [...rows.values()].reduce((n, t) => n + sats(t), 0)
const keptSats = () => w.kept.reduce((n, k) => n + (k.sats ?? 0), 0)
const atomicSends = () => w.gateway.calls.filter((c) => c.path.includes('atomic-send'))

const start = (parts: Array<{ tokenId: string; token: string; amount: number; faceValue: number }>) =>
  direct.startDirectCashlink({ ports, pubkey: ME, i: I, x: X, stall: W.STALL, unit: 'GBP', decimals: 2, amount: parts.reduce((n, p) => n + p.amount, 0), parts })

beforeEach(() => {
  w = W.world(NOW)
  rows = new Map()
  published = []
  recorded = []
  publishOk = () => true
  localStorage.clear()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  ports = {
    ...w.ports,
    identitySecret: () => Uint8Array.from(ID),
    publish: async (secret, token) => {
      expect(linkPubOf(secret)).toBe(linkPubOf(L))
      if (!publishOk(token)) return false
      if (!published.includes(token)) published.push(token)
      return true
    },
    settleSource: async (tokenId, rest) => {
      if (rest) rows.set(tokenId, rest)
      else rows.delete(tokenId)
    },
    recordRows: async (intent, arm) => void recorded.push({ intent: structuredClone(intent), arm }),
    commit: async (source, remainder, parts) => {
      const partIds = parts.map((t, n) => `split-${n}-${t.slice(-10)}`)
      parts.forEach((t, n) => rows.set(partIds[n], t))
      if (remainder) rows.set(source, remainder)
      else rows.delete(source)
      return { partIds, remainderId: remainder ? source : null }
    },
    keep: async (row) => void w.kept.push(row),
  }
})

describe('the direct path makes a locked Cashlink', () => {
  it('whole coupon: locked to L with R_i until x, refunds at the relay by R, wraps on the link, the row armed, no atomic send', async () => {
    const c = coupon([64], 'a')
    const out = await start([c])
    expect(out).toMatchObject({ kind: 'made', delivered: c.faceValue, published: true, armed: true })
    expect(published).toHaveLength(1)
    for (const p of tokenProofs(published[0])) expect(readLinkLock(p.secret)).toEqual({ linkPub: linkPubOf(L), refundPub: xOnlyPub(R), locktime: X })
    expect(w.gateway.deposits.size).toBe(1)
    expect(atomicSends()).toHaveLength(0)
    expect(recorded.at(-1)!.arm.s).toBe('armed')
    // The coupon left the wallet once locked; nothing is in flight any more.
    expect(rows.has('row-a')).toBe(false)
    expect(onLink()).toBe(64)
    expect(intents.loadCashlinkIntents(ME)).toHaveLength(0)
    expect(moneyInFlight(ME).cashlinks).toBe(0)
  })

  it('a carved part: only the part is locked; the row keeps the rest, settled only once locked', async () => {
    const c = coupon([64, 32, 16], 'b')
    const want = creditableFaceValue(parseVoucherToken(W.tokenOf(tokenProofs(c.token).slice(1, 2) as never))).faceValue
    const order: string[] = []
    const settle = ports.settleSource
    ports.settleSource = async (id, rest) => {
      order.push(`settle:${w.gateway.locks.size}`)
      return settle(id, rest)
    }
    const out = await start([{ ...c, amount: want }])
    expect(out.kind).toBe('made')
    expect(onLink()).toBe(32)
    expect(sats(rows.get('row-b')!)).toBe(80)
    // The row was rewritten only after its proof was locked.
    expect(order).toEqual(['settle:1'])
    expect(onLink() + inRows()).toBe(112)
  })

  it('a split part (bearer-split, then locked by K): the link holds exactly the amount', async () => {
    const c = coupon([1024], 'c', { issuanceRatio: 1, faceValue: 100_000 })
    const s = await split.splitVoucher(ports, ME, { tokenId: c.tokenId, token: c.token, amount: 337 })
    expect(s.kind).toBe('split')
    if (s.kind !== 'split') return
    const out = await start(s.parts)
    expect(out).toMatchObject({ kind: 'made', delivered: 337, armed: true })
    expect(onLink()).toBe(337)
    for (const t of published) for (const p of tokenProofs(t)) expect(readLinkLock(p.secret)?.linkPub).toBe(linkPubOf(L))
    expect(atomicSends()).toHaveLength(0)
  })

  it('3 coupons into 3 wraps, every wrap within LINK_WRAP_BUDGET, rows grouped by the link bundle', async () => {
    const parts = [coupon([64], 'd'), coupon([32, 8], 'e'), coupon([16], 'f')]
    const out = await start(parts)
    expect(out).toMatchObject({ kind: 'made', armed: true })
    expect(published).toHaveLength(3)
    for (const t of published) expect(linkWrapBytes(L, t)).toBeLessThanOrEqual(LINK_WRAP_BUDGET)
    const last = recorded.at(-1)!
    const txs = directRows(last.intent, last.arm as never) as unknown as Array<{ bundleId: string; link: { k: string; i: number; x: number; arm: { s: string } } }>
    expect(txs).toHaveLength(3)
    expect(new Set(txs.map((t) => t.bundleId))).toEqual(new Set([cashlinkBundleId(linkPubOf(L))]))
    for (const t of txs) expect(t.link).toMatchObject({ i: I, x: X, arm: { s: 'armed' } })
    expect(onLink()).toBe(120)
  })

  it('a preflight refusal (relay off) leaves every coupon untouched and goes legacy', async () => {
    w.gateway.relayOn = false
    const c = coupon([64], 'g')
    expect(await start([c])).toEqual({ kind: 'legacy', why: 'relay_off' })
    expect(w.mint.log.swaps).toHaveLength(0)
    expect(rows.get('row-g')).toBe(c.token)
    expect(intents.loadCashlinkIntents(ME)).toHaveLength(0)
  })

  it('lock routes missing go legacy, nothing burnt', async () => {
    w.gateway.routes = false
    const c = coupon([64], 'h')
    expect(await start([c])).toEqual({ kind: 'legacy', why: 'routes_unavailable' })
    expect(w.mint.log.swaps).toHaveLength(0)
  })

  it('a coupon with no DLEQ goes legacy, nothing burnt', async () => {
    const proof = w.mint.issue(W.bearerSecret({ nonce: 'nodleq00' }, 'nd'), 64)
    const token = W.tokenOf([{ ...proof, dleq: undefined } as never])
    rows.set('row-nd', token)
    const face = creditableFaceValue(parseVoucherToken(token)).faceValue
    expect(await start([{ tokenId: 'row-nd', token, amount: face, faceValue: face }])).toEqual({ kind: 'legacy', why: 'no_dleq' })
    expect(w.mint.log.swaps).toHaveLength(0)
  })

  it('a lock window problem (coupon lapses before x) goes legacy, nothing burnt', async () => {
    const c = coupon([64], 'win', { expiresAt: X - 3600 })
    expect(await start([c])).toEqual({ kind: 'legacy', why: 'window' })
    expect(w.mint.log.swaps).toHaveLength(0)
  })

  it('a refusal after the burn keeps the value as sats; the part is dropped, the link holds what was locked', async () => {
    const a = coupon([64], 'i')
    const b = coupon([32], 'j')
    const bSecret = tokenProofs(b.token)[0].secret
    const call = w.gateway.call.bind(w.gateway)
    w.gateway.call = async (m, p, body, s) => {
      const lock = body as { predecessor_secret?: string }
      if (p.endsWith('/cashlink/lock') && lock?.predecessor_secret === bSecret && w.mint.witnessOf(bSecret) !== undefined) return { status: 422, body: { refusal: 'LOCK_REFUSED' } }
      return call(m, p, body, s)
    }
    const out = await start([a, b])
    expect(out).toMatchObject({ kind: 'made', delivered: a.faceValue, kept: b.faceValue })
    expect(onLink()).toBe(64)
    expect(keptSats()).toBe(32)
    expect(rows.size).toBe(0)
    expect(onLink() + keptSats()).toBe(96)
  })

  it('every part refused after the burn: no link, all of it kept as sats', async () => {
    const a = coupon([64], 'k')
    const call = w.gateway.call.bind(w.gateway)
    w.gateway.call = async (m, p, body, s) => {
      const lock = body as { predecessor_secret?: string }
      if (p.endsWith('/cashlink/lock') && lock?.predecessor_secret && w.mint.witnessOf(lock.predecessor_secret) !== undefined) return { status: 422, body: { refusal: 'LOCK_REFUSED' } }
      return call(m, p, body, s)
    }
    expect(await start([a])).toEqual({ kind: 'nothing', kept: a.faceValue })
    expect(keptSats()).toBe(64)
    expect(published).toHaveLength(0)
    expect(intents.loadCashlinkIntents(ME)).toHaveLength(0)
  })

  it('a refused publish leaves the link arming and the intent kept; the next run republishes it', async () => {
    publishOk = () => false
    const c = coupon([64], 'l')
    const out = await start([c])
    expect(out).toMatchObject({ kind: 'made', published: false })
    expect(recorded.at(-1)!.arm.s).toBe('arming')
    expect(moneyInFlight(ME).cashlinks).toBe(1)
    publishOk = () => true
    expect(await direct.finishCashlinkIntents(ports, ME)).toBe(1)
    expect(onLink()).toBe(64)
    expect(recorded.at(-1)!.arm.s).toBe('armed')
    expect(intents.loadCashlinkIntents(ME)).toHaveLength(0)
  })

  it('#543 review: a part is recorded as arming BEFORE its burn reaches the mint', async () => {
    // A page that dies between the burn and the next save must resume the part (NUT-09 finds the
    // burn), never re-run its pre-check, which would read our own burn as a stranger's claim.
    const c = coupon([64], 'q')
    const swap = w.ports.mint.swap.bind(w.ports.mint)
    const statesAtBurn: string[] = []
    w.ports.mint.swap = async (m, inputs, outputs) => {
      if (inputs.some((p) => p.secret === tokenProofs(c.token)[0].secret)) {
        statesAtBurn.push(...intents.loadCashlinkIntents(ME).flatMap((i) => i.parts.map((p) => p.state)))
      }
      return swap(m, inputs, outputs)
    }
    await start([c])
    expect(statesAtBurn).toEqual(['arming'])
  })

  it('#543 review: an intent whose refunds are armed but a wrap is not on the link is kept', async () => {
    // Armed at the relay is not "on the link": until every wrap is published the next run must
    // republish, so the intent (and logout's hold) stays.
    publishOk = () => false
    const c = coupon([64], 'r')
    const out = await start([c])
    expect(out).toMatchObject({ kind: 'made', published: false })
    expect(intents.loadCashlinkIntents(ME)).toHaveLength(1)
    expect(intents.loadCashlinkIntents(ME)[0].parts[0].armed).toBe(true)
  })
})

describe('crash recovery: finishCashlinkIntents (spec section 5)', () => {
  /** Run once with the gateway or mint dying at `when`, then restart with everything healthy. */
  async function dieThenFinish(when: (path: string, body: unknown) => boolean, parts: Array<ReturnType<typeof coupon>>) {
    const call = w.gateway.call.bind(w.gateway)
    let died = false
    w.gateway.call = async (m, p, body, s) => {
      if (!died && when(p, body)) {
        died = true
        throw new Error('page died')
      }
      return call(m, p, body, s)
    }
    const first = await start(parts)
    w.gateway.call = call
    expect(intents.loadCashlinkIntents(ME)).toHaveLength(1)
    const finished = await direct.finishCashlinkIntents(ports, ME)
    return { first, finished }
  }

  it('intent written, nothing burnt: the next run starts from the pre-check, coupons untouched until then', async () => {
    const c = coupon([64], 'm')
    // The page dies right after the intent is written: modelled by writing it and not running it.
    intents.saveCashlinkIntent(ME, {
      id: 'x', k: (await import('../giftLink')).secretToText(L), i: I, x: X, stall: W.STALL, unit: 'GBP', decimals: 2, amount: c.faceValue, at: NOW * 1000,
      parts: [{ sourceTokenId: c.tokenId, rowId: c.tokenId, amount: c.faceValue, token: c.token, state: 'new' }],
    })
    expect(rows.get('row-m')).toBe(c.token)
    expect(w.mint.log.swaps).toHaveLength(0)
    expect(await direct.finishCashlinkIntents(ports, ME)).toBe(1)
    expect(onLink()).toBe(64)
    expect(rows.has('row-m')).toBe(false)
  })

  it('after a burn, before the lock: NUT-09 finds our burn, the lock is asked as a resume, then minted', async () => {
    const c = coupon([64], 'n')
    const { first } = await dieThenFinish((p) => p.endsWith('/cashlink/lock-batch') && w.mint.log.swaps.length > 0, [c])
    expect(first.kind).toBe('pending')
    expect(onLink()).toBe(64)
    expect(recorded.at(-1)!.arm.s).toBe('armed')
    expect(intents.loadCashlinkIntents(ME)).toHaveLength(0)
  })

  it('after the lock, before the mint: the known lock (or its replay) is minted, never lost', async () => {
    const c = coupon([64], 'o')
    w.mint.loseNextReply = false
    let locked = false
    const swap = w.mint.swap.bind(w.mint)
    w.mint.swap = async (m, inputs, outputs) => {
      if (locked) {
        locked = false
        throw new Error('page died before the mint')
      }
      const out = await swap(m, inputs, outputs)
      return out
    }
    const call = w.gateway.call.bind(w.gateway)
    w.gateway.call = async (m, p, body, s) => {
      const a = await call(m, p, body, s)
      if (p.endsWith('/cashlink/lock-batch') && a.status === 200 && w.gateway.locks.size > 0) locked = true
      return a
    }
    const first = await start([c])
    expect(first.kind).toBe('pending')
    w.mint.swap = swap
    w.gateway.call = call
    const saved = intents.loadCashlinkIntents(ME)[0]
    expect(Object.keys(saved.parts[0].locks ?? {})).toHaveLength(1)
    expect(await direct.finishCashlinkIntents(ports, ME)).toBe(1)
    expect(onLink()).toBe(64)
  })

  it('minted, not published: republished from the intent', async () => {
    const c = coupon([64], 'p')
    publishOk = () => false
    await start([c])
    expect(published).toHaveLength(0)
    expect(intents.loadCashlinkIntents(ME)[0].parts[0].wraps).toHaveLength(1)
    publishOk = () => true
    expect(await direct.finishCashlinkIntents(ports, ME)).toBe(1)
    expect(onLink()).toBe(64)
  })

  it('published, refunds not deposited: retryDeposit arms it on the next run', async () => {
    const c = coupon([64], 'q')
    // The wraps go out, then the page dies during the refunds/batch.
    const call = w.gateway.call.bind(w.gateway)
    w.gateway.call = async (m, p, body, s) => {
      if (p.endsWith('/cashlink/refunds/batch')) throw new Error('page died')
      return call(m, p, body, s)
    }
    const out = await start([c])
    expect(out).toMatchObject({ kind: 'made', published: true, armed: false })
    expect(onLink()).toBe(64)
    expect(w.gateway.deposits.size).toBe(0)
    // Kept to retry the deposit, but logout is not held: the value is locked on its link.
    expect(intents.loadCashlinkIntents(ME)[0].parts[0].armed).toBe(false)
    expect(moneyInFlight(ME).cashlinks).toBe(0)
    w.gateway.call = call
    expect(await direct.finishCashlinkIntents(ports, ME)).toBe(1)
    expect(w.gateway.deposits.size).toBe(1)
    expect(recorded.at(-1)!.arm.s).toBe('armed')
    expect(intents.loadCashlinkIntents(ME)).toHaveLength(0)
  })

  it('a definite refusal after the burn, then a restart: the value is kept as sats, never burnt twice', async () => {
    const c = coupon([64], 'r')
    const call = w.gateway.call.bind(w.gateway)
    let n = 0
    w.gateway.call = async (m, p, body, s) => {
      if (p.endsWith('/cashlink/lock-batch') && w.mint.log.swaps.length > 0 && n++ === 0) throw new Error('page died')
      if (p.endsWith('/cashlink/lock') && w.mint.log.swaps.length > 0) return { status: 422, body: { refusal: 'LOCK_REFUSED' } }
      if (p.endsWith('/cashlink/lock-batch') && w.mint.log.swaps.length > 0) return { status: 404, body: null }
      return call(m, p, body, s)
    }
    expect((await start([c])).kind).toBe('pending')
    const out = await direct.finishCashlinkIntents(ports, ME)
    expect(out).toBe(1)
    expect(keptSats()).toBe(64)
    expect(published).toHaveLength(0)
    expect(intents.loadCashlinkIntents(ME)).toHaveLength(0)
  })

  it('the source coupon is held from other sends until its part is locked, then removed', async () => {
    const c = coupon([64], 's')
    publishOk = () => false
    const call = w.gateway.call.bind(w.gateway)
    let held: Set<string> | undefined
    w.gateway.call = async (m, p, body, s) => {
      if (p.endsWith('/cashlink/lock-batch') && !held) held = intents.cashlinkHeldTokenIds(ME)
      return call(m, p, body, s)
    }
    await start([c])
    expect(held?.has('row-s')).toBe(true)
    expect(rows.has('row-s')).toBe(false)
    expect(intents.cashlinkHeldTokenIds(ME).has('row-s')).toBe(false)
  })
})

describe('the legacy reason for each pre-check refusal', () => {
  it.each([
    ['relay_unavailable', 'relay_off'],
    ['lock_route_unavailable', 'routes_unavailable'],
    ['window', 'window'],
    ['no_amount_proof', 'no_dleq'],
    ['merchant', 'merchant'],
    ['lock_refused', 'preflight_lock_refused'],
  ])('%s -> %s', (why, reason) => {
    expect(direct.legacyReasonOf({ kind: 'unarmed', why: why as never })).toBe(reason)
  })
})
