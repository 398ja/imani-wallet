/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * #295 phase 4, the money path end to end: a Cashlink is armed (burn, lock, mint, deposit), comes
 * back on its own (the relay posts the pre-signed refund, the wallet re-forms the voucher), is
 * claimed by a recipient, survives a dead page at every step, and degrades safely whenever the
 * gateway's routes or relay are off, missing or refusing. Run against `cashlinkWorld`: a mint that
 * really signs and enforces NUT-11, and a gateway that implements the lock, re-sign and relay rules.
 *
 * Every test names the rule it pins. The invariant behind all of them: value is never lost. Each
 * test that moves value ends by counting it.
 */

vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))

const { armGift, claimLockedGift, settleLockedGift, retryDeposit, restoreFinding, recoverOrphanBurn, cashlinkClaimsInFlight, loadClaims, finishCashlinkClaims, LOCK_PATH, REFUNDS_PATH, RESIGN_PATH } = await import('../cashlinkFlow')
const { readLinkLock, isOpenAfterLocktime, secretHash } = await import('../cashlinkLock')
const { linkPubOf, secretToText, giftCandidates } = await import('../giftLink')
const { parseVoucherToken, tokenProofs } = await import('../voucherToken')
const { MINT_URL, bearerSecret, tokenOf, world, at } = await import('./cashlinkWorld')

type World = ReturnType<typeof world>

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
const LINK = hexToBytes('11'.repeat(32))
const REFUND = hexToBytes('22'.repeat(32))
const RECIPIENT = 'c3'.repeat(32)

let w: World
let armState: string[]
let locks: Map<string, string>

function giftOn(w: World, amounts = [64]) {
  const proofs = amounts.map((a, n) => w.mint.issue(bearerSecret({}, `w${n}`), a))
  return { token: tokenOf(proofs), sentAt: NOW }
}

function armCtx(gift: { token: string; sentAt: number }, extra: Partial<Parameters<typeof armGift>[0]> = {}) {
  return {
    ports: w.ports,
    linkSecret: LINK,
    refundSecret: REFUND,
    x: X,
    gifts: [gift],
    merchant: false,
    onArming: async (ks: string) => void armState.push(`arming:${ks}`),
    onLocked: async (g: string, s: string) => void locks.set(g, s),
    knownLocks: locks,
    ...extra,
  }
}

const lockedToken = () => w.wraps[w.wraps.length - 1]
const keptSats = () => w.kept.reduce((n, k) => n + (k.satsToken ? (k.sats ?? 0) : parseVoucherToken(k.token).tokenAmount), 0)

function returnCtx(extra: Partial<Parameters<typeof settleLockedGift>[0]> = {}) {
  return { ports: w.ports, linkSecret: LINK, refundSecret: REFUND, lockedToken: lockedToken(), onReturning: async () => void armState.push('returning'), ...extra }
}

beforeEach(() => {
  w = world(NOW)
  armState = []
  locks = new Map()
  localStorage.clear()
})

// --- Arming -------------------------------------------------------------------

