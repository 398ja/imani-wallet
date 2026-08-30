import { WalletStorage } from '@imani/wallet-storage'
import type { VoucherRow, TransactionRow } from '@imani/wallet-storage'

import { burnIfSelfIssued } from './burn'
import { toTransaction, type WalletTransaction } from './transactions'
import { publishTx } from './txRecords'
import { publishVoucher, tombstoneVoucher } from './voucherRecords'

/**
 * The wallet's IndexedDB store — vouchers and transactions.
 *
 * WalletStorage is the source of truth, not TanStack Query. Query caches gateway
 * REST reads only; IDB, relay subscriptions and coordinator state stay outside
 * it. Blurring that boundary is how a React layer starts duplicating coordinator
 * responsibilities, which is what reintroduced duplicate transactions and double
 * redemptions in the vanilla app.
 */
let storage: WalletStorage | undefined
let opening: Promise<WalletStorage> | undefined
/** Whose store `storage` is. The DB is user-scoped; this guards the handle. */
let currentUserId: string | undefined

/**
 * Open (or reuse) the store for one user.
 *
 * The identity check is the point. This used to be `if (storage) return storage`,
 * ignoring `userId` — so after an in-session account switch the second user got
 * the FIRST user's handle and read their coupons out of a DB named for someone
 * else. `AuthedApp`'s effect is keyed on `[pubkey]` and NapProvider is wired
 * with `identityChange`, so the switch really does re-run this.
 */
export function openWallet(userId: string): Promise<WalletStorage> {
  if (storage && currentUserId === userId) return Promise.resolve(storage)
  if (opening && currentUserId === userId) return opening

  // Close the previous user's DB rather than leaving it open behind the new
  // handle: it holds an IndexedDB connection and a BroadcastChannel, and a live
  // channel would keep fanning the old user's writes into this session's
  // listeners.
  const previous = storage
  if (previous) void previous.close().catch(() => undefined)

  storage = undefined
  raw = undefined
  currentUserId = userId
  // WalletStorage composes the user-scoped DB name itself (imani-wallet-{userId}).
  const ws = new WalletStorage({ userId })
  const rawWriters = backUpWrites(ws)
  opening = ws.init().then(() => {
    // Guard against an interleaved switch: a slower init for an identity we have
    // since moved on from must not install itself over the newer one.
    if (currentUserId === userId) {
      storage = ws
      raw = rawWriters
    }
    return ws
  })
  return opening
}

/**
 * Mirror every write to the relay as it happens — transaction rows to
 * `txRecords`, coupons to `voucherRecords`.
 *
 * The hook belongs on the storage instance rather than at the call sites
 * because the call sites are not all ours. A coupon arriving over DM is written
 * by imani-apps' `tokenRedemption.js` through
 * `walletStorageIntegration.atomicallyWrite`, which is handed THIS instance
 * (`legacyBridge.ts:220`) — that path is exactly how redemptions came to exist
 * only on the device that received them, and no edit to `dmPoll.ts` would have
 * covered it. Patching the writers here catches that, `issue.ts`, `pay.ts` and
 * `dmPoll.ts` together, and anything added later.
 *
 * Every removal is tombstoned, not silently dropped: a coupon that is gone from
 * the device but still on the relay would come back as money whose proofs are
 * burnt.
 *
 * Fire-and-forget on purpose: a relay round-trip must not sit inside the write
 * `pay.ts` awaits before acking the keep token, or inside the redemption write.
 * A publish lost to a closing tab costs one record until the next login, when
 * `backfillTx` / `backfillVouchers` find it missing and publish it.
 *
 * Returns the unwrapped writers for the restore paths.
 */
interface RawWriters {
  addTransaction(row: TransactionRow): Promise<TransactionRow>
  saveVoucher(row: VoucherRow): Promise<VoucherRow>
}

