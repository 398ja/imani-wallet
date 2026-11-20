/**
 * @vitest-environment jsdom
 */
/**
 * A card sale's customer receipt reaches the stall's record (follow-up to #655/#657).
 *
 * On staging, v0.72.0: the purchase issuer minted card voucher 725e8ba1, the customer redeemed and
 * posted their receipt 12 s later, the stall drained and acknowledged it 16 s after that, and the
 * sale still read "Customer receipt: Not collected". Delivery was right. What went wrong is order:
 * a card sale's `issued:<voucher>` row is not written at the till, it arrives on the stall as the
 * purchase issuer's sealed sale record, filed on the next inbox read. The receipt got there first,
 * `recordCashAttestation` found no row and returned, and the drain acked the receipt anyway, so the
 * attestation was gone from the gateway and from the device.
 *
 * Driven end to end with real parts: the purchase issuer's real discharge and sale record, the
 * stall's real reader (`saleRowsFromRumor`), the customer's real attestation over the coupon's
 * real `delegated` warrant, real NIP-44 from customer to stall, the real drain and the real wallet
 * write-back (storage mocked at the class boundary, as attestationWriteBack.test.ts does).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import { schnorr } from '@noble/curves/secp256k1.js'
import { nip44, type Event } from 'nostr-tools'
import type { TransactionRow } from '@imani/wallet-storage'

import { discharge, type Ports } from '../../../services/purchase-issuer/discharge'
import { sendSaleRecord } from '../../../services/purchase-issuer/saleRecord'
import { STALL, STALL_SK, delegatedCredential, ninetyDayTerm } from '../../../services/purchase-issuer/__tests__/stallFixture'

const rows: TransactionRow[] = []

vi.mock('@imani/wallet-storage', () => ({
  WalletStorage: class {
    async init() {}
    async close() {}
    onChange() {
      return () => {}
    }
    async getAllTransactions() {
      return rows
    }
    async getTransaction(id: string) {
      return rows.find((r) => r.id === id) ?? null
    }
    async updateTransaction(id: string, patch: Record<string, unknown>) {
      const row = rows.find((r) => r.id === id)
      if (!row) return null
      Object.assign(row, patch)
      return row
    }
    async addTransaction(row: TransactionRow) {
      rows.push(row)
      return row
    }
    async atomicallyWrite() {}
    async saveVoucher(row: unknown) {
      return row
    }
    async removeVoucher() {
      return true
    }
    async removeVouchers() {
      return 0
    }
    async clearAndReplaceAllVouchers() {}
    async getAllVouchers() {
      return []
    }
  },
}))
vi.mock('../voucherRecords', () => ({
  publishVoucher: vi.fn().mockResolvedValue(undefined),
  tombstoneVoucher: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../txRecords', async (orig) => ({
  ...(await orig<typeof import('../txRecords')>()),
  publishTx: vi.fn().mockResolvedValue(undefined),
}))

/** The stall's signer, decrypting with its real key. */
vi.mock('../nap', () => ({
  getSigner: () => ({
    pubkey: STALL,
    nip44Decrypt: (counterparty: string, ciphertext: string) =>
      nip44.decrypt(ciphertext, nip44.getConversationKey(hexToBytes(STALL_SK), counterparty)),
  }),
}))
const signedFetch = vi.fn<(path: string, method: string, payload?: unknown) => Promise<Response>>()
vi.mock('../nip98', () => ({
  signedFetch: (...args: Parameters<typeof signedFetch>) => signedFetch(...args),
}))
vi.mock('../notifications/inbox', () => ({ recordNotification: () => true, upsertNotification: () => true }))
vi.mock('../notifications/wants', () => ({ wantsInApp: () => true }))
vi.mock('sonner', () => ({ toast: { success: () => 'id' } }))
/** The inbox read the drain asks for. Its network half is not under test here. */
const collectTillSalesForOwner = vi.fn(async () => 0)
vi.mock('../tillSalesNet', () => ({ collectTillSalesForOwner: () => collectTillSalesForOwner() }))