describe('arming a Cashlink (burn with R, lock, mint, deposit)', () => {
  it('arms: the gift ends up locked to the link with ONE refund key, and the relay holds a refund signed by R', async () => {
    // The whole happy path. The burn carries a SIG_ALL witness by R (gc#255 deviation 1), the lock
    // is the exact link-lock shape, and the deposit is NIP-98 signed by the LINK key.
    const gift = giftOn(w)
    const out = await armGift(armCtx(gift))
    expect(out.kind).toBe('armed')
    const [locked] = tokenProofs(lockedToken())
    const lock = readLinkLock(locked.secret)!
    expect(lock).toEqual({ linkPub: linkPubOf(LINK), refundPub: expect.any(String), locktime: X })
    expect(isOpenAfterLocktime(locked.secret)).toBe(false)
    const deposit = w.gateway.calls.find((c) => c.path === REFUNDS_PATH && (c.body as { proof?: { secret?: string } }).proof?.secret)
    expect(deposit?.signedBy).toBe(linkPubOf(LINK))
    expect(w.gateway.deposits.size).toBe(1)
    expect(armState[0]).toMatch(/^arming:/)
  })

  it('burns with a witness by R over the burn outputs, so the lock route can attribute it', async () => {
    // The lock route reads the burn's recorded witness from NUT-07 and refuses unless R signed the
    // SIG_ALL message over those exact outputs. A burn without it would leave the gift unlockable.
    const gift = giftOn(w)
    await armGift(armCtx(gift))
    const burn = w.mint.log.swaps[0]
    expect(burn.inputs[0].secret).toBe(tokenProofs(gift.token)[0].secret)
    expect(JSON.parse(burn.inputs[0].witness!).signatures).toHaveLength(1)
    expect(w.gateway.locks.size).toBe(1)
  })

  it('a two-proof gift is burnt one proof per swap (SIG_ALL needs identical tags on every input)', async () => {
    const gift = giftOn(w, [32, 32])
    expect((await armGift(armCtx(gift))).kind).toBe('armed')
    const burns = w.mint.log.swaps.filter((s) => s.inputs.some((i) => i.secret.startsWith('["VOUCHER"')))
    expect(burns.every((s) => s.inputs.length === 1)).toBe(true)
    expect(tokenProofs(lockedToken())).toHaveLength(2)
    expect(w.gateway.deposits.size).toBe(2)
  })

  it('never arms a merchant account: a stall\u2019s expired Cashlinks lapse (owner scope 2026-10-21)', async () => {
    const out = await armGift(armCtx(giftOn(w), { merchant: true }))
    expect(out).toEqual({ kind: 'unarmed', why: 'merchant' })
    expect(w.mint.log.swaps).toHaveLength(0)
  })

  it('a gift without its amount proof (no DLEQ) is left as it is: the lock would refuse it AFTER the burn', async () => {
    const proof = w.mint.issue(bearerSecret(), 64)
    const { dleq: _d, ...bare } = proof
    void _d
    const out = await armGift(armCtx({ token: tokenOf([bare]), sentAt: NOW }))
    expect(out).toEqual({ kind: 'unarmed', why: 'no_amount_proof' })
    expect(w.mint.log.swaps).toHaveLength(0)
  })

  it('an expiry under 24 h before the coupon\u2019s own expiry is not armed (Q8), nothing burnt', async () => {
    const proof = w.mint.issue(bearerSecret({ expiresAt: X + 3600 }), 64)
    const out = await armGift(armCtx({ token: tokenOf([proof]), sentAt: NOW }))
    expect(out).toEqual({ kind: 'unarmed', why: 'window' })
    expect(w.mint.log.swaps).toHaveLength(0)
  })

  it('a whole-number-ratio coupon (cashu-voucher#59) is not armed, nothing burnt', async () => {
    const proof = w.mint.issue(bearerSecret({ issuanceRatio: 2 }), 64)
    expect((await armGift(armCtx({ token: tokenOf([proof]), sentAt: NOW }))).kind).toBe('unarmed')
    expect(w.mint.log.swaps).toHaveLength(0)
  })

  it('routes missing (gc Phase 2/3 not released, 404): not armed, nothing burnt, the gift stays a bearer gift', async () => {
    // The release state today: the wallet must degrade to exactly the old behaviour.
    w.gateway.routes = false
    const gift = giftOn(w)
    const out = await armGift(armCtx(gift))
    expect(out).toEqual({ kind: 'unarmed', why: 'lock_route_unavailable' })
    expect(w.mint.log.swaps).toHaveLength(0)
    expect(await w.mint.states(MINT_URL, [tokenProofs(gift.token)[0].secret])).toEqual(['UNSPENT'])
  })

  it('relay switched off (503 RELAY_DISABLED): not armed, nothing burnt, so an unclaimed link comes back the old way', async () => {
    // GATEWAY_CUSTOMER_CASHLINK_REFUND_RELAY_ENABLED=false, as it ships. A locked gift with no
    // relay is no better than a bearer one, so the wallet does not lock it at all.
    w.gateway.relayOn = false
    const out = await armGift(armCtx(giftOn(w)))
    expect(out).toEqual({ kind: 'unarmed', why: 'relay_unavailable' })
    expect(w.mint.log.swaps).toHaveLength(0)
  })

  it('gateway unreachable before the burn: not armed, nothing burnt', async () => {
    w.gateway.down = true
    expect((await armGift(armCtx(giftOn(w)))).kind).toBe('unarmed')
    expect(w.mint.log.swaps).toHaveLength(0)
  })

  it('the lock route refuses the dry run (e.g. ISSUER_SELF_SWAP, 422): not armed, nothing burnt', async () => {
    w.gateway.override.set(LOCK_PATH, { status: 422, body: { refusal: 'ISSUER_SELF_SWAP' } })
    expect(await armGift(armCtx(giftOn(w)))).toEqual({ kind: 'unarmed', why: 'lock_refused' })
    expect(w.mint.log.swaps).toHaveLength(0)
  })

  it('a gift already claimed before arming: reported claimed, nothing burnt', async () => {
    const gift = giftOn(w)
    await w.mint.swap(MINT_URL, tokenProofs(gift.token), [])
    w.mint.spent.set('x', {})
    // Spend it as a recipient would (unlocked bearer: no witness needed).
    const p = tokenProofs(gift.token)[0]
    ;(w.mint as unknown as { spent: Map<string, unknown> }).spent.set(
      (await import('@cashu/crypto/modules/common')).hashToCurve(new TextEncoder().encode(p.secret)).toHex(true),
      {},
    )
    expect((await armGift(armCtx(gift))).kind).toBe('claimed')
  })

  it('the relay refuses the deposit after the lock (e.g. 503 MINT_KEYS_UNAVAILABLE): locked but NOT armed, value still on the link', async () => {
    // Deviation 1 of gc#262: 503 means not armed. The gift is locked (only the link key, or R after
    // x, can spend it), so this wallet takes it back itself after x.
    const gift = giftOn(w)
    w.gateway.depositAnswers = [{ status: 422, body: { refusal: 'MALFORMED' } }, { status: 503, body: { refusal: 'MINT_KEYS_UNAVAILABLE' } }]
    const out = await armGift(armCtx(gift))
    expect(out.kind).toBe('not_armed')
    expect(readLinkLock(tokenProofs(lockedToken())[0].secret)).not.toBeNull()
  })

  it('409 CONFLICT on deposit is "not armed" (another refund is kept for this proof)', async () => {
    w.gateway.depositAnswers = [{ status: 422, body: {} }, { status: 409, body: { refusal: 'CONFLICT' } }]
    expect((await armGift(armCtx(giftOn(w)))).kind).toBe('not_armed')
  })

  it('422 KEYSET_INACTIVE (gc#262 R3): re-reads the active keyset, rebuilds the outputs, and arms', async () => {
    // A keyset rotated between the burn and the deposit. The outputs are re-made in the new keyset
    // (same B_, same witness: SIG_ALL does not cover keyset ids) and deposited once more.
    const gift = giftOn(w)
    w.gateway.depositAnswers = [{ status: 422, body: {} }]
    const realActive = w.mint.activeKeysetId.bind(w.mint)
    let calls = 0
    w.mint.activeKeysetId = async () => {
      calls += 1
      // The deposit's first read sees the old keyset; it is archived just before the deposit.
      if (calls === 2) {
        const old = await realActive()
        w.mint.rotate()
        return old
      }
      return realActive()
    }
    const out = await armGift(armCtx(gift))
    expect(out.kind).toBe('armed')
    const stored = [...w.gateway.deposits.values()][0]
    expect(stored.swap.outputs.every((o) => o.id === w.mint.active().id)).toBe(true)
  })

  it('a lock answer that is not what was asked for (another refund key) is never minted; the burn\u2019s sats are kept', async () => {
    // A hostile or broken gateway. Minting it would put value under a key this wallet does not hold.
    w.gateway.tamperLock = (signed) => signed.replace(/"refund","02[0-9a-f]{64}"/, `"refund","02${'33'.repeat(32)}"`)
    const gift = giftOn(w)
    const out = await armGift(armCtx(gift))
    expect(out.kind).toBe('kept_as_sats')
    expect(keptSats()).toBe(64)
    expect(w.wraps).toHaveLength(0)
  })

  it('a lock that would carry a locktime WITHOUT a refund key is never minted (the hard rule)', async () => {
    w.gateway.tamperLock = (signed) => signed.replace(/,\["refund","02[0-9a-f]{64}"\]/, '')
    const out = await armGift(armCtx(giftOn(w)))
    expect(out.kind).toBe('kept_as_sats')
    expect(w.wraps).toHaveLength(0)
    expect(keptSats()).toBe(64)
  })

  it('a 422 from the lock AFTER the burn keeps the burn\u2019s sats (value never lost)', async () => {
    const gift = giftOn(w)
    // Dry run passes (409), the real lock refuses.
    const call = w.gateway.call.bind(w.gateway)
    let locksSeen = 0
    w.gateway.call = async (m, p, b, s) => {
      if (p === LOCK_PATH && ++locksSeen === 2) return { status: 422, body: { refusal: 'SAT_BOUND_EXCEEDED' } }
      return call(m, p, b, s)
    }
    expect((await armGift(armCtx(gift))).kind).toBe('kept_as_sats')
    expect(keptSats()).toBe(64)
  })
})

