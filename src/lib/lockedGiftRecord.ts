/**
 * The record a minted-locked gift keeps on its history row (#410 G14), and the Activity line read
 * from it. Kept apart from `lockedGifts.ts` (which needs the mint, the lock and the coupon code) so
 * the transaction reader and the relay backup can use it without pulling all of that in.
 */
import { formatDate } from './format'

export type LockedGiftStatus = 'waiting' | 'returning' | 'claimed' | 'returned' | 'gone'

const STATUSES: readonly LockedGiftStatus[] = ['waiting', 'returning', 'claimed', 'returned', 'gone']

/** A minted-locked gift on a history row. The token is harmless without the matching key. */
export interface LockedGiftRecord {
  dir: 'in' | 'out'
  token: string
  x: number
  status: LockedGiftStatus
  stall?: string
  to?: string | null
  closedAt?: number
}

export function asLockedGiftRecord(v: unknown): LockedGiftRecord | undefined {
  const r = v as LockedGiftRecord | null
  if (!r || typeof r !== 'object' || (r.dir !== 'in' && r.dir !== 'out') || typeof r.token !== 'string' || typeof r.x !== 'number') return undefined
  if (!STATUSES.includes(r.status)) return undefined
  return r
}

const SETTLED: readonly LockedGiftStatus[] = ['claimed', 'returned', 'gone']

/**
 * Which of two copies of the same gift's record to keep (a restore meeting the local row). A
 * settled gift never goes back to waiting: an older backup would otherwise reopen it, and the next
 * sweep would try to take back a gift the recipient already has. Between two of the same kind, the
 * local copy wins.
 */
export function laterLockedGift(local: LockedGiftRecord | undefined, incoming: LockedGiftRecord | undefined): LockedGiftRecord | undefined {
  if (!local) return incoming
  if (!incoming) return local
  const rank = (s: LockedGiftStatus) => (SETTLED.includes(s) ? 2 : s === 'returning' ? 1 : 0)
  return rank(incoming.status) > rank(local.status) ? incoming : local
}

/** The Activity line for a gift. Never a key. */
export function lockedGiftMemo(r: Pick<LockedGiftRecord, 'dir' | 'status' | 'x' | 'to' | 'stall'>): string {
  const date = formatDate(r.x)
  if (r.dir === 'out') {
    const who = r.to || 'your recipient'
    switch (r.status) {
      case 'waiting':
        return `Sent to ${who}, claim by ${date}`
      case 'returning':
        return 'Not claimed, coming back to you'
      case 'claimed':
        return `Claimed by ${who}`
      case 'returned':
        return 'Not claimed, taken back into your wallet'
      case 'gone':
        return 'Gift no longer available'
    }
  }
  const from = r.stall ? `Gift from ${r.stall}` : 'Gift'
  switch (r.status) {
    case 'waiting':
    case 'returning':
      return `${from}, claim by ${date}`
    case 'claimed':
      return `${from}, added to your wallet`
    default:
      return `${from}, not claimed in time and returned to the buyer`
  }
}
