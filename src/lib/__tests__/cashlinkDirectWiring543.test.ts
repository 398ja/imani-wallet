/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'
import { getPublicKey } from 'nostr-tools'

/**
 * #543, wired into Send by link: `sendGift` picks the direct path (locked from the start, no atomic
 * send) or the legacy one (atomic send, bearer gift, then arm) BEFORE anything moves, logs which and
 * why, and a direct link is claimed and taken back exactly as an armed legacy one. Storage, the
 * signer and the relay read are faked at their module boundaries; the mint and gateway are
 * `cashlinkWorld`'s.
 */

const ID = hexToBytes('33'.repeat(32))
const ME = getPublicKey(ID)

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  vouchers: [] as Array<Record<string, unknown>>,
  wraps: new Map<string, string[]>(),
  signerKey: null as Uint8Array | null,
  merchant: false,
  legacySends: 0,
}))

vi.mock('../wallet', () => ({
  getWallet: () => ({
    getAllTransactions: async () => h.rows,
    getAllVouchers: async () => h.vouchers,
    updateTransaction: async (id: string, patch: Record<string, unknown>) => {
      const row = h.rows.find((r) => r.id === id)
      if (!row) return null
      Object.assign(row, patch)
      return row
    },
    addTransaction: async (row: Record<string, unknown>) => {
      h.rows = h.rows.filter((r) => r.id !== row.id)
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
  sessionAccount: () => ME,
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
// The legacy send: a bearer gift lands on the link, as gateway-core's atomic send does.
const sent = vi.hoisted(() => ({ token: '' }))
vi.mock('../pay', async (orig) => {
  const real = await orig<typeof import('../pay')>()
  return {
    ...real,
    sendVouchers: async (args: { recipient: { pubkey: string }; link: Record<string, unknown> }) => {
      h.legacySends += 1
      h.rows.push({ id: 'sent:t0', type: 'sent', timestamp: 1, link: args.link })
      h.wraps.set(args.recipient.pubkey, [sent.token])
      return { id: 's1', requested: 100, delivered: 100, parts: 1 }
    },
  }
})

const W = await import('./cashlinkWorld')
await W.loadTokenReader()
const giftLinks = await import('../giftLinks')
const { deriveLinkSecret, linkPubOf } = await import('../giftLink')
const { creditableFaceValue, parseVoucherToken, tokenProofs } = await import('../voucherToken')
const { directRows } = await import('../cashlinkDirectPorts')
const { claimLockedGift } = await import('../cashlinkFlow')

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
let w: ReturnType<typeof W.world>
let info: ReturnType<typeof vi.spyOn>
const L0 = () => deriveLinkSecret(ID, 0)

function couponRow(amounts: number[], nonce: string) {
  const token = W.tokenOf(amounts.map((a, n) => w.mint.issue(W.bearerSecret({ nonce: nonce.padEnd(8, 'n') }, `${nonce}${n}`), a)))
  const parsed = parseVoucherToken(token)
  const face = creditableFaceValue(parsed).faceValue
  const row = {
    token_id: `row-${nonce}`, voucher_id: parsed.voucher.voucherId, token, amount: parsed.tokenAmount, token_amount: parsed.tokenAmount,
    face_value: face, face_unit: 'GBP', face_decimals: 2, issuer_id: W.STALL, issuance_ratio: parsed.voucher.issuanceRatio, status: 'active',
    expires_at: parsed.voucher.expiresAt, created_at: '', updated_at: '',
  }
  h.vouchers.push(row)
  return { row, face }
}

beforeEach(() => {
  localStorage.clear()
  h.rows = []
  h.vouchers = []
  h.wraps.clear()
  h.signerKey = ID
  h.merchant = false
  h.legacySends = 0
  w = W.world(NOW)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout'], shouldAdvanceTime: true })
  vi.setSystemTime(NOW * 1000)
  giftLinks.resetLinkSettlesForTests()
  sent.token = W.tokenOf([w.mint.issue(W.bearerSecret({ nonce: 'legacy00' }), 64)])
  w.ports.deliver = async (secret, token) => {
    h.wraps.set(linkPubOf(secret), [...(h.wraps.get(linkPubOf(secret)) ?? []), token])
    return true
  }
  vi.spyOn(giftLinks.cashlinkSeam, 'ports').mockResolvedValue(w.ports)
  vi.spyOn(giftLinks.cashlinkSeam, 'directPorts').mockResolvedValue({
    ...w.ports,
    identitySecret: () => (h.signerKey ? h.signerKey.slice() : null),
    publish: async (secret, token) => {
      h.wraps.set(linkPubOf(secret), [...(h.wraps.get(linkPubOf(secret)) ?? []), token])
      return true
    },
    settleSource: async (tokenId) => void (h.vouchers = h.vouchers.filter((v) => v.token_id !== tokenId)),
    recordRows: async (intent, arm) => {
      for (const row of directRows(intent, arm) as unknown as Array<Record<string, unknown>>) {
        h.rows = h.rows.filter((r) => r.id !== row.id)
        h.rows.push(row)
      }
    },
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  info = vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const send = (amount: number) => giftLinks.sendGift({ payer: ME, merchant: { pubkey: W.STALL, name: 'Stall' } as never, unit: 'GBP', amount, x: X, settleBudgetMs: 10 })
const logged = () => info.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[cashlink] path='))
const linkOf = () => h.rows.find((r) => r.link)!.link as { k: string; i: number; x: number; status: string; arm?: { s: string } }

describe('sendGift picks the path before anything moves', () => {
  it('direct: no atomic send, every wrap locked to L, the row armed, "path=direct" logged', async () => {
    const { face } = couponRow([64], 'a')
    const out = await send(face)
    expect(logged()).toEqual(['[cashlink] path=direct'])
    expect(h.legacySends).toBe(0)
    expect(out).toMatchObject({ delivered: true, returnsOnItsOwn: true })
    expect(linkOf()).toMatchObject({ i: 0, x: X, status: 'outstanding', arm: { s: 'armed' } })
    const onLink = h.wraps.get(linkPubOf(L0()))!
    expect(onLink).toHaveLength(1)
    for (const p of tokenProofs(onLink[0])) expect(p.secret).toContain('P2PK')
    expect(h.vouchers).toHaveLength(0)
  })

  it.each([
    ['merchant', () => void (h.merchant = true)],
    ['remote_signer', () => void (h.signerKey = null)],
    ['relay_off', () => void (w.gateway.relayOn = false)],
    ['routes_unavailable', () => void (w.gateway.routes = false)],
  ])('legacy, why=%s: the old send, nothing burnt first', async (why, arrange) => {
    const { row, face } = couponRow([64], 'b')
    const coupon = tokenProofs(row.token)[0].secret
    arrange()
    await send(face)
    expect(logged()).toEqual([`[cashlink] path=legacy why=${why}`])
    expect(h.legacySends).toBe(1)
    // The direct path burnt nothing of the coupon before it handed over.
    expect(w.mint.log.swaps.filter((s) => s.inputs.some((i) => i.secret === coupon))).toHaveLength(0)
  })

  it('legacy, why=no_plan: no coupon of this stall covers it', async () => {
    couponRow([64], 'c')
    await send(1_000_000)
    expect(logged()).toEqual(['[cashlink] path=legacy why=no_plan'])
    expect(h.legacySends).toBe(1)
  })
})

describe('a direct link is claimed and taken back as before', () => {
  it('claimed from another wallet by the re-sign route; the sender then reads it claimed', async () => {
    const { face } = couponRow([64], 'd')
    await send(face)
    const k = linkOf().k
    const locked = h.wraps.get(linkPubOf(L0()))!.map((token) => ({ token, sentAt: NOW }))
    const claim = await claimLockedGift({ ports: w.ports, pubkey: 'c3'.repeat(32), linkSecret: L0(), k, lockedTokens: locked })
    expect(claim.kind).toBe('ok')
    expect(w.gateway.resigns.size).toBe(1)
    w.kept.length = 0
    expect((await giftLinks.reconcileGiftLinks(NOW * 1000)).claimed).toBe(1)
    expect(linkOf().status).toBe('claimed')
  })

  it('Take it back before x: back as the voucher, the row Taken back', async () => {
    const { face } = couponRow([64], 'e')
    await send(face)
    expect(await giftLinks.takeBack(linkOf().k)).toEqual({ kind: 'ok' })
    expect(linkOf().status).toBe('reclaimed')
    expect(w.kept).toHaveLength(1)
  })
})