// --- A page that dies part way ------------------------------------------------

describe('arming resumes after a page that died', () => {
  it('after the burn, before the lock: the next run finds the burn by NUT-09 and finishes', async () => {
    const gift = giftOn(w)
    const call = w.gateway.call.bind(w.gateway)
    let locks2 = 0
    w.gateway.call = async (m, p, b, s) => {
      if (p === LOCK_PATH && ++locks2 === 2) throw new Error('page died')
      return call(m, p, b, s)
    }
    expect((await armGift(armCtx(gift))).kind).toBe('arming')
    w.gateway.call = call
    const ks = armState[0].split(':')[1]
    expect((await armGift(armCtx(gift, { burnKeyset: ks }))).kind).toBe('armed')
  })

  it('after the lock was minted, before delivery: the next run finds the minted lock and finishes', async () => {
    const gift = giftOn(w)
    const deliver = w.ports.deliver
    w.ports.deliver = async () => false
    expect((await armGift(armCtx(gift))).kind).toBe('arming')
    w.ports.deliver = deliver
    const ks = armState[0].split(':')[1]
    expect((await armGift(armCtx(gift, { burnKeyset: ks }))).kind).toBe('armed')
    expect(keptSats()).toBe(0)
  })

  it('the lost reply of the mint swap is recovered by NUT-09 (the outputs are derived, so they are found)', async () => {
    const gift = giftOn(w)
    w.mint.loseNextReply = true
    expect((await armGift(armCtx(gift))).kind).toBe('arming')
    const ks = armState[0].split(':')[1]
    expect((await armGift(armCtx(gift, { burnKeyset: ks }))).kind).toBe('armed')
  })
})

