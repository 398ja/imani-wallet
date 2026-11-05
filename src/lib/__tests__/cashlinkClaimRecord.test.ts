/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * A claimed Cashlink writes the claimer's History row, and tells the issuer (the "claimed" notice)
 * through the payment-receipt channel, whose POST fires the issuer's push server-side.
 *
 * Before: the link-locked claim kept the coupon through `cashlinkPorts.keep`, which saved the
 * voucher row only, so History had no `received` row; and nothing told the issuer at all.
 */

const ID = hexToBytes('33'.repeat(32))
const ISSUER = 'a'.repeat(64)
const CLAIMER = 'c3'.repeat(32)

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  vouchers: [] as Array<Record<string, unknown>>,
  wraps: new Map<string, string[]>(),
  signerKey: null as Uint8Array | null,
  account: '' as string,
  receipts: [] as Array<Record<string, unknown>>,
  redeemed: [] as string[],
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
      const same = h.rows.findIndex((r) => r.id === row.id)
      if (same >= 0) h.rows[same] = row
      else h.rows.push(row)
      return row
    },
    saveVoucher: async (row: Record<string, unknown>) => {
      h.vouchers.push(row)
      return row
    },
  }),
  notifyWalletChanged: () => {},
}))
vi.mock('../txRecords', () => ({ publishTx: async () => {} }))
vi.mock('../nap', () => ({
  getSigner: () => {
    if (!h.signerKey) throw new Error('remote signer')
    return { pubkey: h.account, withPrivkey: <T,>(f: (k: Uint8Array) => T) => f(h.signerKey!.slice()) }
  },
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
  sessionAccount: () => h.account,
}))
vi.mock('../paymentReceipt', () => ({
  postPaymentReceipt: async (p: Record<string, unknown>) => void h.receipts.push(p),
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
const sent = vi.hoisted(() => ({ token: '' }))
vi.mock('../pay', () => ({
  sendVouchers: async (args: { recipient: { pubkey: string }; link: Record<string, unknown> }) => {
    h.rows.push({ id: 'sent:t0', type: 'sent', timestamp: 1, link: args.link })
    h.wraps.set(args.recipient.pubkey, [sent.token])
    return { id: 's1', requested: 100, delivered: 100, parts: 1 }
  },
}))

const { world, bearerSecret, tokenOf } = await import('./cashlinkWorld')
const giftLinks = await import('../giftLinks')
const { deriveLinkSecret, linkPubOf, secretToText } = await import('../giftLink')
const { appCashlinkPorts, claimedRow } = await import('../cashlinkPorts')
const { wrapForLink } = await import('../cashlinkFlow')
const { toTransaction } = await import('../transactions')

const NOW = 1_800_000_000
const X = NOW + 7 * 86_400
let w: ReturnType<typeof world>

const flush = async () => {
  for (let n = 0; n < 5; n++) await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  localStorage.clear()
  h.rows = []
  h.vouchers = []
  h.wraps.clear()
  h.signerKey = ID
  h.account = ISSUER
  h.receipts = []
  h.redeemed = []
  w = world(NOW)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout'], shouldAdvanceTime: true })
  vi.setSystemTime(NOW * 1000)
  sent.token = tokenOf([w.mint.issue(bearerSecret(), 64)])
  vi.spyOn(giftLinks.cashlinkSeam, 'ports').mockResolvedValue(w.ports)
  w.ports.deliver = async (secret, token) => {
    h.wraps.set(linkPubOf(secret), [...(h.wraps.get(linkPubOf(secret)) ?? []), token])
    return true
  }
  // The REAL keep, so the claim writes what the app writes.
  w.ports.keep = appCashlinkPorts().keep
  vi.stubGlobal('window', Object.assign(window, { TokenRedemption: { redeem: async (t: string) => void h.redeemed.push(t) } }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function sendLockedLink(): Promise<{ k: string; locked: string }> {
  await giftLinks.sendGift({ payer: ISSUER, merchant: { pubkey: ISSUER } as never, unit: 'GBP', amount: 1000, x: X, settleBudgetMs: 10 })
  const k = (h.rows[0].link as { k: string }).k
  return { k, locked: h.wraps.get(linkPubOf(deriveLinkSecret(ID, 0)))!.at(-1)! }
}

describe('claiming a locked Cashlink', () => {
  it('writes a received row on the claimer side and posts one receipt to the issuer', async () => {
    const { k, locked } = await sendLockedLink()
    // Now the claimer's wallet.
    h.account = CLAIMER
    h.rows = []
    const outcome = await giftLinks.redeemGiftTokens([{ token: locked, sentAt: NOW, senderPubkey: ISSUER }], 'gift_link', k)
    expect(outcome).toEqual({ kind: 'ok' })
    await flush()

    expect(h.vouchers).toHaveLength(1)
    const received = h.rows.filter((r) => r.type === 'received')
    expect(received).toHaveLength(1)
    const tx = toTransaction(received[0] as never)
    expect(tx.direction).toBe('in')
    expect(tx.id).toBe(`received:${h.vouchers[0].token_id}`)

    expect(h.receipts).toHaveLength(1)
    const receipt = h.receipts[0]
    expect(receipt.senderPubkeyHex).toBe(ISSUER)
    expect(receipt.deliveryEventId).toMatch(/^[0-9a-f]{64}$/)
    // Never the link key, a token or a proof secret.
    const text = JSON.stringify(receipt)
    expect(text).not.toContain(k)
    expect(text).not.toContain('cashu')
    expect(text).not.toContain(secretToText(deriveLinkSecret(ID, 0)))
  })

  it('a retry posts the same receipt id (the gateway answers 409, one push)', async () => {
    const { locked } = await sendLockedLink()
    h.account = CLAIMER
    giftLinks.tellIssuerClaimed([{ token: locked, sentAt: NOW, senderPubkey: ISSUER }], CLAIMER)
    await vi.waitFor(() => expect(h.receipts).toHaveLength(1))
    giftLinks.tellIssuerClaimed([{ token: locked, sentAt: NOW, senderPubkey: ISSUER }], CLAIMER)
    await vi.waitFor(() => expect(h.receipts).toHaveLength(2))
    expect(h.receipts[0].deliveryEventId).toBe(h.receipts[1].deliveryEventId)
  })

  it('tells nobody when the wrap names no issuer, or names the claimer', async () => {
    const { locked } = await sendLockedLink()
    giftLinks.tellIssuerClaimed([{ token: locked, sentAt: NOW }], CLAIMER)
    giftLinks.tellIssuerClaimed([{ token: locked, sentAt: NOW, senderPubkey: CLAIMER }], CLAIMER)
    await flush()
    expect(h.receipts).toHaveLength(0)
  })

  it('a take-back writes no received row and tells nobody', async () => {
    const { k } = await sendLockedLink()
    await giftLinks.takeBack(k)
    await flush()
    expect(h.rows.filter((r) => r.type === 'received')).toHaveLength(0)
    expect(h.receipts).toHaveLength(0)
  })
})

describe('a bearer (unlocked) Cashlink', () => {
  it('tells the issuer once it is redeemed by a recipient, never on the sender reclaim', async () => {
    const bearer = tokenOf([w.mint.issue(bearerSecret(), 64)])
    h.account = CLAIMER
    await giftLinks.redeemGiftTokens([{ token: bearer, sentAt: NOW, senderPubkey: ISSUER }], 'gift_link')
    await giftLinks.redeemGiftTokens([{ token: bearer, sentAt: NOW, senderPubkey: ISSUER }], 'gift_link_reclaim')
    await flush()
    expect(h.redeemed).toHaveLength(2)
    expect(h.receipts).toHaveLength(1)
    expect(h.receipts[0].senderPubkeyHex).toBe(ISSUER)
  })
})

describe('the wrap names its issuer by public key', () => {
  it('carries sender_pubkey, which giftTokensFrom reads back', async () => {
    const real = await vi.importActual<typeof import('../giftLink')>('../giftLink')
    const secret = deriveLinkSecret(ID, 4)
    const wrap = wrapForLink(secret, 'cashuBabc', ISSUER)
    const [found] = await real.giftTokensFrom(secret, [wrap as never])
    expect(found.senderPubkey).toBe(ISSUER)
    expect(JSON.stringify(wrap)).not.toContain(secretToText(secret))
  })

  it('omits a malformed sender', async () => {
    const real = await vi.importActual<typeof import('../giftLink')>('../giftLink')
    const secret = deriveLinkSecret(ID, 5)
    const [found] = await real.giftTokensFrom(secret, [wrapForLink(secret, 'cashuBabc', 'nope') as never])
    expect(found.senderPubkey).toBeUndefined()
  })
})

describe('claimedRow', () => {
  it('is the legacy received shape, keyed on the voucher row', () => {
    const row = claimedRow({ token_id: 't1', voucher_id: 'v1', face_value: 250, face_unit: 'gbp', face_decimals: 2, issuer_id: 'ab'.repeat(32) } as never, 'cashuBx', 5)
    expect(row).toMatchObject({ id: 'received:t1', type: 'received', direction: 'in', amount: 250, unit: 'GBP', decimals: 2, voucherId: 'v1', merchantId: 'ab'.repeat(32), timestamp: 5 })
  })
})
