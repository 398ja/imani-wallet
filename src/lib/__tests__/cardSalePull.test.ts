/**
 * @vitest-environment jsdom
 */
/**
 * The pull on login (imani-wallet#275 item 3, residual R1), end to end against the real pieces:
 * payment-adapter's stall list (faked by URL) feeds the purchase issuer's resend (`salePull.ts`),
 * whose rebuilt record is unwrapped with the stall's key and filed by the stall's REAL reader
 * (`collectTillSales`), and the wallet's `pullCardSales` drives it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'
import type { Event } from 'nostr-tools'
import type { TransactionRow } from '@imani/wallet-storage'

import {
  fetchStallPurchases,
  parseStallPurchase,
  rebuildSale,
  resendStallSales,
  type ResendDeps,
} from '../../../services/purchase-issuer/salePull'
import { delegatedWarrant, purchaseNonce } from '../../../services/purchase-issuer/delegatedWarrant'
import { STALL, STALL_SK, delegatedCredential, delegationJson } from '../../../services/purchase-issuer/__tests__/stallFixture'
import { NOSTR_EVENTS_PATH } from '../../../services/purchase-issuer/saleRecord'
import { collectTillSales } from '../tillSales'
import { unwrapSealed } from '../terminalDelivery'
import { toTransaction } from '../transactions'
import { issuedVoucher } from '../issuedVoucher'
import { MAX_RESEND, SALE_TIME_TOLERANCE_MS, parseStallCardSale, pullCardSales, type PullDeps } from '../cardSalePull'

const CREDENTIAL = delegatedCredential()
const PAID_AT = '2026-11-01T10:00:00Z'
const PAID_MS = Date.parse(PAID_AT)

function listed(over: Record<string, unknown> = {}) {
  return {
    voucher_id: '8027e345',
    ref: 'pi_3UQtS1card',
    amount_minor: 650,
    currency: 'gbp',
    livemode: false,
    status: 'DISCHARGED',
    payment: 'PAID',
    paid_at: PAID_AT,
    ...over,
  }
}

/** payment-adapter's list and the gateway's event cache, by URL. */
function services(list: unknown[] | number) {
  const posted: Event[] = []
  const calls: Array<{ url: string; auth: string }> = []
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const auth = String((init.headers as Record<string, string>)?.Authorization ?? '')
    calls.push({ url, auth })
    if (url.startsWith('http://pa/api/v1/purchases?stall=')) {
      return typeof list === 'number' ? new Response('{}', { status: list }) : new Response(JSON.stringify(list))
    }
    if (url === `http://gw${NOSTR_EVENTS_PATH}`) {
      const b = JSON.parse(String(init.body)) as Record<string, unknown>
      posted.push({ ...b, created_at: b.createdAt } as unknown as Event)
      return new Response('{}', { status: 201 })
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  const deps: ResendDeps = {
    purchasesUrl: 'http://pa',
    purchasesToken: 'issuer-token',
    gatewayUrl: 'http://gw',
    livemode: false,
    credentialFor: async (s) => (s === STALL ? CREDENTIAL : null),
    fetchImpl,
  }
  return { posted, calls, deps }
}

/** A wallet: rows by id, and the stall's inbox the issuer posts into. */
function wallet(inbox: Event[]) {
  const rows = new Map<string, TransactionRow>()
  const collect = (stall: string) =>
    collectTillSales(stall, {
      wraps: async () => inbox,
      open: (wrap) => unwrapSealed(wrap, hexToBytes(STALL_SK)),
      has: async (id) => rows.has(id),
      write: async (row) => void rows.set(String((row as unknown as { id: string }).id), row),
    })
  return { rows, collect }
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('the issuer rebuilds a missed sale record from payment-adapter (salePull)', () => {
  it('reads the list with the issuer token, and the rebuilt warrant is byte-identical to the minted one', async () => {
    const { calls, deps } = services([listed()])
    const sales = await fetchStallPurchases(deps.purchasesUrl, deps.purchasesToken, STALL, deps.fetchImpl)
    expect(calls[0]).toEqual({ url: `http://pa/api/v1/purchases?stall=${STALL}`, auth: 'Bearer issuer-token' })
    expect(sales).toHaveLength(1)

    const sale = rebuildSale(CREDENTIAL, sales![0])!
    const minted = delegatedWarrant({
      paymentIntent: 'pi_3UQtS1card',
      issuerId: STALL,
      saleTotalMinor: 650,
      faceDecimals: 2,
      unit: 'GBP',
      reference: 'pi_3UQtS1card',
      lockKeyHex: CREDENTIAL.lockKeyHex,
      delegation: JSON.parse(CREDENTIAL.delegation),
    })
    expect(sale.issuanceWarrant).toBe(minted)
    expect(JSON.parse(sale.issuanceWarrant).nonce).toBe(purchaseNonce('pi_3UQtS1card'))
    expect(sale.at).toBe(PAID_MS)
  })

  it('a restored stall files the missed sale, dated by the payment, as a verified Card sale', async () => {
    const { posted, deps } = services([listed()])
    const w = wallet(posted)

    const result = await pullCardSales(STALL, {
      listSales: async () => [parseStallCardSale(listed())!],
      requestResend: async (ids) => (await resendStallSales(deps, STALL, ids)).kind === 'sent',
      collect: w.collect,
      getRow: async (id) => w.rows.get(id) ?? null,
      patchRow: async () => {},
    })

    expect(result).toMatchObject({ listed: 1, missing: 1, requested: true, filed: 1 })
    const tx = toTransaction(w.rows.get('issued:8027e345')!)
    expect(tx.at).toBe(PAID_MS)
    const record = issuedVoucher([tx], '8027e345', { now: PAID_MS + 1000, stallPubkey: STALL })
    expect(record?.rail).toEqual({ kind: 'card', reference: 'pi_3UQtS1card' })
    expect(record?.warrantVerdict).toEqual({ verdict: 'verified' })

    // Pulling again files nothing: the row is there.
    const again = await pullCardSales(STALL, {
      listSales: async () => [parseStallCardSale(listed())!],
      requestResend: async () => {
        throw new Error('must not be asked')
      },
      collect: w.collect,
      getRow: async (id) => w.rows.get(id) ?? null,
      patchRow: async () => {},
    })
    expect(again).toMatchObject({ missing: 0, requested: false, filed: 0 })
  })

  it('the wallet names a filter, never the sale: an id payment-adapter does not list is sent nothing', async () => {
    const { posted, deps } = services([listed()])
    const result = await resendStallSales(deps, STALL, ['8027e345', 'forged-id'])
    expect(result).toEqual({ kind: 'sent', sent: 1, failed: [], unknown: ['forged-id'] })
    expect(posted).toHaveLength(1)
  })

  it('never describes a test payment from a live issuer, nor the reverse', async () => {
    const { posted, deps } = services([listed({ livemode: true })])
    expect(await resendStallSales(deps, STALL, [])).toEqual({ kind: 'sent', sent: 0, failed: [], unknown: [] })
    expect(posted).toHaveLength(0)
  })

  it('an outage at payment-adapter is unavailable, not "no sales"; an unenrolled stall is not-enrolled', async () => {
    expect((await resendStallSales(services(503).deps, STALL, [])).kind).toBe('unavailable')
    expect((await resendStallSales(services([]).deps, 'f'.repeat(64), [])).kind).toBe('not-enrolled')
  })

  it('sends nothing under a delegation that names another key', () => {
    const wrong = delegatedCredential({ delegation: delegationJson({ delegate: 'e'.repeat(64) }) })
    expect(rebuildSale(wrong, parseStallPurchase(listed())!)).toBeNull()
  })

  it('drops malformed rows rather than describing them', () => {
    expect(parseStallPurchase(listed({ amount_minor: -1 }))).toBeNull()
    expect(parseStallPurchase(listed({ ref: 'ch_1' }))).toBeNull()
    expect(parseStallPurchase(listed({ voucher_id: '../x' }))).toBeNull()
    expect(parseStallPurchase(listed({ paid_at: 'never' }))).toBeNull()
    expect(parseStallPurchase(listed({ amount_minor: 1.5 }))).toBeNull()
  })
})

describe('pullCardSales (wallet)', () => {
  function deps(over: Partial<PullDeps> & { rows?: Map<string, TransactionRow> } = {}): PullDeps & { patched: unknown[] } {
    const rows = over.rows ?? new Map()
    const patched: unknown[] = []
    return {
      listSales: async () => [parseStallCardSale(listed())!],
      requestResend: async () => true,
      collect: async () => 0,
      getRow: async (id) => rows.get(id) ?? null,
      patchRow: async (id, patch) => void patched.push({ id, patch }),
      ...over,
      patched,
    }
  }

  function cardRow(timestampSeconds: number, ref = 'pi_3UQtS1card'): TransactionRow {
    const warrant = delegatedWarrant({
      paymentIntent: ref,
      issuerId: STALL,
      saleTotalMinor: 650,
      faceDecimals: 2,
      unit: 'GBP',
      reference: ref,
      lockKeyHex: CREDENTIAL.lockKeyHex,
      delegation: JSON.parse(CREDENTIAL.delegation),
    })
    return {
      id: 'issued:8027e345',
      type: 'issued',
      timestamp: timestampSeconds,
      issuanceWarrant: warrant,
    } as unknown as TransactionRow
  }

  it('asks for at most MAX_RESEND missing records per login', async () => {
    const many = Array.from({ length: MAX_RESEND + 7 }, (_, i) => parseStallCardSale(listed({ voucher_id: `v-${i}` }))!)
    const asked: string[][] = []
    const d = deps({ listSales: async () => many, requestResend: async (ids) => (asked.push(ids), true) })
    const result = await pullCardSales(STALL, d)
    expect(result.missing).toBe(MAX_RESEND + 7)
    expect(asked[0]).toHaveLength(MAX_RESEND)
  })

  it('does nothing when the list cannot be read, and never throws', async () => {
    const asked = vi.fn()
    expect(await pullCardSales(STALL, deps({ listSales: async () => undefined, requestResend: asked }))).toMatchObject({ listed: 0 })
    expect(asked).not.toHaveBeenCalled()
    const boom = deps({ listSales: async () => { throw new Error('down') } })
    await expect(pullCardSales(STALL, boom)).resolves.toMatchObject({ listed: 0 })
  })

  it('does not collect when the issuer could not be asked', async () => {
    const collect = vi.fn(async () => 0)
    const r = await pullCardSales(STALL, deps({ requestResend: async () => false, collect }))
    expect(r.requested).toBe(false)
    expect(collect).not.toHaveBeenCalled()
  })

  it('R1: a card row dated far from the recorded payment is re-dated to it, the sender time kept', async () => {
    const off = Math.floor((PAID_MS + 3 * 86_400_000) / 1000)
    const d = deps({ rows: new Map([['issued:8027e345', cardRow(off)]]) })
    const r = await pullCardSales(STALL, d)
    expect(r.redated).toBe(1)
    expect(d.patched).toEqual([
      {
        id: 'issued:8027e345',
        patch: { timestamp: Math.floor(PAID_MS / 1000), senderSaleAt: off * 1000, saleTimeSource: 'payment-adapter' },
      },
    ])
  })

  it('R1: a row within the tolerance, or carrying another pi_, is left alone', async () => {
    const near = Math.floor((PAID_MS + SALE_TIME_TOLERANCE_MS - 60_000) / 1000)
    const d1 = deps({ rows: new Map([['issued:8027e345', cardRow(near)]]) })
    expect((await pullCardSales(STALL, d1)).redated).toBe(0)
    const d2 = deps({ rows: new Map([['issued:8027e345', cardRow(1, 'pi_other')]]) })
    expect((await pullCardSales(STALL, d2)).redated).toBe(0)
    expect([...d1.patched, ...d2.patched]).toEqual([])
  })
})
