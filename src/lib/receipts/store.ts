import {
  bytesToHex,
  decodeStoredReceipt,
  decodeSummary,
  encodeStoredReceipt,
  fromBase64Url,
  hexToBytes,
  toBase64Url,
  type StoredReceipt,
} from '@imani/receipts'

/**
 * Spec 049 receipt storage in IndexedDB, one database per wallet pubkey
 * (`imani-receipts-<pubkey>`), like wallet-storage's `imani-wallet-<userId>`.
 *
 * Two stores:
 *  - `receipts`: one row per payment id, the Java `StoredReceiptCodec` bytes (base64url) plus the
 *    display fields the UI lists by. Never pruned (FR-054).
 *  - `pending`: payments sent but not yet receipted (Java `PendingPayment`), and payee records
 *    waiting for a decision.
 *
 * At rest it is as protected as the coupons beside it: wallet-storage keeps proofs in plain
 * IndexedDB, and so does this. Nothing here is ever logged (FR-048): log `paymentId.slice(0,8)`.
 */

export const DB_PREFIX = 'imani-receipts-'
const DB_VERSION = 1
const RECEIPTS = 'receipts'
const PENDING = 'pending'

export type PendingState = 'PENDING_SETTLEMENT' | 'RECEIPTED' | 'CANCELLED' | 'NO_RECEIPT'
export type PendingReason = 'awaiting_spend' | 'mint_unreachable' | 'signer_unsupported' | 'other'

/** A payment this wallet sent, waiting for its proofs to be spent (FR-003). */
export interface PendingPaymentRow {
  paymentId: string
  payeeKey: string
  unit: string
  reference: string
  /** Epoch seconds. */
  paidAt: number
  /** Canonical evidence of every sent proof, hex. Spendable until claimed: never log. */
  evidenceHex: string
  lockedToPayee: boolean
  state: PendingState
  reason?: PendingReason
  notes: string[]
  /** Wallet transaction row this payment belongs to (`sent:<tokenId>` / `payment:<tokenId>`). */
  txId?: string
  /** Gateway send id, for diagnostics only. */
  sendId?: string
  /** Set once `pending_stale` was counted, so it is counted once (telemetry contract). */
  staleCounted?: boolean
}

/** One stored receipt with the fields a list renders without decoding. */
export interface ReceiptRow {
  paymentId: string
  /** `encodeStoredReceipt` bytes, base64url. Holds evidence and its key: never log. */
  stored: string
  role: StoredReceipt['role']
  /** Epoch seconds, from the summary. */
  paidAt: number
  txId?: string
  /** Set when the last backup save failed, so the next settle retries (FR-009). */
  backupPending?: boolean
  updatedAt: number
}

export interface ReceiptStore {
  get(paymentId: string): Promise<{ row: ReceiptRow; receipt: StoredReceipt } | null>
  /** Inserts unless one exists; returns what is stored afterwards (Java `putIfAbsent`). */
  putIfAbsent(receipt: StoredReceipt, extra?: Partial<Pick<ReceiptRow, 'txId' | 'backupPending'>>): Promise<StoredReceipt>
  update(paymentId: string, fn: (r: StoredReceipt) => StoredReceipt, extra?: Partial<Pick<ReceiptRow, 'txId' | 'backupPending'>>): Promise<StoredReceipt | null>
  all(): Promise<Array<{ row: ReceiptRow; receipt: StoredReceipt }>>
  byTx(txId: string): Promise<{ row: ReceiptRow; receipt: StoredReceipt } | null>
  getPending(paymentId: string): Promise<PendingPaymentRow | null>
  putPending(p: PendingPaymentRow): Promise<void>
  /** Inserts unless one exists; true when inserted. */
  addPendingIfAbsent(p: PendingPaymentRow): Promise<boolean>
  updatePending(paymentId: string, fn: (p: PendingPaymentRow) => PendingPaymentRow): Promise<PendingPaymentRow | null>
  allPending(): Promise<PendingPaymentRow[]>
  close(): void
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('idb request failed'))
  })
}

function done(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error ?? new Error('idb transaction failed'))
    t.onabort = () => reject(t.error ?? new Error('idb transaction aborted'))
  })
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('receipts: indexedDB is not available'))
      return
    }
    const r = indexedDB.open(name, DB_VERSION)
    r.onupgradeneeded = () => {
      const db = r.result
      if (!db.objectStoreNames.contains(RECEIPTS)) {
        const s = db.createObjectStore(RECEIPTS, { keyPath: 'paymentId' })
        s.createIndex('txId', 'txId', { unique: false })
      }
      if (!db.objectStoreNames.contains(PENDING)) db.createObjectStore(PENDING, { keyPath: 'paymentId' })
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('indexedDB.open failed'))
  })
}

