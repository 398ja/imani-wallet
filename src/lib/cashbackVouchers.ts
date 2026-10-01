/**
 * The claim state of cashback vouchers on the merchant's Vouchers list (#144).
 *
 * A cashback code is redeemed on a phone this device never sees, so only the
 * portal knows whether it was claimed. This asks it, within bounds: only rows
 * that can still change, and only when the list opens. A list with fifty
 * settled cashbacks costs no requests at all.
 */
import {
  fetchCashbackStatus,
  isTerminalCashbackStatus,
  type CashbackStatusReading,
} from './cashback'
import type { WalletTransaction } from './transactions'
import { recordCashbackStatus } from './wallet'

/**
 * How many status requests may be in flight at once. A merchant with many
 * open cashbacks should not burst the portal every time the list opens.
 */
export const STATUS_REFRESH_CONCURRENCY = 3

/** How long one status request may take before this pass gives up on it. */
const STATUS_REFRESH_TIMEOUT_MS = 8_000

/** The effects and clock, passed in so the bounds can be tested without a network. */
export interface ClaimRefreshPorts {
  fetchStatus: (cashbackId: string) => Promise<CashbackStatusReading | null>
  recordStatus: (rowId: string, reading: CashbackStatusReading) => Promise<void>
  now?: number
  timeoutMs?: number
}

const livePorts: ClaimRefreshPorts = {
  fetchStatus: fetchCashbackStatus,
  recordStatus: recordCashbackStatus,
}

/**
 * A cashback on the Vouchers list whose answer could still change. A row past
 * its expiry cannot be claimed any more, so asking about it buys nothing.
 */
function needsRefresh(row: WalletTransaction, now: number): boolean {
  return (
    row.type === 'cashback' &&
    Boolean(row.cashbackId) &&
    Boolean(row.voucherId) &&
    !isTerminalCashbackStatus(row.cashbackStatus) &&
    !(row.expiresAt !== undefined && row.expiresAt <= now)
  )
}

/** The reading, or null if it takes longer than `ms`. Null is "could not check". */
function withTimeout<T>(work: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const giveUp = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  return Promise.race([work, giveUp]).finally(() => clearTimeout(timer))
}

/**
 * Ask the portal about every open cashback voucher once, and write back the
 * ones that have settled.
 *
 * Only terminal answers are written, matching `useCashbackStatus`: an
 * `Unclaimed` reading is stale as it lands, and storing it would make a row
 * look checked when nothing durable was learned. The write fires the wallet's
 * change event, which reloads the list with the new label.
 */
export async function refreshCashbackClaims(
  rows: readonly WalletTransaction[],
  ports: ClaimRefreshPorts = livePorts,
): Promise<void> {
  const now = ports.now ?? Date.now()
  const timeoutMs = ports.timeoutMs ?? STATUS_REFRESH_TIMEOUT_MS
  const queue = rows.filter((row) => needsRefresh(row, now))

  // A few workers draining one queue: at most STATUS_REFRESH_CONCURRENCY
  // requests in flight, and a slow one holds up only its own worker.
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const reading = await withTimeout(ports.fetchStatus(row.cashbackId as string), timeoutMs)
      if (reading && isTerminalCashbackStatus(reading.status)) {
        await ports.recordStatus(row.id, reading)
      }
    }
  }
  await Promise.all(Array.from({ length: STATUS_REFRESH_CONCURRENCY }, worker))
}

/**
 * What each portal status means to a merchant. The portal's enum is not shown
 * as is: "ManualAttention" and "Revoked" are not words a stall uses.
 */
const CLAIM_LABELS: Record<string, string> = {
  Unclaimed: 'Not claimed yet',
  Claimed: 'Claimed',
  Revoked: 'Withdrawn',
  Expired: 'Expired',
  ManualAttention: 'Needs a check',
}

/**
 * The claim state to show beside a cashback voucher, or undefined for a Sell
 * coupon, whose claims are counted from this device's own rows instead.
 *
 * A status this build does not know reads "Status unknown". Rendering an
 * unknown string would show whatever the portal sent, untranslated.
 */
export function cashbackClaimLabel(row: WalletTransaction): string | undefined {
  if (row.type !== 'cashback') return undefined
  if (!row.cashbackStatus) return CLAIM_LABELS.Unclaimed
  return CLAIM_LABELS[row.cashbackStatus] ?? 'Status unknown'
}
