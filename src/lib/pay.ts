import type { Voucher } from '@imani/voucher-send'
import type { VoucherRow } from '@imani/wallet-storage'

import { getWallet, listVouchers, notifyWalletChanged } from './wallet'
import { legacyApi } from './legacyBridge'
import { couponsFor, toVoucher, type Merchant } from './merchants'
import { buildPaymentTransaction } from './transactions'
import type { NUT18VRequest } from './nap'
import { tokenIdFrom } from '../../packages/wallet-storage/src/tokenId'

/**
 * Paying a merchant's voucher payment request.
 *
 * This follows imani-apps' OWN send path, which is not the one this file
 * originally reached for. Their send screen (`voucher/js/send.js`) drives
 * `bundleSendOrchestrator` → `shared/atomicSendIntegration.js` →
 * `api.initiateAtomicSend` → **`POST /api/v1/atomic-send`**: one escrowed
 * server-side saga that does the split, sends the NIP-17 DM, and hands back a
 * `keep_token` for the change. It does NOT drive VoucherSender, and it does not
 * call the split endpoints to spend.
 *
 * Two things that cost a session to learn, both verified against the running
 * stack rather than read off a controller:
 *
 *  - `/api/v1/wallet/vouchers/split[/preview]` are refused by customer-wallet's
 *    self-custody guard ("its request is routing to the wrong tier"), and
 *    `VoucherSender.send()` calls them unconditionally — even for an exact-value
 *    match — so that route could never complete a payment here.
 *  - `api.splitPreview` in the vanilla app is a **UI affordance only**. Its
 *    result (`splitPreviewData`) is cached and never read, and its catch block
 *    just hides a rounding hint. A failing preview never blocks a send there;
 *    ours treated it as fatal.
 *
 * `/api/v1/atomic-send` lives on account-app, not customer-wallet — see the
 * proxy note in vite.config.ts. `window.api` is imani-apps' own client, already
 * loaded as a classic script by legacyBridge, so this reuses their request
 * building, NIP-98 signing and idempotency rather than re-rolling any of it.
 */

/** Terminal saga states, copied from atomicSendIntegration.js's own list. */
const TERMINAL = [
  'COMPLETED',
  'FAILED',
  'EXPIRED',
  'DM_ERROR',
  'RECLAIM_READY',
  'RECLAIMED',
  'CANCELLED',
  'SPLIT_ERROR',
]

type SendStatus = {
  status?: string
  keep_token?: string
  /** Face value of the change, authoritative — the split may round. */
  keep_face_value?: number
  is_full_send?: boolean
  error?: string
  error_message?: string
}

/**
 * The sats backing a token, straight from its proofs.
 *
 * `sumTokenProofs` is a classic-script global from imani-apps' shared/format.js,
 * which legacyBridge has loaded by the time any of this runs. Used for the
 * change coupon after a split, because the status response carries
 * `keep_face_value` but no keep-side sats, and a proof-summed figure is the
 * mint's actual answer rather than our arithmetic about it. Returns null for
 * compressed tokens, hence the caller's fallback.
 */
function satsInToken(token: string): number | null {
  const sum = (globalThis as unknown as Record<string, unknown>).sumTokenProofs
  if (typeof sum !== 'function') return null
  const value = (sum as (t: string) => number | null)(token)
  return typeof value === 'number' && value > 0 ? value : null
}

/**
 * Pick the coupon to spend.
 *
 * Exact face value first: that makes it a FULL send, so the backend performs no
 * split and returns no keep_token — the one path that needs nothing from the
 * split endpoints this tier refuses. Otherwise the smallest coupon that covers
 * the amount, which is the ordinary split-and-change case.
 */
/**
 * The smallest face amount a coupon can be divided into.
 *
 * A cashu proof is indivisible below one sat, and one sat is worth
 * `issuance_ratio` face minor units — so nothing smaller than `ceil(ratio)` can
 * be split off. imani-apps computes the same floor to step its amount input
 * (`voucher/js/send.js:2319-2325`); here the amount arrives fixed in a payment
 * request, so it is a validation rather than an input constraint.
 *
 * At this stack's ratio of 1.0 with 2-decimal EUR this is one cent, so it never
 * bites today. It becomes real the moment a merchant issues at a ratio above 1 —
 * a 5000 XAF coupon backed by 200 sats has a floor of 25 XAF.
 */