const { openWallet, getWallet } = await import('../wallet')
const { runReceiptDrainTick, startPaymentReceipts, stopPaymentReceipts } = await import('../paymentReceiptDrain')
const { pendingAttestations } = await import('../pendingAttestations')
const { saleRowsFromRumor } = await import('../tillSales')
const { unwrapSealed } = await import('../terminalDelivery')
const { attestationForReceivedCoupon } = await import('../cashAttestation')
const { issuedVoucher } = await import('../issuedVoucher')
const { toTransaction } = await import('../transactions')

const VOUCHER = '725e8ba1-5c5b-4e09-9aaf-45c65934f65f'
const NOW = 1_790_000_000_000
const CUSTOMER_SK = hexToBytes('3'.repeat(63) + '7')
const CUSTOMER = bytesToHex(schnorr.getPublicKey(CUSTOMER_SK))

/** What the purchase issuer sends the stall for one card sale, filed by the stall's own reader. */
async function cardSaleRow(): Promise<TransactionRow> {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ voucher_id: VOUCHER, issuer_id: STALL, token: 'cashuB1' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ event_id: 'e1', fulfilment_recorded: true }), { status: 200 })),
  )
  const sink = vi.fn().mockResolvedValue(new Response('{}'))
  const ports: Ports = {
    validityFor: ninetyDayTerm,
    credentialFor: async () => delegatedCredential(),
    tokenFor: async () => '',
    now: () => NOW,
    sleep: async () => {},
    fileSale: (credential, sale) => sendSaleRecord('http://gw', credential, sale, sink, NOW),
  }
  await discharge(
    'http://gw',
    {
      id: 'evt',
      paymentRequestId: '0123456789abcdef0123456789abcdef',
      stallPubkey: STALL,
      faceValue: 500,
      faceUnit: 'GBP',
      faceDecimals: 2,
      memo: 'Card sale',
      recipient: { kind: 'pubkey', pubkey: CUSTOMER },
      attempts: 0,
      processorReference: 'pi_card',
    },
    ports,
  )
  vi.unstubAllGlobals()
  const body = JSON.parse(String((sink.mock.calls[0][1] as RequestInit).body))
  const opened = unwrapSealed({ ...body, created_at: body.createdAt } as Event, hexToBytes(STALL_SK))!
  const read = saleRowsFromRumor(opened.rumor, opened.sealer, STALL)!
  expect(read.refused).toEqual([])
  return read.rows[0]
}

/** The customer's receipt as the stall's drain receives it: encrypted customer -> stall. */
function customerReceipt(row: TransactionRow) {
  const warrant = (row as unknown as { issuanceWarrant: string }).issuanceWarrant
  const attestation = attestationForReceivedCoupon(warrant, STALL, CUSTOMER, (d) => bytesToHex(schnorr.sign(d, CUSTOMER_SK)))!
  const payload = { v: 1, voucherId: VOUCHER, faceValue: 500, faceUnit: 'GBP', faceDecimals: 2, redeemedAt: 1, cashAttestation: attestation }
  return {
    receiptId: 'r-card',
    recipientPubkeyHex: CUSTOMER,
    ciphertextBase64: nip44.encrypt(JSON.stringify(payload), nip44.getConversationKey(CUSTOMER_SK, STALL)),
    consumeToken: 'tok-card',
    enqueuedAt: 1,
  }
}

function gateway(queue: unknown[]) {
  const acked: string[][] = []
  signedFetch.mockImplementation(async (path, _m, payload) => {
    if (path.endsWith('/ack')) {
      const tokens = (payload as { consumeTokens: string[] }).consumeTokens
      acked.push(tokens)
      return new Response(JSON.stringify({ acknowledged: tokens.length, ignored: 0 }), { status: 200 })
    }
    const receipts = queue.splice(0)
    return new Response(JSON.stringify({ receipts, nonce: 'n', moreAvailable: false }), { status: 200 })
  })
  return { acked }
}

