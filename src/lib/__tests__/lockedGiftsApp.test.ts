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
const h = vi.hoisted(() => ({ privkey: '', rows: new Map<string, Record<string, unknown>>(), published: [] as Array<Record<string, unknown>> }))

// The relay backup: a settled gift's row must go back out, or the next login's restore reads the
// old copy (see lockedGiftBackup.test.ts).
vi.mock('../txRecords', () => ({ publishTx: async (row: Record<string, unknown>) => void h.published.push(row) }))

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
    updateTransaction: async (id: string, patch: Record<string, unknown>) => {
      const next = { ...h.rows.get(id), ...patch }
      h.rows.set(id, next)
      return next
    },
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

function minted(lock: Uint8Array, refund: Uint8Array, nonce = 'n1'): string {
  return tokenOf([w.mint.issue(signLocked(linkLockProposal({ giftSecret: bearerSecret(), linkPub: xOnlyPub(lock), refundPub: xOnlyPub(refund), x: X, maxSats: 64, nonce })), 64)])
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

  it('a locked gift big enough to arrive in chunks is filed too, not redeemed (found on the local stack)', async () => {
    // The gateway splits a DM over its direct limit into cashu_dm_chunk pieces. The reassembled
    // payload used to go straight to redemption, which can never spend a locked proof ("API request
    // failed" on every poll), so the recipient never saw the gift.
    h.privkey = bytesToHex(ME)
    const token = minted(ME, BUYER)
    const payload = transfer(token)
    const original = new TextEncoder().encode(payload)
    const digest = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', original)))
    const b64 = btoa(String.fromCharCode(...original))
    const half = Math.ceil(b64.length / 2)
    const pieces = [b64.slice(0, half), b64.slice(half)].map((fragment, index) =>
      JSON.stringify({
        type: 'cashu_dm_chunk', version: '1.0', payload_type: 'cashu_token_transfer', payload_version: '1.0',
        transfer_id: 'a1b2c3d4-0000-4000-8000-000000000001', chunk_index: index, chunk_total: 2,
        content_encoding: 'identity', content_length: original.length, content_sha256: digest, payload: fragment,
      }),
    )
    const dm = createDmCryptoAdapter()
    const first = await dm.unwrapNip17Dm(wrapTo(ISSUER, ME, pieces[0]) as never, '')
    // Held for its sibling (never a coupon, never processed).
    expect(first === null || (first as { hold?: boolean }).hold === true || first.content === '').toBe(true)
    expect(h.rows.size).toBe(0)
    const done = await dm.unwrapNip17Dm(wrapTo(ISSUER, ME, pieces[1]) as never, '')
    expect(done?.content).toBe('')
    expect(only().lockedGift.status).toBe('waiting')
    await app.sweepLockedGifts()
    expect(only().lockedGift.status).toBe('claimed')
    expect(w.kept).toHaveLength(1)
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
    const last = h.published.at(-1) as { lockedGift: { status: string }; memo: string }
    expect(last.lockedGift.status).toBe('returned')
    expect(last.memo).toBe('Not claimed, taken back into your wallet')
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
  it('#532: a copy handed over as several part wraps of one voucher is read as one token', async () => {
    const one = (nonce: string) => w.mint.issue(signLocked(linkLockProposal({ giftSecret: bearerSecret(), linkPub: xOnlyPub(FORGER), refundPub: xOnlyPub(BUYER), x: X, maxSats: 64, nonce })), 64)
    const [a, b] = [one('p1'), one('p2')]
    app.giftReturnSeam.wraps = async () => [wrapTo(ISSUER, BUYER, sent(tokenOf([a]))) as never, wrapTo(ISSUER, BUYER, sent(tokenOf([b]))) as never]
    app.giftReturnSeam.states = async (t) => w.mint.states('http://mint.test', (await import('../voucherToken')).tokenProofs(t).map((p) => p.secret))
    const read = await app.readGiftReturn(BUYER, undefined, NOW * 1000)
    expect(read.kind).toBe('ok')
    const { tokenProofs } = await import('../voucherToken')
    expect(read.kind === 'ok' && tokenProofs(read.view.token).map((p) => p.secret).sort()).toEqual([a.secret, b.secret].sort())
  })
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

const { parseVoucherToken } = await import('../voucherToken')
const parseUnit = (t: string) => parseVoucherToken(t).voucher.unit
describe('#410 code gift return (parts as R, after a rebalance)', () => {
  const S = hexToBytes('88'.repeat(32))
  const codeSent = (token: string) => JSON.stringify({ type: 'imani_gift_sent', v: 1, token, stall: 'Olive Grove', to: 'dan@example.com', claimBy: X, gift: 'code' })
  function store(original: string, parts: string[], remaining: number, opts: { status?: string; shopKey?: string } = {}) {
    const unit = parseUnit(original)
    const calls: Array<{ signer: string; path: string }> = []
    app.giftReturnSeam.storeAsR = async (r, path) => {
      calls.push({ signer: xOnlyPub(r), path })
      if (path === '/v1/checkout-codes/mine') {
        return { status: 200, body: [{ code: 'IMANIABCD2345EFGH', status: opts.status ?? 'reserved', amount: 64, remaining, unit, expires_at: X, shop_key: opts.shopKey ?? xOnlyPub(S), stall_pubkey: 'aa'.repeat(32) }] }
      }
      if (path === '/v1/checkout-codes/IMANIABCD2345EFGH/parts') return { status: 200, body: { status: 'reserved', amount: remaining, parts: parts.map((token, idx) => ({ idx, token, amount: 1 })) } }
      return { status: 404, body: null }
    }
    app.giftReturnSeam.wraps = async () => [wrapTo(ISSUER, BUYER, codeSent(original)) as never]
    app.giftReturnSeam.states = async (t) => w.mint.states('http://mint.test', (await import('../voucherToken')).tokenProofs(t).map((p) => p.secret))
    app.giftReturnSeam.codeGifts = () => true
    return calls
  }

  it('reads /mine and /{code}/parts signed by R, and settles the unspent successor after x', async () => {
    const { shopSpends, loadTokenReader } = await import('./cashlinkWorld')
    await loadTokenReader()
    const original = minted(S, BUYER)
    const successor = minted(S, BUYER, 'n2')
    shopSpends(w.mint, [original])
    const calls = store(original, [successor], 40)
    const before = await app.readGiftReturn(BUYER, undefined, NOW * 1000)
    expect(before.kind).toBe('code')
    if (before.kind !== 'code') return
    expect(before.view).toMatchObject({ state: 'waiting', remainingMinor: 40, amountMinor: 64, stall: 'Olive Grove', parts: [successor] })
    expect(calls.every((c) => c.signer === xOnlyPub(BUYER))).toBe(true)
    expect(calls.map((c) => c.path)).toEqual(['/v1/checkout-codes/mine', '/v1/checkout-codes/IMANIABCD2345EFGH/parts'])
    // No early take-back.
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000)
    expect((await app.takeBackCodeGift(BUYER, before.view)).kind).toBe('waiting')
    expect(w.mint.log.swaps).toHaveLength(0)
    vi.restoreAllMocks()
    at(w, X + 1)
    const after = await app.readGiftReturn(BUYER, undefined, (X + 1) * 1000)
    if (after.kind !== 'code') throw new Error(`expected a code read, got ${after.kind}`)
    expect(after.view.state).toBe('ready')
    vi.spyOn(Date, 'now').mockReturnValue((X + 1) * 1000)
    expect((await app.takeBackCodeGift(BUYER, after.view)).kind).toBe('returned')
    expect(w.kept).toHaveLength(1)
    vi.restoreAllMocks()
  })

  it('a part that does not refund to R, or is locked to another S, is never settled', async () => {
    const original = minted(S, BUYER)
    store(original, [minted(S, FORGER), minted(ME, BUYER)], 64)
    const read = await app.readGiftReturn(BUYER, undefined, (X + 1) * 1000)
    expect(read.kind === 'code' && read.view.parts).toEqual([])
  })

  it('a code fully used reads as used; a /mine with no matching code is not found', async () => {
    const { shopSpends, loadTokenReader } = await import('./cashlinkWorld')
    await loadTokenReader()
    const original = minted(S, BUYER)
    shopSpends(w.mint, [original])
    store(original, [], 0, { status: 'redeemed' })
    expect(await app.readGiftReturn(BUYER, undefined, NOW * 1000)).toMatchObject({ kind: 'code', view: { state: 'used' } })
    store(original, [], 0, { shopKey: 'ab'.repeat(32) })
    expect((await app.readGiftReturn(BUYER, undefined, NOW * 1000)).kind).toBe('not_found')
  })

  it('VITE_GIFTING_CODE_GIFTS off: read as a plain locked gift, the store is never asked', async () => {
    const original = minted(S, BUYER)
    const calls = store(original, [], 64)
    app.giftReturnSeam.codeGifts = () => false
    expect((await app.readGiftReturn(BUYER, undefined, NOW * 1000)).kind).toBe('ok')
    expect(calls).toHaveLength(0)
  })
})
