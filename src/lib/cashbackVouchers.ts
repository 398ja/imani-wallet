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

/** The two effects, passed in so the bounds can be tested without a network. */
export interface ClaimRefreshPorts {
  fetchStatus: (cashbackId: string) => Promise<CashbackStatusReading | null>
  recordStatus: (rowId: string, reading: CashbackStatusReading) => Promise<void>
}

const livePorts: ClaimRefreshPorts = {
  fetchStatus: fetchCashbackStatus,
  recordStatus: recordCashbackStatus,
}

/** A cashback on the Vouchers list whose answer could still change. */
function needsRefresh(row: WalletTransaction): boolean {
  return (
    row.type === 'cashback' &&
    Boolean(row.cashbackId) &&
    Boolean(row.voucherId) &&
    !isTerminalCashbackStatus(row.cashbackStatus)
  )
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
  const open = rows.filter(needsRefresh)
  await Promise.all(
    open.map(async (row) => {
      const reading = await ports.fetchStatus(row.cashbackId as string)
      if (reading && isTerminalCashbackStatus(reading.status)) {
        await ports.recordStatus(row.id, reading)
      }
    }),
  )
}

/**
 * The claim state to show beside a cashback voucher, or undefined for a Sell
 * coupon, whose claims are counted from this device's own rows instead.
 */
export function cashbackClaimLabel(row: WalletTransaction): string | undefined {
  if (row.type !== 'cashback') return undefined
  return row.cashbackStatus && row.cashbackStatus !== 'Unclaimed'
    ? row.cashbackStatus
    : 'Not claimed yet'
}