export function minSplitStep(voucher: Voucher): number {
  const face = voucher.face_value ?? 0
  const sats = voucher.token_amount ?? 0
  const ratio = voucher.issuance_ratio ?? (sats > 0 ? face / sats : 0)
  return Math.max(1, Math.ceil(ratio))
}

export type SplitCheck = { ok: true } | { ok: false; reason: string }

/**
 * Can this coupon pay exactly this amount?
 *
 * A full send needs no split and is always allowed — that is the path a 1-sat
 * coupon still has. Anything else has to leave at least one whole sat on BOTH
 * sides: the merchant cannot be sent a fraction of a proof, and neither can the
 * change. imani-apps enforces the send side by stepping its input and the keep
 * side by capping it at `floor(max / step)`; both are checked explicitly here.
 */
export function checkSplittable(voucher: Voucher, amount: number): SplitCheck {
  const face = voucher.face_value ?? 0
  const sats = voucher.token_amount ?? 0

  if (amount <= 0) return { ok: false, reason: 'The amount must be more than zero.' }
  if (amount > face) return { ok: false, reason: 'This voucher is worth less than the amount.' }
  if (amount === face) return { ok: true } // full send — no split involved

  // Below here a split is required.
  if (sats <= 0) {
    return { ok: false, reason: 'This voucher has no sats backing, so it cannot be split.' }
  }
  if (sats <= 1) {
    return {
      ok: false,
      reason: 'This voucher is backed by a single sat and can only be spent whole.',
    }
  }

  const step = minSplitStep(voucher)
  if (amount < step) {
    return { ok: false, reason: `The smallest amount this voucher can be split into is ${step}.` }
  }
  if (face - amount < step) {
    return {
      ok: false,
      reason: `Paying this would leave less than ${step} behind, which cannot be split off.`,
    }
  }
  return { ok: true }
}

/**
 * Still has value to send?
 *
 * `'spent'` is voucher-send's own vocabulary; `'redeemed'` is a merchant's
 * coupon that came home and was burnt (burn.ts). Offering either would build a
 * send the mint refuses, after the confirmation screen has already promised it.
 */
function isUnspent(voucher: Voucher): boolean {
  const status = (voucher.status ?? '').toLowerCase()
  return status !== 'spent' && status !== 'redeemed'
}

/**
 * Coupons that could pay this amount, best first.
 *
 * Exact matches lead — they need no split at all — then the smallest coupons
 * that can be divided to it. Returns every candidate rather than one, because
 * the gateway can refuse a specific coupon (see payRequest).
 */
export function selectVouchers(vouchers: Voucher[], amount: number): Voucher[] {
  const usable = vouchers
    .filter((v) => v.token && isUnspent(v) && checkSplittable(v, amount).ok)
    .sort((a, b) => (a.face_value ?? 0) - (b.face_value ?? 0))
  return [
    ...usable.filter((v) => v.face_value === amount),
    ...usable.filter((v) => v.face_value !== amount),
  ]
}

/**
 * Why no coupon can pay this, for the confirmation screen.
 *
 * Reports against the coupon that came closest — the largest one, which is the
 * most likely to be splittable — so the message names a real obstacle rather
 * than a generic refusal.
 */
export function splitObstacle(vouchers: Voucher[], amount: number): string | null {
  if (selectVouchers(vouchers, amount).length > 0) return null

  const best = vouchers
    .filter((v) => v.token && isUnspent(v))
    .sort((a, b) => (b.face_value ?? 0) - (a.face_value ?? 0))[0]
  if (!best) return null

  const check = checkSplittable(best, amount)
  return check.ok ? null : check.reason
}

/** States where the backend holds the token and expects the sender to take it back. */
const RECLAIMABLE = ['DM_ERROR', 'RECLAIM_READY', 'EXPIRED', 'FAILED', 'SPLIT_ERROR']

/** Poll budget for the send saga: 40 × 500ms = 20s before we stop waiting. */
export const POLL_ATTEMPTS = 40
export const POLL_INTERVAL_MS = 500