/** Exported for tests: `openWallet` needs IndexedDB, this needs only a double. */
export function backUpWrites(ws: WalletStorage): RawWriters {
  const rawAdd = ws.addTransaction.bind(ws)
  const rawAtomic = ws.atomicallyWrite.bind(ws)
  const rawSave = ws.saveVoucher.bind(ws)
  const rawRemove = ws.removeVoucher.bind(ws)
  const rawRemoveMany = ws.removeVouchers.bind(ws)
  const rawReplaceAll = ws.clearAndReplaceAllVouchers.bind(ws)

  ws.addTransaction = async (row: TransactionRow) => {
    const merged = await rawAdd(row)
    void publishTx(merged)
    return merged
  }

  ws.atomicallyWrite = async (input: Parameters<WalletStorage['atomicallyWrite']>[0]) => {
    await rawAtomic(input)
    for (const row of input.transactions ?? []) void publishTx(row)
    // Transaction rows can go straight back out — they carry their own `id`.
    // Voucher rows cannot, hence `mirrorWritten`. See its doc comment.
    void mirrorWritten(ws, input.vouchers ?? [])
  }

  ws.saveVoucher = async (row: VoucherRow) => {
    // The MERGED row, not the argument: the store derives `token_id` from the
    // token and fills `created_at`/`updated_at`. Publishing the argument would
    // back up a coupon with no primary key, and `d` is that key.
    const saved = await rawSave(row)
    void publishVoucher(saved)
    void burnIfSelfIssued(saved, currentUserId ?? '')
    return saved
  }

  ws.removeVoucher = async (tokenId: string) => {
    const removed = await rawRemove(tokenId)
    if (removed) void tombstoneVoucher(tokenId)
    return removed
  }

  ws.removeVouchers = async (tokenIds: string[]) => {
    const count = await rawRemoveMany(tokenIds)
    for (const tokenId of tokenIds) void tombstoneVoucher(tokenId)
    return count
  }

  ws.clearAndReplaceAllVouchers = async (rows: VoucherRow[]) => {
    // Read what is about to be discarded BEFORE discarding it — anything not in
    // the replacement set is a removal and needs its tombstone.
    const before = await ws.getAllVouchers()
    await rawReplaceAll(rows)
    const kept = new Set(rows.map((row) => row.token_id))
    for (const row of before) {
      if (row.token_id && !kept.has(row.token_id)) void tombstoneVoucher(row.token_id)
    }
    void mirrorWritten(ws, rows)
  }

  return { addTransaction: rawAdd, saveVoucher: rawSave }
}

/**
 * Back up the coupons the store actually WROTE, not the rows it was handed.
 *
 * `token_id` is the `d` tag of a coupon's backup event — its identity — and it
 * is derived from the token by the store, INSIDE `atomicallyWrite`, onto a copy
 * (`WalletStorage.ts:537` spreads into a new row). The caller's own objects
 * never gain it. `buildVoucher` in `shared/tokenRedemption.js` does not set one,
 * so every coupon arriving over DM reached `publishVoucher` with `token_id`
 * undefined and was dropped by its own `if (!row.token_id) return` guard.
 *
 * That is why staging carried a kind-7376 `received:…` history event for coupons
 * it had no kind-7375 for: transaction rows come with an `id` of their own,
 * coupons do not. Nothing looked wrong until a logout, because `backfillVouchers`
 * publishes whatever IndexedDB holds at the NEXT login — and logout wipes
 * IndexedDB first, so the coupons went with it.
 *
 * Matched back by token: `token_id` is a hash of the token, so one row per token.
 * The re-read is what `saveVoucher`'s wrapper gets for free by publishing the
 * merged row it is handed back.
 */
