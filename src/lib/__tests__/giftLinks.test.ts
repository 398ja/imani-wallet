import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * Claim links phase 4, the sender's side (spec 3.3 "Status and reclaim", Q4, Q5): the limit, the
 * counter, the NUT-07 status, reclaim after `x`, Take it back, and the restore scan's gap rule.
 * Storage, the signer and the redeem are faked at their module boundaries.
 */

const ID = hexToBytes('33'.repeat(32))

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  redeemed: [] as Array<{ token: string; source: string }>,
  redeemFails: null as null | string,
  wraps: new Map<string, string[]>(),
  sent: [] as Array<Record<string, unknown>>,
  signerKey: null as Uint8Array | null,
  /** The send delivers a wrap to this link key (as the gateway does on COMPLETED). */
  deliverTo: null as string | null,
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
    return { withPrivkey: <T,>(f: (k: Uint8Array) => T) => f(h.signerKey!) }
  },
}))
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({}),
  withCorrelation: async (_ids: unknown, run: (id: string) => unknown) => run('corr'),
}))
vi.mock('../trustedMint', () => ({
  loadTrustedMints: async () => {},
  checkTokenBacking: () => ({ outcome: 'accept' }),
}))
vi.mock('../cashbackValidation', () => ({ cashbackValidation: () => undefined }))
vi.mock('../pay', () => ({
  sendVouchers: async (args: Record<string, unknown>) => {
    h.sent.push(args)
    const to = (args.recipient as { pubkey: string }).pubkey
    if (h.deliverTo === to) h.wraps.set(to, ['cashuBdelivered'])
    return { id: 's1', requested: 100, delivered: 100, parts: 1 }
  },
}))
// The wrap fetch is the network: each link key answers with the tokens registered for its pubkey.
vi.mock('../giftLink', async (orig) => {
  const real = await orig<typeof import('../giftLink')>()
  return {
    ...real,
    // A key with nothing registered has no wraps (so the send's free-key probe passes it).
    fetchGiftWraps: async (secret: Uint8Array) =>
      (h.wraps.get(real.linkPubOf(secret)) ?? []).length ? [{ id: real.linkPubOf(secret) }] : [],
    giftTokensFrom: async (secret: Uint8Array) =>
      (h.wraps.get(real.linkPubOf(secret)) ?? []).map((token) => ({ token, sentAt: 1_800_000_000 })),
  }
})

import { deriveLinkSecret, linkPubOf, secretToText, type ProofState } from '../giftLink'
import {
  MAX_OUTSTANDING_LINKS,
  RESTORE_GAP,
  allocateLink,
  nextLinkIndex,
  reconcileGiftLinks,
  restoreScan,
  sendGift,
  takeBack,
  tooManyLinksMessage,
} from '../giftLinks'
import { buildVoucherToken } from './voucherFixtures'

const store = new Map<string, string>()
const PUB = 'a'.repeat(64)

function linkRow(i: number, status = 'outstanding', x = 1_900_000_000) {
  const k = secretToText(deriveLinkSecret(ID, i))
  return { id: `sent:t${i}`, type: 'sent', timestamp: i, link: { k, i, x, status } }
}

