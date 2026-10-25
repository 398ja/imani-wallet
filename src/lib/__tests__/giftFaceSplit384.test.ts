/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * imani-wallet#384: a Cashlink taken back returned every sat, but the balance read one cent short.
 *
 * What happened on staging (R53): a 277-sat gift (ratio 0.07220, face €0.20) sat on the link as four
 * proofs of 256/16/4/1 sats. Each proof came back as its own coupon row, and each row's face was
 * rounded on its own: 18.48 + 1.16 + 0.29 + 0.07 = 20.0 c exactly, but 18 + 1 + 0 + 0 = 19 c shown.
 * The fix apportions the gift's face across its proofs by largest remainder, so the rows add up.
 */

vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))

const { armGift, settleLockedGift, claimLockedGift, recoverOrphanBurn, LOCK_PATH } = await import('../cashlinkFlow')
const { secretToText } = await import('../giftLink')
const { tokenProofs } = await import('../voucherToken')
const { derivedOutputs, sigAllWitness } = await import('../cashlinkLock')
const { parseVoucherToken, creditableFaceValue } = await import('../voucherToken')
const { MINT_URL, bearerSecret, tokenOf, world } = await import('./cashlinkWorld')

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
const LINK = hexToBytes('11'.repeat(32))
const REFUND = hexToBytes('22'.repeat(32))
const STAGING = { unit: 'EUR', faceValue: 20, faceDecimals: 2, issuanceRatio: 0.0722 }

let w: ReturnType<typeof world>
beforeEach(() => {
  w = world(NOW)
  localStorage.clear()
})

/** What the app's `keep` port files as the row's face_value (cashlinkPorts.ts). */
const rowFace = (k: { token: string; faceValue?: number }) => k.faceValue ?? creditableFaceValue(parseVoucherToken(k.token)).faceValue

async function armAndTakeBack(amounts: number[]) {
  const proofs = amounts.map((a, n) => w.mint.issue(bearerSecret(STAGING, `w${n}`), a))
  const gift = { token: tokenOf(proofs), sentAt: NOW }
  const locks = new Map<string, string>()
  await armGift({
    ports: w.ports, linkSecret: LINK, refundSecret: REFUND, x: X, gifts: [gift], merchant: false,
    onArming: async () => {}, onLocked: async (g: string, s: string) => void locks.set(g, s), knownLocks: locks,
  })
  const lockedToken = w.wraps[w.wraps.length - 1]
  const out = await settleLockedGift({ ports: w.ports, linkSecret: LINK, refundSecret: REFUND, lockedToken, takeBackNow: true, onReturning: async () => {} })
  return out
}

describe('#384 a returned gift keeps its face value', () => {
  it('staging R53: 277 sats as 256/16/4/1 at ratio 0.07220 come back as €0.20, not €0.19', async () => {
    // Before the fix each of the four rows rounded alone (18/1/0/0 = 19 c). After, they sum to 20 c.
    expect((await armAndTakeBack([256, 16, 4, 1])).kind).toBe('returned')
    expect(w.kept).toHaveLength(4)
    expect(w.kept.reduce((n, k) => n + parseVoucherToken(k.token).tokenAmount, 0)).toBe(277)
    expect(w.kept.reduce((n, k) => n + rowFace(k), 0)).toBe(20)
    expect(MINT_URL).toBeTruthy()
  })
})

describe('#384 largest-remainder split (property)', () => {
  it('for any split of a gift, the whole shares sum to the rounded exact total and each is within 1 of its exact share', async () => {
    // Plain-English: however a voucher is cut into proofs, filing it as rows never gains or loses
    // a cent against the whole. Seeded so a failure reproduces.
    const { apportion } = await import('../faceSplit')
    let seed = 384
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    for (let run = 0; run < 2000; run++) {
      const ratio = Math.round(rnd() * 100_000) / 1_000_000 + 0.00001
      const sats = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => 2 ** Math.floor(rnd() * 12))
      const exact = sats.map((s) => s * ratio)
      const shares = apportion(exact)
      const total = exact.reduce((a, b) => a + b, 0)
      expect(shares.reduce((a, b) => a + b, 0)).toBe(Math.round(total + 1e-9))
      shares.forEach((s, i) => expect(Math.abs(s - exact[i])).toBeLessThan(1))
    }
  })

  it('the staging numbers split to 19/1/0/0 = 20, never 18/1/0/0', async () => {
    // 18.48, 1.16, 0.29, 0.07: floors give 19 c, the one cent owed goes to the largest remainder (0.48).
    const { apportion } = await import('../faceSplit')
    expect(apportion([256, 16, 4, 1].map((s) => s * 0.0722))).toEqual([19, 1, 0, 0])
  })
})