// --- Coming back --------------------------------------------------------------

describe('an armed Cashlink comes back on its own', () => {
  it('the relay posts at x + 60 s; on the next run the wallet fetches by sha256(secret), checks the signatures and re-forms the voucher', async () => {
    // The #295 acceptance: expiry with the app closed. The relay refunds, the wallet re-forms on
    // its next run, and the mint now refuses a late claim (already spent).
    await armGift(armCtx(giftOn(w)))
    at(w, X + 61)
    await w.gateway.runRelay(X + 61)
    expect([...w.gateway.deposits.values()][0].state).toBe('REFUNDED')
    const out = await settleLockedGift(returnCtx())
    expect(out.kind).toBe('returned')
    expect(w.kept).toHaveLength(1)
    expect(w.kept[0].satsToken).toBeUndefined()
    const coupon = parseVoucherToken(w.kept[0].token)
    expect(coupon.voucher.lockKey).toBeUndefined() // Q4: unlocked
    expect(coupon.tokenAmount).toBe(64)
    const fetch = w.gateway.calls.find((c) => c.method === 'GET')!
    expect(fetch.path).toBe(`${REFUNDS_PATH}/${secretHash(tokenProofs(lockedToken())[0].secret)}`)
    expect(fetch.signedBy).not.toBe(linkPubOf(LINK)) // signed by R, so only the sender shortens retention
  })

  it('a late claim after the relay posted is refused BY THE MINT (already spent)', async () => {
    await armGift(armCtx(giftOn(w)))
    at(w, X + 61)
    await w.gateway.runRelay(X + 61)
    const out = await claimLockedGift({ ports: w.ports, pubkey: RECIPIENT, linkSecret: LINK, k: secretToText(LINK), lockedTokens: [{ token: lockedToken(), sentAt: NOW }] })
    expect(out.kind).toBe('claimed')
  })

  it('the re-sign is authorised by R, the key the mint recorded for the spend (the "spend decides" rule)', async () => {
    await armGift(armCtx(giftOn(w)))
    at(w, X + 61)
    await w.gateway.runRelay(X + 61)
    await settleLockedGift(returnCtx())
    expect([...w.gateway.resigns.values()][0].caller).toBe('refund')
  })

  it('a relay answer whose signatures do not verify (DLEQ) is not trusted: the mint is asked by NUT-09 instead', async () => {
    await armGift(armCtx(giftOn(w)))
    at(w, X + 61)
    await w.gateway.runRelay(X + 61)
    const d = [...w.gateway.deposits.values()][0]
    w.gateway.fetchAnswer = { status: 200, body: { state: 'REFUNDED', signatures: d.signatures!.map((s) => ({ ...s, dleq: { e: '00'.repeat(32), s: '00'.repeat(32) } })) } }
    expect((await settleLockedGift(returnCtx())).kind).toBe('returned')
    expect(keptSats()).toBe(64)
  })

  it('fetch answers 404 (relay off since, or purged): the wallet asks the mint (NUT-09) and still re-forms', async () => {
    await armGift(armCtx(giftOn(w)))
    at(w, X + 61)
    await w.gateway.runRelay(X + 61)
    w.gateway.fetchAnswer = { status: 404, body: null }
    expect((await settleLockedGift(returnCtx())).kind).toBe('returned')
  })

  it('the gateway is unreachable for the fetch: the mint is the record, and it still comes back', async () => {
    await armGift(armCtx(giftOn(w)))
    at(w, X + 61)
    await w.gateway.runRelay(X + 61)
    const call = w.gateway.call.bind(w.gateway)
    w.gateway.call = async (m, p, b, s) => {
      if (m === 'GET') throw new Error('down')
      return call(m, p, b, s)
    }
    expect((await settleLockedGift(returnCtx())).kind).toBe('returned')
  })
})

