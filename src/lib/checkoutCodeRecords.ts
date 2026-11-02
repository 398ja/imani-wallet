/**
 * The customer's checkout codes, as this wallet remembers them (#402), per account.
 *
 * A code is value no coupon row describes while it is outstanding: every part's coupon has been
 * burnt and re-minted locked to the shop key `S`, and only this record says which refund key (`R`,
 * derived from the identity key and the wallet-wide counter `i`) brings it back. So:
 *
 * - every part's source coupon is held back from spending while its code is outstanding
 *   (`checkoutHeldTokenIds`, read by `pay.ts` `withoutInFlight`);
 * - logout is refused while any code is outstanding (`checkoutCodesInFlight`, `inFlightMoney.ts`),
 *   because logout sweeps localStorage and this record is the only map back to the value.
 *
 * Only `inFlightMoney.ts` is imported (the key lives there, so logout cannot drift from it).
 * Nothing secret is kept: `R` is re-derived from `i`. A part's bearer source token is kept only
 * until it is locked, the same class as the coupon row it came from.
 */

import { checkoutCodesLedgerKey } from './inFlightMoney'

export const checkoutCodesKey = checkoutCodesLedgerKey
export const checkoutRefundCounterKey = (pubkey: string) => `imani-wallet:checkout-refund-next:${pubkey}`

export type CheckoutPartState =
  /** Planned, nothing burnt. */
  | 'new'
  /** `onArming` recorded: a burn may have happened, the next run finishes it. */
  | 'arming'
  /** Locked to `S` (and on its way to the store). */
  | 'locked'
  /** Never burnt (a refusal before anything moved): the coupon is as it was. */
  | 'unarmed'
  /** The lock was refused after the burn: its value came back as sats, already kept. */
  | 'kept'
  /** Back in this wallet (expired refund, cancel or change), or spent by the shop. Finished. */
  | 'settled'

export interface CheckoutPartRecord {
  /** The wallet-wide counter value `R` is derived from. */
  i: number
  /** Minor units this part is worth (its credited face value). */
  amount: number
  /** The coupon row it was made from (a whole coupon). Absent for a split, which is carved first. */
  sourceTokenId?: string
  /** The bearer token being locked. Dropped once locked. */
  token?: string
  /** Whether this part had to be carved off a larger coupon first. */
  split?: boolean
  state: CheckoutPartState
  burnKeyset?: string
  /** Signed locks, by gift secret, for a resume that the gateway no longer replays. */
  locks?: Record<string, string>
  /** The R-and-S-locked token, once minted. */
  lockedToken?: string
  /** Whether the relay holds every proof's pre-signed refund. */
  armed?: boolean
  depositKeyset?: string
  /**
   * #472: earlier locked tokens of this part, oldest first, kept for audit when a balance successor
   * replaced it (the shop used some of it and re-locked the rest to `S`). Spent at the mint.
   */
  replacedTokens?: string[]
}

/** #472: one order that used part of a code. Minor units, epoch ms. */
export interface CheckoutRedemption {
  at: number
  /** What this order took. */
  amount: number
  /** What was left on the code after it. */
  remaining: number
}

export type CheckoutCodeStatus =
  /** Locking the parts. */
  | 'locking'
  /** Every part is locked; the deposit has not been answered yet. Retried with the same key. */
  | 'depositing'
  | 'reserved'
  | 'held'
  /** #472: an order redeemed it keeping a balance; the store is waiting for its `/rebalance`. */
  | 'settling'
  | 'cancelling'
  | 'redeemed'
  | 'cancelled'
  | 'expired'
  /** No code was issued (a part could not be locked, or the store refused). Parts come back at `x`. */
  | 'abandoned'