const encode = (r: StoredReceipt): string => toBase64Url(encodeStoredReceipt(r))
const decode = (s: string): StoredReceipt => decodeStoredReceipt(fromBase64Url(s))

function rowOf(r: StoredReceipt, prev: ReceiptRow | undefined, extra?: Partial<ReceiptRow>): ReceiptRow {
  // paidAt is read from the summary bytes the receipt carries: TLV tag 9.
  let paidAt = prev?.paidAt ?? 0
  try {
    paidAt = summaryPaidAt(r.receipt.summaryBytes)
  } catch {
    // keep the previous value
  }
  return {
    paymentId: prev?.paymentId ?? paymentIdOf(r),
    stored: encode(r),
    role: r.role,
    paidAt,
    ...(prev?.txId ? { txId: prev.txId } : {}),
    ...(prev?.backupPending ? { backupPending: prev.backupPending } : {}),
    ...extra,
    updatedAt: Date.now(),
  }
}

const summaryPaidAt = (b: Uint8Array) => decodeSummary(b).paidAt
const paymentIdOf = (r: StoredReceipt) => decodeSummary(r.receipt.summaryBytes).paymentId

/** Opens (or creates) the receipt store for one wallet. */
export async function openReceiptStore(pubkey: string): Promise<ReceiptStore> {
  const db = await openDb(DB_PREFIX + pubkey.toLowerCase())

  const getRow = async (paymentId: string): Promise<ReceiptRow | undefined> =>
    req(db.transaction(RECEIPTS, 'readonly').objectStore(RECEIPTS).get(paymentId)) as Promise<ReceiptRow | undefined>

  const store: ReceiptStore = {
    async get(paymentId) {
      const row = await getRow(paymentId)
      return row ? { row, receipt: decode(row.stored) } : null
    },
    async putIfAbsent(receipt, extra) {
      const id = paymentIdOf(receipt)
      const t = db.transaction(RECEIPTS, 'readwrite')
      const s = t.objectStore(RECEIPTS)
      const existing = (await req(s.get(id))) as ReceiptRow | undefined
      if (existing) {
        await done(t)
        return decode(existing.stored)
      }
      s.put(rowOf(receipt, undefined, extra))
      await done(t)
      return receipt
    },
    async update(paymentId, fn, extra) {
      const t = db.transaction(RECEIPTS, 'readwrite')
      const s = t.objectStore(RECEIPTS)
      const existing = (await req(s.get(paymentId))) as ReceiptRow | undefined
      if (!existing) {
        await done(t)
        return null
      }
      const next = fn(decode(existing.stored))
      s.put(rowOf(next, existing, extra))
      await done(t)
      return next
    },
    async all() {
      const rows = (await req(db.transaction(RECEIPTS, 'readonly').objectStore(RECEIPTS).getAll())) as ReceiptRow[]
      const out: Array<{ row: ReceiptRow; receipt: StoredReceipt }> = []
      for (const row of rows) {
        try {
          out.push({ row, receipt: decode(row.stored) })
        } catch {
          // An unreadable row is skipped, never deleted (FR-054).
        }
      }
      return out
    },
    async byTx(txId) {
      const rows = (await req(
        db.transaction(RECEIPTS, 'readonly').objectStore(RECEIPTS).index('txId').getAll(txId),
      )) as ReceiptRow[]
      const row = rows[0]
      return row ? { row, receipt: decode(row.stored) } : null
    },
    async getPending(paymentId) {
      return ((await req(db.transaction(PENDING, 'readonly').objectStore(PENDING).get(paymentId))) as PendingPaymentRow | undefined) ?? null
    },
    async putPending(p) {
      const t = db.transaction(PENDING, 'readwrite')
      t.objectStore(PENDING).put(p)
      await done(t)
    },
    async addPendingIfAbsent(p) {
      const t = db.transaction(PENDING, 'readwrite')
      const s = t.objectStore(PENDING)
      const existing = await req(s.get(p.paymentId))
      if (!existing) s.put(p)
      await done(t)
      return !existing
    },
    async updatePending(paymentId, fn) {
      const t = db.transaction(PENDING, 'readwrite')
      const s = t.objectStore(PENDING)
      const existing = (await req(s.get(paymentId))) as PendingPaymentRow | undefined
      if (!existing) {
        await done(t)
        return null
      }
      const next = fn(existing)
      s.put(next)
      await done(t)
      return next
    },
    async allPending() {
      return (await req(db.transaction(PENDING, 'readonly').objectStore(PENDING).getAll())) as PendingPaymentRow[]
    },
    close() {
      db.close()
    },
  }
  return store
}

export const evidenceHexOf = bytesToHex
export const evidenceBytesOf = hexToBytes