describe('a FAILED relay arm (any cause) is "not armed": the wallet takes the gift back itself', () => {
  it('FAILED code_12002 (the keyset was archived after the deposit): the wallet posts its own refund in the active keyset', async () => {
    // gc#262 second check: a rotation after deposit makes the relay's post FAIL with 12002. The fetch
    // shows FAILED; the gift is still on the link, and this wallet's own refund lands.
    await armGift(armCtx(giftOn(w)))
    w.mint.rotate()
    at(w, X + 61)
    await w.gateway.runRelay(X + 61)
    expect([...w.gateway.deposits.values()][0].state).toBe('FAILED')
    const out = await settleLockedGift(returnCtx({ depositKeyset: [...w.gateway.deposits.values()][0].swap.outputs[0].id }))
    expect(out.kind).toBe('returned')
    expect(keptSats()).toBe(64)
  })

  it('FAILED attempts_exhausted:restore_* (the relay could not read the mint): NUT-09 first, which finds our own landed refund', async () => {
    await armGift(armCtx(giftOn(w)))
    at(w, X + 61)
    await w.gateway.runRelay(X + 61)
    // The relay says FAILED, though its post landed (R1 of gc#262: a restore blip is not "spent").
    w.gateway.fetchAnswer = { status: 200, body: { state: 'FAILED' } }
    expect((await settleLockedGift(returnCtx())).kind).toBe('returned')
    expect(keptSats()).toBe(64)
  })

  it('never armed (relay was off at send) and the link expires: the wallet posts the refund itself and it comes back', async () => {
    const gift = giftOn(w)
    w.gateway.depositAnswers = [{ status: 422, body: {} }, { status: 503, body: { refusal: 'RELAY_DISABLED' } }]
    expect((await armGift(armCtx(gift))).kind).toBe('not_armed')
    at(w, X + 1)
    expect((await settleLockedGift(returnCtx())).kind).toBe('returned')
    expect(w.gateway.deposits.size).toBe(0)
  })

  it('the wallet posting the SAME refund as the relay at the same moment changes nothing: identical outputs, one return', async () => {
    await armGift(armCtx(giftOn(w)))
    at(w, X + 61)
    const first = settleLockedGift(returnCtx())
    await w.gateway.runRelay(X + 61)
    expect((await first).kind).toBe('returned')
    expect(keptSats()).toBe(64)
  })

  it('the mint clock behind ours near x (10001): nothing signed, it stays on its way back and the next run finishes', async () => {
    await armGift(armCtx(giftOn(w)))
    at(w, X + 5)
    w.mint.clockBehindUntil = X + 600
    expect((await settleLockedGift(returnCtx())).kind).toBe('returning')
    at(w, X + 700)
    expect((await settleLockedGift(returnCtx())).kind).toBe('returned')
  })

  it('a deposit that failed is retried before x, and a stored one replays (200)', async () => {
    const gift = giftOn(w)
    w.gateway.depositAnswers = [{ status: 422, body: {} }, { status: 503, body: { refusal: 'RELAY_DISABLED' } }]
    await armGift(armCtx(gift))
    expect((await retryDeposit(w.ports, LINK, REFUND, lockedToken())).kind).toBe('armed')
    expect((await retryDeposit(w.ports, LINK, REFUND, lockedToken())).kind).toBe('armed')
    expect(w.gateway.deposits.size).toBe(1)
  })
})

