import { outstandingLiability } from './stats'
import { currencyDecimals, formatFace } from './format'
import type { WalletTransaction } from './transactions'
import type { MerchantProfile } from './merchant'
import { signedFetch, type RequestSigner } from './nip98'
import { attemptLogout, type LogoutDeps, type LogoutOutcome } from './logout'

/**
 * In-app account deletion (imani-wallet#558, server side imani-gateway-core#205).
 *
 * The user owns their key, so "deleting the account" removes what the operator holds for it:
 * the handle (retired by the server, never claimable again) and the push registration. The key
 * and the vouchers on this device are erased by the logout that follows, exactly as a logout
 * erases them, and come back only with the key or a backup.
 */

/** Why a merchant may not delete yet: what customers can still spend, and until when. */
export interface LiabilityBlock {
  /** Minor units, in `unit`. */
  amount: number
  unit: string
  /** The latest expiry among the outstanding vouchers, ms. Null when one never expires. */
  lastExpiry: number | null
}

/**
 * The same figure the merchant dashboard shows (`outstandingLiability`), plus the latest expiry
 * among the issued vouchers still valid. Null when there is nothing outstanding, or no stall.
 */
export function liabilityBlock(
  rows: WalletTransaction[],
  merchant: MerchantProfile | null,
  pubkey: string,
  now: number,
): LiabilityBlock | null {
  if (!merchant) return null
  const unit = merchant.issuanceCurrency
  const amount = outstandingLiability(rows, { pubkey, unit, now })
  if (amount <= 0) return null
  const live = rows.filter(
    (tx) => tx.type === 'issued' && tx.unit === unit && !(tx.expiresAt !== undefined && tx.expiresAt <= now),
  )
  const lastExpiry = live.some((tx) => tx.expiresAt === undefined)
    ? null
    : live.reduce((max, tx) => Math.max(max, tx.expiresAt ?? 0), 0) || null
  return { amount, unit, lastExpiry }
}

export type DeleteHandleResult = 'deleted' | 'not-owner' | 'unknown' | 'unauthorized' | 'unavailable' | 'network'

/** The signed DELETE of the handle. Never throws. */
export async function deleteHandle(nip05: string, signer?: RequestSigner): Promise<DeleteHandleResult> {
  try {
    const response = await signedFetch(
      `/api/v1/nip05?nip05=${encodeURIComponent(nip05)}`,
      'DELETE',
      undefined,
      signer,
      { signal: AbortSignal.timeout(15_000) },
    )
    if (response.status === 204 || response.ok) return 'deleted'
    if (response.status === 403) return 'not-owner'
    if (response.status === 404) return 'unknown'
    if (response.status === 401) return 'unauthorized'
    if (response.status === 501) return 'unavailable'
    return 'network'
  } catch {
    return 'network'
  }
}

export const DELETE_COPY = {
  notOwner: 'This name belongs to a different account, so nothing was deleted.',
  unknown: 'We could not find your name on Imani, so nothing was deleted.',
  unauthorized: 'We could not confirm it is you. Nothing was deleted.',
  unavailable: 'Deleting accounts is not available yet. Nothing was deleted.',
  network: 'We could not reach Imani. Nothing was deleted. Check your connection and try again.',
} as const

/** Which DELETE_COPY line explains each failed result. */
export const REASON_COPY: Record<Exclude<DeleteHandleResult, 'deleted'>, keyof typeof DELETE_COPY> = {
  'not-owner': 'notOwner',
  unknown: 'unknown',
  unauthorized: 'unauthorized',
  unavailable: 'unavailable',
  network: 'network',
}

export type DeletionOutcome =
  | { status: 'done' }
  | { status: 'blocked'; logout: Extract<LogoutOutcome, { status: 'blocked' }> }
  | { status: 'failed'; reason: Exclude<DeleteHandleResult, 'deleted'> }
  /**
   * The handle is deleted (and retired, which is permanent), but the logout refused afterwards,
   * for example another tab opened. The account IS deleted: the next step is `finishLogout`,
   * which never sends the DELETE again.
   */
  | { status: 'deleted-logout-pending'; logout: Extract<LogoutOutcome, { status: 'blocked' }> | { status: 'cancelled' } }

