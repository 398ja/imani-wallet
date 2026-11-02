/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'
import { hashToCurve } from '@cashu/crypto/modules/common'
import { nip17 } from 'nostr-tools'

import { createCashlinkSender, emptyState, CashlinkSenderError, type SenderState, type SenderTransport } from '../src/index'
import { deriveLinkSecret, linkPubOf, secretFromText, type GiftWrap } from '../../../src/lib/giftLink'
import { deriveRefundSecret, readLinkLock, xOnlyPub } from '../../../src/lib/cashlinkLock'
import { claimLockedGift, lockedOnLink, type CashlinkPorts } from '../../../src/lib/cashlinkFlow'
import { parseVoucherToken, tokenProofs } from '../../../src/lib/voucherToken'
import { INDIVIDUAL_LIMITS, limitsFor } from '../../../packages/wallet-core/src/linkLimits'
import { MINT_URL, at, bearerSecret, tokenOf, world, type World } from '../../../src/lib/__tests__/cashlinkWorld'

/**
 * #366: `@imani/cashlink-sender` against the rule-based fake mint and gateway the app's own Cashlink
 * tests use (`cashlinkWorld`), plus an in-memory relay. The engine is the app's (`cashlinkFlow`), so
 * these pin what the SDK adds: index reservation, state with no secrets, limits, reconcile,
 * take-back, restore, and refusing what it must not touch.
 */

const KEY = hexToBytes('5e'.repeat(32))
const NOW = 1_800_000_000
const X = NOW + 3 * 86_400
const ORIGIN = 'https://wallet.example'

let w: World
let wraps: Map<string, GiftWrap[]>
let kept: Array<{ token: string; why: string; i: number; ref?: string }>
let received: string[]
let receiveAnswer: (token: string) => { token: string } | 'spent' | 'failed'

/** A relay in memory: wraps by recipient, as the gateway's nostr query returns them. */
function transport(): SenderTransport {
  return {
    mint: w.mint,
    gateway: w.gateway,
    publish: async (_k, wrap) => {
      const ev = wrap as unknown as GiftWrap
      const p = ev.tags.find((t) => t[0] === 'p')?.[1] ?? ''
      wraps.set(p, [...(wraps.get(p) ?? []), ev])
      return true
    },
    query: async (_k, linkPub) => wraps.get(linkPub) ?? [],
    receive: async (token) => {
      received.push(token)
      return receiveAnswer(token)
    },
  }
}

function sender(extra: Partial<Parameters<typeof createCashlinkSender>[0]> = {}) {
  return createCashlinkSender({
    secretKey: KEY,
    gatewayUrl: 'https://gw.example',
    mintUrl: MINT_URL,
    walletOrigin: ORIGIN,
    keep: async (c) => void kept.push({ token: c.token, why: c.why, i: c.i, ...(c.ref ? { ref: c.ref } : {}) }),
    transport: transport(),
    now: () => w.clock.now * 1000,
    sleep: async () => {},
    ...extra,
  })
}

/** A coupon the sender holds: issued by the stall, with a DLEQ, at the mint. */
let n = 0
const coupon = (amount = 64, over: Parameters<typeof bearerSecret>[0] = {}) => tokenOf([w.mint.issue(bearerSecret(over, `c${n++}`), amount)])

/** The recipient opens the link with the app's own claim path. */
async function claim(url: string) {
  const k = new URL(url).hash.match(/k=([^&]+)/)![1]
  const linkSecret = secretFromText(k)!
  const linkPub = linkPubOf(linkSecret)
  const tokens = (wraps.get(linkPub) ?? []).map((ev) => {
    const r = nip17.unwrapEvent(ev as never, linkSecret) as { content: string; created_at: number }
    return { token: (JSON.parse(r.content) as { token: string }).token, sentAt: r.created_at }
  })
  const got: string[] = []
  const ports: CashlinkPorts = { ...w.ports, keep: async (c) => void got.push(c.token) }
  const outcome = await claimLockedGift({ ports, pubkey: 'cd'.repeat(32), linkSecret, k, lockedTokens: lockedOnLink(tokens, linkPub) })
  return { outcome, got }
}

// The app's claim path keeps its blinding factors in localStorage.
if (typeof globalThis.localStorage === 'undefined') {
  const m = new Map<string, string>()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  }
}

beforeEach(() => {
  w = world(NOW)
  wraps = new Map()
  kept = []
  received = []
  receiveAnswer = (token) => ({ token: `reformed:${token.slice(-8)}` })
  localStorage.clear()
})

