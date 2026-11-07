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

export type DeleteHandleResult = 'deleted' | 'not-owner' | 'unknown' | 'network'

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
    return 'network'
  } catch {
    return 'network'
  }
}

export const DELETE_COPY = {
  notOwner: 'This name belongs to a different account, so nothing was deleted.',
  unknown: 'We could not find your name on Imani, so nothing was deleted.',
  network: 'We could not reach Imani. Nothing was deleted. Check your connection and try again.',
} as const

export type DeletionOutcome =
  | { status: 'done' }
  | { status: 'blocked'; logout: Extract<LogoutOutcome, { status: 'blocked' }> }
  | { status: 'failed'; reason: Exclude<DeleteHandleResult, 'deleted'> }

export interface DeletionDeps {
  logout?: typeof attemptLogout
  deleteHandle?: typeof deleteHandle
  logoutDeps?: LogoutDeps
  reload?: () => void
}

/**
 * The whole deletion, in the order the owner set:
 * 1. every logout safety check (in-flight money, unconfirmed backups, checkout codes); a refusal
 *    refuses the deletion with the same message, and nothing is deleted;
 * 2. the signed DELETE of the handle; a 403, 404 or network failure changes nothing;
 * 3. the rest of the logout, which cancels the push registration and erases this device.
 *
 * Step 2 runs where logout would ask "Log out?", so it happens only once the checks have passed.
 */
export async function deleteAccount(
  pubkey: string,
  nip05: string | undefined,
  deps: DeletionDeps = {},
): Promise<DeletionOutcome> {
  const run = deps.logout ?? attemptLogout
  const del = deps.deleteHandle ?? deleteHandle
  let failure: Exclude<DeleteHandleResult, 'deleted'> | null = null
  const outcome = await run(
    pubkey,
    () => true,
    deps.reload,
    {
      ...deps.logoutDeps,
      proceed: async () => {
        if (!nip05) return true
        const result = await del(nip05)
        if (result === 'deleted') return true
        failure = result
        return false
      },
    },
  )
  if (failure) return { status: 'failed', reason: failure }
  if (outcome.status === 'blocked') return { status: 'blocked', logout: outcome }
  if (outcome.status === 'done') return { status: 'done' }
  return { status: 'failed', reason: 'network' }
}

/** The refusal for a merchant whose customers can still spend vouchers (#558). */
export function liabilityMessage(block: LiabilityBlock): string {
  const amount = formatFace(block.amount, { unit: block.unit, decimals: currencyDecimals(block.unit) })
  const first = `You have ${amount} in vouchers your customers can still spend.`
  if (block.lastExpiry === null) {
    return `${first} Some of them never expire, so your account can't be deleted while they are out. You can close your stall instead.`
  }
  return `${first} The last one expires on ${new Date(block.lastExpiry).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}. You can delete your account after that.`
}