async function mirrorWritten(ws: WalletStorage, written: VoucherRow[]): Promise<void> {
  const tokens = new Set(written.map((row) => row.token).filter(Boolean))
  if (tokens.size === 0) return
  for (const row of await ws.getAllVouchers()) {
    if (!row.token || !tokens.has(row.token)) continue
    void publishVoucher(row)
    // The same re-read serves the burn: a coupon coming back to the merchant
    // who issued it arrives on THIS path — imani-apps' TokenRedemption writes
    // through `atomicallyWrite`, never through `saveVoucher` — so a hook on the
    // DM poller alone would miss every redemption. See burn.ts.
    void burnIfSelfIssued(row, currentUserId ?? '')
  }
}

let raw: RawWriters | undefined

/**
 * Write a row WITHOUT mirroring it back to the relay.
 *
 * For rows that came FROM the relay. Going through the wrapped writer would
 * make every login republish everything it had just read.
 */
export async function addRestoredTransaction(row: TransactionRow): Promise<TransactionRow> {
  if (!raw) throw new Error('Wallet not opened yet — call openWallet(userId) first.')
  return raw.addTransaction(row)
}

/** The coupon counterpart of `addRestoredTransaction`. Same reason. */
export async function addRestoredVoucher(row: VoucherRow): Promise<VoucherRow> {
  if (!raw) throw new Error('Wallet not opened yet — call openWallet(userId) first.')
  return raw.saveVoucher(row)
}

export function getWallet(): WalletStorage {
  if (!storage) throw new Error('Wallet not opened yet — call openWallet(userId) first.')
  return storage
}

/**
 * Close and DELETE one user's store. Used by logout.
 *
 * The database has to be closed first or `deleteDatabase` blocks indefinitely on
 * the open connection — it does not reject, it simply never fires, so the logout
 * would hang with the key already gone. The module-level handle is cleared too,
 * so a later `getWallet()` throws its honest "not opened" rather than handing
 * back a handle to a database that no longer exists.
 *
 * Resolves even when the delete is blocked by another tab holding the same DB
 * open: logout must not stall on a window the user has forgotten about, and the
 * key is destroyed regardless, which is the part that protects them.
 */
export async function wipeWallet(userId: string): Promise<void> {
  const open = storage
  storage = undefined
  opening = undefined
  currentUserId = undefined
  raw = undefined
  if (open) await open.close().catch(() => undefined)

  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(`imani-wallet-${userId}`)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    // Another tab still has it open. Nothing useful to do from here, and the
    // delete completes once that tab lets go.
    request.onblocked = () => resolve()
  })
}

/**
 * Subscribe to "the wallet's contents changed", from any tab including this one.
 *
 * `WalletStorage.onChange` alone is not enough. Its `postEvent` publishes to a
 * BroadcastChannel, and local listeners are fanned out only when that channel
 * DELIVERS — but BroadcastChannel never echoes to the context that posted. So a
 * write made by this tab (a coupon arriving over DM and being redeemed right
 * here) notifies every other tab and not the one that needs to re-render. The
 * symptom is a coupon that is correct in IndexedDB and absent from the screen
 * until a manual reload, which reads as a receive bug rather than a
 * notification one.
 *
 * Local writers call `notifyWalletChanged()`; cross-tab writes still arrive via
 * onChange. Screens subscribe here and get both.
 */
const localListeners = new Set<() => void>()

export function onWalletChanged(listener: () => void): () => void {
  localListeners.add(listener)
  const unsubscribeChannel = getWallet().onChange(listener)
  return () => {
    localListeners.delete(listener)
    unsubscribeChannel()
  }
}

/** Announce a write made by this tab. */
export function notifyWalletChanged(): void {
  for (const listener of localListeners) listener()
}

export async function listVouchers(): Promise<VoucherRow[]> {
  return getWallet().getAllVouchers()
}

/** One coupon by its content-derived primary key. Null once it has been spent. */
export async function getVoucherRow(tokenId: string): Promise<VoucherRow | null> {
  return (await getWallet().getVoucher(tokenId)) ?? null
}

