/**
 * Gift links, the wallet's side of them: allocate a link key, send, keep the row, watch it, take
 * it back, find it again after a restore, and claim one (claim links phase 4, spec 3.3).
 *
 * The pure parts (derivation, the link, fetch, verify) are in `giftLink.ts`. This module owns the
 * storage, the counter and the redeem. Nothing here logs a link secret.
 */
import type { TransactionRow } from '@imani/wallet-storage'

import {
  combinedState,
  deriveLinkSecret,
  fetchGiftWraps,
  formatGiftLink,
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
import { sendVouchers, type SendResult } from './pay'
import { publishTx } from './txRecords'
import { cashbackValidation } from './cashbackValidation'
import { checkTokenBacking, loadTrustedMints } from './trustedMint'
import { asGiftLinkRecord, buildSentTransaction, type GiftLinkRecord, type GiftLinkStatus } from './transactions'
import { creditableFaceValue, parseVoucherToken } from './voucherToken'
import { getWallet, notifyWalletChanged } from './wallet'
import type { Merchant } from './merchants'
import { tokenIdFrom } from '../../packages/wallet-storage/src/tokenId'

// ─── Limits (Q5) ─────────────────────────────────────────────────────────────

/** Q5: no fee, at most this many outstanding links per wallet. */
export const MAX_OUTSTANDING_LINKS = 10

/** The restore scan's gap (spec 3.3): `i = 0 … last + 20`. */
export const RESTORE_GAP = 20

export function tooManyLinksMessage(n = MAX_OUTSTANDING_LINKS): string {
  return `You have ${n} links waiting to be claimed. Take one back or wait for it to be claimed.`
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

export async function outstandingLinkCount(): Promise<number> {
  const links = distinctLinks(await linkRows())
  let n = 0
  for (const parts of links.values()) if (parts.some((p) => p.link.status === 'outstanding')) n += 1
  return n
}

async function setLinkStatus(rows: LinkRow[], status: GiftLinkStatus, at = Date.now()): Promise<void> {
  const wallet = getWallet()
  for (const r of rows) {
    const link: GiftLinkRecord = { ...r.link, status, closedAt: at }
    const merged = await wallet.updateTransaction(r.id, { link } as unknown as Partial<TransactionRow>)
    if (merged) void publishTx(merged)
  }
  notifyWalletChanged()
}

// ─── Send ────────────────────────────────────────────────────────────────────

export interface GiftSent {
  result: SendResult
  link: string
  x: number
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
}: {
  payer: string
  merchant: Merchant
  unit: string
  amount: number
  memo?: string
  /** The link's expiry, unix seconds, already capped (`giftExpiry`). */
  x: number
  walletOrigin?: string
}): Promise<GiftSent & { delivered: boolean }> {
  const rows = await linkRows()
  const outstanding = [...distinctLinks(rows).values()].filter((p) => p.some((r) => r.link.status === 'outstanding')).length
  if (outstanding >= MAX_OUTSTANDING_LINKS) throw new Error(tooManyLinksMessage())

  const used = new Set(rows.map((r) => r.link.i).filter((i): i is number => i !== undefined))
  const allocated = allocateLink(payer, used)
  const k = secretToText(allocated.secret)
  const link = formatGiftLink(walletOrigin, allocated.secret, x)
  if (!link) throw new Error('Could not make a link for this wallet.')
  // Reserved BEFORE the send: a send that ends with its outcome unknown must still never reuse the
  // index (that link key may hold the coupon).
  if (allocated.i !== undefined) advanceLinkIndex(payer, allocated.i)

  const record: GiftLinkRecord = { k, x, status: 'outstanding', ...(allocated.i !== undefined ? { i: allocated.i } : {}) }
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
  let delivered = false
  for (let attempt = 0; attempt < 5 && !delivered; attempt++) {
    try {
      delivered = (await giftTokensFrom(allocated.secret, await fetchGiftWraps(allocated.secret))).length > 0
    } catch {
      delivered = false
    }
    if (!delivered) await new Promise((r) => setTimeout(r, 1500))
  }
  return { result, link, x, delivered }
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
): Promise<GiftRedeemOutcome> {
  await loadTrustedMints()
  for (const { token } of tokens) {
    if (checkTokenBacking(token).outcome !== 'accept') return { kind: 'held' }
  }
  await legacyApi()
  const redemption = window.TokenRedemption
  if (!redemption) return { kind: 'failed', message: 'This wallet could not start the receive.' }
  let added = 0
  let spent = 0
  for (const { token } of tokens) {
    try {
      const validation = cashbackValidation(token)
      await withCorrelation(validation ? { validation: { ...validation } } : {}, (correlationId) =>
        redemption.redeem(token, { source, metadata: { correlation_id: correlationId } }),
      )
      added += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/11001|already[\s_]spent|proof already used|already been redeemed|already redeemed/i.test(message)) {
        spent += 1
        continue
      }
      notifyWalletChanged()
      return { kind: 'failed', message }
    }
  }
  notifyWalletChanged()
  if (added === 0 && spent > 0) return { kind: 'claimed' }
  return { kind: 'ok' }
}

/** Fetch, unwrap and return a link's coupons. */
export async function giftTokensForSecret(secret: Uint8Array): Promise<GiftToken[]> {
  return giftTokensFrom(secret, await fetchGiftWraps(secret))
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
  return { verdict: await verifyGift(tokens, x, nowMs), tokens }
}