describe('take it back, before the link expires', () => {
  it('goes the link key\u2019s way (R cannot spend before x) and re-forms the voucher', async () => {
    await armGift(armCtx(giftOn(w)))
    expect((await settleLockedGift(returnCtx({ takeBackNow: true }))).kind).toBe('returned')
    expect([...w.gateway.resigns.values()][0].caller).toBe('link')
    expect(keptSats()).toBe(64)
  })

  it('still on the link before x and not asked: nothing moves', async () => {
    await armGift(armCtx(giftOn(w)))
    const swaps = w.mint.log.swaps.length
    expect((await settleLockedGift(returnCtx())).kind).toBe('waiting')
    expect(w.mint.log.swaps.length).toBe(swaps)
  })

  it('a re-sign refused after the sats came back (422) keeps the sats: value never lost', async () => {
    await armGift(armCtx(giftOn(w)))
    w.gateway.override.set(RESIGN_PATH, { status: 422, body: { refusal: 'NOT_OUR_ISSUANCE' } })
    expect((await settleLockedGift(returnCtx({ takeBackNow: true }))).kind).toBe('returned')
    expect(w.kept[0].satsToken).toBeDefined()
    expect(keptSats()).toBe(64)
  })

  it('re-sign routes gone (404) after the sats came back: the sats are kept', async () => {
    await armGift(armCtx(giftOn(w)))
    w.gateway.routes = false
    expect((await settleLockedGift(returnCtx({ takeBackNow: true }))).kind).toBe('returned')
    expect(keptSats()).toBe(64)
  })

  it('re-sign answers 5xx: it stays on its way back, and the next run (same nonce, same request) finishes', async () => {
    await armGift(armCtx(giftOn(w)))
    w.gateway.override.set(RESIGN_PATH, { status: 503, body: null })
    expect((await settleLockedGift(returnCtx({ takeBackNow: true }))).kind).toBe('returning')
    expect((await settleLockedGift(returnCtx({ takeBackNow: true }))).kind).toBe('returned')
    expect(keptSats()).toBe(64)
  })
})

// --- Claiming -----------------------------------------------------------------

