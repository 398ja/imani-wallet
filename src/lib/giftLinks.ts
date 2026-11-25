/**
 * Gift links, the wallet's side of them: allocate a link key, send, keep the row, watch it, take
 * it back, find it again after a restore, and claim one (claim links phase 4, spec 3.3).
 *
 * The pure parts (derivation, the link, fetch, verify) are in `giftLink.ts`. This module owns the
 * storage, the counter and the redeem. Nothing here logs a link secret.
 */
import type { TransactionRow } from '@imani/wallet-storage'
import { INDIVIDUAL_LIMITS } from '@imani/wallet-core'

import {
  combinedState,
  deriveLinkSecret,
  fetchGiftWraps,
  fetchGiftWrapsAnswer,
  formatGiftLink,
  giftCandidates,
  giftTokensFrom,
  linkPubOf,
  randomLinkSecret,
  secretFromText,
  secretToText,
  tokenState,
  verifyGift,
  type GiftToken,
  type GiftVerdict,
  type ProofState,
} from './giftLink'
import { legacyApi, withCorrelation } from './legacyBridge'
import { getSigner } from './nap'
import { ForeignVoucherRefusedError, isServerForeignRefusal, refuseForeignIssuer, refuseForeignVouchers, sessionAccount } from './merchantVouchers'
import { sendVouchers, type SendResult } from './pay'
import { publishTx } from './txRecords'
import { cashbackValidation } from './cashbackValidation'
import { checkTokenBacking, loadTrustedMints } from './trustedMint'
import { asGiftLinkRecord, buildSentTransaction, CASHLINK_TAKEN_BACK_MEMO, type GiftLinkRecord, type GiftLinkStatus } from './transactions'
import { creditableFaceValue, parseVoucherToken, tokenProofs, voucherOfSecret } from './voucherToken'
import { getWallet, notifyWalletChanged } from './wallet'
import type { Merchant } from './merchants'
import { tokenIdFrom } from '../../packages/wallet-storage/src/tokenId'
import { beginReceive, isReceiveDeferred, withSpend } from './receiveGate'
import { deriveRefundSecret, readLinkLock, xOnlyPub } from './cashlinkLock'
import {
  armGift,
  burntByThisWallet,
  cashlinkBundleId,
  claimLockedGift,
  lockedLocktime,
  lockedOnLink,
  recoverOrphanBurn,
  restoreFinding,
  retryDeposit,
  settleLockedGift,
  tokenStates,
  type ArmOutcome,
  type CashlinkPorts,
  type ReturnOutcome,
} from './cashlinkFlow'
import { CLAIM_RECHECK_AFTER_MS, isSingleReadClaim, isUnverifiedClaim, unconfirmedClaimLinks, type GiftLinkArm } from './transactions'
import { pendingSendsKey } from './inFlightMoney'
import { cashlinkIntentLinkKeys, movingCashlinkLinkKeys } from './cashlinkIntents'

/** #543: links a direct Cashlink of this account is still moving value onto. */
function directIntentLinks(): Set<string> {
  const pubkey = sessionAccount(getSigner)
  return pubkey ? movingCashlinkLinkKeys(pubkey) : new Set()
}
import { loadMerchant } from './merchant'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

// --- #295 phase 4 seams -----------------------------------------------------

/**
 * What the Cashlink return needs from the outside, behind one seam so tests drive every failure.
 * Loaded lazily: the real ports reach the relay and the mint, which a send that never arms (a
 * merchant, a remote signer) has no reason to load.
 */
export const cashlinkSeam = {
  ports: async (): Promise<CashlinkPorts> => (await import('./cashlinkPorts')).appCashlinkPorts(),
  markMoving: async (pubkey: string, id: string): Promise<void> => (await import('./cashlinkPorts')).markMoving(pubkey, id),
  clearMoving: async (pubkey: string, id: string): Promise<void> => (await import('./cashlinkPorts')).clearMoving(pubkey, id),
  /** #381: the mint gift coupons live at, for a NUT-07 check with no token in hand. */
  mintUrl: async (): Promise<string> => (await (await import('./config')).gatewayMintConfig()).mintUrl.trim().replace(/\/+$/, ''),
  /** #543: the direct path's ports, the coupon rows it plans over, and the bearer split for a split part. */
  directPorts: async (): Promise<import('./cashlinkDirect').DirectPorts> => (await import('./cashlinkDirectPorts')).appDirectPorts(),
  vouchers: async (): Promise<import('@imani/wallet-storage').VoucherRow[]> => getWallet().getAllVouchers(),
  split: async (pubkey: string, req: { tokenId: string; token: string; amount: number }): Promise<import('./voucherSplit').SplitOutcome> => {
    const [{ splitVoucher }, { appCheckoutPorts }] = await Promise.all([import('./voucherSplit'), import('./checkoutCodePorts')])
    return splitVoucher(appCheckoutPorts(), pubkey, req)
  },
  /** #543: a split's change is locked to this wallet's own key: made an ordinary coupon again. */
  unlockSelfLocked: async (pubkey: string): Promise<void> => {
    await (await import('./selfLockedCouponsApp')).unlockSelfLockedCouponsNow(pubkey)
  },
  isMerchant: (pubkey: string): boolean => {
    try {
      return loadMerchant(pubkey) !== null
    } catch {
      return false
    }
  },
}

const locksKey = (pubkey: string) => `imani-wallet:cashlink-locks:${pubkey}`

/** Signed link locks this device has seen, by gift secret. Not value: a lock is locked. */
function knownLocks(pubkey: string): Map<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(locksKey(pubkey)) ?? '{}') as Record<string, unknown>
    return new Map(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'))
  } catch {
    return new Map()
  }
}