describe('send', () => {
  it('arms a link: the coupon is locked to the link with the sender’s refund key, locktime x, and the take-back is at the relay', async () => {
    const s = sender()
    const state = emptyState(s.pubkey)
    const sent = await s.send(state, coupon(), X, 'emp-1')
    expect(sent.link.status).toBe('armed')
    expect(sent.returnsOnItsOwn).toBe(true)
    const lock = readLinkLock(tokenProofs(sent.link.token)[0].secret)!
    expect(lock.locktime).toBe(X)
    expect(lock.linkPub).toBe(linkPubOf(deriveLinkSecret(KEY, 0)))
    expect(lock.refundPub).toBe(xOnlyPub(deriveRefundSecret(KEY, 0)))
    expect(w.gateway.deposits.size).toBe(1)
    expect(sent.url.startsWith(`${ORIGIN}/g#v=1&k=`)).toBe(true)
  })

  it('the state holds no secret: no link key, no refund key, no sender key, and the url is not in it', async () => {
    const s = sender()
    const state = emptyState(s.pubkey)
    const sent = await s.send(state, coupon(), X)
    const json = JSON.stringify(state)
    const k = new URL(sent.url).hash.match(/k=([^&]+)/)![1]
    expect(json).not.toContain(k)
    expect(json).not.toContain('5e'.repeat(32))
    for (const secret of [deriveLinkSecret(KEY, 0), deriveRefundSecret(KEY, 0)]) expect(json).not.toContain(Buffer.from(secret).toString('hex'))
    expect(Object.keys(state.links[0]).sort()).toEqual(['i', 'keyset', 'ref', 'sentAt', 'status', 'token', 'x'].filter((f) => f !== 'ref'))
  })

  it('uses a fresh index per link, past anything used and past any link that already has wraps', async () => {
    const s = sender()
    const state = emptyState(s.pubkey)
    // Someone (an earlier lost run) already used index 0.
    const busy = linkPubOf(deriveLinkSecret(KEY, 0))
    wraps.set(busy, [{ id: 'x', kind: 1059, pubkey: 'p', created_at: 0, content: '', tags: [['p', busy]], sig: '' }])
    const a = await s.send(state, coupon(), X)
    const b = await s.send(state, coupon(), X)
    expect([a.link.i, b.link.i]).toEqual([1, 2])
    expect(state.highWater).toBe(2)
  })

  it('refuses before anything moves: wrong mint, unverified, own stall, bad window', async () => {
    const s = sender()
    const state = emptyState(s.pubkey)
    const code = (p: Promise<unknown>) => p.then(() => 'sent', (e) => (e instanceof CashlinkSenderError ? e.code : String(e)))
    expect(await code(sender({ mintUrl: 'http://other.mint' }).send(emptyState(s.pubkey), coupon(), X))).toBe('wrong_mint')
    // Signed by the issuer key, but naming another key as the issuer: does not verify.
    expect(await code(s.send(state, coupon(64, { issuerPublicKey: s.pubkey }), X))).toBe('unverified')
    // The sender's own coupon (it is the stall): a stall does not send Cashlinks of its own (Q3).
    expect(await code(s.send(state, coupon(64, { issuerId: s.pubkey }), X))).toBe('own_stall')
    expect(await code(s.send(state, coupon(), NOW + 60))).toBe('window')
    expect(await code(s.send(state, coupon(), NOW + 40 * 86_400))).toBe('window')
    expect(await code(s.send(state, coupon(64, { expiresAt: X + 3600 }), X))).toBe('window')
    expect(await code(s.send(state, 'cashuBnotatoken', X))).toBe('bad_coupon')
    expect(state.links).toEqual([])
    expect(state.highWater).toBe(-1)
    expect(w.mint.log.swaps.length).toBe(0)
    expect(wraps.size).toBe(0)
  })

  it('a coupon without a DLEQ goes on the link as a bearer gift, not armed, nothing burnt', async () => {
    const s = sender()
    const state = emptyState(s.pubkey)
    const p = w.mint.issue(bearerSecret({}, 'nod'), 64)
    delete (p as { dleq?: unknown }).dleq
    const sent = await s.send(state, tokenOf([p]), X)
    expect(sent.link.status).toBe('unarmed')
    expect(sent.link.why).toBe('no_amount_proof')
    expect(sent.returnsOnItsOwn).toBe(false)
    expect(w.mint.log.swaps.length).toBe(0)
  })

  it('relay off: the gift stays a bearer gift on its link (unarmed), so reconcile takes it back after x', async () => {
    w.gateway.relayOn = false
    const s = sender()
    const state = emptyState(s.pubkey)
    const sent = await s.send(state, coupon(), X)
    expect(sent.link.status).toBe('unarmed')
    expect(sent.link.why).toBe('relay_unavailable')
    at(w, X + 1)
    const r = await s.reconcile(state)
    expect(r.returned).toBe(1)
    expect(state.links[0].status).toBe('returned')
    expect(received).toEqual([sent.link.token])
    expect(kept[0].i).toBe(sent.link.i)
  })

  it('a state from another key is refused', async () => {
    const s = sender()
    const foreign: SenderState = emptyState('ab'.repeat(32))
    await expect(s.send(foreign, coupon(), X)).rejects.toMatchObject({ code: 'wrong_state' })
  })
})