describe('claiming a locked Cashlink (the recipient)', () => {
  it('burns with the link key, gets the unlocked successor for the link pathway, and mints it', async () => {
    await armGift(armCtx(giftOn(w)))
    const out = await claimLockedGift({ ports: w.ports, pubkey: RECIPIENT, linkSecret: LINK, k: secretToText(LINK), lockedTokens: [{ token: lockedToken(), sentAt: NOW }] })
    expect(out.kind).toBe('ok')
    expect([...w.gateway.resigns.values()][0].caller).toBe('link')
    expect(parseVoucherToken(w.kept[0].token).voucher.lockKey).toBeUndefined()
    expect(cashlinkClaimsInFlight(RECIPIENT)).toBe(0)
  })

  it('the factors are written BEFORE the burn, and logout counts them until the coupon is in', async () => {
    await armGift(armCtx(giftOn(w)))
    w.gateway.override.set(RESIGN_PATH, { status: 503, body: null })
    const out = await claimLockedGift({ ports: w.ports, pubkey: RECIPIENT, linkSecret: LINK, k: secretToText(LINK), lockedTokens: [{ token: lockedToken(), sentAt: NOW }] })
    expect(out.kind).toBe('failed')
    expect(cashlinkClaimsInFlight(RECIPIENT)).toBe(1)
    // Start-up finishes it from what it wrote down.
    expect(await finishCashlinkClaims(w.ports, RECIPIENT)).toBe(1)
    expect(cashlinkClaimsInFlight(RECIPIENT)).toBe(0)
    expect(loadClaims(RECIPIENT)).toEqual([])
  })

  it('the sender racing the claim: whoever spent it first wins, and the other is told', async () => {
    await armGift(armCtx(giftOn(w)))
    await settleLockedGift(returnCtx({ takeBackNow: true }))
    const out = await claimLockedGift({ ports: w.ports, pubkey: RECIPIENT, linkSecret: LINK, k: secretToText(LINK), lockedTokens: [{ token: lockedToken(), sentAt: NOW }] })
    expect(out.kind).toBe('claimed')
  })

  it('the stall that issued the coupon is refused before anything moves (Q3: no self-swap)', async () => {
    await armGift(armCtx(giftOn(w)))
    const swaps = w.mint.log.swaps.length
    const stall = parseVoucherToken(lockedToken()).voucher.issuerId
    const out = await claimLockedGift({ ports: w.ports, pubkey: stall, linkSecret: LINK, k: secretToText(LINK), lockedTokens: [{ token: lockedToken(), sentAt: NOW }] })
    expect(out.kind).toBe('own_coupon')
    expect(w.mint.log.swaps.length).toBe(swaps)
  })

  it('a claim after x that loses to the relay is told it was already claimed; nothing of the recipient\u2019s is spent', async () => {
    await armGift(armCtx(giftOn(w)))
    at(w, X + 61)
    await w.gateway.runRelay(X + 61)
    const out = await claimLockedGift({ ports: w.ports, pubkey: RECIPIENT, linkSecret: LINK, k: secretToText(LINK), lockedTokens: [{ token: lockedToken(), sentAt: NOW }] })
    expect(out.kind).toBe('claimed')
    expect(cashlinkClaimsInFlight(RECIPIENT)).toBe(0)
  })

  it('a gift locked to the link is a candidate for that link only; any other lock is still left out', async () => {
    await armGift(armCtx(giftOn(w)))
    const t = { token: lockedToken(), sentAt: NOW }
    expect(giftCandidates([t], linkPubOf(LINK))).toHaveLength(1)
    expect(giftCandidates([t], 'ab'.repeat(32))).toHaveLength(0)
    expect(giftCandidates([t])).toHaveLength(0)
  })
})

// --- Restore ------------------------------------------------------------------

