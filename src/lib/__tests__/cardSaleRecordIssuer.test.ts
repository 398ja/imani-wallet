/**
 * @vitest-environment jsdom
 */
/**
 * The purchase issuer files each card sale into the stall's ledger (imani-wallet#275, gap D).
 *
 * Pinned end to end against the stall's REAL reader (`src/lib/tillSales.ts`): what this service
 * sends after a mint, unwrapped with the stall's key, files as a verified `issued` row whose
 * merchant record reads "Card" with the pi_ reference, as the S1 manual check did.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'
import type { Event } from 'nostr-tools'

import { discharge, type Obligation, type Ports } from '../../../services/purchase-issuer/discharge'
import { NOSTR_EVENTS_PATH, resendSaleRecords, sendSaleRecord, type CardSale } from '../../../services/purchase-issuer/saleRecord'
import { STALL, STALL_SK, delegatedCredential, ninetyDayTerm } from '../../../services/purchase-issuer/__tests__/stallFixture'
import { collectTillSales, saleRowsFromRumor } from '../tillSales'
import { unwrapSealed } from '../terminalDelivery'
import { issuedVoucher } from '../issuedVoucher'
import { toTransaction } from '../transactions'
import type { TransactionRow } from '@imani/wallet-storage'

const CREDENTIAL = delegatedCredential()
const REF = 'pi_3UQtS1card'

const OBLIGATION: Obligation = {
  id: 'evt_s1',
  paymentRequestId: '0123456789abcdef0123456789abcdef',
  stallPubkey: STALL,
  faceValue: 500,
  faceUnit: 'GBP',
  faceDecimals: 2,
  memo: 'Test Stall S1 Gift Card',
  recipient: { kind: 'pubkey', pubkey: 'c'.repeat(64) },
  attempts: 0,
  processorReference: REF,
}

const NOW = 1_790_000_000_000

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}

/** The wrap posted to the gateway's event cache, rebuilt as a nostr event. */
function postedWrap(init: RequestInit): Event {
  const b = JSON.parse(String(init.body)) as Record<string, unknown>
  return { ...b, created_at: b.createdAt } as unknown as Event
}