export interface DeletionDeps {
  logout?: typeof attemptLogout
  deleteHandle?: typeof deleteHandle
  logoutDeps?: LogoutDeps
  reload?: () => void
}

/**
 * Accounts whose handle this page has already deleted, in this document. A retry after our own
 * 204 must not send the DELETE again (the second answer is a 404 and would read as "unknown").
 */
const deletedHere = new Set<string>()

/** For tests. */
export function forgetDeletedHandles(): void {
  deletedHere.clear()
}

export function handleDeleted(pubkey: string): boolean {
  return deletedHere.has(pubkey)
}

/**
 * The whole deletion, in the order the owner set:
 * 1. every logout safety check (in-flight money, unconfirmed backups, checkout codes, other tabs,
 *    writers drained); a refusal refuses the deletion with the same message, nothing is deleted;
 * 2. the signed DELETE of the handle, run by `attemptLogout`'s `proceed` hook immediately before
 *    its first irreversible step; a 403, 404 or network failure cancels and changes nothing;
 * 3. the rest of the logout: push unsubscribe, session end, wipe.
 *
 * Once the DELETE has answered 204 the deletion is done. A logout that still refuses after it
 * is `deleted-logout-pending`, and every later attempt goes straight to `finishLogout`.
 */
export async function deleteAccount(
  pubkey: string,
  nip05: string | undefined,
  deps: DeletionDeps = {},
): Promise<DeletionOutcome> {
  if (deletedHere.has(pubkey)) return finishLogout(pubkey, deps)
  const run = deps.logout ?? attemptLogout
  const del = deps.deleteHandle ?? deleteHandle
  let failure: Exclude<DeleteHandleResult, 'deleted'> | null = null
  const outcome = await run(pubkey, () => true, deps.reload, {
    ...deps.logoutDeps,
    proceed: async () => {
      if (!nip05) return true
      const result = await del(nip05)
      if (result === 'deleted') {
        deletedHere.add(pubkey)
        return true
      }
      failure = result
      return false
    },
  })
  if (outcome.status === 'done') return { status: 'done' }
  if (deletedHere.has(pubkey)) {
    return { status: 'deleted-logout-pending', logout: outcome.status === 'blocked' ? outcome : { status: 'cancelled' } }
  }
  if (failure) return { status: 'failed', reason: failure }
  if (outcome.status === 'blocked') return { status: 'blocked', logout: outcome }
  return { status: 'failed', reason: 'network' }
}

/** After the handle is deleted: plain logout, never the DELETE again. */
export async function finishLogout(pubkey: string, deps: DeletionDeps = {}): Promise<DeletionOutcome> {
  const run = deps.logout ?? attemptLogout
  const outcome = await run(pubkey, () => true, deps.reload, deps.logoutDeps)
  if (outcome.status === 'done') return { status: 'done' }
  return { status: 'deleted-logout-pending', logout: outcome.status === 'blocked' ? outcome : { status: 'cancelled' } }
}

export const DELETED_PENDING_COPY = 'Your account is deleted. Close other Imani tabs, then tap Finish to log out.'

/** The refusal for a merchant whose customers can still spend vouchers (#558). */
export function liabilityMessage(block: LiabilityBlock): string {
  const amount = formatFace(block.amount, { unit: block.unit, decimals: currencyDecimals(block.unit) })
  const first = `You have ${amount} in vouchers your customers can still spend.`
  if (block.lastExpiry === null) {
    return `${first} Some of them never expire, so your account can't be deleted while they are out. You can close your stall instead.`
  }
  return `${first} The last one expires on ${new Date(block.lastExpiry).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}. You can delete your account after that.`
}

