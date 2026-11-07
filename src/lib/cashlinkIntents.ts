/**
 * #543: a Cashlink being made on the direct path, written down BEFORE anything moves.
 *
 * The record holds the link (its key `k`, index `i` and expiry `x`), every part (the coupon row it
 * comes from and the bearer token it locks) and each part's progress: the burn keyset, the signed
 * locks, the locked token and the wraps already on the link. Everything else (the refund key `R_i`,
 * the burn outputs, the lock bodies, the carriers) is derived from the wallet key and this record,
 * so a page that dies anywhere is finished by `finishCashlinkIntents` on the next start.
 *
 * Its own module with no heavy imports: `pay.ts` reads it to hold the coupons back from other
 * sends, and logout reads its key (`inFlightMoney.ts`) to stay off while one exists.
 */
import { cashlinkIntentsKey } from './inFlightMoney'

export type CashlinkPartState =
  /** Nothing of it has moved. */
  | 'new'
  /** Recorded before its burn: from here the next run resumes it, never re-checks it. */
  | 'arming'
  /** Locked to the link, its refunds deposited (`armed`) or not. */
  | 'locked'
  /** Refused after its burn: its value was kept in this wallet as sats. */
  | 'kept'
  /** Refused before anything moved (the mint refused the burn): the coupon is as it was. */
  | 'unarmed'
  /** Spent by somebody else before it could be locked. */
  | 'gone'

export interface CashlinkIntentPart {
  /** The coupon row this part is drawn from. */
  sourceTokenId: string
  /** The id its sent row is written under (`sent:<rowId>`), fixed when the intent is written. */
  rowId: string
  /** The voucher, for the row. */
  voucherId?: string
  /** The source row was settled (removed, or rewritten to `rest`) once the part stopped being a coupon. */
  sourceSettled?: true
  /** What this part draws, minor units. */
  amount: number
  /** The bearer token the part locks: the whole row, or proofs carved from it. Dropped once locked. */
  token?: string
  /** Carved from its row (only some proofs): once the part is locked the row keeps `rest`. */
  carved?: true
  rest?: string | null
  state: CashlinkPartState
  burnKeyset?: string
  /** Signed locks, by gift secret, recorded before they are minted. */
  locks?: Record<string, string>
  /** The `P2PK(L)` tokens, cut one per wrap (`splitTokenByVoucher` + `fitToWraps`), once minted. */
  wraps?: string[]
  armed?: boolean
  depositKeyset?: string
  /** The wrap tokens of this part confirmed on the link (relay OK and gateway 2xx). */
  published?: string[]
}

export interface CashlinkIntent {
  /** The link key, as text: one intent per link. */
  id: string
  k: string
  i: number
  x: number
  /** The stall whose coupons these are, and its name for the row. */
  stall: string
  merchantName?: string
  unit: string
  decimals: number
  amount: number
  memo?: string
  /** ms. */
  at: number
  parts: CashlinkIntentPart[]
  /** The sent rows are written (they may still say `arming` until every wrap is on the link). */
  rowsWritten?: true
}

export function loadCashlinkIntents(pubkey: string): CashlinkIntent[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(cashlinkIntentsKey(pubkey)) ?? '[]') as unknown
    return Array.isArray(parsed) ? (parsed as CashlinkIntent[]) : []
  } catch {
    return []
  }
}

/** Synchronous, and throws when it cannot be written: nothing may move until it is. */
export function saveCashlinkIntent(pubkey: string, intent: CashlinkIntent): void {
  const rest = loadCashlinkIntents(pubkey).filter((i) => i.id !== intent.id)
  localStorage.setItem(cashlinkIntentsKey(pubkey), JSON.stringify([...rest, intent]))
}

export function forgetCashlinkIntent(pubkey: string, id: string): void {
  try {
    const left = loadCashlinkIntents(pubkey).filter((i) => i.id !== id)
    if (left.length === 0) localStorage.removeItem(cashlinkIntentsKey(pubkey))
    else localStorage.setItem(cashlinkIntentsKey(pubkey), JSON.stringify(left))
  } catch {
    // Left listed: logout stays off, and the next run finds it finished and clears it.
  }
}

/** Coupon rows an unfinished intent still draws on: no other send may spend them. Never throws. */
export function cashlinkHeldTokenIds(pubkey: string): Set<string> {
  const held = new Set<string>()
  for (const intent of loadCashlinkIntents(pubkey)) {
    // Until its part is done with it: moving, or moved and the row not yet settled.
    for (const p of intent.parts) if (p.state !== 'unarmed' && !p.sourceSettled) held.add(p.sourceTokenId)
  }
  return held
}

/** The link keys of every unfinished intent: the restore scan never adopts them. */
export function cashlinkIntentLinkKeys(pubkey: string): Set<string> {
  return new Set(loadCashlinkIntents(pubkey).map((i) => i.k))
}

/**
 * Whether an intent's value is still moving: a part not yet locked or kept, a source row not yet
 * settled, or a locked wrap not yet on its link. One kept only to retry a refund deposit is not (its
 * gift is locked on the link). The same rule as `inFlightMoney`'s, which may import nothing.
 */
export function isMoving(intent: CashlinkIntent): boolean {
  return intent.parts.some((p) => {
    if (p.state === 'new' || p.state === 'arming') return true
    if ((p.state === 'kept' || p.state === 'locked') && !p.sourceSettled) return true
    return p.state === 'locked' && (p.wraps ?? []).some((w) => !(p.published ?? []).includes(w))
  })
}

/** The link keys of intents still moving: no settle touches them until the intent's run is done. */
export function movingCashlinkLinkKeys(pubkey: string): Set<string> {
  return new Set(loadCashlinkIntents(pubkey).filter(isMoving).map((i) => i.k))
}
