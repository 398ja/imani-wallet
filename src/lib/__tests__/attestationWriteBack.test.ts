import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransactionRow } from '@imani/wallet-storage'

/**
 * DEV-246's write-back, and the mapping that carries it to the screen.
 *
 * These are the surfaces the original DEV-246 tests never reached. That work
 * asserted `attestation.ts` thoroughly and stopped at the module being edited,
 * so the integration boundary between attestation and STORAGE — the two
 * functions that actually put a receipt on a row — had no coverage at all, and
 * neither did the `toTransaction` mapping that feeds `TransactionPage`. A
 * receipt that is computed correctly and never lands is invisible to every
 * test that stops at the producer.
 *
 * `recordAttestationReceipt` and `recordReceiptByNullifier` are the real
 * exported functions here, driven through the real `openWallet` with
 * `WalletStorage` mocked at the class boundary — the same seam
 * `backUpWrites.test.ts` uses, because the root has no `fake-indexeddb` and the
 * genuine store needs one.
 */

const rows: TransactionRow[] = []
/** Patches applied by `updateTransaction`, in order, for exact assertions. */
const patches: { id: string; patch: Record<string, unknown> }[] = []
let updateThrows = false
let broadcasts = 0

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
      if (updateThrows) throw new Error('IndexedDB is gone')
      const row = rows.find((r) => r.id === id)
      // The real store returns null for an unknown id rather than creating one.
      if (!row) return null
      patches.push({ id, patch })
      Object.assign(row, patch)
      return row
    }
    // Unused by these paths, but `backUpWrites` wraps them on open.
    async addTransaction(row: TransactionRow) {
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
vi.mock('../txRecords', () => ({ publishTx: vi.fn().mockResolvedValue(undefined) }))

const {
  openWallet,
  recordAttestationReceipt,
  recordReceiptByNullifier,
  onWalletChanged,
  getTransactionRow,
} = await import('../wallet')
const { toTransaction } = await import('../transactions')

const NULLIFIER = 'a'.repeat(64)
const EVENT_ID = 'e'.repeat(64)
const AT = 1_788_000_000_000

function row(overrides: Record<string, unknown> = {}): TransactionRow {
  return {
    id: 'received:tok-1',
    type: 'received',
    timestamp: 1_787_000_000_000,
    amount: 2500,
    unit: 'XAF',
    decimals: 0,
    voucherId: 'v-1',
    attestationNullifier: NULLIFIER,
    ...overrides,
  } as unknown as TransactionRow
}

beforeEach(async () => {
  rows.length = 0
  patches.length = 0
  updateThrows = false
  broadcasts = 0
  await openWallet(`user-${Math.random()}`)
})

describe('the receipt reaches the row', () => {
  it('writes exactly the three receipt fields and nothing else', async () => {
    rows.push(row({ memo: 'keep me', amount: 2500 }))

    await recordAttestationReceipt('received:tok-1', {
      nullifier: NULLIFIER,
      eventId: EVENT_ID,
      at: AT,
    })

    // A PATCH, not a rewrite. `updateTransaction` merges, so anything extra
    // here would silently clobber a field the redemption path wrote.
    expect(patches).toEqual([
      {
        id: 'received:tok-1',
        patch: {
          attestationNullifier: NULLIFIER,
          attestationEventId: EVENT_ID,
          attestationAt: AT,
        },
      },
    ])
    // And the untouched fields survive.
    expect(rows[0]).toMatchObject({ memo: 'keep me', amount: 2500, voucherId: 'v-1' })
  })

  it('notifies listeners, so a detail screen open on the row updates', async () => {
    // The write is made by THIS tab, and BroadcastChannel never echoes to the
    // context that posted — see notifyWalletChanged. Without this the receipt
    // appears only on the next navigation, which reads as it not being saved.
    rows.push(row())
    const stop = onWalletChanged(() => {
      broadcasts++
    })
    await recordAttestationReceipt('received:tok-1', {
      nullifier: NULLIFIER,
      eventId: EVENT_ID,
      at: AT,
    })
    stop()
    expect(broadcasts).toBe(1)
  })

  it('never throws when the store fails', async () => {
    // The redemption is complete and the money has moved. Failing to record
    // WHERE it was published must not surface as a failed redemption.
    rows.push(row())
    updateThrows = true
    await expect(
      recordAttestationReceipt('received:tok-1', {
        nullifier: NULLIFIER,
        eventId: EVENT_ID,
        at: AT,
      }),
    ).resolves.toBeUndefined()
  })

  it('is a no-op for a row that is gone', async () => {
    // The sweep reads a snapshot, so a row can vanish before its receipt is
    // written. Not an error, and it must not invent a row.
    await recordAttestationReceipt('received:missing', {
      nullifier: NULLIFIER,
      eventId: EVENT_ID,
      at: AT,
    })
    expect(rows).toHaveLength(0)
    expect(patches).toHaveLength(0)
  })
})

describe('finding the row by nullifier (dmPoll has no row id)', () => {
  it('stamps the row carrying that nullifier', async () => {
    rows.push(row({ id: 'received:other', attestationNullifier: 'b'.repeat(64) }))
    rows.push(row({ id: 'received:target', attestationNullifier: NULLIFIER }))

    await recordReceiptByNullifier({ nullifier: NULLIFIER, eventId: EVENT_ID, at: AT })

    expect(patches.map((p) => p.id)).toEqual(['received:target'])
  })

  it('stamps NO row when the nullifier matches none', async () => {
    // A redemption written by a path that does not carry the correlation stamp
    // has nowhere to put the receipt. Silence is the honest outcome; stamping
    // an arbitrary row would attribute a public record to the wrong redemption.
    rows.push(row({ attestationNullifier: 'b'.repeat(64) }))
    await recordReceiptByNullifier({ nullifier: NULLIFIER, eventId: EVENT_ID, at: AT })
    expect(patches).toHaveLength(0)
  })

  it('does not confuse two redemptions of similar rows', async () => {
    // Same voucher, same amount, different tokens — the ordinary partial
    // redemption case. Only the nullifier distinguishes them.
    const n2 = 'c'.repeat(64)
    rows.push(row({ id: 'received:part-1', attestationNullifier: NULLIFIER }))
    rows.push(row({ id: 'received:part-2', attestationNullifier: n2 }))

    await recordReceiptByNullifier({ nullifier: n2, eventId: EVENT_ID, at: AT })

    expect(patches.map((p) => p.id)).toEqual(['received:part-2'])
    expect(rows.find((r) => r.id === 'received:part-1')).not.toHaveProperty('attestationEventId')
  })
})

describe('what the screen reads back', () => {
  it('carries the receipt through the store to the mapped transaction', async () => {
    // The whole chain: publish-time receipt -> write-back -> stored row ->
    // toTransaction -> the fields TransactionPage renders. Asserted end to end
    // because each hop was written separately and only the last one is visible.
    rows.push(row())
    await recordAttestationReceipt('received:tok-1', {
      nullifier: NULLIFIER,
      eventId: EVENT_ID,
      at: AT,
    })

    const stored = await getTransactionRow('received:tok-1')
    const tx = toTransaction(stored!)

    expect(tx.attestationEventId).toBe(EVENT_ID)
    expect(tx.attestationAt).toBe(AT)
    expect(tx.attestationNullifier).toBe(NULLIFIER)
  })

  it('reads NO receipt on a row that only has a nullifier', async () => {
    // The trap the card named. Every redemption stamps a nullifier, so a UI
    // keyed on it would read "published" on plain ecash and on every customer
    // row. `TransactionPage` gates on attestationEventId, which must be
    // undefined here.
    rows.push(row())
    const tx = toTransaction((await getTransactionRow('received:tok-1'))!)
    expect(tx.attestationNullifier).toBe(NULLIFIER)
    expect(tx.attestationEventId).toBeUndefined()
    expect(tx.attestationAt).toBeUndefined()
  })

  it('normalises a receipt date stored in seconds', async () => {
    // `attestationAt` is written in milliseconds, but a row round-tripped
    // through a relay record could carry seconds. Dating a receipt to 1970
    // reads as data loss, so toTransaction discriminates by magnitude.
    rows.push(row({ attestationEventId: EVENT_ID, attestationAt: 1_788_000_000 }))
    const tx = toTransaction((await getTransactionRow('received:tok-1'))!)
    expect(tx.attestationAt).toBe(1_788_000_000_000)
  })
})