/**
 * Swap a coupon's token for a replacement (split change, or a reclaimed token).
 *
 * `token_id` is content-derived, so a new token means a new key: the old row has
 * to go and the new one has to carry a recomputed id, or the row ends up
 * claiming a token_id that does not hash to its own token.
 *
 * Addressed by `tokenId` — the store's primary key — NOT by `voucher_id`. This
 * used to resolve the row with `getVoucherByVoucherId`, which is an index-only
 * lookup, and `toVoucher` hands callers `voucher_id: row.voucher_id ??
 * row.token_id`. So for a row stored without a voucher_id the lookup was handed
 * a token_id, matched nothing, and returned null — the removal below silently
 * no-opped, leaving the just-spent coupon in the wallet at full face value while
 * `{...row}` spread nothing and the change row lost its issuer, unit and
 * decimals. `couponsFor`'s doc in merchants.ts already spells out why voucher_id
 * cannot address one coupon: it is a merchant TEMPLATE id, shared between
 * coupons issued together, so even a hit could have returned the wrong row.
 *
 * Exported for tests: this is the money-losing path and it is worth pinning.
 */
export async function replaceVoucherToken(
  wallet: Pick<ReturnType<typeof getWallet>, 'getVoucher' | 'removeVoucher' | 'saveVoucher'>,
  tokenId: string,
  token: string,
  faceValue?: number,
): Promise<void> {
  const row = await wallet.getVoucher(tokenId)
  if (row) {
    await wallet.removeVoucher(tokenId)
  } else {
    // Should not happen now the key is the primary key, and it must never be
    // silent: the replacement below still runs, because dropping the change
    // token would lose real money.
    console.error('[pay] no row for the coupon being replaced; key:', tokenId)
  }

  // The sats must move with the face value. A coupon that keeps its old
  // token_amount after a partial spend claims backing it no longer has, and
  // since face is re-derivable as round(token_amount × issuance_ratio), a stale
  // sats figure re-inflates the face value on the next read — imani-apps'
  // "25 XAF credited as 5000" bug. Proof sum first (the mint's own answer),
  // pro-rata second, matching what the vanilla send screen writes back.
  const sats =
    satsInToken(token) ??
    (typeof row?.token_amount === 'number' &&
    typeof row?.face_value === 'number' &&
    row.face_value > 0 &&
    faceValue !== undefined
      ? Math.round(row.token_amount * (faceValue / row.face_value))
      : row?.token_amount)

  await wallet.saveVoucher({
    ...row,
    token_id: await tokenIdFrom(token),
    // No `voucher_id` override. The spread already carries the row's own, and
    // the old override wrote whatever id the caller happened to hold — which,
    // for a row without one, was a token_id masquerading as a voucher_id.
    token,
    ...(faceValue === undefined ? {} : { face_value: faceValue }),
    ...(sats === undefined ? {} : { token_amount: sats, amount: sats }),
    status: 'active',
    updated_at: new Date().toISOString(),
  } as Parameters<typeof wallet.saveVoucher>[0])
}

/**
 * Take the money back after a failed send.
 *
 * `reclaimed_token` replaces the source coupon's token — the original proofs
 * were spent during the split, so the row must carry the new token or the
 * coupon is a listing for money that no longer exists. `token_id` is
 * content-derived, so it has to be recomputed rather than carried over.
 */
