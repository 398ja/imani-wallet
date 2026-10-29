/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * #410 G14: gifts minted already locked (no arm, no relay deposit). Run against `cashlinkWorld`,
 * the mint that enforces NUT-11 and the gateway that implements the re-sign rules. The locked proof
 * is issued directly by the mint (as the Purchase Issuer's mint would), never through the lock route.
 */
vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }) }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))

const { claimLockedGift, LOCK_PATH, REFUNDS_PATH } = await import('../cashlinkFlow')
const { linkLockProposal, xOnlyPub } = await import('../cashlinkLock')
const { secretToText } = await import('../giftLink')
const { parseVoucherToken } = await import('../voucherToken')
const { acceptGiftSent, checkLockedGift, lockedGiftMemo, parseGiftSent, parseReturnFragment, returnStateOf, settleIncoming, takeBackLockedGift } = await import('../lockedGifts')
const { bearerSecret, signLocked, tokenOf, world, at } = await import('./cashlinkWorld')

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
const LOCK = hexToBytes('33'.repeat(32))
const R = hexToBytes('44'.repeat(32))
const OTHER = hexToBytes('55'.repeat(32))
const RECIPIENT = 'c3'.repeat(32)
const ISSUER_SEAL = 'd4'.repeat(32)

let w: ReturnType<typeof world>

function mintedLocked(amounts = [64], lockKey = LOCK, refund = R, x = X): string {
  const proofs = amounts.map((a, n) =>
    w.mint.issue(
      signLocked(linkLockProposal({ giftSecret: bearerSecret({}, `w${n}`), linkPub: xOnlyPub(lockKey), refundPub: xOnlyPub(refund), x, maxSats: a, nonce: `nn${n}` })),
      a,
    ),
  )
  return tokenOf(proofs)
}

const keptSats = () => w.kept.reduce((n, k) => n + (k.sats ?? parseVoucherToken(k.token).tokenAmount), 0)
const noLockOrRelay = () => w.gateway.calls.every((c) => c.path !== LOCK_PATH && !c.path.includes(REFUNDS_PATH))

beforeEach(() => {
  localStorage.clear()
  w = world(NOW)
})

describe('email recipient: /g claim of a minted-locked proof', () => {
  it('claims it into an unlocked coupon, link key\'s way, with no lock route or relay', async () => {
    const token = mintedLocked([64, 32])
    const out = await claimLockedGift({ ports: w.ports, pubkey: RECIPIENT, linkSecret: LOCK, k: secretToText(LOCK), lockedTokens: [{ token, sentAt: NOW }] })
    expect(out.kind).toBe('ok')
    expect(w.kept).toHaveLength(2)
    expect(w.kept.every((k) => parseVoucherToken(k.token).voucher.lockKey === undefined)).toBe(true)
    expect(keptSats()).toBe(96)
    expect([...w.gateway.resigns.values()].every((r) => r.caller === 'link')).toBe(true)
    expect(noLockOrRelay()).toBe(true)
  })

  it('after the buyer took it back: claimed', async () => {
    const token = mintedLocked()
    at(w, X + 1)
    expect((await takeBackLockedGift(w.ports, R, token)).kind).toBe('returned')
    w.kept.length = 0
    const out = await claimLockedGift({ ports: w.ports, pubkey: RECIPIENT, linkSecret: LOCK, k: secretToText(LOCK), lockedTokens: [{ token, sentAt: NOW }] })
    expect(out.kind).toBe('claimed')
    expect(w.kept).toHaveLength(0)
  })
})

