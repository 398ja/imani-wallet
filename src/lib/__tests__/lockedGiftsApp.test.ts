/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { nip17 } from 'nostr-tools'

/**
 * #410 G14, the app side: dm-poll's unwrap files a locked gift instead of redeeming it, the
 * `imani_gift_sent` notice records an outgoing gift (never balance), the sweep claims / takes back,
 * and the guest return page finds the gift through a wrap to getPublicKey(R).
 */
const h = vi.hoisted(() => ({ privkey: '', rows: new Map<string, Record<string, unknown>>() }))

vi.mock('../trustedMint', () => ({ checkTokenBacking: () => ({ outcome: 'accept' }), loadTrustedMints: async () => {}, checkMintAndUnit: () => 'trusted' }))
vi.mock('../issuerAllowlist', () => ({ checkIssuer: () => 'ok' }))
vi.mock('../terminalDeliveryNet', () => ({ collectEnrolled: async () => 0 }))
vi.mock('../nap', async () => {
  const { getPublicKey } = await import('nostr-tools')
  const { hexToBytes } = await import('@noble/hashes/utils')
  return {
    getSigner: () => ({
      get pubkey() {
        return getPublicKey(hexToBytes(h.privkey))
      },
      withPrivkey<T>(borrow: (k: Uint8Array) => T): T {
        if (!h.privkey) throw new Error('locked')
        return borrow(hexToBytes(h.privkey))
      },
    }),
  }
})
vi.mock('../wallet', () => ({
  notifyWalletChanged: () => {},
  getWallet: () => ({
    getTransaction: async (id: string) => h.rows.get(id) ?? null,
    addTransaction: async (r: Record<string, unknown>) => void h.rows.set(String(r.id), r),
    updateTransaction: async (id: string, patch: Record<string, unknown>) => void h.rows.set(id, { ...h.rows.get(id), ...patch }),
    getAllTransactions: async () => [...h.rows.values()],
  }),
}))

const { createDmCryptoAdapter } = await import('../dmCrypto')
const app = await import('../lockedGiftsApp')
const { linkLockProposal, xOnlyPub } = await import('../cashlinkLock')
const { toTransaction } = await import('../transactions')
const { bearerSecret, signLocked, tokenOf, world, at } = await import('./cashlinkWorld')

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
const ME = hexToBytes('33'.repeat(32))
const BUYER = hexToBytes('44'.repeat(32))
const ISSUER = hexToBytes('66'.repeat(32))
const FORGER = hexToBytes('77'.repeat(32))

let w: ReturnType<typeof world>

function minted(lock: Uint8Array, refund: Uint8Array): string {
  return tokenOf([w.mint.issue(signLocked(linkLockProposal({ giftSecret: bearerSecret(), linkPub: xOnlyPub(lock), refundPub: xOnlyPub(refund), x: X, maxSats: 64, nonce: 'n1' })), 64)])
}
const transfer = (token: string) => JSON.stringify({ type: 'cashu_token_transfer', version: '1.0', token })
const sent = (token: string, to: string | null = 'bob@example.com') => JSON.stringify({ type: 'imani_gift_sent', v: 1, token, stall: 'Mama Put', to, claimBy: X })
const wrapTo = (from: Uint8Array, to: Uint8Array, content: string) => nip17.wrapEvent(from, { publicKey: xOnlyPub(to) }, content)

beforeEach(() => {
  localStorage.clear()
  h.rows.clear()
  w = world(NOW)
  app.lockedGiftSeam.ports = async () => w.ports
  app.lockedGiftSeam.now = () => w.clock.now * 1000
  app.lockedGiftSeam.issuerKey = async () => xOnlyPub(ISSUER)
})

const realOwnKey = app.lockedGiftSeam.ownKey
beforeEach(() => {
  app.lockedGiftSeam.ownKey = realOwnKey
})

const only = () => [...h.rows.values()][0] as Record<string, unknown> & { lockedGift: { status: string } }

describe('handle recipient through dm-poll', () => {
  it('a transfer locked to my key is filed as a pending gift (no token for redeem), then claimed into balance', async () => {
    h.privkey = bytesToHex(ME)
    const token = minted(ME, BUYER)
    const dm = await createDmCryptoAdapter().unwrapNip17Dm(wrapTo(ISSUER, ME, transfer(token)) as never, '')
    expect(dm?.content).toBe('')
    await app.sweepLockedGifts()
    expect(only().lockedGift.status).toBe('claimed')
    expect(w.kept).toHaveLength(1)
    expect(toTransaction(only() as never).direction).toBe('in')
    expect(only().voucherId).toBeUndefined()
  })

  it('a key that cannot be lent: stays "Claim by", no balance; claims once the key is readable', async () => {
    h.privkey = bytesToHex(ME)
    const token = minted(ME, BUYER)
    const lend = app.lockedGiftSeam.ownKey
    app.lockedGiftSeam.ownKey = () => null
    await createDmCryptoAdapter().unwrapNip17Dm(wrapTo(ISSUER, ME, transfer(token)) as never, '')
    await app.sweepLockedGifts()
    expect(only().lockedGift.status).toBe('waiting')
    expect(String(only().memo)).toMatch(/claim by/)
    expect(w.kept).toHaveLength(0)
    app.lockedGiftSeam.ownKey = lend
    await app.sweepLockedGifts()
    expect(only().lockedGift.status).toBe('claimed')
  })

  it('taken back by the buyer before we could claim: dropped with a clear row', async () => {
    h.privkey = bytesToHex(ME)
    const token = minted(ME, BUYER)
    app.lockedGiftSeam.ownKey = () => null
    await createDmCryptoAdapter().unwrapNip17Dm(wrapTo(ISSUER, ME, transfer(token)) as never, '')
    at(w, X + 1)
    const { takeBackLockedGift } = await import('../lockedGifts')
    await takeBackLockedGift(w.ports, BUYER, token)
    w.kept.length = 0
    app.lockedGiftSeam.ownKey = () => Uint8Array.from(ME)
    await app.sweepLockedGifts()
    expect(only().lockedGift.status).toBe('gone')
    expect(String(only().memo)).toMatch(/returned to the buyer/)
    expect(w.kept).toHaveLength(0)
  })

  it('a transfer locked to someone else is left to the ordinary path (not filed)', async () => {
    h.privkey = bytesToHex(ME)
    const token = minted(FORGER, BUYER)
    const dm = await createDmCryptoAdapter().unwrapNip17Dm(wrapTo(ISSUER, ME, transfer(token)) as never, '')
    expect(dm?.content).toContain('cashu_token_transfer')
    expect(h.rows.size).toBe(0)
  })
})