beforeEach(() => {
  store.clear()
  h.rows = []
  h.redeemed = []
  h.redeemFails = null
  h.wraps.clear()
  h.sent = []
  h.signerKey = ID
  h.deliverTo = null
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.stubGlobal('window', {
    location: { origin: 'https://wallet.example' },
    TokenRedemption: {
      redeem: async (token: string, opts: { source: string }) => {
        if (h.redeemFails) throw new Error(h.redeemFails)
        h.redeemed.push({ token, source: opts.source })
        return {}
      },
    },
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('allocating link keys (spec 3.3)', () => {
  it('derives at the next index, skipping any a row already uses', () => {
    const a = allocateLink(PUB, new Set([0, 1]))
    expect(a.i).toBe(2)
    expect(a.linkPub).toBe(linkPubOf(deriveLinkSecret(ID, 2)))
  })

  it('uses a random secret when the key is in a remote signer', () => {
    h.signerKey = null
    const a = allocateLink(PUB, new Set())
    expect(a.i).toBeUndefined()
    expect(a.secret).toHaveLength(32)
  })
})

describe('Send by link (Q5)', () => {
  it(`refuses an eleventh outstanding link with the spec's copy, before anything moves`, async () => {
    h.rows = Array.from({ length: MAX_OUTSTANDING_LINKS }, (_, i) => linkRow(i))
    await expect(sendGift({ payer: PUB, merchant: {} as never, unit: 'EUR', amount: 100, x: 1_900_000_000 })).rejects.toThrow(
      tooManyLinksMessage(),
    )
    expect(h.sent).toHaveLength(0)
    expect(tooManyLinksMessage()).toBe('You have 10 links waiting to be claimed. Take one back or wait for it to be claimed.')
  })

  it('counts claimed and taken-back links as no longer waiting', async () => {
    h.rows = [...Array.from({ length: 9 }, (_, i) => linkRow(i)), linkRow(9, 'claimed'), linkRow(10, 'reclaimed')]
    // The delivery check (spec 3.3 send step 3) finds the wrap at once.
    h.deliverTo = linkPubOf(deriveLinkSecret(ID, 11))
    const out = await sendGift({ payer: PUB, merchant: {} as never, unit: 'EUR', amount: 100, x: 1_900_000_000 })
    expect(out.delivered).toBe(true)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].link).toMatchObject({ i: 11, status: 'outstanding', x: 1_900_000_000 })
    expect((h.sent[0].recipient as { pubkey: string }).pubkey).toBe(linkPubOf(deriveLinkSecret(ID, 11)))
    expect(out.link).toBe(`https://wallet.example/g#v=1&k=${secretToText(deriveLinkSecret(ID, 11))}&x=1900000000`)
    // The index is reserved before the send, so an unknown outcome can never reuse it.
    expect(nextLinkIndex(PUB)).toBe(12)
  })
})

describe('status and reclaim (spec 3.3)', () => {
  const token = buildVoucherToken({}, [8]).token

  it('marks a link claimed when its proofs are spent, and redeems nothing', async () => {
    h.rows = [linkRow(0)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    const out = await reconcileGiftLinks(Date.now(), async () => 'SPENT')
    expect(out).toEqual({ claimed: 1, reclaimed: 0 })
    expect((h.rows[0].link as { status: string }).status).toBe('claimed')
    expect(h.redeemed).toHaveLength(0)
  })

  it('leaves an unspent link alone before x', async () => {
    h.rows = [linkRow(0, 'outstanding', 2_000_000_000)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    await reconcileGiftLinks(1_900_000_000_000, async () => 'UNSPENT')
    expect(h.redeemed).toHaveLength(0)
    expect((h.rows[0].link as { status: string }).status).toBe('outstanding')
  })

  it('takes an unspent link back after x, with source gift_link_reclaim', async () => {
    h.rows = [linkRow(0, 'outstanding', 1_800_000_000)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    const out = await reconcileGiftLinks(1_800_000_001_000, async () => 'UNSPENT')
    expect(out).toEqual({ claimed: 0, reclaimed: 1 })
    expect(h.redeemed).toEqual([{ token, source: 'gift_link_reclaim' }])
    expect((h.rows[0].link as { status: string }).status).toBe('reclaimed')
  })

  it('reads a race lost at the mint as claimed, not as an error', async () => {
    h.rows = [linkRow(0, 'outstanding', 1_800_000_000)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    h.redeemFails = 'Token already spent (11001)'
    await reconcileGiftLinks(1_800_000_001_000, async () => 'UNSPENT')
    expect((h.rows[0].link as { status: string }).status).toBe('claimed')
  })

  it('never reclaims when the mint cannot answer', async () => {
    h.rows = [linkRow(0, 'outstanding', 1_800_000_000)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    await reconcileGiftLinks(1_800_000_001_000, async (): Promise<ProofState> => 'UNKNOWN')
    expect(h.redeemed).toHaveLength(0)
  })
})

describe('Take it back (Q4)', () => {
  it('receives the link itself before x', async () => {
    const token = buildVoucherToken({}, [8]).token
    h.rows = [linkRow(0, 'outstanding', 2_000_000_000)]
    h.wraps.set(linkPubOf(deriveLinkSecret(ID, 0)), [token])
    vi.stubGlobal('fetch', async () => Response.json({ states: [{ state: 'UNSPENT' }] }))
    const out = await takeBack(String((h.rows[0].link as { k: string }).k))
    expect(out.kind).toBe('ok')
    expect(h.redeemed).toEqual([{ token, source: 'gift_link_reclaim' }])
    expect((h.rows[0].link as { status: string }).status).toBe('reclaimed')
  })
})

describe('the restore scan (spec 3.3: i = 0 … last + 20)', () => {
  const token = buildVoucherToken({}, [8]).token
  const probeSeen: number[] = []
  const probeFor = (holding: Set<number>) => async (secret: Uint8Array) => {
    for (let i = 0; i < 200; i++) {
      if (linkPubOf(deriveLinkSecret(ID, i)) === linkPubOf(secret)) {
        probeSeen.push(i)
        return holding.has(i) ? [{ token: `${token}`, sentAt: 1_800_000_000 }] : []
      }
    }
    return []
  }
  beforeEach(() => {
    probeSeen.length = 0
  })

  it(`scans ${RESTORE_GAP + 1} indices on an empty wallet and adopts what it finds`, async () => {
    const adopted = await restoreScan(PUB, probeFor(new Set([3])), async () => 'UNSPENT', 1_800_000_000_000)
    expect(adopted).toBe(1)
    // Found at 3, so the window slides to 3 + 20.
    expect(Math.max(...probeSeen)).toBe(3 + RESTORE_GAP)
    expect(h.rows).toHaveLength(1)
    expect(h.rows[0]).toMatchObject({ type: 'sent', link: { i: 3, status: 'outstanding' } })
    expect(nextLinkIndex(PUB)).toBe(4)
  })

  it('slides past a run with gaps shorter than 20, and stops 20 after the last', async () => {
    await restoreScan(PUB, probeFor(new Set([0, 15, 34])), async () => 'UNSPENT', 1_800_000_000_000)
    expect(Math.max(...probeSeen)).toBe(34 + RESTORE_GAP)
  })

  it('does not adopt a claimed link, nor one a row already knows', async () => {
    h.rows = [linkRow(2)]
    const adopted = await restoreScan(PUB, probeFor(new Set([2, 5])), async () => 'SPENT', 1_800_000_000_000)
    expect(adopted).toBe(0)
    expect(h.rows).toHaveLength(1)
  })

  it('does nothing for a remote-signer account (its random links are in the encrypted history)', async () => {
    h.signerKey = null
    expect(await restoreScan(PUB, probeFor(new Set([0])))).toBe(0)
    expect(probeSeen).toHaveLength(0)
  })
})