/** One transaction by id. */
export async function getTransactionRow(id: string): Promise<TransactionRow | null> {
  return (await getWallet().getTransaction(id)) ?? null
}

/**
 * Stamp a row with the receipt of the attestation published for it (DEV-246).
 *
 * A write-back rather than a field set at redemption time, because the receipt
 * cannot exist yet when the row is written: `attestRedemption` runs AFTER the
 * proofs are burnt and the row is saved, deliberately, so that a relay failure
 * can never turn a completed redemption into a reported error. The event id and
 * date only come into being once a relay has taken the record.
 *
 * `updateTransaction` merges a patch, so this touches nothing else on the row.
 * It returns null for an id that is not there, which is not an error: the sweep
 * reads a snapshot, and a row can be gone by the time its receipt is written.
 *
 * Never throws. The redemption is complete and the money has moved; failing to
 * record where it was published must not surface as a failed redemption.
 */
export async function recordAttestationReceipt(
  id: string,
  receipt: { nullifier: string; eventId: string; at: number },
): Promise<void> {
  try {
    await getWallet().updateTransaction(id, {
      attestationNullifier: receipt.nullifier,
      attestationEventId: receipt.eventId,
      attestationAt: receipt.at,
    } as unknown as Partial<TransactionRow>)
    // The detail screen may be open on this very row. Without this the receipt
    // appears only on the next navigation — see notifyWalletChanged: a write
    // made by this tab is not echoed back to it by BroadcastChannel.
    notifyWalletChanged()
  } catch (error) {
    console.error('[wallet] attestation receipt not recorded', error)
  }
}

/**
 * The same write-back, for a caller that knows the nullifier but not the row id.
 *
 * dmPoll is that caller. Its row id is `received:<tokenId>` where `tokenId` is
 * the fingerprint of the token AFTER the mint swap — a value the redemption
 * path computes internally and does not hand back. Reconstructing it here would
 * duplicate the legacy writer's id convention in a second place, which is
 * exactly the class of assumption that made `transactionsWith` match nothing.
 *
 * The nullifier is a sounder key anyway: `withCorrelation` stamped it onto the
 * row during the very redemption being attested, and it is unique per token.
 *
 * A linear scan, deliberately — there is no index on this field, the store is
 * small, and this runs once per redemption well off the hot path.
 */
export async function recordReceiptByNullifier(receipt: {
  nullifier: string
  eventId: string
  at: number
}): Promise<void> {
  try {
    const rows = await listTransactions()
    const match = rows.find(
      (row) =>
        (row as unknown as Record<string, unknown>).attestationNullifier === receipt.nullifier,
    )
    // No row is not an error. The stamp rides `withCorrelation`, and a
    // redemption written by some path that does not carry it has nowhere to
    // put the receipt; the sweep will not find it either, which is honest.
    if (!match?.id) return
    await recordAttestationReceipt(match.id, receipt)
  } catch (error) {
    console.error('[wallet] attestation receipt not matched to a row', error)
  }
}

export async function listTransactions(): Promise<TransactionRow[]> {
  return getWallet().getAllTransactions()
}

/**
 * Transactions with one merchant, newest first.
 *
 * Field names follow the WRITER, which is tokenRedemption's
 * `_buildReceiveTransactionRow`: it emits `merchantId` / `counterparty` /
 * `timestamp`, not `issuer_id` / `created_at`. Guessing the snake_case
 * spellings here matched nothing, and an empty list is indistinguishable from
 * "no transactions yet" — the screen said "Nothing yet." over a store that had
 * the row. Other spellings stay accepted for rows written by other paths.
 */
export async function transactionsWith(pubkey: string): Promise<WalletTransaction[]> {
  const target = pubkey.toLowerCase()
  const all = await listTransactions()
  return all
    .map(toTransaction)
    .filter((tx) => (tx.merchantId ?? tx.counterparty ?? '').toLowerCase() === target)
    .sort((a, b) => b.at - a.at)
}
