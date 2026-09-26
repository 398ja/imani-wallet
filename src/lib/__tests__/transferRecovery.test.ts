import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event } from 'nostr-tools'
import type { TransactionRow } from '@imani/wallet-storage'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

/**
 * ADR 0014's recovery and disclosure claims, end to end (#91 review, D3).
 *
 * The receipt can be found, opened and disclosed only by someone holding the
 * nonce. These pin where each party keeps it, and that it survives what a
 * wiped device goes through: the relay backup (`toContent`, NIP-44 sealed to
 * self) and the restore (`toRow`).
 *
 * - Receiver: the payload is filed on the `received` row found by the
 *   `transferId` stamped during the redemption, and re-published to the backup.
 * - Sender: nothing is filed. The `sent` row keeps `transferId`, and the
 *   nonce is recomputed from the sender's key.
 */

const SENDER_SK = hexToBytes('1'.repeat(64))
const RECEIVER_SK = hexToBytes('2'.repeat(64))
const RECEIVER = bytesToHex(schnorr.getPublicKey(RECEIVER_SK))

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

const backedUp: TransactionRow[] = []
vi.mock('../txRecords', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  publishTx: async (row: TransactionRow) => {
    backedUp.push({ ...row })
  },
}))
vi.mock('../voucherRecords', () => ({
  publishVoucher: async () => {},
  tombstoneVoucher: async () => {},
}))

const { openWallet, recordTransferSignature } = await import('../wallet')
const { toContent, toRow } = await import('../txRecords')
const { toTransaction, buildSentTransaction } = await import('../transactions')
const { signTransfer, parseTransferSignature, openTransferReceipt, buildTransferReceipt, transferSecretFor, transferTag, transferIdFor } =
  await import('../transferSignature')

const TOKEN = 'cashuB-the-gift'
const TRANSFER = transferIdFor(TOKEN)
const PARAMS = { transfer: TRANSFER, recipient: RECEIVER, amount: 250, unit: 'EUR', decimals: 2 }

/** Through the relay backup and back, as a wiped device restores it. */
const viaRelay = (row: TransactionRow) => toTransaction(toRow(row.id!, toContent(toTransaction(row))))

/** The receipt the receiver published, as a relay would hand it back. */
function receiptFor(payload: ReturnType<typeof signTransfer>): Event {
  const tag = transferTag(payload.transfer, payload.nonce)
  return buildTransferReceipt(payload, transferSecretFor(RECEIVER_SK, 'receiver', tag, payload.nonce), true)
}

beforeEach(async () => {
  rows.length = 0
  backedUp.length = 0
  await openWallet(`user-${Math.random()}`)
})

describe('the receiver keeps the nonce', () => {
  it('files the payload on the received row by transfer id, backs it up, and it survives a restore', async () => {
    rows.push({
      id: 'received:after-swap',
      type: 'received',
      amount: 250,
      unit: 'EUR',
      decimals: 2,
      timestamp: 1_788_000_000_000,
      transferId: TRANSFER,
    } as unknown as TransactionRow)
    const payload = signTransfer(SENDER_SK, PARAMS)

    await recordTransferSignature(TRANSFER, JSON.stringify(payload))

    expect(backedUp).toHaveLength(1)
    const restored = viaRelay(backedUp[0]!)
    expect(restored.transferId).toBe(TRANSFER)
    const kept = parseTransferSignature(restored.transferSignature!)!
    expect(openTransferReceipt(receiptFor(payload), kept)).toEqual({
      ok: true, amount: 250, unit: 'EUR', decimals: 2,
    })
  })

  it('keeps the first payload filed, never a later one', async () => {
    rows.push({ id: 'received:x', type: 'received', transferId: TRANSFER } as unknown as TransactionRow)
    const first = JSON.stringify(signTransfer(SENDER_SK, PARAMS))
    await recordTransferSignature(TRANSFER, first)
    await recordTransferSignature(TRANSFER, JSON.stringify(signTransfer(SENDER_SK, { ...PARAMS, amount: 1 })))
    expect((rows[0] as unknown as { transferSignature: string }).transferSignature).toBe(first)
  })

  it('does nothing, and never throws, when no row carries the transfer id', async () => {
    await expect(recordTransferSignature(TRANSFER, '{}')).resolves.toBeUndefined()
    expect(backedUp).toHaveLength(0)
  })
})

describe('the sender needs only its key and the sent row', () => {
  it('rebuilds a payload that opens the receipt, after the row went through the relay', () => {
    const original = signTransfer(SENDER_SK, PARAMS)
    const receipt = receiptFor(original)

    const sent = buildSentTransaction({
      tokenId: 'spent-coupon',
      amount: 250,
      unit: 'EUR',
      decimals: 2,
      merchantId: 'f'.repeat(64),
      recipientPubkey: RECEIVER,
      transferId: TRANSFER,
      at: 1_788_000_000_000,
    })
    const restored = viaRelay(sent)
    expect(restored.transferId).toBe(TRANSFER)

    // The device is wiped: all that is left is the key and the restored row.
    const rebuilt = signTransfer(SENDER_SK, {
      transfer: restored.transferId!,
      recipient: restored.counterparty!,
      amount: restored.amount,
      unit: restored.unit,
      decimals: restored.decimals,
    })
    expect(rebuilt.nonce).toBe(original.nonce)
    expect(openTransferReceipt(receipt, rebuilt)).toEqual({ ok: true, amount: 250, unit: 'EUR', decimals: 2 })
  })

  it('leaves a sent row with no transfer id (an older gateway) without one', () => {
    const sent = buildSentTransaction({
      tokenId: 't', amount: 1, unit: 'EUR', decimals: 2, merchantId: 'f'.repeat(64),
      recipientPubkey: RECEIVER, at: 1,
    })
    expect(viaRelay(sent).transferId).toBeUndefined()
  })
})