describe('handle recipient: locked to this wallet\'s own key', () => {
  it('claims with the wallet key into a coupon kept as balance', async () => {
    const token = mintedLocked()
    expect(checkLockedGift(token, 'lock', xOnlyPub(LOCK)).ok).toBe(true)
    expect(await settleIncoming(w.ports, RECIPIENT, token, () => Uint8Array.from(LOCK))).toBe('claimed')
    expect(keptSats()).toBe(64)
    expect(w.kept[0].why).toBe('claimed')
  })

  it('a signer that cannot lend its key keeps it waiting, nothing kept, and claims later', async () => {
    const token = mintedLocked()
    expect(await settleIncoming(w.ports, RECIPIENT, token, () => null)).toBe('waiting')
    expect(w.kept).toHaveLength(0)
    expect(await settleIncoming(w.ports, RECIPIENT, token, () => Uint8Array.from(LOCK))).toBe('claimed')
  })

  it('a transient mint failure leaves it waiting, and the next poll claims it', async () => {
    const token = mintedLocked()
    w.mint.down = true
    expect(await settleIncoming(w.ports, RECIPIENT, token, () => Uint8Array.from(LOCK))).toBe('waiting')
    w.mint.down = false
    expect(await settleIncoming(w.ports, RECIPIENT, token, () => Uint8Array.from(LOCK))).toBe('claimed')
    expect(keptSats()).toBe(64)
  })

  it('after x, taken back by the buyer first: gone (dropped with a clear row)', async () => {
    const token = mintedLocked()
    at(w, X + 1)
    await takeBackLockedGift(w.ports, R, token)
    w.kept.length = 0
    expect(await settleIncoming(w.ports, RECIPIENT, token, () => Uint8Array.from(LOCK))).toBe('gone')
    expect(w.kept).toHaveLength(0)
    expect(lockedGiftMemo({ dir: 'in', status: 'gone', x: X, stall: 'Mama Put' })).toMatch(/returned to the buyer/)
  })

  it('refuses: locked to someone else, and open-after-locktime shape', () => {
    expect(checkLockedGift(mintedLocked([64], OTHER), 'lock', xOnlyPub(LOCK))).toEqual({ ok: false, why: 'wrong_key' })
    const [kind, body] = JSON.parse(linkLockProposal({ giftSecret: bearerSecret(), linkPub: xOnlyPub(LOCK), refundPub: xOnlyPub(R), x: X, maxSats: 64, nonce: 'no' }))
    const open = JSON.stringify([kind, { ...body, tags: body.tags.filter((t: string[]) => t[0] !== 'refund') }])
    const token = tokenOf([w.mint.issue(signLocked(open), 64)])
    expect(checkLockedGift(token, 'lock', xOnlyPub(LOCK))).toEqual({ ok: false, why: 'open_after_locktime' })
  })

  it('refuses a forged issuer signature and an untrusted mint', () => {
    const signed = signLocked(linkLockProposal({ giftSecret: bearerSecret(), linkPub: xOnlyPub(LOCK), refundPub: xOnlyPub(R), x: X, maxSats: 64, nonce: 'nf' }))
    const forged = signed.replace(/\["max_sats","64"\]/, '["max_sats","65"]')
    expect(forged).not.toBe(signed)
    expect(checkLockedGift(tokenOf([w.mint.issue(forged, 64)]), 'lock', xOnlyPub(LOCK))).toEqual({ ok: false, why: 'bad_signature' })
    expect(checkLockedGift(mintedLocked(), 'lock', xOnlyPub(LOCK), () => ({ outcome: 'hold' }))).toEqual({ ok: false, why: 'untrusted_mint' })
  })
})