async function reclaim(
  api: { reclaimAtomicSend(sendId: string): Promise<{ reclaimed_token?: string }> },
  wallet: ReturnType<typeof getWallet>,
  sendId: string,
  tokenId: string,
  status: SendStatus,
): Promise<string> {
  if (!RECLAIMABLE.includes(String(status.status))) return ''
  try {
    const result = await api.reclaimAtomicSend(sendId)
    if (!result?.reclaimed_token) {
      return ' The gateway reported nothing to return.'
    }

    await replaceVoucherToken(wallet, tokenId, result.reclaimed_token)
    notifyWalletChanged()
    return ' Your voucher has been returned to your wallet.'
  } catch (error) {
    // Best-effort by design. A throw here would REPLACE the real failure with a
    // secondary one, hiding why the payment failed at all. On this stack reclaim
    // is itself unavailable ("Reclaim requires HTTP receive endpoint which is
    // not yet available"), so this is the expected branch, and the user needs to
    // be told the coupon is parked rather than silently gone.
    console.error('[pay] reclaim failed', error)
    return (
      ` Your voucher is held by the gateway (send ${sendId}) and could not be` +
      ` returned automatically: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * A send whose outcome we never saw.
 *
 * Everything `settleSend` needs, because by the time this is read back the
 * coupon, the merchant and the request are all long out of scope. Stored rather
 * than re-derived: the source coupon is exactly what a settle DELETES, so a
 * record that pointed at it by lookup would be unreadable in the one case that
 * matters.
 */
export interface PendingSend {
  sendId: string
  /** Primary key of the source row — see `replaceVoucherToken`. */
  tokenId: string
  /** Minor units actually paid, never the coupon's face value. */
  amount: number
  unit: string
  decimals: number
  merchantPubkey: string
  merchantName?: string
  voucherId?: string
  memo?: string
  /** Source coupon's face, for the change when the gateway omits keep_face_value. */
  sourceFaceValue: number
  at: number
}

// Same `imani-wallet:` prefix and pubkey scoping as the profile, merchant and
// payment-request records.
const pendingKey = (pubkey: string) => `imani-wallet:pending-sends:${pubkey}`

/**
 * What a pre-rename build wrote. These two fields were `farmerPubkey` and
 * `farmerName` until the merchant rename, and a send in flight across the
 * upgrade is read back by the new code.
 *
 * ponytail: read-side fallback rather than a migration pass — nothing else reads
 * this record, and the whole store is capped at 20 entries with a lifetime of one
 * saga. Delete both this type and the coalesces in `loadPendingSends` once no
 * wallet can still be mid-send from a build that predates the rename.
 */
type LegacyPendingSend = PendingSend & { farmerPubkey?: string; farmerName?: string }

export function loadPendingSends(pubkey: string): PendingSend[] {
  try {
    const raw = localStorage.getItem(pendingKey(pubkey))
    if (!raw) return []
    const parsed = JSON.parse(raw) as LegacyPendingSend[]
    if (!Array.isArray(parsed)) return []
    // Normalised HERE and nowhere else, so `settleSend` and
    // `reconcilePendingSends` only ever see the current field names. Without it
    // an in-flight send settles with `merchantId: undefined` and the finished
    // transaction loses the counterparty it was paid to.
    return parsed
      .filter((p) => typeof p?.sendId === 'string')
      .map((p) => ({
        ...p,
        merchantPubkey: p.merchantPubkey ?? p.farmerPubkey,
        merchantName: p.merchantName ?? p.farmerName,
      }))
  } catch {
    return []
  }
}

function savePendingSends(pubkey: string, sends: PendingSend[]): void {
  if (sends.length === 0) localStorage.removeItem(pendingKey(pubkey))
  else localStorage.setItem(pendingKey(pubkey), JSON.stringify(sends))
}

/** Records a send we stopped waiting for. Keyed on send id, so a retry overwrites. */
function rememberPendingSend(pubkey: string, pending: PendingSend): void {
  const others = loadPendingSends(pubkey).filter((p) => p.sendId !== pending.sendId)
  savePendingSends(pubkey, [pending, ...others].slice(0, 20))
}

/**
 * Settle the local side of a COMPLETED send.
 *
 * The proofs are already gone from the source coupon: either the whole thing was
 * sent, or the backend split it and handed back the change as keep_token.
 * Acknowledging lets the backend erase its copy, so it must come after the local
 * write, never before.
 *
 * Shared by the live path and `reconcilePendingSends` deliberately — two
 * settle implementations would be two chances to get the change coupon wrong,
 * and that is the money-losing edit in this file.
 *
 * Returns false when the source row is already gone, which means a settle has
 * happened before (another tab, or a reconcile racing the live path). Bailing
 * there is not fussiness: `replaceVoucherToken` spreads the row it found, so a
 * second pass would rewrite the change coupon from `null` and strip its issuer,
 * unit and decimals.
 */
async function settleSend(
  api: { ackKeepToken(sendId: string): Promise<void> },
  wallet: ReturnType<typeof getWallet>,
  pending: PendingSend,
  status: SendStatus,
): Promise<boolean> {
  const spentTokenId = pending.tokenId
  const source = await wallet.getVoucher(spentTokenId)
  if (!source) {
    console.warn('[pay] source coupon already settled, skipping:', pending.sendId)
    await api.ackKeepToken(pending.sendId).catch(() => {})
    return false
  }

  if (status.keep_token) {
    // Partial send: what comes back is the change. Prefer the server's
    // keep_face_value — the split can round, so a local subtraction is not
    // guaranteed to agree with the token actually issued.
    await replaceVoucherToken(
      wallet,
      spentTokenId,
      status.keep_token,
      status.keep_face_value ?? pending.sourceFaceValue - pending.amount,
    )
  } else {
    // Full send: the coupon is gone. Remove by its real key and say so loudly if
    // it did not match, because a silent no-op here leaves the customer looking
    // at a coupon they have already spent.
    const removed = await wallet.removeVoucher(spentTokenId)
    if (!removed) {
      console.error('[pay] spent coupon was not removed from the wallet, key:', spentTokenId)
    }
  }

  // Record the spend so the merchant's history shows both sides. Written after the
  // coupon settles, not before: a transaction row is a record, and the coupon is
  // the money. If this throws, the payment still happened and the coupon is
  // correctly gone — a missing history entry beats a phantom coupon, so it is
  // non-fatal but never silent.
  try {
    await wallet.addTransaction(
      buildPaymentTransaction({
        tokenId: spentTokenId,
        amount: pending.amount,
        unit: pending.unit,
        decimals: pending.decimals,
        merchantId: pending.merchantPubkey,
        merchantName: pending.merchantName,
        voucherId: pending.voucherId,
        memo: pending.memo,
        at: pending.at,
      }),
    )
  } catch (error) {
    console.error('[pay] payment recorded at the gateway but not in local history', error)
  }

  await api.ackKeepToken(pending.sendId).catch(() => {
    // Non-fatal: the backend expires its copy anyway, and the money has moved.
  })
  return true
}

/**
 * Finish sends this wallet stopped waiting for.
 *
 * The poll below gives up after 20s, which is not a verdict on the payment: on
 * 2026-08-16 a saga blocked at the gateway for 7m48s and then completed
 * normally. Until this existed the send id was reported to the customer and then
 * forgotten, so a saga that finished late finished only at the gateway — the
 * merchant had the coupon, while the customer's wallet still listed a coupon whose
 * proofs the mint had burnt, showed no payment in its history, and left the
 * change (`keep_token`) unclaimed until the gateway cleared it 48 hours later.
 *
 * Run on login, beside the other reconciliations. Never throws: a wallet must
 * open whether or not the gateway is reachable.
 */
export async function reconcilePendingSends(pubkey: string): Promise<number> {
  const pending = loadPendingSends(pubkey)
  if (pending.length === 0) return 0

  let api: {
    getAtomicSendStatus(sendId: string): Promise<SendStatus>
    ackKeepToken(sendId: string): Promise<void>
    reclaimAtomicSend(sendId: string): Promise<{ reclaimed_token?: string }>
  }
  try {
    api = (await legacyApi()) as never
  } catch (error) {
    console.error('[pay] cannot reconcile pending sends, API client unavailable', error)
    return 0
  }

  const wallet = getWallet()
  const unresolved: PendingSend[] = []
  let settled = 0

  for (const send of pending) {
    try {
      const status = await api.getAtomicSendStatus(send.sendId)

      if (!TERMINAL.includes(String(status.status))) {
        // Still in flight at the gateway. Keep waiting — but not forever: a send
        // the gateway no longer recognises would otherwise be retried on every
        // login for the life of the wallet. The saga's own expiry is well inside
        // this window, so anything still non-terminal after a week is a row that
        // is never going to answer.
        if (Date.now() - send.at < 7 * 24 * 60 * 60 * 1000) unresolved.push(send)
        else console.error('[pay] giving up on a send that never reached a terminal state:', send.sendId)
        continue
      }

      if (status.status === 'COMPLETED') {
        if (await settleSend(api, wallet, send, status)) settled += 1
        continue
      }

      // Terminal but not completed. Same reasoning as the live path: the saga
      // has already burnt the source coupon's proofs and is holding the
      // replacement, so failing without reclaiming leaves the money in an escrow
      // the customer cannot see.
      const note = await reclaim(api, wallet, send.sendId, send.tokenId, status)
      console.warn(`[pay] pending send ${send.sendId} ended as ${status.status}.${note}`)
    } catch (error) {
      // A status call that fails is a network answer, not a payment answer —
      // keep the record and try again next login.
      console.error('[pay] could not check pending send', send.sendId, error)
      unresolved.push(send)
    }
  }

  savePendingSends(pubkey, unresolved)
  if (settled > 0) notifyWalletChanged()
  return settled
}

/**
 * The body for `POST /api/v1/atomic-send`.
 *
 * Extracted so the one invariant that matters can be tested without a gateway:
 * **the amount sent is the requested amount, never the coupon's face value.**
 *
 * gateway-core splits for `send.faceValue() != null ? send.faceValue() :
 * send.amount()` (AtomicSendService), so `faceValue` here IS the send amount.
 * Passing the source coupon's face value instead made a €2.50 request against a
 * €5.00 coupon complete as `is_full_send=true` — the merchant got the whole
 * coupon, the customer got no change, and the transaction row recorded €2.50
 * while €5.00 left the wallet. imani-apps passes `amount` and `faceValue` as the
 * same send amount (voucher/js/send.js:3380-3383); only unit and decimals
 * describe the source coupon.
 *
 * Exact-value payments cannot catch a regression here — when the request equals
 * the coupon, the right and wrong values are the same number.
 */
export function buildSendParams(
  request: NUT18VRequest,
  candidate: Voucher,
): Record<string, unknown> {
  return {
    token: candidate.token,
    amount: request.amount,
    recipientPubkey: request.issuerId,
    memo: request.description,
    faceValue: request.amount,
    faceUnit: candidate.face_unit,
    faceDecimals: candidate.face_decimals,
    voucherId: candidate.voucher_id,
    issuerId: candidate.issuer_id,
    paymentRequestId: request.paymentId,
  }
}

export async function payRequest({
  request,
  merchant,
  payer,
}: {
  request: NUT18VRequest
  raw: string
  merchant: Merchant
  payer: string
}): Promise<string> {
  // Checked HERE and not only on the screen, because this is the one door the
  // money leaves by. PayPage reads the clock when it loads — a request that
  // lapses while the customer is deciding would walk straight past that check,
  // and the coupons would go out against a request the issuer has timed out.
  if (request.expiresAt !== undefined && request.expiresAt * 1000 < Date.now()) {
    throw new Error('This payment request has expired.')
  }

  // Brings up imani-apps' api.js as a classic script and, critically, its
  // NIP-98 credentials — /api/v1/atomic-send is authenticated.
  const api = (await legacyApi()) as unknown as {
    initiateAtomicSend(
      params: Record<string, unknown>,
      idempotencyKey?: string | null,
    ): Promise<{ send_id?: string; sendId?: string; status?: string }>
    getAtomicSendStatus(sendId: string): Promise<SendStatus>
    ackKeepToken(sendId: string): Promise<void>
    reclaimAtomicSend(sendId: string): Promise<{ status?: string; reclaimed_token?: string }>
  }
  if (!api?.initiateAtomicSend) throw new Error('Gateway API client is not loaded.')

  // `couponsFor` rather than a local filter, so the pay screen and the merchant
  // screens share ONE definition of "this merchant's coupons". The local filter was
  // `v.issuer_id === merchant.pubkey`, comparing a raw issuer id against a
  // VoucherGrouper-normalised pubkey; every other comparison in the app
  // lowercases first, so any row whose issuer_id differed only in case was
  // invisible here while its coupon sat on the merchant's card. It also filters
  // expired coupons, which the send would have failed on anyway.
  //
  // The ROW is kept beside each Voucher: `toVoucher` drops `token_id`, and that
  // is the only thing that can address one coupon in the store. Object identity
  // is safe as the map key because `selectVouchers` filters and sorts — it never
  // clones — so the candidates it returns are these same objects.
  const rows = couponsFor(await listVouchers(), merchant.pubkey)
  const rowOf = new Map<Voucher, VoucherRow>()
  const mine = rows.map((row) => {
    const voucher = toVoucher(row)
    rowOf.set(voucher, row)
    return voucher
  })
  const candidates = selectVouchers(mine, request.amount)
  if (candidates.length === 0) {
    // Says why, not just that it failed — "cannot be split below 25" is
    // actionable in a way that "no coupon covers 10" is not.
    throw new Error(
      splitObstacle(mine, request.amount) ?? 'You have no voucher from this shop for that amount.',
    )
  }

  // A coupon whose previous send is still in flight is refused outright
  // ("An active send already exists for voucher …"). On this stack that state is
  // permanent for any send that failed at DM delivery, since reclaim is
  // unavailable — so a single stuck coupon must not block a wallet that holds
  // seven good ones. Walk past the refused ones instead of failing on the first.
  let initiated: { send_id?: string; sendId?: string; status?: string } | null = null
  let voucher: Voucher | null = null
  /** The stored row behind `voucher` — the only thing carrying its primary key. */
  let sourceRow: VoucherRow | null = null
  let lastRefusal: Error | null = null

  for (const candidate of candidates) {
    try {
      initiated = await api.initiateAtomicSend(
        buildSendParams(request, candidate),
        // Keyed by payment AND coupon: a double-tap on Pay must dedupe to one
        // send, but moving to the next coupon is a genuinely different send and
        // must not collide with the refused one's key.
        `pay_${request.paymentId}_${candidate.voucher_id}`,
      )
      voucher = candidate
      sourceRow = rowOf.get(candidate) ?? null
      break
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('active send already exists')) throw error
      lastRefusal = error instanceof Error ? error : new Error(message)
      console.warn('[pay] coupon busy, trying the next one:', candidate.voucher_id)
    }
  }

  if (!initiated || !voucher || !sourceRow) {
    throw new Error(
      `Every voucher from this shop is tied up in an unfinished send. ${lastRefusal?.message ?? ''}`.trim(),
    )
  }

  const sendId = initiated.send_id ?? initiated.sendId
  if (!sendId) throw new Error('Gateway accepted the send but returned no send id.')

  // ponytail: poll rather than subscribe. The saga also streams over SSE
  // (api.subscribeAtomicSendEvents), which is what the vanilla app uses — but
  // SSE on this stack drops with ERR_INCOMPLETE_CHUNKED_ENCODING (§11.4), and a
  // dropped stream would read as a stuck payment. Swap to SSE when that is
  // fixed; the terminal-state handling below is the same either way.
  let status: SendStatus = { status: initiated.status }
  for (let i = 0; i < POLL_ATTEMPTS && !TERMINAL.includes(String(status.status)); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    status = await api.getAtomicSendStatus(sendId)
  }

  const wallet = getWallet()

  // Everything a settle needs, captured while the coupon and the request are
  // still in scope — see PendingSend.
  const pending: PendingSend = {
    sendId,
    tokenId: sourceRow.token_id,
    amount: request.amount,
    unit: voucher.face_unit ?? request.unit ?? '',
    decimals: voucher.face_decimals ?? 2,
    merchantPubkey: merchant.pubkey,
    merchantName: merchant.name === merchant.pubkey ? undefined : merchant.name,
    voucherId: voucher.voucher_id,
    memo: request.description,
    sourceFaceValue: voucher.face_value ?? 0,
    at: Date.now(),
  }

  // Running out of polls is NOT a failed payment, and must not be reported as
  // one. A saga still mid-flight has a non-terminal status, which used to fall
  // into the branch below and tell the customer "Payment did not complete" —
  // while the merchant went on to receive the coupon moments later. `reclaim`
  // could not soften it either: a non-terminal status is not in RECLAIMABLE, so
  // it returned '' and nothing was reclaimed.
  //
  // The local coupon is deliberately left untouched: we do not know the outcome,
  // and deleting a coupon for a send that may yet fail is worse than showing one
  // that may already be spent. What is NOT left is the send itself — it goes in
  // the pending ledger so `reconcilePendingSends` can finish it on the next
  // login. Before that, a saga that completed late completed only at the
  // gateway; see that function for what it cost.
  if (!TERMINAL.includes(String(status.status))) {
    rememberPendingSend(payer, pending)
    throw new Error(
      `This payment is still going through at the gateway (send ${sendId}, ` +
        `${status.status ?? 'no status'}). It has NOT failed and your voucher is ` +
        `unchanged here — check the shop's history again in a moment before retrying.`,
    )
  }

  if (status.status !== 'COMPLETED') {
    // The saga has already burned the source coupon's proofs by this point and
    // is holding the replacement (TOKEN_HELD). Failing without reclaiming would
    // leave the customer's money in an escrow they cannot see — the coupon
    // would still be listed locally while being unspendable. The backend says
    // as much on DM_ERROR: "sender should reclaim via RECLAIM_FROM_DM_ERROR".
    const note = await reclaim(api, wallet, sendId, sourceRow.token_id, status)
    throw new Error(
      `Payment did not complete (${status.status ?? 'no status'})` +
        `${status.error_message ?? status.error ? `: ${status.error_message ?? status.error}` : ''}` +
        note,
    )
  }

  await settleSend(api, wallet, pending, status)

  notifyWalletChanged()
  return request.paymentId
}