describe('limits', () => {
  // 11 and 12 full sends: past vitest's 5 s default on a loaded full-suite run (seen 2026-11-02, as
  // the test below), well inside it alone.
  it('without wallet-api the individual limit applies (the safe default), and the 11th open link is refused before anything moves', { timeout: 30_000 }, async () => {
    const s = sender()
    expect(await s.limits()).toEqual(INDIVIDUAL_LIMITS)
    const state = emptyState(s.pubkey)
    for (let i = 0; i < 10; i++) await s.send(state, coupon(), X)
    const swaps = w.mint.log.swaps.length
    await expect(s.send(state, coupon(), X)).rejects.toMatchObject({ code: 'too_many_outstanding' })
    expect(state.links.length).toBe(10)
    expect(w.mint.log.swaps.length).toBe(swaps)
  })

  it('a business limit passed in (from wallet-api) lets a batch past 10', { timeout: 30_000 }, async () => {
    const s = sender()
    const state = emptyState(s.pubkey)
    const lim = limitsFor('business', 50)
    for (let i = 0; i < 12; i++) await s.send(state, coupon(), X, `emp-${i}`, lim)
    expect(state.links.filter((l) => l.status === 'armed').length).toBe(12)
  })

  // 11 full sends (burn, lock, carry, deposit each): past vitest's 5 s default when the whole suite
  // runs in parallel (seen on a loaded run, 2026-11-02), well inside it alone.
  it('claimed and returned links free their slot', { timeout: 30_000 }, async () => {
    const s = sender()
    const state = emptyState(s.pubkey)
    for (let i = 0; i < 10; i++) await s.send(state, coupon(), X)
    await s.takeBack(state, state.links[0].i)
    expect(s.counts(state)).toEqual({ outstanding: 9, expiredUnreturned: 0 })
    await expect(s.send(state, coupon(), X)).resolves.toBeTruthy()
  })

  it('reads the limits from wallet-api, signed by the sender', async () => {
    let auth = ''
    const s = sender({
      walletApiUrl: 'https://api.example',
      fetchImpl: (async (_u: string, init?: RequestInit) => {
        auth = String((init?.headers as Record<string, string>).Authorization)
        return new Response(JSON.stringify({ limits: limitsFor('business', 300) }), { status: 200 })
      }) as typeof fetch,
    })
    expect((await s.limits()).maxOutstanding).toBe(300)
    const ev = JSON.parse(Buffer.from(auth.replace(/^Nostr /, ''), 'base64').toString()) as { pubkey: string; tags: string[][] }
    expect(ev.pubkey).toBe(s.pubkey)
    expect(ev.tags).toContainEqual(['u', 'https://api.example/v1/links/limits'])
  })
})