describe('a discharge files the card sale into the stall ledger', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('after the mint, sends a record the stall files as a verified Card sale with its pi_', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(201, { voucher_id: '8027e345', issuer_id: STALL, token: 'cashuB1' }))
      .mockResolvedValueOnce(reply(200, { event_id: 'e1', fulfilment_recorded: true }))
    vi.stubGlobal('fetch', fetchMock)
    const sent: Array<{ sale: CardSale }> = []
    const sink = vi.fn()
    const ports: Ports = {
      validityFor: ninetyDayTerm,
      credentialFor: async () => CREDENTIAL,
      tokenFor: async () => '',
      now: () => NOW,
      sleep: async () => {},
      fileSale: async (credential, sale) => {
        sent.push({ sale })
        return sendSaleRecord('http://gw', credential, sale, sink.mockResolvedValue(new Response('{}')), NOW)
      },
    }

    const outcome = await discharge('http://gw', OBLIGATION, ports)
    expect(outcome.kind).toBe('discharged')
    expect(sent).toHaveLength(1)
    expect(sink).toHaveBeenCalledTimes(1)
    const [url, init] = sink.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`http://gw${NOSTR_EVENTS_PATH}`)
    expect(String((init.headers as Record<string, string>).Authorization)).toMatch(/^Nostr /)

    const opened = unwrapSealed(postedWrap(init), hexToBytes(STALL_SK))!
    const read = saleRowsFromRumor(opened.rumor, opened.sealer, STALL)!
    expect(read.refused).toEqual([])
    const tx = toTransaction(read.rows[0])
    expect(tx.id).toBe('issued:8027e345')
    const record = issuedVoucher([tx], '8027e345', { now: NOW + 1000, stallPubkey: STALL })
    expect(record?.rail).toEqual({ kind: 'card', reference: REF })
    expect(record?.warrantVerdict).toEqual({ verdict: 'verified' })
  })

  it('files the sale even when delivery fails: the coupon exists, it is the stall\u2019s sale', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(reply(201, { voucher_id: 'v2', issuer_id: STALL, token: 'cashuB2' }))
        .mockResolvedValueOnce(reply(500, { error: 'down' })),
    )
    const fileSale = vi.fn().mockResolvedValue(true)
    const outcome = await discharge('http://gw', OBLIGATION, {
      validityFor: ninetyDayTerm,
      credentialFor: async () => CREDENTIAL,
      tokenFor: async () => '',
      now: () => NOW,
      sleep: async () => {},
      fileSale,
    })
    expect(outcome.kind).toBe('undelivered')
    expect(fileSale).toHaveBeenCalledTimes(1)
  })

  it('a failing or throwing record never changes the outcome', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(reply(201, { voucher_id: 'v3', issuer_id: STALL, token: 'cashuB3' }))
        .mockResolvedValueOnce(reply(200, { event_id: 'e3', fulfilment_recorded: true })),
    )
    const outcome = await discharge('http://gw', OBLIGATION, {
      validityFor: ninetyDayTerm,
      credentialFor: async () => CREDENTIAL,
      tokenFor: async () => '',
      now: () => NOW,
      sleep: async () => {},
      fileSale: async () => {
        throw new Error('boom')
      },
    })
    expect(outcome.kind).toBe('discharged')
  })

  it('a port that throws SYNCHRONOUSLY never changes the outcome either (review of #278)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(reply(201, { voucher_id: 'v4', issuer_id: STALL, token: 'cashuB4' }))
        .mockResolvedValueOnce(reply(200, { event_id: 'e4', fulfilment_recorded: true })),
    )
    const outcome = await discharge('http://gw', OBLIGATION, {
      validityFor: ninetyDayTerm,
      credentialFor: async () => CREDENTIAL,
      tokenFor: async () => '',
      now: () => NOW,
      sleep: async () => {},
      fileSale: (() => {
        throw new Error('sync boom')
      }) as unknown as Ports['fileSale'],
    })
    expect(outcome.kind).toBe('discharged')
  })

  it('the filed record carries the coupon expiry, so the merchant record does not read "No expiry"', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(reply(201, { voucher_id: 'v5', issuer_id: STALL, token: 'cashuB5' }))
        .mockResolvedValueOnce(reply(200, { event_id: 'e5', fulfilment_recorded: true })),
    )
    const sink = vi.fn().mockResolvedValue(new Response('{}'))
    await discharge('http://gw', OBLIGATION, {
      validityFor: ninetyDayTerm,
      credentialFor: async () => CREDENTIAL,
      tokenFor: async () => '',
      now: () => NOW,
      sleep: async () => {},
      fileSale: (credential, sale) => sendSaleRecord('http://gw', credential, sale, sink, NOW),
    })
    const [, init] = sink.mock.calls[0] as [string, RequestInit]
    const opened = unwrapSealed(postedWrap(init), hexToBytes(STALL_SK))!
    const tx = toTransaction(saleRowsFromRumor(opened.rumor, opened.sealer, STALL)!.rows[0])
    // The stall's own 90 days from the mint (#312), in ms on the row.
    expect(tx.expiresAt).toBe((Math.floor(NOW / 1000) + 90 * 86_400) * 1000)
  })

  it('files nothing when nothing was minted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(400, { error: 'bad' })))
    const fileSale = vi.fn()
    await discharge('http://gw', OBLIGATION, {
      validityFor: ninetyDayTerm,
      credentialFor: async () => CREDENTIAL,
      tokenFor: async () => '',
      now: () => NOW,
      sleep: async () => {},
      fileSale,
    })
    expect(fileSale).not.toHaveBeenCalled()
  })

  it('sendSaleRecord never throws: a refused or unreachable gateway is false', async () => {
    const sale = { voucherId: 'v', faceValue: 1, faceUnit: 'GBP', faceDecimals: 2, memo: '', at: NOW, issuanceWarrant: '{}' }
    expect(await sendSaleRecord('http://gw', CREDENTIAL, sale, vi.fn().mockResolvedValue(new Response('', { status: 401 })))).toBe(false)
    expect(await sendSaleRecord('http://gw', CREDENTIAL, sale, vi.fn().mockRejectedValue(new Error('down')))).toBe(false)
  })
})

describe('the pull fallback re-sends a missed card sale, and the stall files it once', () => {
  beforeEach(() => localStorage.clear())

  it('two re-sends of the same sale file one row', async () => {
    // Capture the warrant the discharge minted under.
    let sale: CardSale | undefined
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(reply(201, { voucher_id: 'v9', issuer_id: STALL, token: 'cashuB9' }))
        .mockResolvedValueOnce(reply(200, { event_id: 'e9', fulfilment_recorded: true })),
    )
    await discharge('http://gw', OBLIGATION, {
      validityFor: ninetyDayTerm,
      credentialFor: async () => CREDENTIAL,
      tokenFor: async () => '',
      now: () => NOW,
      sleep: async () => {},
      fileSale: async (_c, s) => ((sale = s), false), // the first send was lost
    })

    const posted: Event[] = []
    const gw = vi.fn(async (_u: string, init: RequestInit) => (posted.push(postedWrap(init)), new Response('{}')))
    const result = await resendSaleRecords('http://gw', CREDENTIAL, [sale!, sale!], gw as unknown as typeof fetch)
    expect(result).toEqual({ sent: 2, failed: [] })

    const written = new Map<string, TransactionRow>()
    const filed = await collectTillSales(STALL, {
      wraps: async () => posted,
      open: (w) => unwrapSealed(w, hexToBytes(STALL_SK)),
      has: async (id) => written.has(id),
      write: async (row) => void written.set(row.id as string, row),
      refreshRoster: async () => false,
    })
    expect(filed).toBe(1)
    expect([...written.keys()]).toEqual(['issued:v9'])
  })
})