describe('#384 second check: every call site files the gift-wide shares (mutant killers)', () => {
  // The staging gift again: per-proof rounding would file 18+1+0+0 = 19 c, the shares file 20 c.
  // Each test reaches ONE call site with all four proofs and checks the rows add up to the gift.
  const AMOUNTS = [256, 16, 4, 1]
  const faceSum = () => w.kept.reduce((n, k) => n + rowFace(k), 0)

  function stagingGift() {
    const proofs = AMOUNTS.map((a, n) => w.mint.issue(bearerSecret(STAGING, `w${n}`), a))
    return { token: tokenOf(proofs), sentAt: NOW }
  }
  async function arm(gift: { token: string; sentAt: number }) {
    const locks = new Map<string, string>()
    return armGift({
      ports: w.ports, linkSecret: LINK, refundSecret: REFUND, x: X, gifts: [gift], merchant: false,
      onArming: async () => {}, onLocked: async (g: string, s: string) => void locks.set(g, s), knownLocks: locks,
    })
  }

  it('claim, minted path: the recipient gets the four coupons back as 20 c, not 19 c', async () => {
    // The ordinary claim: each proof is burnt, re-signed and minted as an unlocked coupon.
    expect((await arm(stagingGift())).kind).toBe('armed')
    const out = await claimLockedGift({ ports: w.ports, pubkey: 'c3'.repeat(32), linkSecret: LINK, k: secretToText(LINK), lockedTokens: [{ token: w.wraps[w.wraps.length - 1], sentAt: NOW }] })
    expect(out.kind).toBe('ok')
    expect(w.kept).toHaveLength(4)
    expect(w.kept.every((k) => !k.satsToken)).toBe(true)
    expect(faceSum()).toBe(20)
  })

  it('take-back refused by the gateway (routes gone): the sats kept still read as 20 c', async () => {
    // The sender takes the gift back but the re-sign is refused, so each proof is kept as plain sats.
    expect((await arm(stagingGift())).kind).toBe('armed')
    w.gateway.routes = false
    const lockedToken = w.wraps[w.wraps.length - 1]
    expect((await settleLockedGift({ ports: w.ports, linkSecret: LINK, refundSecret: REFUND, lockedToken, takeBackNow: true, onReturning: async () => {} })).kind).toBe('returned')
    expect(w.kept).toHaveLength(4)
    expect(w.kept.every((k) => k.satsToken)).toBe(true)
    expect(faceSum()).toBe(20)
  })

  it('arm refused after the burns: the sats kept read as the gift\u2019s 20 c', async () => {
    // The dry-run locks pass, then every real lock is refused after its burn: the value comes home as sats.
    const gift = stagingGift()
    const call = w.gateway.call.bind(w.gateway)
    let locksSeen = 0
    w.gateway.call = async (m, p, b, s) => {
      if (p === LOCK_PATH && ++locksSeen > AMOUNTS.length) return { status: 422, body: { refusal: 'SAT_BOUND_EXCEEDED' } }
      return call(m, p, b, s)
    }
    expect((await arm(gift)).kind).toBe('kept_as_sats')
    expect(w.kept).toHaveLength(4)
    expect(faceSum()).toBe(20)
  })

  it('orphan burn (the device died before the lock): the four proofs come home as 20 c', async () => {
    // Every proof was burnt with R but no lock was ever recorded. Recovery keeps the sats.
    const gift = stagingGift()
    for (const p of tokenProofs(gift.token)) {
      const outs = derivedOutputs(REFUND, 'burn', p.secret, p.amount, p.id)
      expect((await w.mint.swap(MINT_URL, [{ ...p, witness: sigAllWitness(REFUND, p.secret, p.C, outs) }], outs)).kind).toBe('signed')
    }
    expect(await recoverOrphanBurn(w.ports, REFUND, gift)).toBe(true)
    expect(w.kept).toHaveLength(4)
    expect(faceSum()).toBe(20)
  })
})