describe('signed-in buyer through dm-poll', () => {
  it('records an outgoing gift (not balance), then takes it back after x into an unlocked coupon', async () => {
    h.privkey = bytesToHex(BUYER)
    const token = minted(ME, BUYER)
    const dm = await createDmCryptoAdapter().unwrapNip17Dm(wrapTo(ISSUER, BUYER, sent(token)) as never, '')
    expect(dm?.content).toBe('')
    const row = only()
    expect(row.type).toBe('gift_sent')
    expect(String(row.memo)).toMatch(/^Sent to bob@example.com, claim by/)
    expect(toTransaction(row as never).direction).toBe('out')
    await app.sweepLockedGifts()
    expect(only().lockedGift.status).toBe('waiting')
    expect(w.kept).toHaveLength(0)
    at(w, X + 1)
    expect((await app.sweepLockedGifts()).returned).toBe(1)
    expect(only().lockedGift.status).toBe('returned')
    expect(w.kept[0].why).toBe('returned')
  })

  it('claimed by the recipient before x: recorded as claimed', async () => {
    h.privkey = bytesToHex(BUYER)
    const token = minted(ME, BUYER)
    await createDmCryptoAdapter().unwrapNip17Dm(wrapTo(ISSUER, BUYER, sent(token, null)) as never, '')
    const { settleIncoming } = await import('../lockedGifts')
    await settleIncoming(w.ports, 'c3'.repeat(32), token, () => Uint8Array.from(ME))
    w.kept.length = 0
    await app.sweepLockedGifts()
    expect(only().lockedGift.status).toBe('claimed')
    expect(String(only().memo)).toBe('Claimed by your recipient')
  })

  it('refuses a notice sealed by someone other than the issuer', async () => {
    h.privkey = bytesToHex(BUYER)
    await createDmCryptoAdapter().unwrapNip17Dm(wrapTo(FORGER, BUYER, sent(minted(ME, BUYER))) as never, '')
    expect(h.rows.size).toBe(0)
  })

  it('refuses a notice whose refund key is not mine', async () => {
    h.privkey = bytesToHex(BUYER)
    await createDmCryptoAdapter().unwrapNip17Dm(wrapTo(ISSUER, BUYER, sent(minted(ME, FORGER))) as never, '')
    expect(h.rows.size).toBe(0)
  })

  it('issuer key unreachable: the wrap is left for a retry (null)', async () => {
    h.privkey = bytesToHex(BUYER)
    app.lockedGiftSeam.issuerKey = async () => {
      throw new Error('down')
    }
    expect(await createDmCryptoAdapter().unwrapNip17Dm(wrapTo(ISSUER, BUYER, sent(minted(ME, BUYER))) as never, '')).toBeNull()
  })
})

describe('guest return page', () => {
  it('finds the gift via the wrap to getPublicKey(R), shows waiting, then takes it back after x', async () => {
    h.privkey = bytesToHex(ME)
    const token = minted(FORGER, BUYER)
    app.giftReturnSeam.wraps = async () => [wrapTo(ISSUER, BUYER, sent(token)) as never]
    app.giftReturnSeam.states = async (t) => w.mint.states('http://mint.test', (await import('../voucherToken')).tokenProofs(t).map((p) => p.secret))
    const read = await app.readGiftReturn(BUYER, undefined, NOW * 1000)
    expect(read.kind === 'ok' && read.view.state).toBe('waiting')
    expect(read.kind === 'ok' && read.view.stall).toBe('Mama Put')
    at(w, X + 1)
    vi.spyOn(Date, 'now').mockReturnValue((X + 1) * 1000)
    expect((await app.takeBackGuestGift(BUYER, token)).kind).toBe('returned')
    expect(w.kept).toHaveLength(1)
    vi.restoreAllMocks()
  })

  it('takes nothing back before x', async () => {
    const token = minted(FORGER, BUYER)
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000)
    expect((await app.takeBackGuestGift(BUYER, token)).kind).toBe('waiting')
    expect(w.mint.log.swaps).toHaveLength(0)
    vi.restoreAllMocks()
  })

  it('ignores a forged-seal wrap and an optional t locked to another refund key', async () => {
    app.giftReturnSeam.wraps = async () => [wrapTo(FORGER, BUYER, sent(minted(ME, BUYER))) as never]
    expect((await app.readGiftReturn(BUYER, undefined, NOW * 1000)).kind).toBe('not_found')
    expect(await app.readGiftReturn(BUYER, minted(ME, FORGER), NOW * 1000)).toEqual({ kind: 'refused', why: 'wrong_key' })
  })
})