describe('restore after the sender\u2019s device is lost', () => {
  it('a locked gift still on its link is found, with its exact expiry (the lock\u2019s locktime)', async () => {
    await armGift(armCtx(giftOn(w)))
    const found = await restoreFinding(w.ports, LINK, REFUND, [{ token: lockedToken(), sentAt: NOW }])
    expect(found).toMatchObject({ kind: 'locked', x: X })
  })

  it('after expiry with the app closed, a restored wallet finds the refunded gift as "on its way back" and re-forms it', async () => {
    await armGift(armCtx(giftOn(w)))
    at(w, X + 61)
    await w.gateway.runRelay(X + 61)
    const found = await restoreFinding(w.ports, LINK, REFUND, [{ token: lockedToken(), sentAt: NOW }])
    expect(found.kind).toBe('returning')
    expect((await settleLockedGift(returnCtx())).kind).toBe('returned')
  })

  it('a burn whose lock never reached the link (the record died with the device) is kept as sats', async () => {
    const gift = giftOn(w)
    w.gateway.override.set(LOCK_PATH, { status: 409, body: { refusal: 'PREDECESSOR_NOT_SPENT' } })
    const call = w.gateway.call.bind(w.gateway)
    let n = 0
    w.gateway.call = async (m, p, b, s) => {
      if (p === LOCK_PATH && ++n >= 2) throw new Error('page died')
      return call(m, p, b, s)
    }
    await armGift(armCtx(gift))
    const found = await restoreFinding(w.ports, LINK, REFUND, [gift])
    expect(found.kind).toBe('arming')
    expect(await recoverOrphanBurn(w.ports, REFUND, gift)).toBe(true)
    expect(keptSats()).toBe(64)
  })

  it('a claimed gift is not adopted', async () => {
    await armGift(armCtx(giftOn(w)))
    await claimLockedGift({ ports: w.ports, pubkey: RECIPIENT, linkSecret: LINK, k: secretToText(LINK), lockedTokens: [{ token: lockedToken(), sentAt: NOW }] })
    expect((await restoreFinding(w.ports, LINK, REFUND, [{ token: lockedToken(), sentAt: NOW }])).kind).toBe('none')
  })
})

// --- Conservation ---------------------------------------------------------------

describe('value is conserved on every path', () => {
  it.each([
    ['relay off at send, wallet takes it back after x', async () => {
      w.gateway.depositAnswers = [{ status: 422, body: {} }, { status: 503, body: {} }]
      await armGift(armCtx(giftOn(w, [32, 16])))
      at(w, X + 1)
      await settleLockedGift(returnCtx())
    }],
    ['armed, relay posts, wallet re-forms', async () => {
      await armGift(armCtx(giftOn(w, [32, 16])))
      at(w, X + 61)
      await w.gateway.runRelay(X + 61)
      await settleLockedGift(returnCtx())
    }],
    ['armed, taken back by hand', async () => {
      await armGift(armCtx(giftOn(w, [32, 16])))
      await settleLockedGift(returnCtx({ takeBackNow: true }))
    }],
  ])('%s: the sender ends with exactly what was gifted', async (_name, run) => {
    await run()
    expect(keptSats()).toBe(48)
  })
})

// --- Reviewer (rev-wallet377): value kept as sats is ONE row per token -------------

describe('rev-wallet377 H1: sats kept against one coupon token are never overwritten', () => {
  it('a two-proof gift refused AFTER both burns keeps BOTH proofs\u2019 sats (one row per token in the real store)', async () => {
    // The real `keep` writes one voucher row per tokenIdFrom(token): a second keepAsSats under the
    // same coupon token MERGES over the first, so the first proof's sats vanish.
    const gift = giftOn(w, [32, 16])
    const call = w.gateway.call.bind(w.gateway)
    let locksSeen = 0
    w.gateway.call = async (m, p, b, s) => {
      // Two dry runs pass (409), both real locks refuse after their burns.
      if (p === LOCK_PATH && ++locksSeen > 2) return { status: 422, body: { refusal: 'SAT_BOUND_EXCEEDED' } }
      return call(m, p, b, s)
    }
    expect((await armGift(armCtx(gift))).kind).toBe('kept_as_sats')
    expect(keptSats()).toBe(48)
  })

  it('a two-proof gift whose re-sign is refused on return keeps BOTH proofs\u2019 sats', async () => {
    await armGift(armCtx(giftOn(w, [32, 16])))
    w.gateway.routes = false
    expect((await settleLockedGift(returnCtx({ takeBackNow: true }))).kind).toBe('returned')
    expect(keptSats()).toBe(48)
  })

  it('a two-proof claim whose re-sign is refused keeps BOTH proofs\u2019 sats for the recipient', async () => {
    await armGift(armCtx(giftOn(w, [32, 16])))
    w.gateway.routes = false
    const out = await claimLockedGift({ ports: w.ports, pubkey: RECIPIENT, linkSecret: LINK, k: secretToText(LINK), lockedTokens: [{ token: lockedToken(), sentAt: NOW }] })
    expect(out.kind).toBe('ok')
    expect(keptSats()).toBe(48)
  })
})
