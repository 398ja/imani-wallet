import { WalletStorage } from '@imani/wallet-storage'
import type { VoucherRow, TransactionRow } from '@imani/wallet-storage'

import { toTransaction, type WalletTransaction } from './transactions'

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
  currentUserId = userId
  // WalletStorage composes the user-scoped DB name itself (imani-wallet-{userId}).
  const ws = new WalletStorage({ userId })
  opening = ws.init().then(() => {
    // Guard against an interleaved switch: a slower init for an identity we have
    // since moved on from must not install itself over the newer one.
    if (currentUserId === userId) storage = ws
    return ws
  })
  return opening
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

export async function listTransactions(): Promise<TransactionRow[]> {
  return getWallet().getAllTransactions()
}

/**
 * Transactions with one farmer, newest first.
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