// ─── Status, take back, reclaim after x (spec 3.3) ───────────────────────────

export type TakeBackOutcome = GiftRedeemOutcome | { kind: 'not_found' }

/** "Take it back" (Q4): the sender receives its own link, before or after `x`. */
export async function takeBack(k: string): Promise<TakeBackOutcome> {
  const secret = secretFromText(k)
  if (!secret) return { kind: 'not_found' }
  const rows = (await linkRows()).filter((r) => r.link.k === k)
  let tokens: GiftToken[]
  try {
    tokens = await giftTokensForSecret(secret)
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
  if (tokens.length === 0) return { kind: 'not_found' }
  const states = await Promise.all(tokens.map((t) => tokenState(t.token)))
  if (combinedState(states) === 'SPENT') {
    await setLinkStatus(rows, 'claimed')
    return { kind: 'claimed' }
  }
  const unspent = tokens.filter((_, n) => states[n] !== 'SPENT')
  const outcome = await redeemGiftTokens(unspent, 'gift_link_reclaim')
  if (outcome.kind === 'ok') await setLinkStatus(rows, 'reclaimed')
  else if (outcome.kind === 'claimed') await setLinkStatus(rows, 'claimed')
  return outcome
}

/**
 * On start and on opening History (spec 3.3): every outstanding link is checked by NUT-07. Spent
 * means claimed. Past `x` and still unspent means take it back now. Never throws: the wallet must
 * open whatever the mint says.
 */
export async function reconcileGiftLinks(
  nowMs = Date.now(),
  state: (token: string) => Promise<ProofState> = tokenState,
): Promise<{ claimed: number; reclaimed: number }> {
  let claimed = 0
  let reclaimed = 0
  try {
    for (const [k, parts] of distinctLinks(await linkRows())) {
      if (!parts.some((p) => p.link.status === 'outstanding')) continue
      const secret = secretFromText(k)
      if (!secret) continue
      let tokens: GiftToken[]
      try {
        tokens = await giftTokensForSecret(secret)
      } catch {
        continue
      }
      if (tokens.length === 0) continue
      const states = await Promise.all(tokens.map((t) => state(t.token)))
      const overall = combinedState(states)
      if (overall === 'SPENT') {
        await setLinkStatus(parts, 'claimed')
        claimed += 1
        continue
      }
      if (overall !== 'UNSPENT') continue
      if (Math.floor(nowMs / 1000) >= parts[0].link.x) {
        const outcome = await redeemGiftTokens(tokens, 'gift_link_reclaim')
        if (outcome.kind === 'ok') {
          await setLinkStatus(parts, 'reclaimed')
          reclaimed += 1
        } else if (outcome.kind === 'claimed') {
          await setLinkStatus(parts, 'claimed')
          claimed += 1
        }
      }
    }
  } catch (error) {
    console.warn('[gift] could not check outstanding links', error instanceof Error ? error.message : String(error))
  }
  return { claimed, reclaimed }
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
    let last = Math.max(-1, ...rows.map((r) => r.link.i ?? -1), nextLinkIndex(pubkey) - 1)
    let adopted = 0
    for (let i = 0; i <= last + RESTORE_GAP; i++) {
      const secret = deriveLinkSecret(id, i)
      const k = secretToText(secret)
      let tokens: GiftToken[]
      try {
        tokens = await probe(secret)
      } catch {
        continue
      }
      if (tokens.length === 0) continue
      if (i > last) last = i
      advanceLinkIndex(pubkey, i)
      if (known.has(k)) continue
      const states = await Promise.all(tokens.map((t) => state(t.token)))
      if (combinedState(states) !== 'UNSPENT') continue
      await adoptLink(k, i, tokens, nowMs)
      known.add(k)
      adopted += 1
    }
    return adopted
  } finally {
    id.fill(0)
  }
}

async function adoptLink(k: string, i: number, tokens: GiftToken[], nowMs: number): Promise<void> {
  const wallet = getWallet()
  for (const { token, sentAt } of tokens) {
    let parsed
    try {
      parsed = parseVoucherToken(token)
    } catch {
      continue
    }
    const exp = parsed.voucher.expiresAt
    const expS = exp ? (exp > 1e12 ? Math.floor(exp / 1000) : exp) : undefined
    const x = Math.min(Math.floor(nowMs / 1000) + 30 * 86400, expS ?? Infinity)
    const row = buildSentTransaction({
      tokenId: `gift-${await tokenIdFrom(token)}`,
      amount: creditableFaceValue(parsed).faceValue,
      unit: parsed.voucher.unit,
      decimals: parsed.voucher.faceDecimals,
      merchantId: (/^[0-9a-f]{64}$/i.test(parsed.voucher.issuerId ?? '') ? parsed.voucher.issuerId : parsed.voucher.issuerPublicKey).toLowerCase(),
      recipientPubkey: linkPubOf(secretFromText(k)!),
      recipientName: 'Link',
      voucherId: parsed.voucher.voucherId,
      link: { k, i, x, status: 'outstanding' },
      at: sentAt * 1000,
    })
    await wallet.addTransaction(row)
  }
  notifyWalletChanged()
}