describe('buyer take-back (refund key, no link key, no relay)', () => {
  const msg = (token: string) => parseGiftSent(JSON.stringify({ type: 'imani_gift_sent', v: 1, token, stall: 'Mama Put', to: 'bob@example.com', claimBy: X }))!

  it('accepts a gift-sent notice: refund = own key, issuer seal, trusted mint; `to` may be null', () => {
    const token = mintedLocked()
    expect(acceptGiftSent(msg(token), xOnlyPub(R), ISSUER_SEAL, ISSUER_SEAL).ok).toBe(true)
    const handle = parseGiftSent(JSON.stringify({ type: 'imani_gift_sent', v: 1, token, stall: 'S', to: null, claimBy: X }))!
    expect(handle.to).toBeNull()
    expect(acceptGiftSent(handle, xOnlyPub(R), ISSUER_SEAL, ISSUER_SEAL).ok).toBe(true)
    expect(lockedGiftMemo({ dir: 'out', status: 'waiting', x: X, to: 'bob@example.com' })).toMatch(/^Sent to bob@example.com, claim by /)
  })

  it('never shows a key as the recipient', () => {
    const m = parseGiftSent(JSON.stringify({ type: 'imani_gift_sent', v: 1, token: 'x', stall: 'S', to: 'ab'.repeat(32), claimBy: X }))!
    expect(m.to).toBeNull()
  })

  it('refuses: wrong refund key, forged seal, untrusted mint, forged voucher signature', () => {
    const token = mintedLocked()
    expect(acceptGiftSent(msg(token), xOnlyPub(OTHER), ISSUER_SEAL, ISSUER_SEAL)).toEqual({ ok: false, why: 'wrong_key' })
    expect(acceptGiftSent(msg(token), xOnlyPub(R), 'e5'.repeat(32), ISSUER_SEAL)).toEqual({ ok: false, why: 'wrong_issuer' })
    expect(acceptGiftSent(msg(token), xOnlyPub(R), undefined, ISSUER_SEAL)).toEqual({ ok: false, why: 'wrong_issuer' })
    expect(acceptGiftSent(msg(token), xOnlyPub(R), ISSUER_SEAL, ISSUER_SEAL, () => ({ outcome: 'hold' }))).toEqual({ ok: false, why: 'untrusted_mint' })
    const forged = signLocked(linkLockProposal({ giftSecret: bearerSecret(), linkPub: xOnlyPub(LOCK), refundPub: xOnlyPub(R), x: X, maxSats: 64, nonce: 'nf' })).replace(/"locktime","\d+"/, `"locktime","${X + 1}"`)
    expect(acceptGiftSent(msg(tokenOf([w.mint.issue(forged, 64)])), xOnlyPub(R), ISSUER_SEAL, ISSUER_SEAL)).toEqual({ ok: false, why: 'bad_signature' })
  })

  it('before x: waiting, nothing moves', async () => {
    const token = mintedLocked()
    expect((await takeBackLockedGift(w.ports, R, token)).kind).toBe('waiting')
    expect(w.mint.log.swaps).toHaveLength(0)
  })

  it('after x, unspent: taken back by the refund key and re-formed into an unlocked coupon', async () => {
    const token = mintedLocked([64, 32])
    at(w, X + 1)
    const steps: string[] = []
    const out = await takeBackLockedGift(w.ports, R, token, async () => void steps.push('returning'))
    expect(out.kind).toBe('returned')
    expect(steps.length).toBeGreaterThan(0)
    expect(keptSats()).toBe(96)
    expect(w.kept.every((k) => k.why === 'returned' && parseVoucherToken(k.token).voucher.lockKey === undefined)).toBe(true)
    expect([...w.gateway.resigns.values()].every((r) => r.caller === 'refund')).toBe(true)
    expect(noLockOrRelay()).toBe(true)
  })

  it('a second run after a returned take-back changes nothing (idempotent)', async () => {
    const token = mintedLocked()
    at(w, X + 1)
    await takeBackLockedGift(w.ports, R, token)
    const kept = w.kept.length
    expect((await takeBackLockedGift(w.ports, R, token)).kind).toBe('returned')
    expect(w.kept.length).toBe(kept)
  })

  it('spent before x by the recipient: claimed, nothing kept', async () => {
    const token = mintedLocked()
    await claimLockedGift({ ports: w.ports, pubkey: RECIPIENT, linkSecret: LOCK, k: secretToText(LOCK), lockedTokens: [{ token, sentAt: NOW }] })
    w.kept.length = 0
    at(w, X + 1)
    expect((await takeBackLockedGift(w.ports, R, token)).kind).toBe('claimed')
    expect(w.kept).toHaveLength(0)
  })

  it('a wrong refund key does nothing', async () => {
    const token = mintedLocked()
    at(w, X + 1)
    expect((await takeBackLockedGift(w.ports, OTHER, token)).kind).toBe('unknown')
    expect(w.mint.log.swaps).toHaveLength(0)
  })
})

describe('return page helpers', () => {
  it('reads r (and optional t) from the fragment, refusing anything else', () => {
    expect(parseReturnFragment('#r=' + '44'.repeat(32))?.r).toEqual(R)
    expect(parseReturnFragment('#r=' + '44'.repeat(32) + '&t=cashuBxyz')?.t).toBe('cashuBxyz')
    expect(parseReturnFragment('#r=zz')).toBeNull()
    expect(parseReturnFragment('#r=' + '00'.repeat(32))).toBeNull()
  })

  it('state by NUT-07 and the clock', () => {
    expect(returnStateOf(['SPENT'], X, NOW * 1000)).toBe('claimed')
    expect(returnStateOf(['UNSPENT'], X, NOW * 1000)).toBe('waiting')
    expect(returnStateOf(['UNSPENT'], X, (X + 1) * 1000)).toBe('ready')
    expect(returnStateOf(['UNKNOWN'], X, (X + 1) * 1000)).toBe('unknown')
  })
})