export interface CheckoutCodeRecord {
  /** Also the deposit's idempotency key. */
  id: string
  stall: string
  shopKey: string
  shopUrl: string
  platform: string
  unit: string
  decimals: number
  /** Minor units. */
  amount: number
  /**
   * #472: what is left on the code now, minor units. Starts at `amount`; absent on records made
   * before #472 (read it through {@link remainingOf}).
   */
  remaining?: number
  /** #472: each order that used part of the code, oldest first. */
  redemptions?: CheckoutRedemption[]
  /** Epoch seconds: every part's locktime. */
  x: number
  createdAt: number
  status: CheckoutCodeStatus
  /** Canonical form, once the store issued it. */
  code?: string
  codeHash?: string
  /** What the shop spent, minor units, once redeemed. */
  spent?: number
  /** The change the shop gave back, minor units, once its coupons are in (recorded once). */
  change?: number
  /** Why no code was issued. */
  refusal?: string
  /** Set once every part's value is spent or back: the code no longer holds anything. */
  done?: boolean
  /** In the store's `idx` order: a part's index here is its `idx` on the code, for good. */
  parts: CheckoutPartRecord[]
}

/** What is left on a code, minor units (#472). A record from before #472 still holds its amount. */
export const remainingOf = (r: Pick<CheckoutCodeRecord, 'amount' | 'remaining'>): number => r.remaining ?? r.amount

/** Every record, newest first. Unreadable storage throws: the caller decides what unknown means. */
export function loadCheckoutCodes(pubkey: string): CheckoutCodeRecord[] {
  const raw = localStorage.getItem(checkoutCodesKey(pubkey))
  if (!raw) return []
  const parsed: unknown = JSON.parse(raw)
  return Array.isArray(parsed) ? (parsed as CheckoutCodeRecord[]) : []
}

/** Throws when it cannot be written: nothing may move until it can. */
export function saveCheckoutCode(pubkey: string, record: CheckoutCodeRecord): void {
  const all = loadCheckoutCodes(pubkey).filter((r) => r.id !== record.id)
  localStorage.setItem(checkoutCodesKey(pubkey), JSON.stringify([record, ...all].sort((a, b) => b.createdAt - a.createdAt)))
  for (const listener of [...listeners]) {
    try {
      listener(pubkey, { ...record, parts: record.parts.map((p) => ({ ...p })) })
    } catch {
      // A listener is display (history); the record is written either way.
    }
  }
}

type CheckoutCodeListener = (pubkey: string, record: CheckoutCodeRecord) => void
const listeners = new Set<CheckoutCodeListener>()

/** Called after every successful save, with a copy of the record. Returns the unsubscribe. */
export function onCheckoutCodeSaved(listener: CheckoutCodeListener): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export const isOutstanding = (r: CheckoutCodeRecord): boolean => !r.done

/** Coupon rows held by an outstanding code. Unreadable storage holds nothing back here (logout still refuses). */
export function checkoutHeldTokenIds(pubkey: string): Set<string> {
  try {
    return new Set(
      loadCheckoutCodes(pubkey)
        .filter(isOutstanding)
        .flatMap((r) => r.parts.filter((p) => p.state !== 'unarmed').map((p) => p.sourceTokenId))
        .filter((id): id is string => typeof id === 'string'),
    )
  } catch {
    return new Set()
  }
}

/** Outstanding codes. Storage that cannot be read counts as one. Never throws. */
export function checkoutCodesInFlight(pubkey: string): number {
  try {
    return loadCheckoutCodes(pubkey).filter(isOutstanding).length
  } catch {
    return 1
  }
}

/** The next unused refund index, wallet-wide. */
export function nextCheckoutRefundIndex(pubkey: string): number {
  const n = Number(localStorage.getItem(checkoutRefundCounterKey(pubkey)))
  return Number.isSafeInteger(n) && n >= 0 ? n : 0
}

/**
 * Reserve `count` indices, written BEFORE any of them is used, so a page that dies never hands one
 * out twice (the same `R` on two parts would let the relay link them). Throws when it cannot write.
 */
export function reserveCheckoutRefundIndices(pubkey: string, count: number): number[] {
  const used = new Set<number>()
  try {
    for (const r of loadCheckoutCodes(pubkey)) for (const p of r.parts) used.add(p.i)
  } catch {
    // The counter alone, then.
  }
  const out: number[] = []
  let i = nextCheckoutRefundIndex(pubkey)
  while (out.length < count) {
    if (!used.has(i)) out.push(i)
    i += 1
  }
  localStorage.setItem(checkoutRefundCounterKey(pubkey), String(i))
  return out
}