describe('claim, reconcile and take back', () => {
  it('the recipient claims with the app’s claim path; reconcile marks it claimed and keeps nothing', async () => {
    const s = sender()
    const state = emptyState(s.pubkey)
    const sent = await s.send(state, coupon(), X)
    const { outcome, got } = await claim(sent.url)
    expect(outcome.kind).toBe('ok')
    expect(got.length).toBe(1)
    const r = await s.reconcile(state)
    expect(r).toMatchObject({ claimed: 1, returned: 0 })
    expect(state.links[0].status).toBe('claimed')
    expect(kept).toEqual([])
  })

  it('take back before x: the coupon comes back to keep(), unlocked, same face value, tagged with its link and ref', async () => {
    const s = sender()
    const state = emptyState(s.pubkey)
    const gift = coupon()
    const sent = await s.send(state, gift, X, 'emp-7')
    expect(await s.takeBack(state, sent.link.i)).toBe('returned')
    expect(kept.length).toBe(1)
    expect(kept[0]).toMatchObject({ i: sent.link.i, ref: 'emp-7' })
    const back = parseVoucherToken(kept[0].token)
    expect(tokenProofs(kept[0].token).every((p) => !readLinkLock(p.secret))).toBe(true)
    expect(back.voucher.faceValue).toBe(parseVoucherToken(gift).voucher.faceValue)
    // A recipient opening the link now finds nothing to claim.
    const late = await claim(sent.url)
    expect(late.got).toEqual([])
  })

  it('after x, the relay posts the take-back; reconcile fetches it and keeps the coupon', async () => {
    const s = sender()
    const state = emptyState(s.pubkey)
    await s.send(state, coupon(), X)
    at(w, X + 120)
    await w.gateway.runRelay(X + 120)
    const r = await s.reconcile(state)
    expect(r.returned).toBe(1)
    expect(state.links[0].status).toBe('returned')
    expect(kept.length).toBe(1)
  })

  it('reconcile is idempotent: a second pass changes nothing and keeps nothing twice', async () => {
    const s = sender()
    const state = emptyState(s.pubkey)
    await s.send(state, coupon(), X)
    await s.takeBack(state, 0)
    const before = JSON.stringify(state)
    const r = await s.reconcile(state)
    expect(r.checked).toBe(0)
    expect(JSON.stringify(state)).toBe(before)
    expect(kept.length).toBe(1)
  })

  it('a bearer gift claimed by the recipient is claimed, never "taken back" (its wrap stays on the link)', async () => {
    w.gateway.relayOn = false
    const s = sender()
    const state = emptyState(s.pubkey)
    const sent = await s.send(state, coupon(), X)
    // The recipient swaps the bearer proofs away (into outputs of their own).
    for (const p of tokenProofs(sent.link.token)) w.mint.spent.set(hashToCurve(new TextEncoder().encode(p.secret)).toHex(true), {})
    at(w, X + 1)
    const r = await s.reconcile(state)
    expect(r.claimed).toBe(1)
    expect(received).toEqual([])
  })

  it('a take-back the gateway cannot do yet stays pending, and the next pass finishes it', async () => {
    w.gateway.relayOn = false
    const s = sender()
    const state = emptyState(s.pubkey)
    await s.send(state, coupon(), X)
    at(w, X + 1)
    receiveAnswer = () => 'failed'
    expect((await s.reconcile(state)).pending).toBe(1)
    receiveAnswer = (t) => ({ token: `ok:${t.slice(-4)}` })
    expect((await s.reconcile(state)).returned).toBe(1)
    expect(kept.length).toBe(1)
  })
})

describe('restore from the key alone', () => {
  it('rebuilds open links with their exact x, and does not adopt claimed or returned ones', async () => {
    const s = sender()
    const state = emptyState(s.pubkey)
    const a = await s.send(state, coupon(), X)
    const b = await s.send(state, coupon(), X + 3600)
    const c = await s.send(state, coupon(), X + 7200)
    await claim(a.url)
    await s.takeBack(state, b.link.i)
    const fresh = emptyState(s.pubkey)
    const r = await s.restore(fresh)
    expect(r.adopted).toBe(1)
    expect(fresh.links.map((l) => [l.i, l.x])).toEqual([[c.link.i, X + 7200]])
    expect(fresh.highWater).toBe(2)
    // And the restored link can still be taken back.
    expect(await s.takeBack(fresh, c.link.i)).toBe('returned')
  })

  it('scans past a gap in the indices, up to the account type’s restore gap', async () => {
    const s = sender()
    const state = emptyState(s.pubkey)
    state.highWater = 14 // indices 0..14 were reserved by a run that crashed before sending
    const sent = await s.send(state, coupon(), X)
    expect(sent.link.i).toBe(15)
    const fresh = emptyState(s.pubkey)
    expect((await s.restore(fresh)).adopted).toBe(1)
    expect(fresh.links[0].i).toBe(15)
  })

  it('a bearer gift with no record is adopted to be taken back at once (its x is unknown)', async () => {
    w.gateway.relayOn = false
    const s = sender()
    const state = emptyState(s.pubkey)
    await s.send(state, coupon(), X)
    const fresh = emptyState(s.pubkey)
    await s.restore(fresh)
    expect(fresh.links[0]).toMatchObject({ status: 'unarmed', why: 'restored_without_record', x: NOW })
    expect((await s.reconcile(fresh)).returned).toBe(1)
  })
})