function rememberLock(pubkey: string, giftSecret: string, signed: string): void {
  try {
    const all = Object.fromEntries(knownLocks(pubkey))
    all[giftSecret] = signed
    // Bounded: the gateway replays a lock to the identical request, so this is a convenience.
    const entries = Object.entries(all).slice(-50)
    localStorage.setItem(locksKey(pubkey), JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // A full store: the gateway's replay finds it instead.
  }
}

/**
 * #533: an arm puts a link's locked coupons on it as several wraps, so a run can stop after some of
 * them. Fewer locked proofs on the link than bearer proofs it locked from means the rest are minted
 * but on no wrap: the arm is resumed to deliver them (it replays every step by derivation), or
 * neither the claimer nor a take-back could ever reach them. A proof kept as sats instead of locked
 * also counts short, and costs one extra resume: the resumed arm leaves `arming` either way.
 */
function partlyDelivered(locked: GiftToken[], tokens: GiftToken[]): boolean {
  try {
    const count = (ts: GiftToken[]) => ts.reduce((n, t) => n + tokenProofs(t.token).length, 0)
    return count(locked) < count(giftCandidates(tokens))
  } catch {
    return false
  }
}

/**
 * The gift on this link locked to it with THIS wallet's refund key: the sender's own Cashlink.
 *
 * The link's public key is public (a wrap's p tag), and the lock route takes any link key, so a
 * stranger can lock a coupon of their own to this link with their own refund key and wrap it onto
 * it. Picking the first locked token would then settle the stranger's (refused as "not this
 * wallet's Cashlink" for ever) and the sender's own gift would never be settled or taken back
 * (rev-wallet377 M1). Empty when this wallet has no refund key for the link.
 */
function ownLockedOnLink(link: Pick<GiftLinkRecord, 'i'>, linkSecret: Uint8Array, tokens: GiftToken[]): GiftToken[] {
  const refundSecret = refundSecretFor(link)
  if (!refundSecret) return []
  try {
    const refundPub = xOnlyPub(refundSecret)
    const linkPub = linkPubOf(linkSecret)
    return lockedOnLink(giftCandidates(tokens, linkPub), linkPub).filter(({ token }) =>
      tokenProofs(token).every((p) => readLinkLock(p.secret)?.refundPub === refundPub),
    )
  } catch {
    return []
  } finally {
    refundSecret.fill(0)
  }
}

/** The refund key of a link, for an account whose key this wallet can read. Only those are armed. */
function refundSecretFor(link: Pick<GiftLinkRecord, 'i'>): Uint8Array | null {
  if (link.i === undefined) return null
  const id = identitySecret()
  if (!id) return null
  try {
    return deriveRefundSecret(id, link.i)
  } finally {
    id.fill(0)
  }
}

// ─── Limits (Q5) ─────────────────────────────────────────────────────────────

/**
 * Q5: no fee, at most this many outstanding links per wallet. The app is an individual's wallet, so
 * these are wallet-core's individual limits (#366): one source with the API senders' limits, so the
 * two cannot drift. Business senders (employers) send from a server with `@imani/cashlink-sender`.
 */
export const MAX_OUTSTANDING_LINKS = INDIVIDUAL_LIMITS.maxOutstanding

/** The restore scan's gap (spec 3.3): `i = 0 … last + 20`. */
export const RESTORE_GAP = INDIVIDUAL_LIMITS.restoreGap

export function tooManyLinksMessage(n = MAX_OUTSTANDING_LINKS): string {
  return `You have ${n} links waiting to be claimed. Take one back or wait for it to be claimed.`
}

/**
 * #295 phase 0: at most this many links past their expiry that have not come back yet.
 *
 * A link past `x` no longer counts against `MAX_OUTSTANDING_LINKS`, so an expired link that the
 * wallet could not take back (the voucher service was unreachable, say) stops blocking new ones.
 * Until the take-back is automatic (#295 phase 1 onwards) such a link can still be opened by whoever
 * holds it, which is exactly what the limit bounds (spec 6.7), so these are capped on their own.
 */
export const MAX_EXPIRED_UNRETURNED = INDIVIDUAL_LIMITS.maxExpiredUnreturned

export function tooManyExpiredMessage(n = MAX_EXPIRED_UNRETURNED): string {
  return `${n} of your Cashlinks have expired and have not come back yet. Keep Imani open for a minute so it can take them back, then try again.`
}

// ─── The counter ─────────────────────────────────────────────────────────────

const counterKey = (pubkey: string) => `imani-wallet:gift-link-next:${pubkey}`

/** The next unused index, per wallet, kept locally (spec 3.3). */
export function nextLinkIndex(pubkey: string): number {
  try {
    const n = Number(localStorage.getItem(counterKey(pubkey)))
    return Number.isSafeInteger(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

/** Never moves backwards: an index once used is never handed out again. */
export function advanceLinkIndex(pubkey: string, past: number): void {
  try {
    if (past + 1 > nextLinkIndex(pubkey)) localStorage.setItem(counterKey(pubkey), String(past + 1))
  } catch {
    // A full store: the restore scan still finds what was sent, and the next send re-derives the
    // same index only if this write failed, which `allocateLink` guards against with the rows.
  }
}

/**
 * Whether this wallet's key is readable here, so link keys can be derived from it. An account whose
 * key lives in a remote signer cannot, and gets a random secret instead (spec 3.3), stored on the
 * row and so in the encrypted history backup.
 */
function identitySecret(): Uint8Array | null {
  try {
    return getSigner().withPrivkey((key) => Uint8Array.from(key))
  } catch {
    return null
  }
}

export interface AllocatedLink {
  secret: Uint8Array
  linkPub: string
  i?: number
}

/**
 * The next link key. Derived at the next index no row of this wallet already uses (a counter lost
 * with the browser storage must not hand out a link that is still outstanding), or random when
 * the key cannot be read.
 */
export function allocateLink(pubkey: string, usedIndices: ReadonlySet<number>): AllocatedLink {
  const id = identitySecret()
  if (!id) {
    const secret = randomLinkSecret()
    return { secret, linkPub: linkPubOf(secret) }
  }
  try {
    let i = nextLinkIndex(pubkey)
    while (usedIndices.has(i)) i += 1
    const secret = deriveLinkSecret(id, i)
    return { secret, linkPub: linkPubOf(secret), i }
  } finally {
    id.fill(0)
  }
}

// ─── Rows ────────────────────────────────────────────────────────────────────

/** How many derived indices a send skips past (each one already holding a wrap) before giving up. */
const MAX_INDEX_PROBES = 64

/**
 * The next link key that is unused AT THE RELAY, not only on this device (review of #247, F3).
 *
 * The local counter and rows are gone after a logout (`sweepAppStorage`, `wipeWallet`), on a restored
 * or second device, and until start-up's history restore and scan have run. Allocating from them alone
 * re-derived i = 0 for a new gift while gift 0 was still unclaimed: two coupons on one bearer key, so
 * whoever opened either link took both. So every derived index is checked for wraps first and skipped
 * (and reserved) while it has any. A check that cannot complete refuses the send: "unknown" is not
 * "unused", and nothing has moved yet. A random secret (remote signer) needs no check.
 */
export async function unusedLink(
  pubkey: string,
  usedIndices: ReadonlySet<number>,
  wrapsAt: (secret: Uint8Array) => Promise<unknown[]> = fetchGiftWraps,
): Promise<AllocatedLink> {
  const used = new Set(usedIndices)
  for (let probe = 0; probe < MAX_INDEX_PROBES; probe++) {
    const allocated = allocateLink(pubkey, used)
    if (allocated.i === undefined) return allocated
    // Reserved BEFORE the await, so a second send started meanwhile (this tab or another) never
    // derives the same index. A probe that then fails leaves a gap, never a reuse.
    advanceLinkIndex(pubkey, allocated.i)
    used.add(allocated.i)
    let wraps: unknown[]
    try {
      wraps = await wrapsAt(allocated.secret)
    } catch {
      throw new Error('Could not check the link with the voucher service. Nothing has been sent; try again.')
    }
    if (wraps.length === 0) return allocated
    // Somebody (this wallet, before a wipe) already used this key: never again. Already reserved.
  }
  throw new Error('Could not find a free link. Nothing has been sent; try again later.')
}

export interface LinkRow {
  id: string
  row: TransactionRow
  link: GiftLinkRecord
}

/** Every `sent` row with a link, oldest first. */
export async function linkRows(): Promise<LinkRow[]> {
  const rows = await getWallet().getAllTransactions()
  const out: LinkRow[] = []
  for (const row of rows) {
    const r = row as unknown as Record<string, unknown>
    if (r.type !== 'sent') continue
    const link = asGiftLinkRecord(r.link)
    if (link) out.push({ id: String(r.id), row, link })
  }
  return out.sort((a, b) => Number((a.row as { timestamp?: number }).timestamp ?? 0) - Number((b.row as { timestamp?: number }).timestamp ?? 0))
}

/** Distinct links (a bundle writes one row per part, all with the same link). */
export function distinctLinks(rows: LinkRow[]): Map<string, LinkRow[]> {
  const byKey = new Map<string, LinkRow[]>()
  for (const r of rows) byKey.set(r.link.k, [...(byKey.get(r.link.k) ?? []), r])
  return byKey
}

export interface LinkCounts {
  /** Outstanding and before `x`: can still be claimed. What `MAX_OUTSTANDING_LINKS` limits. */
  waiting: number
  /** Outstanding but past `x`: not taken back yet. What `MAX_EXPIRED_UNRETURNED` limits. */
  expiredUnreturned: number
}

/** The two counts the limits read (#295 phase 0), from rows already loaded. */
export function countLinks(rows: LinkRow[], nowMs = Date.now()): LinkCounts {
  const now = Math.floor(nowMs / 1000)
  let waiting = 0
  let expiredUnreturned = 0
  for (const parts of distinctLinks(rows).values()) {
    if (!parts.some((p) => p.link.status === 'outstanding')) continue
    // #379: the link's own row (an adopted duplicate's expiry was a guess).
    const link = openLinkOf(parts)
    if (now < link.x) waiting += 1
    // #295 phase 4: past its expiry, an armed link is already on its way back without this wallet
    // (and the mint refuses a late claim once it has), so it bounds nothing and is not counted.
    else if (link.arm?.s === 'armed' || link.arm?.s === 'returning') continue
    else expiredUnreturned += 1
  }
  return { waiting, expiredUnreturned }
}

export async function linkCounts(nowMs = Date.now()): Promise<LinkCounts> {
  return countLinks(await linkRows(), nowMs)
}

/** Links that can still be claimed: outstanding and before their expiry. */
export async function outstandingLinkCount(nowMs = Date.now()): Promise<number> {
  return (await linkCounts(nowMs)).waiting
}

/** Why a new link is refused right now, or null when one may be made. */
export function linkLimitMessage(counts: LinkCounts): string | null {
  if (counts.waiting >= MAX_OUTSTANDING_LINKS) return tooManyLinksMessage()
  if (counts.expiredUnreturned >= MAX_EXPIRED_UNRETURNED) return tooManyExpiredMessage()
  return null
}

/**
 * What opening Send by link runs (#295 phase 0): settle every link (claimed ones marked, expired ones
 * taken back), then count. So a sender whose ten links have all expired can make an eleventh as soon
 * as the screen opens, not only after a restart. Never throws: the reconcile swallows its own errors.
 */
export async function settleAndCountLinks(
  nowMs = Date.now(),
  state: (token: string) => Promise<ProofState> = tokenState,
  budgetMs = SETTLE_BUDGET_MS,
): Promise<LinkCounts> {
  if (await settleWithin(nowMs, state, budgetMs)) lastSettledAt = Date.now()
  return linkCounts(nowMs)
}

/**
 * #540 F1: when the Send by link screen last finished its settle (wall clock, ms). `sendGift` does
 * not settle again within `RECENT_SETTLE_MS` of it: the same links were checked seconds ago, and
 * the limit is still judged from freshly read rows. Only a settle that finished counts; one cut
 * short by the budget is still running and proves nothing yet.
 */
let lastSettledAt: number | undefined
export const RECENT_SETTLE_MS = 60_000

/**
 * How long Send waits for the settle before counting what is stored (review of #367). Each link is a
 * relay query, a mint check and maybe a receive, none with its own deadline, so a slow gateway
 * would otherwise hold "Checking your vouchers…" (and the send) for as long as the browser waits.
 * The settle carries on in the background; only the wait is cut short.
 */
export const SETTLE_BUDGET_MS = 8_000

/** Settle, waiting at most `budgetMs`. True when the settle finished within it. */
async function settleWithin(nowMs: number, state: (token: string) => Promise<ProofState>, budgetMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reconcileGiftLinks(nowMs, state).then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), budgetMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One link-record write at a time in this tab (second check of #367). Each write re-reads the record
 * and then writes it; two of those interleaved (both read `outstanding`, both write) let the last
 * one win whatever it says. The chain makes each read-then-write atomic against the others.
 */
let linkWrites: Promise<unknown> = Promise.resolve()
function serialised<T>(run: () => Promise<T>): Promise<T> {
  const next = linkWrites.then(run, run)
  linkWrites = next.catch(() => undefined)
  return next
}

function setLinkStatus(rows: LinkRow[], status: GiftLinkStatus, at = Date.now(), extra: Partial<GiftLinkRecord> = {}): Promise<void> {
  // #379: every "claimed" this module writes has been decided by the mint (the gift is spent, and
  // not into this wallet's own outputs), so it is recorded as confirmed. #261: except one resting on
  // a single SPENT checkstate, which says so (`claimReason`) and is read again on a later pass.
  const confirmed = status === 'claimed' && extra.claimReason === undefined ? { verifiedAt: at, ...extra } : extra
  return serialised(() => writeLinkStatus(rows, status, at, confirmed))
}

/** #261: a claim decided by one SPENT checkstate: why and when, so a later read can undo it. */
function spentReadClaim(at: number): Partial<GiftLinkRecord> {
  return { claimReason: 'mint-spent', spentSeenAt: at }
}

/**
 * #261: the second read of a claim that rested on one SPENT checkstate. Every bearer gift still
 * SPENT confirms it (`verifiedAt`); every one UNSPENT opens the link again, so the take-back it
 * stopped can run; anything else (the mint unreachable, PENDING, a mix) leaves it for the next pass.
 */
async function recheckSpentRead(rows: LinkRow[], tokens: GiftToken[], state: (token: string) => Promise<ProofState>, nowMs: number): Promise<'open' | 'left'> {
  const link = rows.map((r) => r.link).find(isSingleReadClaim)
  if (!link || nowMs - (link.spentSeenAt ?? 0) < CLAIM_RECHECK_AFTER_MS) return 'left'
  const gifts = giftCandidates(tokens)
  if (gifts.length === 0) return 'left'
  const states = await Promise.all(gifts.map((t) => state(t.token)))
  if (states.every((s) => s === 'SPENT')) {
    await confirmSpentRead(rows, nowMs)
    return 'left'
  }
  if (states.every((s) => s === 'UNSPENT')) {
    await reopenSpentRead(rows)
    return 'open'
  }
  return 'left'
}

/** #261: the second SPENT read agrees: the claim stands, confirmed. */
function confirmSpentRead(rows: LinkRow[], at: number): Promise<void> {
  return serialised(async () => {
    const wallet = getWallet()
    const fresh = await currentLinks()
    for (const r of rows) {
      const now = fresh.get(r.id) ?? r.link
      if (!isSingleReadClaim(now)) continue
      const merged = await wallet.updateTransaction(r.id, { link: { ...now, verifiedAt: at } } as unknown as Partial<TransactionRow>)
      if (merged) void publishTx(merged)
    }
    notifyWalletChanged()
  })
}

/** #261: the mint now says UNSPENT: the claim is undone and the link is outstanding again. */
function reopenSpentRead(rows: LinkRow[]): Promise<void> {
  return serialised(async () => {
    const wallet = getWallet()
    const fresh = await currentLinks()
    for (const r of rows) {
      const now = fresh.get(r.id) ?? r.link
      if (!isSingleReadClaim(now)) continue
      const { closedAt: _c, claimReason: _r, spentSeenAt: _s, ...rest } = now
      void _c
      void _r
      void _s
      const link: GiftLinkRecord = { ...rest, status: 'outstanding' }
      const merged = await wallet.updateTransaction(r.id, { link } as unknown as Partial<TransactionRow>)
      if (merged) void publishTx(merged)
    }
    console.warn('[gift] a Cashlink closed as claimed on one SPENT read is UNSPENT now; opened again')
    notifyWalletChanged()
  })
}

/**
 * #379: open again a link an older build closed as "claimed" without the mint saying so, with what
 * this run found (its arm state, and the lock's locktime as `x`). Only a record still in that state
 * is changed; a settle that closed it properly meanwhile stands. Every row of the link is opened,
 * including a duplicate a restore scan adopted, so the link reads the same everywhere.
 */
function reopenLink(rows: LinkRow[], patch: { arm: GiftLinkArm | undefined; x?: number }): Promise<void> {
  return serialised(async () => {
    const wallet = getWallet()
    const fresh = await currentLinks()
    for (const r of rows) {
      const now = fresh.get(r.id) ?? r.link
      if (!isUnverifiedClaim(now) && now.status !== 'outstanding') continue
      const { arm: _a, closedAt: _c, ...rest } = now
      void _a
      void _c
      const link: GiftLinkRecord = { ...rest, status: 'outstanding', ...(patch.x !== undefined ? { x: patch.x } : {}), ...(patch.arm ? { arm: patch.arm } : {}) }
      const merged = await wallet.updateTransaction(r.id, { link } as unknown as Partial<TransactionRow>)
      if (merged) void publishTx(merged)
    }
    notifyWalletChanged()
  })
}

/** #379: record that a "claimed" link was checked and really was claimed. */
function confirmClaim(rows: LinkRow[], at = Date.now()): Promise<void> {
  return serialised(async () => {
    const wallet = getWallet()
    const fresh = await currentLinks()
    for (const r of rows) {
      const now = fresh.get(r.id) ?? r.link
      if (!isUnverifiedClaim(now)) continue
      const merged = await wallet.updateTransaction(r.id, { link: { ...now, verifiedAt: at } } as unknown as Partial<TransactionRow>)
      if (merged) void publishTx(merged)
    }
    notifyWalletChanged()
  })
}

/**
 * #379: a locked link's expiry IS its lock's locktime. A row that says otherwise (adopted by a restore
 * scan that raced the send, with "30 days from now") is corrected, on every row of the link.
 */
function syncLinkExpiry(rows: LinkRow[], x: number): Promise<void> {
  if (rows.every((r) => r.link.x === x)) return Promise.resolve()
  return serialised(async () => {
    const wallet = getWallet()
    const fresh = await currentLinks()
    for (const r of rows) {
      const now = fresh.get(r.id) ?? r.link
      if (now.x === x) continue
      const merged = await wallet.updateTransaction(r.id, { link: { ...now, x } } as unknown as Partial<TransactionRow>)
      if (merged) void publishTx(merged)
    }
    notifyWalletChanged()
  })
}

/** Record a link's return state (#295 phase 4) without closing it. Only on a link still open. */
function setLinkArm(rows: LinkRow[], arm: GiftLinkArm | undefined): Promise<void> {
  return serialised(async () => {
    const wallet = getWallet()
    const fresh = await currentLinks()
    for (const r of rows) {
      const now = fresh.get(r.id) ?? r.link
      if (now.status !== 'outstanding') continue
      const { arm: _old, ...rest } = now
      void _old
      const link: GiftLinkRecord = arm ? { ...rest, arm } : rest
      const merged = await wallet.updateTransaction(r.id, { link } as unknown as Partial<TransactionRow>)
      if (merged) void publishTx(merged)
    }
    notifyWalletChanged()
  })
}

async function writeLinkStatus(rows: LinkRow[], status: GiftLinkStatus, at: number, extra: Partial<GiftLinkRecord>): Promise<void> {
  const wallet = getWallet()
  const fresh = await currentLinks()
  for (const r of rows) {
    // Review of #367: `rows` is a snapshot taken before a relay query, a mint check and a receive.
    // Another settle (start-up, Send, the hourly pass, History) may have closed the link meanwhile;
    // its answer stands. Otherwise a take-back lost to our own earlier take-back reads "already
    // redeemed" and would relabel "Taken back" as "Claimed".
    const now = fresh.get(r.id) ?? r.link
    // Second check of #367: the order the two settles finish in is not the order they won in. The
    // loser's "already redeemed in another session" can come back before the winner has saved, so
    // a `claimed` may land first. `reclaimed` is the one answer that is certain (this wallet holds
    // the value), so it corrects any other close; nothing else overwrites a closed link.
    if (now.status !== 'outstanding' && !(status === 'reclaimed' && now.status !== 'reclaimed')) continue
    const link: GiftLinkRecord = { ...now, ...extra, status, closedAt: at }
    const merged = await wallet.updateTransaction(r.id, { link } as unknown as Partial<TransactionRow>)
    if (merged) void publishTx(merged)
  }
  notifyWalletChanged()
}

/** Every link record as stored right now, by row id. */
async function currentLinks(): Promise<Map<string, GiftLinkRecord>> {
  return new Map((await linkRows()).map((r) => [r.id, r.link]))
}

/**
 * Record that the "Cashlink expired" notice was filed (#295 phase 0), on the link's own record so the
 * encrypted history carries it to a restored or second device. Status and close time are untouched:
 * the record is re-read first, so a take-back that landed while the notice was filed is kept.
 */
export function markLinksNoticed(rows: LinkRow[], at = Date.now()): Promise<void> {
  return serialised(() => writeLinksNoticed(rows, at))
}

async function writeLinksNoticed(rows: LinkRow[], at: number): Promise<void> {
  const wallet = getWallet()
  const fresh = await currentLinks()
  for (const r of rows) {
    const now = fresh.get(r.id) ?? r.link
    if (now.noticedAt !== undefined) continue
    const link: GiftLinkRecord = { ...now, noticedAt: at }
    const merged = await wallet.updateTransaction(r.id, { link } as unknown as Partial<TransactionRow>)
    if (merged) void publishTx(merged)
  }
}

// ─── Send ────────────────────────────────────────────────────────────────────

export interface GiftSent {
  result: SendResult
  link: string
  x: number
  /**
   * #295 phase 4: whether the link comes back on its own if nobody claims it. False means it comes
   * back the next time this wallet runs after its expiry, as before (the service may be off).
   */
  returnsOnItsOwn?: boolean
}

/**
 * Send by link (spec 3.3 send, 4.2). Refuses past Q5's limit before anything moves. The ordinary
 * atomic send carries the coupon to the link key; `refuseIfWrongMerchant` passes because a fresh
 * key has no merchant record. Once COMPLETED, the wrap is fetched back and unwrapped with the
 * secret (the delivery check), and the link is returned for the screen to show.
 */
export async function sendGift({
  payer,
  merchant,
  unit,
  amount,
  memo,
  x,
  walletOrigin = window.location.origin,
  nowMs = Date.now(),
  state = tokenState,
  settleBudgetMs = SETTLE_BUDGET_MS,
}: {
  payer: string
  merchant: Merchant
  unit: string
  amount: number
  memo?: string
  /** The link's expiry, unix seconds, already capped (`giftExpiry`). */
  x: number
  walletOrigin?: string
  /** The clock and the NUT-07 check the reconcile uses; seams for tests. */
  nowMs?: number
  state?: (token: string) => Promise<ProofState>
  settleBudgetMs?: number
}): Promise<GiftSent & { delivered: boolean }> {
  // Owner rule 2026-10-13: a merchant account takes only its own stall's vouchers, so it could never
  // take a link of another stall's coupon back (reclaim is a receive). Refused before anything moves.
  // Own-stall coupons are already excluded from gifts (spec 4.2), so a merchant gifts nothing.
  const issuer = typeof merchant?.pubkey === 'string' ? merchant.pubkey.toLowerCase() : ''
  if (issuer && issuer !== payer.toLowerCase()) {
    await refuseForeignIssuerForGift(issuer, payer)
  }
  // #295 phase 0: settle every link first. A link that was claimed is marked, and one past its
  // expiry is taken back, so neither blocks this send. Never throws, and waits at most
  // `settleBudgetMs`. #540 F1: skipped when the Send screen finished the same settle moments ago.
  if (lastSettledAt === undefined || Date.now() - lastSettledAt > RECENT_SETTLE_MS) {
    await settleWithin(nowMs, state, settleBudgetMs)
  }
  const rows = await linkRows()
  const refusal = linkLimitMessage(countLinks(rows, nowMs))
  if (refusal) throw new Error(refusal)

  const used = new Set(rows.map((r) => r.link.i).filter((i): i is number => i !== undefined))
  const allocated = await unusedLink(payer, used)
  const k = secretToText(allocated.secret)
  const link = formatGiftLink(walletOrigin, allocated.secret, x)
  if (!link) throw new Error('Could not make a link for this wallet.')
  // Reserved BEFORE the send: a send that ends with its outcome unknown must still never reuse the
  // index (that link key may hold the coupon).
  if (allocated.i !== undefined) advanceLinkIndex(payer, allocated.i)

  const record: GiftLinkRecord = { k, x, status: 'outstanding', ...(allocated.i !== undefined ? { i: allocated.i } : {}) }
  // #379: from here until the arm has finished, no settle and no restore scan in this tab touches it.
  linksInFlight.add(k)
  sendingNow.add(k)
  let sendDone!: () => void
  sendsRunning.set(k, new Promise<void>((r) => (sendDone = r)))
  try {
  // #543: locked from the start when it can be, decided before anything moves; otherwise the
  // legacy path below (atomic send, bearer gift, then arm), exactly as before.
  // #543 review: a counted spend (#335), as the legacy send is through `deliver`. Logout closes spends
  // and waits for one running, so it can never wipe the wallet between a burn and its intent's save.
  const direct = await withSpend(() => tryDirect({ payer, merchant, unit, amount, memo, x, i: allocated.i, nowMs }))
  if (direct.kind === 'made') {
    console.info('[cashlink] path=direct')
    // #543 review: a wrap still not on the link (the relay out of reach through every try) is tried
    // again in the background within the minute the screen promises, not only at the next start.
    if (!direct.published) scheduleIntentRetry(payer)
    return {
      // #543 review: the bundle id the rows share, never `k` (the link's bearer secret).
      result: { id: cashlinkBundleId(allocated.linkPub), requested: amount, delivered: direct.delivered, parts: direct.parts, ...(direct.delivered < amount ? { shortfall: 'part of it could not be locked; its value is kept in your wallet' } : {}) },
      link,
      x,
      delivered: direct.published,
      returnsOnItsOwn: direct.armed,
    }
  }
  console.info(`[cashlink] path=legacy why=${direct.why}`)
  const result = await sendVouchers({
    payer,
    recipient: { pubkey: allocated.linkPub, name: 'Link' },
    merchant,
    unit,
    amount,
    memo,
    link: record,
  })

  // The delivery check (spec 3.3 send step 3). A miss is reported, not fatal: the gift wrap can
  // reach the gateway's cache a moment after COMPLETED, and the recipient's wallet queries again.
  // #540 F3: the tokens this read found are handed to the arm, which used to read the link a second
  // time straight after. A hit costs no sleep; only a miss waits and reads again.
  let delivered = false
  let onLink: GiftToken[] = []
  for (let attempt = 0; attempt < 5 && !delivered; attempt++) {
    try {
      onLink = await giftTokensFrom(allocated.secret, await fetchGiftWraps(allocated.secret))
      delivered = onLink.length > 0
    } catch {
      delivered = false
    }
    if (!delivered && attempt < 4) await new Promise((r) => setTimeout(r, 1500))
  }
  // #295 phase 4: lock the gift to its link and leave its take-back with the voucher service, so it
  // comes back on its own. Only once it is on the link, only for an account whose key this wallet
  // can read (the refund key is derived from it), and never for a merchant (owner scope: a stall's
  // expired Cashlinks lapse). Anything that stops it leaves the link exactly as it is.
  let returnsOnItsOwn = false
  if (delivered && allocated.i !== undefined && !cashlinkSeam.isMerchant(payer)) {
    returnsOnItsOwn = (await armLink(payer, k, allocated.secret, allocated.i, x, onLink)).kind === 'armed'
  }
  return { result, link, x, delivered, returnsOnItsOwn }
  } finally {
    sendingNow.delete(k)
    linksInFlight.delete(k)
    sendsRunning.delete(k)
    sendDone()
  }
}

/**
 * #379: the links this tab is sending or arming right now, by link key. Every settle (start-up,
 * History, Send, the hourly pass) and the restore scan leave them alone until that finishes: a
 * snapshot taken before the lock reads our own burn of the bearer gift as "claimed", and the restore
 * scan, which cannot yet see the send's row, would adopt the link a second time with a made-up expiry.
 */
const linksInFlight = new Set<string>()
/**
 * #401: the settle running for each link. Overlapping reconcile runs wait on it and re-read the
 * link's rows, so two runs never settle the same link at once (that lost a cent under latency).
 */
const linkSettles = new Map<string, Promise<void>>()
/** Tests only: forget settles a previous test left pending. */
export function resetLinkSettlesForTests(): void {
  linkSettles.clear()
  lastSettledAt = undefined
}
/**
 * #401: how many links one reconcile run checks at once. Two, so one slow take-back never holds up
 * the others, without filling the browser's few connections to the gateway (start-up and the open
 * History row can each run a check at the same time).
 */
export const RECONCILE_CONCURRENCY = 2
/** The newest row time of a link (newest links are checked first). */
const newestOf = (parts: LinkRow[]): number => Math.max(...parts.map((p) => Number(p.row.timestamp) || 0))

/**
 * Arm (or resume arming) one link, recording each step on its row. Never throws.
 */
async function armLink(
  pubkey: string,
  k: string,
  linkSecret: Uint8Array,
  i: number,
  x: number,
  /** #540 F3: the link's tokens, read by the caller just now; read here when not given. */
  onLink?: GiftToken[],
): Promise<ArmOutcome> {
  const refundSecret = refundSecretFor({ i })
  if (!refundSecret) return { kind: 'unarmed', why: 'not_lockable' }
  linksInFlight.add(k)
  try {
    const rowsNow = () => linkRows().then((all) => all.filter((r) => r.link.k === k))
    const rows = await rowsNow()
    if (rows.length === 0) return { kind: 'unarmed', why: 'no_gift' }
    const id = rows[0].id
    const tokens = giftCandidates(onLink ?? (await giftTokensForSecret(linkSecret)))
    const ports = await cashlinkSeam.ports()
    // #379: resumed whenever any row of the link says `arming`, with or without its keyset. A resume
    // never re-runs the pre-check, which would read our own burn as a claim.
    const prior = rows.find((r) => r.link.arm?.s === 'arming')?.link.arm
    const outcome = await armGift({
      ports,
      linkSecret,
      refundSecret,
      x,
      gifts: tokens,
      merchant: cashlinkSeam.isMerchant(pubkey),
      knownLocks: knownLocks(pubkey),
      ...(prior ? { resuming: true } : {}),
      ...(prior?.ks ? { burnKeyset: prior.ks } : {}),
      onArming: async (ks) => {
        // Written before the burn, and logout stays off until it is cleared: from the burn on, the
        // value is moving and only this wallet (or its restore) finishes it.
        await cashlinkSeam.markMoving(pubkey, id)
        await setLinkArm(await rowsNow(), { s: 'arming', ks })
      },
      onLocked: async (giftSecret, signed) => rememberLock(pubkey, giftSecret, signed),
    })
    const fresh = await rowsNow()
    switch (outcome.kind) {
      case 'armed':
        await setLinkArm(fresh, { s: 'armed', ks: outcome.keyset })
        await cashlinkSeam.clearMoving(pubkey, id)
        break
      case 'not_armed':
        // Locked to the link, but nothing waits at the voucher service: this wallet takes it back.
        await setLinkArm(fresh, { s: 'not_armed', ...(outcome.keyset ? { ks: outcome.keyset } : {}) })
        await cashlinkSeam.clearMoving(pubkey, id)
        break
      case 'claimed':
        await setLinkStatus(fresh, 'claimed')
        await cashlinkSeam.clearMoving(pubkey, id)
        break
      case 'kept_as_sats':
        // The gift could not be locked after it was burnt; its value is back in this wallet.
        await setLinkStatus(fresh, 'reclaimed', Date.now(), { noticedAt: Date.now() })
        await cashlinkSeam.clearMoving(pubkey, id)
        break
      case 'arming':
        // Part way: left as it is, and finished on the next run.
        break
      case 'unarmed':
        // The mint refused the burn outright after `onArming` (rev-wallet377 M2): nothing moved,
        // so the link is the ordinary gift it was. Clear `arming`, or every run would retry it.
        if (outcome.why === 'burn_refused') {
          await setLinkArm(fresh, undefined)
          await cashlinkSeam.clearMoving(pubkey, id)
        }
        break
    }
    return outcome
  } catch (error) {
    console.warn('[gift] could not finish arming a Cashlink yet', error instanceof Error ? error.name : 'error')
    return { kind: 'arming', why: 'error' }
  } finally {
    refundSecret.fill(0)
    // The send that started this keeps the key listed until it returns (sendGift's own finally).
    if (!sendingNow.has(k)) linksInFlight.delete(k)
  }
}

/** Links whose send (not only the arm) is still running in this tab. */
const sendingNow = new Set<string>()
/**
 * The send-and-arm of each link still running in this tab, so a "Take it back" tapped during it
 * waits for it (see `takeBack`).
 */
const sendsRunning = new Map<string, Promise<void>>()

/**
 * How long a "Take it back" waits for its own link's send and arm. They finish in seconds; the cap
 * only stops a hung send from holding the tap forever.
 */
export const TAKE_BACK_WAITS_FOR_SEND_MS = 90_000

/**
 * #543: what Send by link warms while the amount is typed: the mint (its keyset and keys) and the
 * modules the direct path loads on demand. Never throws, never blocks.
 */
export async function warmCashlinkPath(): Promise<void> {
  try {
    const [{ warmMint }, { trustedMintUrls }] = await Promise.all([import('./cashlinkFlow'), import('./trustedMint'), import('./cashlinkDirect'), import('./cashlinkDirectPorts'), import('./voucherSplit'), import('./checkoutCodePorts')])
    for (const url of trustedMintUrls()) warmMint(url)
  } catch {
    // Only a cold cache.
  }
}

type DirectTry =
  | { kind: 'made'; delivered: number; parts: number; published: boolean; armed: boolean }
  | { kind: 'legacy'; why: string }

/**
 * Whether `sendGift` will try the locked path (#543) for this payer, as `tryDirect` decides: not a
 * merchant, and a key this wallet can read (a derived link index). For the confirm screen's figure.
 */
export function cashlinkDirectOpen(payer: string): boolean {
  if (cashlinkSeam.isMerchant(payer)) return false
  const id = identitySecret()
  if (!id) return false
  id.fill(0)
  return true
}

/**
 * #543: make the Cashlink locked from the start (`cashlinkDirect.ts`), or say why not while nothing
 * has moved, so the caller takes the legacy path. Throws only once value has moved and no link can
 * be shown (all of it kept as sats, or part way: the next start finishes it).
 */
async function tryDirect(req: { payer: string; merchant: Merchant; unit: string; amount: number; memo?: string; x: number; i: number | undefined; nowMs: number }): Promise<DirectTry> {
  // Keep in step with `cashlinkDirectOpen`, which tells the confirm screen which path this takes.
  if (cashlinkSeam.isMerchant(req.payer)) return { kind: 'legacy', why: 'merchant' }
  if (req.i === undefined) return { kind: 'legacy', why: 'remote_signer' }
  let rows: import('@imani/wallet-storage').VoucherRow[]
  try {
    rows = await cashlinkSeam.vouchers()
  } catch {
    return { kind: 'legacy', why: 'no_plan' }
  }
  if (rows.length === 0) return { kind: 'legacy', why: 'no_plan' }
  const direct = await import('./cashlinkDirect')
  const nowS = Math.floor(req.nowMs / 1000)
  let plan
  try {
    plan = direct.planDirectParts({ rows, payer: req.payer, stall: req.merchant.pubkey, unit: req.unit, amount: req.amount, x: req.x, nowS })
  } catch {
    plan = null
  }
  if (!plan) return { kind: 'legacy', why: 'no_plan' }
  const ports = await cashlinkSeam.directPorts()
  // A part no subset of proofs can make is split first (its own crash-safe intent, #402).
  const splitting = plan.find((p) => p.needsSplit)
  let made: Array<{ tokenId: string; token: string; amount: number; faceValue: number }> = []
  if (splitting) {
    const out = await cashlinkSeam.split(req.payer, { tokenId: splitting.row.token_id, token: splitting.row.token, amount: splitting.amount })
    if (out.kind === 'refused') return { kind: 'legacy', why: 'split_refused' }
    if (out.kind === 'kept_as_sats') throw new Error('Your voucher could not be split. Its value is still in your wallet, now as sats. Nothing was sent.')
    if (out.kind === 'pending') throw new Error('Your voucher is being split. It is safe, and it finishes the next time Imani opens. Try again in a moment.')
    made = out.parts
  }
  const parts = plan.flatMap((p) => (p.needsSplit ? made : [{ tokenId: p.row.token_id, token: p.row.token, amount: p.amount, faceValue: p.faceValue }]))
  const out = await direct.startDirectCashlink({
    ports,
    pubkey: req.payer,
    i: req.i,
    x: req.x,
    stall: req.merchant.pubkey,
    ...(req.merchant.name && req.merchant.name !== req.merchant.pubkey ? { merchantName: req.merchant.name } : {}),
    unit: req.unit,
    decimals: plan[0].row.face_decimals ?? 2,
    amount: req.amount,
    ...(req.memo ? { memo: req.memo } : {}),
    parts,
  })
  if (splitting) {
    // The legacy send cannot spend a coupon locked to this wallet's own key: unlocked first then.
    const unlocking = cashlinkSeam.unlockSelfLocked(req.payer).catch(() => undefined)
    if (out.kind === 'legacy') await unlocking
  }
  if (out.kind === 'legacy') return out
  if (out.kind === 'made') return { kind: 'made', delivered: out.delivered, parts: parts.length, published: out.published, armed: out.armed }
  if (out.kind === 'nothing') throw new Error('The Cashlink could not be made. Its value is still in your wallet, now as sats.')
  throw new Error('Your Cashlink is still being made. It is safe, and it finishes the next time Imani opens.')
}

async function refuseForeignIssuerForGift(issuer: string, payer: string): Promise<void> {
  try {
    await refuseForeignIssuer(issuer, payer)
  } catch (e) {
    if (e instanceof ForeignVoucherRefusedError) {
      throw new Error(
        e.reason === 'merchant'
          ? 'A merchant account cannot send another stall\u2019s voucher as a Cashlink: it could not take it back. Send it to a customer instead.'
          : e.message,
      )
    }
    throw e
  }
}

/** The link for a stored row, to show again. */
export function linkFor(record: GiftLinkRecord, walletOrigin = window.location.origin): string | null {
  const secret = secretFromText(record.k)
  return secret ? formatGiftLink(walletOrigin, secret, record.x) : null
}

// ─── Redeem (claim and reclaim) ──────────────────────────────────────────────

export type GiftRedeemOutcome =
  | { kind: 'ok' }
  | { kind: 'claimed' }
  | { kind: 'held' }
  | { kind: 'failed'; message: string }
  /** Owner rule 2026-10-13: a merchant account and another stall's voucher. Nothing was swapped. */
  | { kind: 'merchant_refused'; reason: 'merchant' | 'unknown' }

/**
 * Receive gift tokens into this wallet. `gift_link` for a recipient, `gift_link_reclaim` for the
 * sender taking it back (spec 3.3). The backing is checked before anything is swapped, as for
 * cashback: a token at a mint this wallet does not trust is never received. The issuer signature
 * is recorded on the row (`cashbackValidation`). No declaration header is sent (D9): the legacy
 * receive never adds one, and this path adds nothing.
 */
export async function redeemGiftTokens(
  tokens: GiftToken[],
  source: 'gift_link' | 'gift_link_reclaim',
  /** The link's key, text form. Needed for a gift locked to its link (#295 phase 4). */
  key?: string,
  /** A take-back: the id of the `sent` row that made the Cashlink, linked from the return's row. */
  returnOf?: string,
): Promise<GiftRedeemOutcome> {
  await loadTrustedMints()
  for (const { token } of tokens) {
    if (checkTokenBacking(token).outcome !== 'accept') return { kind: 'held' }
  }
  // Owner rule 2026-10-13: a merchant account takes only its own stall's vouchers. Before any swap,
  // so a refused gift stays on its link for a customer account (or for the sender to take back).
  const account = sessionAccount(getSigner)
  if (account) {
    try {
      await refuseForeignVouchers(tokens.map((t) => t.token), account)
    } catch (e) {
      if (e instanceof ForeignVoucherRefusedError) return { kind: 'merchant_refused', reason: e.reason }
      throw e
    }
  }
  await legacyApi()
  const redemption = window.TokenRedemption
  if (!redemption) return { kind: 'failed', message: 'This wallet could not start the receive.' }
  // The receive gate (#331), before the first swap: once logout has started,
  // nothing is swapped and the gift stays on its link for the next try.
  let endReceive: () => void
  try {
    endReceive = beginReceive()
  } catch (e) {
    if (isReceiveDeferred(e)) return { kind: 'failed', message: RECEIVE_PAUSED_MESSAGE }
    throw e
  }
  try {
    // #295 phase 4: a gift locked to its link is claimed by this wallet's own swap with the link key
    // and re-signed unlocked; the gateway's receive cannot open it. Everything else as before.
    const linkSecret = key ? secretFromText(key) : null
    const locked = linkSecret ? lockedOnLink(tokens, linkPubOf(linkSecret)) : []
    if (linkSecret && locked.length > 0 && source === 'gift_link') {
      const outcome = await claimLockedGift({ ports: await cashlinkSeam.ports(), pubkey: account ?? '', linkSecret, k: key!, lockedTokens: locked })
      notifyWalletChanged()
      if (outcome.kind === 'own_coupon') return { kind: 'failed', message: OWN_COUPON_MESSAGE }
      if (outcome.kind !== 'ok') return outcome
      tellIssuerClaimed(locked, account)
      const rest = tokens.filter((t) => !locked.includes(t))
      return rest.length === 0 ? outcome : await swapGiftTokens(rest, source, redemption, cashlinkBundleId(linkPubOf(linkSecret)), returnOf)
    }
    return await swapGiftTokens(tokens, source, redemption, linkSecret ? cashlinkBundleId(linkPubOf(linkSecret)) : undefined, returnOf)
  } finally {
    endReceive()
  }
}

/**
 * Tell whoever made and funded the Cashlink that it was claimed (the "claimed" notice).
 *
 * Reuses the payment-receipt channel rather than a new one: `POST /api/v1/payment-receipts` fires
 * the issuer's `voucher_claimed` Web Push server-side (gateway-core `fireSettlementPush`), so the
 * issuer's app need not be open, and their `paymentReceiptDrain` files the bell row and toast
 * when it next runs. Observed here, by the claimer, because only the claim knows it happened at
 * the moment it happens: the issuer learns of a spend only when its own wallet next settles the
 * link, and the gateway's re-sign route cannot tell the issuer's key from a stranger's.
 *
 * The issuer is the wrap's `sender_pubkey` (a public key). The receipt id is derived from the
 * locked proof's secret hash, never the secret or the link key, and is stable so a retry is a 409.
 * Fire and forget: the coupon is already here, a lost receipt costs only the notice.
 */
export function tellIssuerClaimed(locked: GiftToken[], claimer: string | undefined): void {
  const issuer = locked.map((t) => t.senderPubkey).find((p): p is string => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p))
  if (!issuer || issuer === claimer?.toLowerCase()) return
  let faceValue = 0
  let faceUnit: string | undefined
  let faceDecimals: number | undefined
  let voucherId: string | undefined
  let verified = true
  for (const { token } of locked) {
    try {
      const parsed = parseVoucherToken(token)
      faceValue += creditableFaceValue(parsed).faceValue
      faceUnit ??= parsed.voucher.unit
      faceDecimals ??= parsed.voucher.faceDecimals
      voucherId ??= parsed.voucher.voucherId
      if (cashbackValidation(token)?.signatureValid !== true) verified = false
    } catch {
      verified = false
    }
  }
  let anchor: string
  try {
    anchor = 'cashlink:' + tokenProofs(locked[0].token).map((p) => bytesToHex(sha256(new TextEncoder().encode(p.secret)))).join(',')
  } catch {
    return
  }
  void import('./paymentReceipt').then(({ postPaymentReceipt }) =>
    postPaymentReceipt({
      senderPubkeyHex: issuer,
      deliveryEventId: bytesToHex(sha256(new TextEncoder().encode(anchor))),
      voucherId,
      // Amounts only from a verified voucher, as on the DM receive.
      ...(verified && faceUnit ? { faceValue, faceUnit, faceDecimals } : {}),
    }),
  ).catch(() => undefined)
}

/** A stall opening a Cashlink of its own coupon (owner decision Q3: no self-swap). Nothing moved. */
export const OWN_COUPON_MESSAGE =
  'This Cashlink holds a voucher from your own stall, so it can’t be added here. Ask the sender to send it to your handle instead.'

/** Shown when a gift is opened while this wallet is logging out. Nothing was taken from the link. */
export const RECEIVE_PAUSED_MESSAGE =
  'This wallet is logging out, so the gift was not added. It is still on its link. Try again after you log in.'

async function swapGiftTokens(
  tokens: GiftToken[],
  source: 'gift_link' | 'gift_link_reclaim',
  redemption: NonNullable<Window['TokenRedemption']>,
  /** One id for every coupon off this link, so History folds a several-coupon claim into one entry. */
  bundleId?: string,
  /** A take-back's `sent` row id (see `redeemGiftTokens`). */
  returnOf?: string,
): Promise<GiftRedeemOutcome> {
  let added = 0
  let spent = 0
  let failure: string | undefined
  const claimed: GiftToken[] = []
  for (const gift of tokens) {
    const { token } = gift
    try {
      const validation = cashbackValidation(token)
      // A take-back is the sender's own coupon coming home: its row says so, in the link's bundle,
      // as the locked path's does (`takenBackRow`). Without the memo the row read "Received via DM".
      const takenBack = source === 'gift_link_reclaim' ? { memo: CASHLINK_TAKEN_BACK_MEMO, ...(returnOf ? { returnOf } : {}) } : {}
      await withCorrelation({ ...(validation ? { validation: { ...validation } } : {}), ...(bundleId ? { bundleId } : {}), ...takenBack }, (correlationId) =>
        redemption.redeem(token, { source, metadata: { correlation_id: correlationId } }),
      )
      added += 1
      claimed.push(gift)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The server refused it under the same rule: nothing was swapped, and nothing else will pass.
      if (isServerForeignRefusal(error)) return { kind: 'merchant_refused', reason: 'merchant' }
      if (/11001|already[\s_]spent|proof already used|already been redeemed|already redeemed/i.test(message)) {
        spent += 1
        continue
      }
      // Keep going (second check of #247): a token the mint refuses (a third party can wrap a copy
      // of a real voucher's signed secret with a bad mint signature to the link key; it passes
      // every check here and reads UNSPENT) must not stop the genuine coupon after it being added.
      // Each redeem is idempotent per token, and the outcome is still 'failed', so a retry follows.
      failure ??= message
    }
  }
  notifyWalletChanged()
  // A recipient's claim (never the sender's own take-back) tells the issuer, one receipt per coupon.
  if (source === 'gift_link') for (const gift of claimed) tellIssuerClaimed([gift], sessionAccount(getSigner))
  if (failure !== undefined) return { kind: 'failed', message: failure }
  if (added === 0 && spent > 0) return { kind: 'claimed' }
  return { kind: 'ok' }
}

/** Fetch, unwrap and return a link's coupons. */
export async function giftTokensForSecret(secret: Uint8Array): Promise<GiftToken[]> {
  return giftTokensFrom(secret, await fetchGiftWraps(secret))
}

/**
 * Start-up (#295 phase 4): finish every Cashlink claim this wallet began and did not finish (the
 * page died after the burn). Behind the receive gate, like every receive. Never throws.
 */
/**
 * #543 review: when a direct Cashlink is made with a wrap not yet on its link, its intent is run
 * again after these delays (each run republishes only what is missing, under the intent's lock).
 */
export const INTENT_RETRY_DELAYS_MS = [5_000, 20_000, 60_000]

function scheduleIntentRetry(pubkey: string, delays: readonly number[] = INTENT_RETRY_DELAYS_MS): void {
  const [first, ...rest] = delays
  if (first === undefined) return
  setTimeout(() => {
    // Only for the account that made it: the run derives R from the signed-in key.
    if (sessionAccount(getSigner) !== pubkey) return
    void finishCashlinkIntentsNow(pubkey).then(() => {
      if (movingCashlinkLinkKeys(pubkey).size > 0) scheduleIntentRetry(pubkey, rest)
    })
  }, first)
}

/**
 * #543: every Cashlink a page left part way on the direct path, finished from its intent (spec
 * section 5), beside `finishPendingCashlinkClaims` at start-up. Never throws.
 */
export async function finishCashlinkIntentsNow(pubkey: string): Promise<number> {
  try {
    if (cashlinkIntentLinkKeys(pubkey).size === 0) return 0
    const [{ finishCashlinkIntents }, ports] = await Promise.all([import('./cashlinkDirect'), cashlinkSeam.directPorts()])
    return await finishCashlinkIntents(ports, pubkey)
  } catch {
    return 0
  }
}

export async function finishPendingCashlinkClaims(pubkey: string): Promise<number> {
  const { finishCashlinkClaims, loadClaims } = await import('./cashlinkFlow')
  if (loadClaims(pubkey).length === 0) return 0
  let endReceive: () => void
  try {
    endReceive = beginReceive()
  } catch {
    return 0
  }
  try {
    return await finishCashlinkClaims(await cashlinkSeam.ports(), pubkey, identitySecret)
  } catch {
    return 0
  } finally {
    endReceive()
  }
}

/** Read and verify a gift for the prompt or the banner. Never spends. */
export async function readGift(key: string, x: number, nowMs = Date.now()): Promise<{ verdict: GiftVerdict; tokens: GiftToken[] }> {
  const secret = secretFromText(key)
  if (!secret) return { verdict: { kind: 'unreachable' }, tokens: [] }
  await loadTrustedMints()
  let tokens: GiftToken[]
  try {
    tokens = await giftTokensForSecret(secret)
  } catch {
    return { verdict: { kind: 'unreachable' }, tokens: [] }
  }
  if (tokens.length === 0) return { verdict: { kind: 'unreachable' }, tokens }
  return { verdict: await verifyGift(tokens, x, nowMs, undefined, linkPubOf(secret)), tokens }
}

// ─── Status, take back, reclaim after x (spec 3.3) ───────────────────────────

export type TakeBackOutcome = GiftRedeemOutcome | { kind: 'not_found' }

/** "Take it back" (Q4): the sender receives its own link, before or after `x`. */
export async function takeBack(k: string): Promise<TakeBackOutcome> {
  const secret = secretFromText(k)
  if (!secret) return { kind: 'not_found' }
  // A tap seconds after "Cashlink ready" can land while this tab is still locking the gift to its
  // link. Read now, the gift is the bearer copy the lock is about to burn: the tap took THAT back
  // and the lock then left the real gift on the link, claimable, under a row that said "taken back"
  // (staging, 2026-10-30). Every background check already leaves such a link alone (linksInFlight);
  // the tap waits for the send instead, then takes back whatever it left.
  const sending = sendsRunning.get(k)
  if (sending) {
    const finished = await Promise.race([sending.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), TAKE_BACK_WAITS_FOR_SEND_MS))])
    if (!finished) return { kind: 'failed', message: 'This Cashlink is still being sent. Try again in a moment.' }
  }
  const rows = (await linkRows()).filter((r) => r.link.k === k)
  let tokens: GiftToken[]
  try {
    tokens = await giftTokensForSecret(secret)
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
  // Taken back (or found claimed) by hand: the sender already knows, so no "expired" notice follows.
  const told = { noticedAt: Date.now() }
  // #295 phase 4: a gift locked to its link comes back by this wallet's own swap.
  const locked = rows[0] ? ownLockedOnLink(openLinkOf(rows), secret, tokens) : []
  if (locked.length > 0 && rows[0]) {
    // #401: while this tap's take-back runs, a History or start-up check leaves the link to it
    // (as for a send or an arm): two runs of the same take-back only race each other at the gateway.
    linksInFlight.add(k)
    let outcome: ReturnOutcome
    try {
      outcome = await settleLocked(rows, secret, locked.map((t) => t.token), true)
    } finally {
      linksInFlight.delete(k)
    }
    if (outcome.kind === 'returned') return { kind: 'ok' }
    if (outcome.kind === 'claimed') return { kind: 'claimed' }
    return { kind: 'failed', message: 'Could not take it back just now. Try again.' }
  }
  // An armed link whose locked gift cannot be read right now: never read its spent bearer as claimed.
  if (rows.some((r) => r.link.arm)) return { kind: 'not_found' }
  // Only coupons that pass their own checks: anything else was wrapped to the link's public key by
  // someone else and must not block the take-back (review of #247, F1).
  tokens = giftCandidates(tokens)
  if (tokens.length === 0) return { kind: 'not_found' }
  const states = await Promise.all(tokens.map((t) => tokenState(t.token)))
  if (combinedState(states) === 'SPENT') {
    // #379: spent by this wallet's own burn is an arm part way, never a claim. The next run finishes it.
    const ours = rows[0] ? await spentByOurBurn(openLinkOf(rows), tokens) : false
    if (ours !== false) {
      if (ours === true) {
        await cashlinkSeam.markMoving(sessionAccount(getSigner) ?? '', rows[0].id)
        await setLinkArm(rows, { s: 'arming' })
      }
      return { kind: 'failed', message: 'Could not take it back just now. Try again.' }
    }
    const at = Date.now()
    await setLinkStatus(rows, 'claimed', at, { ...told, ...spentReadClaim(at) })
    return { kind: 'claimed' }
  }
  const unspent = tokens.filter((_, n) => states[n] !== 'SPENT')
  // The link key: its bundle id goes on the take-back's History row.
  const outcome = await redeemGiftTokens(unspent, 'gift_link_reclaim', k, rows[0] ? creationRowId(rows) : undefined)
  if (outcome.kind === 'ok') await setLinkStatus(rows, 'reclaimed', Date.now(), told)
  else if (outcome.kind === 'claimed') await setLinkStatus(rows, 'claimed', Date.now(), told)
  return outcome
}

/**
 * The link's outcome from each locked token's: anything unfinished wins (the next run carries on),
 * then any coupon back here makes it "taken back", and only all claimed is "claimed".
 */
export function combineReturns(outcomes: ReturnOutcome[]): ReturnOutcome {
  if (outcomes.length === 0) return { kind: 'unknown', why: 'nothing locked' }
  const unknown = outcomes.find((o) => o.kind === 'unknown')
  if (unknown) return unknown
  const kinds = new Set(outcomes.map((o) => o.kind))
  if (kinds.has('returning')) return outcomes.find((o) => o.kind === 'returning')!
  if (kinds.has('waiting')) return kinds.size === 1 ? { kind: 'waiting' } : { kind: 'returning', why: 'part way' }
  return kinds.has('returned') ? { kind: 'returned' } : { kind: 'claimed' }
}

/**
 * One run for a locked link (#295 phase 4), recording what it found. `takeBackNow` is "Take it back"
 * before the link expires. Never throws.
 */
async function settleLocked(rows: LinkRow[], linkSecret: Uint8Array, lockedTokens: string[], takeBackNow = false): Promise<ReturnOutcome> {
  const link = openLinkOf(rows)
  const refundSecret = refundSecretFor(link)
  if (!refundSecret) return { kind: 'unknown', why: 'no refund key here' }
  const pubkey = sessionAccount(getSigner) ?? ''
  try {
    const ports = await cashlinkSeam.ports()
    // Every locked token on the link (one per coupon), not only the first: a link of several
    // coupons came back one coupon at a time, and the rest stayed on the link.
    const outcomes: ReturnOutcome[] = []
    for (const lockedToken of lockedTokens) outcomes.push(await settleLockedGift({
      ports,
      linkSecret,
      refundSecret,
      lockedToken,
      ...(link.arm?.ks ? { depositKeyset: link.arm.ks } : {}),
      // #396: a take-back already started ("Take it back" before x, so the row is `returning`) is
      // finished on every later run too. Without this, the next run read the proofs still on the link
      // as "waiting for x", and a gift taken back part way stayed part way until its expiry.
      takeBackNow: takeBackNow || link.arm?.s === 'returning',
      returnOf: creationRowId(rows),
      onReturning: async () => {
        // Before anything leaves the link: logout stays off until it is back as a voucher.
        await cashlinkSeam.markMoving(pubkey, rows[0].id)
        if (link.arm?.s !== 'returning') await setLinkArm(rows, { s: 'returning', ...(link.arm?.ks ? { ks: link.arm.ks } : {}) })
      },
    }))
    const outcome = combineReturns(outcomes)
    const told = takeBackNow ? { noticedAt: Date.now() } : {}
    if (outcome.kind === 'returned') {
      await setLinkStatus(rows, 'reclaimed', Date.now(), told)
      await cashlinkSeam.clearMoving(pubkey, rows[0].id)
    } else if (outcome.kind === 'claimed') {
      await setLinkStatus(rows, 'claimed', Date.now(), told)
      await cashlinkSeam.clearMoving(pubkey, rows[0].id)
    } else if (outcome.kind === 'waiting' && link.arm?.s === 'not_armed' && Math.floor(ports.now() / 1000) < link.x) {
      // Not armed yet and still before its expiry: leave the take-back with the service again (the
      // same derivation, so one it already holds replays). Off or refused: stays as it is.
      let armed: string | undefined
      for (const lockedToken of lockedTokens) {
        const again = await retryDeposit(ports, linkSecret, refundSecret, lockedToken)
        armed = again.kind === 'armed' && armed !== '' ? again.keyset : ''
      }
      if (armed) await setLinkArm(rows, { s: 'armed', ks: armed })
    }
    return outcome
  } finally {
    refundSecret.fill(0)
  }
}

/**
 * Whether every coupon on a link is past its own expiry (plus a grace for a wallet clock that runs
 * fast). The mint refuses an expired voucher to everyone (`voucher_expired`), so such a link can be
 * neither claimed nor taken back. A coupon with no expiry, or one that cannot be read, never lapses.
 */
export const COUPON_LAPSE_GRACE_S = 60 * 60

/**
 * How long past every coupon's expiry (by this device's clock) a link is closed even when the
 * take-back failed for another reason (offline, a gateway that rewords the refusal). Long enough
 * that no realistic clock error closes a live coupon (second check of #367).
 */
export const COUPON_LAPSE_HARD_S = 7 * 24 * 60 * 60

/**
 * A server's refusal of an expired voucher, as the receive surfaces it. Two servers can say it:
 * - gateway-customer refuses it FIRST, before the swap reaches the mint, by its own (server) clock:
 *   `JdbcWalletPort.inspectVoucherReceiveMetadata`, "Voucher token expired. Reason: voucher expiry
 *   exceeded." (400 WALLET_003). This is the one a gift coupon actually meets, since every gift
 *   coupon is unlocked and the gateway reads its blob (third check of #367).
 * - the mint (`voucher_expired`, code 90016, "Voucher has expired and cannot be redeemed"), for a
 *   voucher the gateway could not read.
 * The HTTP code (WALLET_003) is shared with every invalid token, so the text is all there is. A
 * reworded refusal is not lost: it falls to the one-week rule.
 */
const EXPIRED_REFUSAL = /voucher[_ ]expired|voucher has expired|voucher token expired|voucher expiry exceeded|\b90016\b/i

/**
 * Whether a link whose take-back did not succeed is past saving: every coupon still on it is past
 * its own expiry, AND either the mint said so or the device clock is a week past it. A failed
 * take-back alone, with the device clock just past the expiry, is not enough: the device clock may
 * run fast, and the failure may be the network. Then the link stays outstanding and is retried.
 */
function lapseConfirmed(outcome: GiftRedeemOutcome, unspent: GiftToken[], nowMs: number): boolean {
  if (!couponsLapsed(unspent, nowMs)) return false
  if (outcome.kind === 'failed' && EXPIRED_REFUSAL.test(outcome.message)) return true
  return couponsLapsed(unspent, nowMs, COUPON_LAPSE_HARD_S)
}

function couponsLapsed(tokens: GiftToken[], nowMs: number, graceS = COUPON_LAPSE_GRACE_S): boolean {
  const now = Math.floor(nowMs / 1000)
  if (tokens.length === 0) return false
  return tokens.every(({ token }) => {
    try {
      const exp = parseVoucherToken(token).voucher.expiresAt
      if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return false
      // Seconds, exactly as the mint reads the tag (`VoucherMetadata.expiresAt`). The wallet's 1e12
      // seconds-or-milliseconds guess must not be used here: a value the guess calls milliseconds
      // is, to the mint, a date thousands of years away, so the coupon is live there.
      return now > exp + graceS
    } catch {
      return false
    }
  })
}

/**
 * On start and on opening History (spec 3.3): every outstanding link is checked by NUT-07. Spent
 * means claimed. Past `x` and still unspent means take it back now. Never throws: the wallet must
 * open whatever the mint says.
 */
export async function reconcileGiftLinks(
  nowMs = Date.now(),
  state: (token: string) => Promise<ProofState> = tokenState,
  /** #401: the link the sender is looking at (its History row): checked first, on its own. */
  first?: string,
): Promise<{ claimed: number; reclaimed: number }> {
  let claimed = 0
  let reclaimed = 0
  try {
    const all = await linkRows()
    const doubtedLinks = unconfirmedClaimLinks(all.map((r) => r.link))
    // #401: on a slow network a walk over every link, one after another, took longer than the sender
    // stayed on the page. A take-back already started (`returning`) goes first, the newest links next
    // (the ones the sender is most likely looking at), and up to RECONCILE_CONCURRENCY links are
    // checked at once, so one slow take-back never holds up the claim check of the others.
    const ordered = [...distinctLinks(all)].sort(
      ([ka, a], [kb, b]) =>
        Number(kb === first) - Number(ka === first) ||
        Number(b.some((p) => p.link.arm?.s === 'returning')) - Number(a.some((p) => p.link.arm?.s === 'returning')) ||
        newestOf(b) - newestOf(a),
    )
    const reconcileOne = async (k: string, snapshot: LinkRow[]): Promise<void> => {
      const doubted = doubtedLinks.has(k)
      // #261: a claim that rests on one SPENT read is read again once it is due.
      const singleRead = !doubted && snapshot.some((p) => isSingleReadClaim(p.link) && nowMs - (p.link.spentSeenAt ?? 0) >= CLAIM_RECHECK_AFTER_MS)
      if (!doubted && !singleRead && !snapshot.some((p) => p.link.status === 'outstanding')) return
      const secret = secretFromText(k)
      if (!secret) return
      let tokens: GiftToken[]
      try {
        tokens = await giftTokensForSecret(secret)
      } catch {
        return
      }
      // #379: a Cashlink an older build closed as "claimed" while it was being locked is checked again
      // by the mint, and opened again unless someone else really spent it.
      if (doubted) {
        const verdict = await recheckClaim(snapshot, secret, tokens, nowMs)
        if (verdict === 'returned') reclaimed += 1
        if (verdict !== 'open') return
      }
      if (singleRead && (await recheckSpentRead(snapshot, tokens, state, nowMs)) !== 'open') return
      const parts = doubted || singleRead ? (await linkRows()).filter((r) => r.link.k === k) : snapshot
      if (!parts.some((p) => p.link.status === 'outstanding')) return
      // #295 phase 4, first: a link part way through being locked is finished, and a link whose gift
      // is locked to it is settled by its own rules. Its original bearer gift, spent by the lock,
      // must never be read below as "claimed".
      const link = openLinkOf(parts)
      const locked = ownLockedOnLink(link, secret, tokens)
      if (link.arm?.s === 'arming' && link.i !== undefined && (locked.length === 0 || partlyDelivered(locked, tokens))) {
        await armLink(sessionAccount(getSigner) ?? '', k, secret, link.i, link.x)
        return
      }
      if (locked.length > 0) {
        // #379: the lock is the record. Its locktime is the link's expiry, and a link still marked
        // `arming` with its lock already on the link got as far as the deposit: whatever the relay
        // said, this wallet takes it back itself unless a retried deposit arms it.
        const locktime = lockedLocktime(locked[0].token)
        if (locktime !== null) await syncLinkExpiry(parts, locktime)
        if (link.arm?.s === 'arming' || !link.arm) {
          await setLinkArm(parts, { s: 'not_armed', ...(link.arm?.ks ? { ks: link.arm.ks } : {}) })
          await cashlinkSeam.clearMoving(sessionAccount(getSigner) ?? '', parts[0].id)
        }
        const fresh = (await linkRows()).filter((r) => r.link.k === k && r.link.status === 'outstanding')
        if (fresh.length === 0) return
        const outcome = await settleLocked(fresh, secret, locked.map((t) => t.token))
        if (outcome.kind === 'returned') reclaimed += 1
        else if (outcome.kind === 'claimed') claimed += 1
        return
      }
      if (link.arm) return
      // As in takeBack: a third party's wrap to the link key must not freeze it (review of #247, F1).
      tokens = giftCandidates(tokens)
      if (tokens.length === 0) return
      const states = await Promise.all(tokens.map((t) => state(t.token)))
      const overall = combinedState(states)
      if (overall === 'SPENT') {
        // #379: spent by this wallet's own burn (an arm whose record is not on this row) is not a
        // claim: the link is finished as a resumed arm on the next run.
        const ours = await spentByOurBurn(link, tokens)
        if (ours === 'unknown') return
        if (ours) {
          await cashlinkSeam.markMoving(sessionAccount(getSigner) ?? '', parts[0].id)
          await setLinkArm(parts, { s: 'arming' })
          if (link.i !== undefined) await armLink(sessionAccount(getSigner) ?? '', k, secret, link.i, link.x)
          return
        }
        await setLinkStatus(parts, 'claimed', nowMs, spentReadClaim(nowMs))
        claimed += 1
        return
      }
      if (overall !== 'UNSPENT') return
      // Review of #380: the send's own row's expiry, never an adopted duplicate's 30-day guess.
      if (Math.floor(nowMs / 1000) >= link.x) {
        const unspent = tokens.filter((_, n) => states[n] === 'UNSPENT')
        // The take-back is always tried first: the mint's clock, not this device's, decides whether a
        // coupon has lapsed (second check of #367). A wallet clock running fast must never close a
        // link the mint would still let come back.
        // The link key: its bundle id goes on the take-back's History row.
        const outcome = await redeemGiftTokens(unspent, 'gift_link_reclaim', k, creationRowId(parts))
        if (outcome.kind === 'ok') {
          await setLinkStatus(parts, 'reclaimed', nowMs)
          reclaimed += 1
        } else if (outcome.kind === 'claimed') {
          await setLinkStatus(parts, 'claimed', nowMs)
          claimed += 1
        } else if (lapseConfirmed(outcome, unspent, nowMs)) {
          // Review of #367: once every coupon still on the link is past its own expiry the mint
          // refuses it to everyone, the sender included, so the take-back fails on every run and the
          // link would count against MAX_EXPIRED_UNRETURNED for ever. It is closed as expired. Only
          // the UNSPENT coupons are read: one that already came back (or was claimed) must not hold
          // the link open until its own, later, expiry.
          await setLinkStatus(parts, 'expired', nowMs)
        }
      }
    }
    const one = async ([k, snapshot]: (typeof ordered)[number]): Promise<void> => {
      // #379: a link this tab is sending, arming or (#401) taking back is left to that run. #543: and
      // one still being made on the direct path, which `finishCashlinkIntents` finishes.
      if (linksInFlight.has(k) || directIntentLinks().has(k)) return
      const before = linkSettles.get(k)
      const mine = (async () => {
        if (before) await before
        const parts = before ? (await linkRows()).filter((r) => r.link.k === k) : snapshot
        try {
          await reconcileOne(k, parts)
        } catch (error) {
          // One link's failure must not stop the others being checked.
          console.warn('[gift] could not check a link', error instanceof Error ? error.message : String(error))
        }
      })()
      linkSettles.set(k, mine)
      try {
        await mine
      } finally {
        if (linkSettles.get(k) === mine) linkSettles.delete(k)
      }
    }
    let next = 0
    // The link on screen is settled before the others start, so they never compete with it.
    if (first !== undefined && ordered[0]?.[0] === first) await one(ordered[next++])
    await Promise.all(
      Array.from({ length: Math.min(RECONCILE_CONCURRENCY, ordered.length) }, async () => {
        while (next < ordered.length) await one(ordered[next++])
      }),
    )
  } catch (error) {
    console.warn('[gift] could not check outstanding links', error instanceof Error ? error.message : String(error))
  }
  // #410 G14: gifts minted already locked, run from the same place: claim the ones locked to this
  // wallet, take back the unclaimed ones it bought. Never throws.
  try {
    reclaimed += (await (await import('./lockedGiftsApp')).sweepLockedGifts()).returned
  } catch {
    // Next run.
  }
  return { claimed, reclaimed }
}

/**
 * The row a link's settle reads: an open one, the send's own before one a restore scan adopted (whose
 * expiry was a guess), and the soonest expiry. Every write still goes to every row of the link.
 */
function openLinkOf(parts: LinkRow[]): GiftLinkRecord {
  const open = parts.filter((p) => p.link.status === 'outstanding')
  const ranked = [...(open.length > 0 ? open : parts)].sort(
    (a, b) =>
      Number(b.link.arm !== undefined) - Number(a.link.arm !== undefined) ||
      Number(isAdoptedRow(a)) - Number(isAdoptedRow(b)) ||
      a.link.x - b.link.x,
  )
  return ranked[0].link
}

/** A row the restore scan wrote (`adoptLink`), not the send itself. */
const isAdoptedRow = (r: LinkRow): boolean => r.id.startsWith('sent:gift-')

/**
 * The row that made a Cashlink, which its take-back's row links to: the send's own row before one a
 * restore scan adopted, and of a several-coupon send its first row in id order, so every run of a
 * take-back names the same one. Exported for tests.
 */
export function creationRowId(rows: readonly LinkRow[]): string {
  const ranked = [...rows].sort((a, b) => Number(isAdoptedRow(a)) - Number(isAdoptedRow(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return ranked[0].id
}

/**
 * #379: whether a link's spent bearer gift went into this wallet's own burn outputs (an arm), which
 * is never a claim. False for a link with no index (never armed); 'unknown' when the mint, or this
 * session's key, cannot say.
 */
async function spentByOurBurn(link: Pick<GiftLinkRecord, 'i'>, gifts: GiftToken[]): Promise<boolean | 'unknown'> {
  // Only a gift with its amount proof could ever have been burnt by an arm (see burntByThisWallet).
  if (!gifts.some(({ token }) => hasAmountProof(token))) return false
  // A link with no index was never armed (an arm needs `i`), so its spend is no burn of ours. One
  // with an index whose key this session cannot read is undecided: never a claim (review of #380).
  if (link.i === undefined) return false
  const refundSecret = refundSecretFor(link)
  if (!refundSecret) return 'unknown'
  try {
    return await burntByThisWallet(await cashlinkSeam.ports(), refundSecret, gifts)
  } catch {
    return 'unknown'
  } finally {
    refundSecret.fill(0)
  }
}

/**
 * #379: a Cashlink an older build closed as "claimed" while it was being locked, checked again by the
 * mint. 'open' when it is outstanding again and the reconcile carries on with it; 'returned' when it
 * came back here; 'left' when it was really claimed or cannot be decided yet (then it stays as it is,
 * and logout stays off).
 *
 * - Its own locked gift is still on the link, unspent: open again, `not_armed`, `x` = the locktime.
 *   After `x` the run below takes it back with this wallet's return key.
 * - Its locked gift is spent: settled now. Into this wallet's own outputs it comes back ("Taken
 *   back"); otherwise it really was claimed, and that is recorded as checked.
 * - No lock on the link, and the bearer gift went into this wallet's burn: open again as `arming`,
 *   so the arm is finished (or its value kept). Bearer still unspent: open again as an ordinary gift.
 * - Bearer spent by someone else: really claimed.
 */
async function recheckClaim(rows: LinkRow[], linkSecret: Uint8Array, tokens: GiftToken[], nowMs = Date.now()): Promise<'open' | 'returned' | 'left'> {
  const link = openLinkOf(rows)
  const refundSecret = refundSecretFor(link)
  if (!refundSecret) return 'left'
  const pubkey = sessionAccount(getSigner) ?? ''
  try {
    // #381 (owner, option a): no gift wrap to check. Settled only when nothing can be recovered.
    if (tokens.length === 0) {
      if (await wraplessPastSaving(linkSecret, refundSecret, pubkey, nowMs)) await confirmClaim(rows, nowMs)
      return 'left'
    }
    const ports = await cashlinkSeam.ports()
    const locked = ownLockedOnLink(link, linkSecret, tokens)
    if (locked.length > 0) {
      // Every locked token on the link (one per coupon, #533), not only the first: a link whose
      // first coupon was claimed but whose second is still locked is open, not settled.
      const states = (await Promise.all(locked.map((t) => tokenStates(ports, t.token)))).flat()
      if (states.some((s) => s !== 'SPENT' && s !== 'UNSPENT')) return 'left'
      const locktime = lockedLocktime(locked[0].token) ?? link.x
      if (states.some((s) => s === 'UNSPENT')) {
        await reopenLink(rows, { arm: { s: 'not_armed', ...(link.arm?.ks ? { ks: link.arm.ks } : {}) }, x: locktime })
        return 'open'
      }
      await syncLinkExpiry(rows, locktime)
      const outcome = await settleLocked(rows, linkSecret, locked.map((t) => t.token))
      if (outcome.kind === 'claimed') await confirmClaim(rows)
      return outcome.kind === 'returned' ? 'returned' : 'left'
    }
    const bearer = giftCandidates(tokens).filter((t) => lockedOnLink([t], linkPubOf(linkSecret)).length === 0)
    if (bearer.length === 0) return 'left'
    let ours: boolean
    try {
      ours = await burntByThisWallet(ports, refundSecret, bearer)
    } catch {
      return 'left'
    }
    if (ours) {
      await cashlinkSeam.markMoving(pubkey, rows[0].id)
      await reopenLink(rows, { arm: { s: 'arming', ...(link.arm?.ks ? { ks: link.arm.ks } : {}) } })
      return 'open'
    }
    const states = (await Promise.all(bearer.map((t) => tokenStates(ports, t.token)))).flat()
    if (states.every((s) => s === 'SPENT')) {
      await confirmClaim(rows)
      return 'left'
    }
    if (states.every((s) => s === 'UNSPENT')) {
      await reopenLink(rows, { arm: undefined })
      await cashlinkSeam.clearMoving(pubkey, rows[0].id)
      return 'open'
    }
    return 'left'
  } catch (error) {
    console.warn('[gift] could not check a Cashlink marked claimed', error instanceof Error ? error.name : 'error')
    return 'left'
  } finally {
    refundSecret.fill(0)
  }
}

/**
 * #381 (owner, option a; review of #388): whether an old claimed row whose gift wraps are gone holds
 * nothing this wallet could still bring back. All of these, or it keeps logout off:
 * - the relay gave a well-formed answer with no event at all (not wraps it could not read, not an
 *   error, not an odd body);
 * - this device kept the signed lock(s) of the link (`knownLocks`), each with the coupon's OWN
 *   expiry, and now is past every one by COUPON_LAPSE_HARD_S. The link's `x` is not that date: a
 *   coupon may outlive it by months and stays refundable with R until it expires;
 * - the mint answers for every locked proof, and none is UNSPENT.
 */
async function wraplessPastSaving(linkSecret: Uint8Array, refundSecret: Uint8Array, pubkey: string, nowMs: number): Promise<boolean> {
  const answer = await giftLinksRelay.answer(linkSecret)
  if (!answer.emptyAnswer) return false
  const linkPub = linkPubOf(linkSecret)
  const refundPub = xOnlyPub(refundSecret)
  const locks = [...knownLocks(pubkey).values()].filter((s) => {
    const lock = readLinkLock(s)
    return lock?.linkPub === linkPub && lock.refundPub === refundPub
  })
  if (locks.length === 0) return false
  const now = Math.floor(nowMs / 1000)
  for (const s of locks) {
    const exp = voucherOfSecret(s)?.expiresAt
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0 || now <= exp + COUPON_LAPSE_HARD_S) return false
  }
  const ports = await cashlinkSeam.ports()
  const states = await ports.mint.states(await cashlinkSeam.mintUrl(), locks)
  return states.length === locks.length && states.every((s) => s === 'SPENT')
}

/** #381: the relay's raw answer for a link; a seam for tests. */
export const giftLinksRelay = {
  answer: (secret: Uint8Array) => fetchGiftWrapsAnswer(secret),
}

/**
 * The restore scan (spec 3.3): derive `i = 0 … last + 20`, look for wraps to each, and adopt any
 * link whose coupon is still unspent and that no row here knows. "last" is the highest index seen
 * in a row or with a wrap, so the window slides past a run of links. Adopted links get a minimal
 * `sent` row (`x` from the link is unknown, so it is the coupon's own expiry or 30 days from the
 * scan, whichever is sooner), and go through the normal reconcile afterwards.
 *
 * Only for a derivable key; a random secret is restored from the encrypted history instead.
 */
export async function restoreScan(
  pubkey: string,
  probe: (secret: Uint8Array) => Promise<GiftToken[]> = giftTokensForSecret,
  state: (token: string) => Promise<ProofState> = tokenState,
  nowMs = Date.now(),
): Promise<number> {
  const id = identitySecret()
  if (!id) return 0
  try {
    const rows = await linkRows()
    const known = new Set(rows.map((r) => r.link.k))
    // #379: a link this wallet is sending right now (this tab, or a send whose row is not written
    // yet) is the send's, never adopted as a second row with a guessed expiry.
    for (const k of [...linksInFlight, ...pendingSendLinks(pubkey), ...cashlinkIntentLinkKeys(pubkey)]) known.add(k)
    let last = Math.max(-1, ...rows.map((r) => r.link.i ?? -1), nextLinkIndex(pubkey) - 1)
    let adopted = 0
    // #540 F8: probed RESTORE_PROBE_BATCH indices at a time, each batch handled in index order
    // afterwards, so every #379 guard below runs exactly as it did one by one.
    let probed: Promise<GiftToken[] | null>[] = []
    let batchStart = 0
    for (let i = 0; i <= last + RESTORE_GAP; i++) {
      if (i >= batchStart + probed.length) {
        batchStart = i
        const end = Math.min(i + RESTORE_PROBE_BATCH - 1, last + RESTORE_GAP)
        probed = []
        for (let j = i; j <= end; j++) probed.push(probe(deriveLinkSecret(id, j)).catch(() => null))
      }
      const secret = deriveLinkSecret(id, i)
      const k = secretToText(secret)
      const answer = await probed[i - batchStart]
      if (answer === null) continue
      let tokens: GiftToken[] = answer
      if (tokens.length === 0) continue
      if (i > last) last = i
      advanceLinkIndex(pubkey, i)
      if (known.has(k)) continue
      // #379: the scan runs alongside start-up, so a send can begin or finish while it iterates. A
      // link being sent, or whose row was written since the scan began, is never adopted again.
      if (linksInFlight.has(k) || pendingSendLinks(pubkey).includes(k) || (await linkRows()).some((r) => r.link.k === k)) {
        known.add(k)
        continue
      }
      // #295 phase 4: a gift of ours locked to this link, or one on its way back, is adopted with
      // its exact expiry (the lock's locktime) so the normal run finishes it.
      const refundSecret = deriveRefundSecret(id, i)
      try {
        const found = await restoreFinding(await cashlinkSeam.ports(), secret, refundSecret, giftCandidates(tokens, linkPubOf(secret)))
        if (found.kind === 'locked' || found.kind === 'returning') {
          const arm: GiftLinkArm = { s: found.kind === 'locked' ? 'not_armed' : 'returning' }
          if (await adoptLink(k, i, [{ token: found.lockedToken, sentAt: tokens[0].sentAt }], nowMs, { x: found.x, arm })) adopted += 1
          known.add(k)
          continue
        }
        if (found.kind === 'arming') {
          // Burnt for a lock that never reached the link, and the record of it is gone with the
          // device: the burn's sats are this wallet's and are kept, never left behind.
          if (await recoverOrphanBurn(await cashlinkSeam.ports(), refundSecret, found.bearer)) adopted += 1
          continue
        }
      } finally {
        refundSecret.fill(0)
      }
      tokens = giftCandidates(tokens)
      if (tokens.length === 0) continue
      const states = await Promise.all(tokens.map((t) => state(t.token)))
      if (combinedState(states) !== 'UNSPENT') continue
      if (await adoptLink(k, i, tokens, nowMs)) adopted += 1
      known.add(k)
    }
    return adopted
  } finally {
    id.fill(0)
  }
}

/** #540 F8: how many link keys the restore scan asks about at once. */
export const RESTORE_PROBE_BATCH = 4
/** #540 F8: the start-up restore scan runs at most this often on a device that kept its history. */
export const RESTORE_SCAN_EVERY_MS = 24 * 60 * 60 * 1000
const restoreScanKey = (pubkey: string) => `imani-wallet:gift-restore-scan:${pubkey}`

/**
 * #540 F8: the start-up restore scan, only when it can find something. The stamp lives under the
 * `imani-wallet:` prefix, so logout's sweep (and a new device, or wiped storage) removes it and
 * the next start scans at once; otherwise at most once a day. The scan only adopts links this
 * device's rows do not know, and a device that kept its rows already knows every link it made.
 */
export async function restoreScanIfDue(
  pubkey: string,
  nowMs = Date.now(),
  scan: (pubkey: string) => Promise<number> = restoreScan,
): Promise<number> {
  let stamp = NaN
  try {
    stamp = Number(localStorage.getItem(restoreScanKey(pubkey)))
  } catch {
    // No storage: scan, as before.
  }
  if (Number.isFinite(stamp) && stamp > 0 && nowMs - stamp >= 0 && nowMs - stamp < RESTORE_SCAN_EVERY_MS) return 0
  const adopted = await scan(pubkey)
  try {
    localStorage.setItem(restoreScanKey(pubkey), String(nowMs))
  } catch {
    // Scans again next start.
  }
  return adopted
}

/** A link this wallet has a pending send for (its row is written only once the send settles). */
function pendingSendLinks(pubkey: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(pendingSendsKey(pubkey)) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map((p) => asGiftLinkRecord((p as { link?: unknown } | null)?.link)?.k).filter((k): k is string => typeof k === 'string')
  } catch {
    return []
  }
}

function hasAmountProof(token: string): boolean {
  try {
    return tokenProofs(token).some((p) => p.dleq)
  } catch {
    return false
  }
}

async function adoptLink(
  k: string,
  i: number,
  tokens: GiftToken[],
  nowMs: number,
  locked?: { x: number; arm: GiftLinkArm },
): Promise<boolean> {
  const wallet = getWallet()
  // #379: the last word before writing. A row of this link written meanwhile (the send settling) is
  // the link's record; a second, adopted one would carry a guessed expiry next to it.
  if (linksInFlight.has(k) || (await linkRows()).some((r) => r.link.k === k)) return false
  for (const { token, sentAt } of tokens) {
    let parsed
    try {
      parsed = parseVoucherToken(token)
    } catch {
      continue
    }
    const exp = parsed.voucher.expiresAt
    const expS = exp ? (exp > 1e12 ? Math.floor(exp / 1000) : exp) : undefined
    const x = locked?.x ?? Math.min(Math.floor(nowMs / 1000) + 30 * 86400, expS ?? Infinity)
    const row = buildSentTransaction({
      tokenId: `gift-${await tokenIdFrom(token)}`,
      amount: creditableFaceValue(parsed).faceValue,
      unit: parsed.voucher.unit,
      decimals: parsed.voucher.faceDecimals,
      merchantId: (/^[0-9a-f]{64}$/i.test(parsed.voucher.issuerId ?? '') ? parsed.voucher.issuerId : parsed.voucher.issuerPublicKey).toLowerCase(),
      recipientPubkey: linkPubOf(secretFromText(k)!),
      recipientName: 'Link',
      voucherId: parsed.voucher.voucherId,
      link: { k, i, x, status: 'outstanding', ...(locked ? { arm: locked.arm } : {}) },
      at: sentAt * 1000,
      // One link's coupons are one send: History folds them (the live send's random id is gone).
      ...(tokens.length > 1 ? { bundleId: cashlinkBundleId(linkPubOf(secretFromText(k)!)) } : {}),
    })
    await wallet.addTransaction(row)
  }
  notifyWalletChanged()
  return true
}