function verdictOnRecord() {
  const txs = rows.map((r) => toTransaction(r))
  return issuedVoucher(txs, VOUCHER, { now: NOW + 1000, stallPubkey: STALL })?.attestationVerdict
}

describe('a card sale collects its customer receipt (follow-up to #655/#657)', () => {
  beforeEach(async () => {
    rows.length = 0
    localStorage.clear()
    signedFetch.mockReset()
    collectTillSalesForOwner.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await openWallet(`stall-${Math.random()}`)
    stopPaymentReceipts()
  })
  afterEach(() => {
    stopPaymentReceipts()
    vi.restoreAllMocks()
  })

  it('the staging order: receipt drained and acked BEFORE the sale record is filed, still collected', async () => {
    const row = await cardSaleRow()
    const gw = gateway([customerReceipt(row)])

    // 18:41:52: the drain returns the receipt. The sale row is not on this device yet.
    startPaymentReceipts(STALL)
    await vi.waitFor(() => expect(gw.acked).toEqual([['tok-card']]))
    // The receipt is gone from the gateway, so the attestation must be kept here...
    await vi.waitFor(() => expect(pendingAttestations(STALL)).toHaveLength(1))
    // ...and the inbox read for the missing sale record asked for.
    await vi.waitFor(() => expect(collectTillSalesForOwner).toHaveBeenCalled())
    expect(verdictOnRecord()).toBeUndefined()

    // The purchase issuer's sale record is filed (inbox read, or the login pull).
    await getWallet().addTransaction(row)
    expect(verdictOnRecord()).toEqual({ verdict: 'none' }) // "Not collected", the reported screen

    // The next drain pass, with nothing new on the queue, files the kept attestation.
    await runReceiptDrainTick()
    expect(verdictOnRecord()).toEqual({ verdict: 'attested' }) // "Customer signed for it"
    expect(pendingAttestations(STALL)).toEqual([])
  })

  it('a cash-style order (row already there) files at once and keeps nothing', async () => {
    const row = await cardSaleRow()
    await getWallet().addTransaction(row)
    const gw = gateway([customerReceipt(row)])

    startPaymentReceipts(STALL)
    await vi.waitFor(() => expect(gw.acked).toHaveLength(1))
    await vi.waitFor(() => expect(verdictOnRecord()).toEqual({ verdict: 'attested' }))
    await vi.waitFor(() => expect(pendingAttestations(STALL)).toEqual([]))
    expect(collectTillSalesForOwner).not.toHaveBeenCalled()
  })

  it('a junk attestation for the same voucher neither files nor evicts the genuine one', async () => {
    const row = await cardSaleRow()
    const genuine = customerReceipt(row)
    const junkPayload = { v: 1, voucherId: VOUCHER, redeemedAt: 1, cashAttestation: '{"junk":true}' }
    const ATTACKER_SK = hexToBytes('2'.repeat(63) + '8')
    const junk = {
      receiptId: 'r-junk',
      recipientPubkeyHex: bytesToHex(schnorr.getPublicKey(ATTACKER_SK)),
      ciphertextBase64: nip44.encrypt(JSON.stringify(junkPayload), nip44.getConversationKey(ATTACKER_SK, STALL)),
      consumeToken: 'tok-junk',
      enqueuedAt: 1,
    }
    const gw = gateway([junk, genuine])

    startPaymentReceipts(STALL)
    await vi.waitFor(() => expect(gw.acked).toHaveLength(1))
    await vi.waitFor(() => expect(pendingAttestations(STALL)).toHaveLength(2))

    await getWallet().addTransaction(row)
    await runReceiptDrainTick()
    expect(verdictOnRecord()).toEqual({ verdict: 'attested' })
    expect(pendingAttestations(STALL)).toEqual([])
  })
})
