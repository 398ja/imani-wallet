import type { Voucher } from '@imani/voucher-send'
import type { TransactionRow, VoucherRow } from '@imani/wallet-storage'

import { getWallet, listVouchers, notifyWalletChanged } from './wallet'
import { legacyApi } from './legacyBridge'
import { couponsFor, issuerKey, toMerchants, toVoucher, type Merchant } from './merchants'
import { merchantStatus } from './merchant'
import { getSigner } from './nap'
import { hasSelfLockedProof } from './selfLockedCoupons'
import { spentTokenIds, withoutSpent } from './spentCoupons'
import { buildPaymentTransaction, buildSentTransaction, type GiftLinkRecord } from './transactions'
import { sendTransferSignature } from './transferSignature'
import { creditableFaceValue, parseVoucherToken } from './voucherToken'
import { publishTx } from './txRecords'
import { OWN_STALL_COPY, giftExclusion } from './giftLink'
import { FULLY_REDEEMED_STATUS, VoucherFullyRedeemedError, isVoucherFullyRedeemed } from './fullyRedeemed'
import type { NUT18VRequest } from './nap'
import { tokenIdFrom } from '../../packages/wallet-storage/src/tokenId'
import { carryExpiryReminders } from './expiryReminders'
import { withSpend } from './receiveGate'
import { PENDING_SEND_LIFETIME_MS as SEND_LIFETIME, pendingSendsKey } from './inFlightMoney'
import { checkoutHeldTokenIds } from './checkoutCodeRecords'
import { forgetSendIntent, gatewayAnswered, keyForSend, pendingIntentVoucher } from './sendIntent'
import {
  RequestAlreadyPaidError,
  isSettledSend,
  rememberSettledSend,
  settledAgainstRequest,
} from './settledSends'

/**
 * The money decisions now live in `@imani/wallet-core`.
 *
 * They moved because the wallet API (#3) has to give the same answers as the
 * app, and two implementations of "what does this spend cost" is a class of bug
 * that cannot be tested away. Re-exported here rather than repointing forty
 * call sites: this file is still where a reader looks for the send path, and
 * the package is where the decisions are made.
 */
export {
  minSplitStep,
  checkSplittable,
  selectVouchers,
  planParts,
  splitObstacle,
  passedOver,
  type SplitCheck,
  type SendPart,
  type SendPlan,
} from '@imani/wallet-core'
import { passedOver, planParts, selectVouchers, splitObstacle } from '@imani/wallet-core'

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
  /**
   * sha256(send token)[:32], the gateway's delivery-correlation id. The one
   * identifier for this transfer that the recipient can also compute, which is
   * what the sender's signature (#91) is keyed on. Absent from older gateways.
   */
  sent_voucher_id?: string
  error?: string
  error_message?: string
  /** Why a FAILED send failed. `VOUCHER_FULLY_REDEEMED` is the mint's 90025 (cashu-mint#540). */
  error_code?: string
  /**
   * #461: set by a gateway that answers an initiate with a send it already had for this
   * idempotency key. Such an answer describes an EARLIER send, never this one.
   */
  idempotent_replay?: boolean
  /** #461: sha256(source token)[:32] of the send the gateway is describing, when it says. */
  token_fingerprint?: string
}

/**
 * The send failed because the mint's redemption cap refused the coupon (cashu-mint#540, 90025).
 *
 * Not reclaimed: the mint signed nothing, so the source row still holds the holder's proofs, and
 * the reclaim endpoint refuses a FAILED send anyway. The row is marked `fully_redeemed` so it is
 * never offered for a payment again (a retry is refused the same way) and is listed for "Swap back
 * to sats" instead. Never throws: the caller's job is to report the refusal, which a failed write
 * must not replace.
 */
async function markFullyRedeemed(
  wallet: ReturnType<typeof getWallet>,
  pending: Pick<PendingSend, 'tokenId' | 'sendId' | 'voucherId'>,
): Promise<void> {
  try {
    const row = await wallet.getVoucher(pending.tokenId)
    if (!row) return
    await wallet.saveVoucher({
      ...row,
      status: FULLY_REDEEMED_STATUS,
      updated_at: new Date().toISOString(),
    } as Parameters<typeof wallet.saveVoucher>[0])
    notifyWalletChanged()
  } catch (error) {
    console.error('[pay] could not mark a fully redeemed coupon', pending.sendId, error)
  }
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
/** States where the backend holds the token and expects the sender to take it back. */
const RECLAIMABLE = ['DM_ERROR', 'RECLAIM_READY', 'EXPIRED', 'FAILED', 'SPLIT_ERROR']

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

  const newTokenId = await tokenIdFrom(token)
  await wallet.saveVoucher({
    ...row,
    token_id: newTokenId,
    // No `voucher_id` override. The spread already carries the row's own, and
    // the old override wrote whatever id the caller happened to hold — which,
    // for a row without one, was a token_id masquerading as a voucher_id.
    token,
    ...(faceValue === undefined ? {} : { face_value: faceValue }),
    ...(sats === undefined ? {} : { token_amount: sats, amount: sats }),
    status: 'active',
    updated_at: new Date().toISOString(),
  } as Parameters<typeof wallet.saveVoucher>[0])
  // #265/#269 review: the change keeps the coupon's expiry, so it keeps what the customer was
  // already told about it: no second "expires in N days" entry and no banner back. Never throws.
  carryExpiryReminders(tokenId, newTokenId)
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
  /** Issuer of the coupon being spent — NEVER the person it was sent to. */
  merchantPubkey: string
  merchantName?: string
  /**
   * Set only on a customer-to-customer send; absent means this is a payment to
   * the merchant named above. It is what makes `settleSend` write a 'sent' row
   * instead of a 'payment' one, and it is stored rather than re-derived for the
   * same reason as everything else here: by reconcile time the recipient is
   * long out of scope, and a name resolved from kind-0 may be unreachable.
   */
  recipientPubkey?: string
  recipientName?: string
  /**
   * Set on a payment of a merchant's request, so a second payment of the same request can be
   * refused while this one is unconfirmed (#128). A redemption has no `recipientPubkey`.
   */
  paymentRequestId?: string
  voucherId?: string
  memo?: string
  /**
   * Set when this send was one part of a bundle, so the history can show three
   * rows as one send of the total rather than three unexplained ones. Carried
   * on the pending record because a reconcile finishing a part on the next
   * login has no other way back to the bundle it belonged to.
   */
  bundleId?: string
  /** Source coupon's face, for the change when the gateway omits keep_face_value. */
  sourceFaceValue: number
  at: number
  /**
   * Set on a send to a gift LINK key (claim links phase 4, spec 3.3). Stored on the pending send so a
   * send settled late by `reconcilePendingSends` still writes the link onto its row, and still
   * skips the ADR 0014 transfer signature (Q7).
   */
  link?: GiftLinkRecord
}

// Same `imani-wallet:` prefix and pubkey scoping as the profile, merchant and
// payment-request records.
// Defined in inFlightMoney.ts, which logout reads to refuse while one is live.
const pendingKey = pendingSendsKey

/**
 * How long an unconfirmed send is still taken to be in flight. The saga's own expiry is well
 * inside it, so a send still unanswered after this is one that is never going to answer (#127).
 */
const PENDING_SEND_LIFETIME_MS = SEND_LIFETIME

function isStillInFlight(send: PendingSend): boolean {
  return Date.now() - send.at < PENDING_SEND_LIFETIME_MS
}

/** The pending sends that still hold their coupon and their recipient back (#128). */
function inFlightSends(payer: string): PendingSend[] {
  return loadPendingSends(payer).filter(isStillInFlight)
}

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
 * Drops a send whose outcome we did watch, terminal either way.
 *
 * The ledger exists for sends nobody saw the end of. Leaving a finished one in
 * it costs a pointless status call on every login, and worse: a settled send
 * gets settled again. `settleSend` bails safely when the source coupon is
 * already gone, but it still re-acks the keep token, so the next login would
 * report finishing work that finished seconds after the tap.
 */
function forgetPendingSend(pubkey: string, sendId: string): void {
  savePendingSends(
    pubkey,
    loadPendingSends(pubkey).filter((p) => p.sendId !== sendId),
  )
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
/**
 * What the RECEIVER will credit for the part this send delivered, in the
 * signed voucher's own unit and decimals, so the sender signs the figures the
 * receiver compares and the receipt can carry its commitment (#91).
 *
 * The receiver's figure is `creditableFaceValue` of the token it gets, which
 * is round(sent sats x ratio), clamped to the face. The sent sats are the
 * gateway's split rule: the whole source token on a full send (no change
 * came back), else floor(amount / ratio), gateway-core's default
 * (`VoucherSplitProperties.roundingMode = FLOOR`). On a fractional ratio that
 * can differ from `amount`, and signing `amount` then drops every such receipt
 * to the bare form. Undefined when the source token does not parse (plain
 * ecash), and the caller signs what it asked for, as before.
 */
export function signedPartOf(
  sourceToken: string | undefined,
  amount: number,
  fullSend: boolean,
): { amount: number; unit: string; decimals: number } | undefined {
  if (!sourceToken) return undefined
  try {
    const parsed = parseVoucherToken(sourceToken)
    const { issuanceRatio, unit, faceDecimals } = parsed.voucher
    if (!(issuanceRatio > 0)) return undefined
    const sats = fullSend
      ? parsed.tokenAmount
      : Math.min(parsed.tokenAmount, Math.floor(amount / issuanceRatio + 1e-9))
    const { faceValue } = creditableFaceValue({ ...parsed, tokenAmount: sats })
    return { amount: faceValue, unit, decimals: faceDecimals }
  } catch {
    return undefined
  }
}

/**
 * Why a COMPLETED answer is NOT this send's own completion, or undefined when it is (#461).
 *
 * The rule this enforces: a coupon is deleted only when this exact token was consumed by this
 * exact send. A gateway that replays an idempotency key answers with the EARLIER send's state,
 * and before this `settleSend` took that as its own: no keep_token (the original's change had
 * been acked and cleared), so it took the full-send branch and deleted the change coupon, whose
 * proofs never left the wallet. Any doubt here leaves the coupon alone: a coupon that is shown
 * but already spent is refused by the mint on its next use, a coupon deleted while unspent is
 * money the customer cannot see.
 */
export function replayedSendReason(
  payer: string,
  pending: Pick<PendingSend, 'sendId' | 'tokenId'>,
  status: SendStatus,
): string | undefined {
  if (isSettledSend(payer, pending.sendId)) return 'this wallet already settled that send'
  if (status.idempotent_replay === true) return 'the gateway replayed an earlier send'
  if (status.token_fingerprint && status.token_fingerprint !== pending.tokenId) {
    return 'the gateway describes a send of a different coupon'
  }
  // A partial send whose change is missing. A real one hands the change back until it is acked,
  // and once acked the source row is already replaced (caught above as "already settled").
  if (!status.keep_token && status.is_full_send === false) {
    return 'a partial send came back without its change'
  }
  return undefined
}

async function settleSend(
  api: { ackKeepToken(sendId: string): Promise<void> },
  wallet: ReturnType<typeof getWallet>,
  payer: string,
  pending: PendingSend,
  status: SendStatus,
  /**
   * The transfer id, fetched AFTER the settle when the status in hand has
   * none (an idempotent initiate that answered COMPLETED at once). Never
   * awaited here, so a slow gateway cannot hold up the local row.
   */
  transferIdLater?: () => Promise<string | undefined>,
): Promise<boolean> {
  const spentTokenId = pending.tokenId
  // #461: never settle an answer that describes some other send. No removeVoucher, no row, no
  // ack (the ack belongs to the send that really completed).
  const replay = replayedSendReason(payer, pending, status)
  if (replay) {
    console.error('[pay] not settling a replayed send, coupon kept:', pending.sendId, replay)
    return false
  }
  const source = await wallet.getVoucher(spentTokenId)
  if (!source) {
    console.warn('[pay] source coupon already settled, skipping:', pending.sendId)
    await api.ackKeepToken(pending.sendId).catch(() => {})
    return false
  }
  // Read before the settle below removes or replaces the source row.
  const part = signedPartOf(
    (source as { token?: string }).token,
    pending.amount,
    !status.keep_token,
  )

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
  //
  // Which row depends on where the money went, and `recipientPubkey` is the only
  // thing that knows: same saga, same settle, two records. See
  // `buildSentTransaction` for why a send keeps the ISSUER in `merchantId`.
  try {
    const common = {
      tokenId: spentTokenId,
      amount: pending.amount,
      unit: pending.unit,
      decimals: pending.decimals,
      merchantId: pending.merchantPubkey,
      merchantName: pending.merchantName,
      voucherId: pending.voucherId,
      memo: pending.memo,
      at: pending.at,
    }
    await wallet.addTransaction(
      pending.recipientPubkey
        ? buildSentTransaction({
            ...common,
            recipientPubkey: pending.recipientPubkey,
            recipientName: pending.recipientName,
            bundleId: pending.bundleId,
            // What the transfer signature below is keyed on, kept so it can
            // be rebuilt after a wipe (its nonce derives from our key and this).
            transferId: status.sent_voucher_id,
            link: pending.link,
          })
        : buildPaymentTransaction({ ...common, bundleId: pending.bundleId }),
    )
  } catch (error) {
    console.error('[pay] payment recorded at the gateway but not in local history', error)
  }

  // Sign the transfer for the recipient (#91), on a CUSTOMER-to-customer send
  // only. A payment request has no `recipientPubkey`, and a plain send to a
  // stall's key (which `sendVouchers` allows when it is the issuer) is asked
  // about with the same `merchantStatus` that `refuseIfWrongMerchant` uses: a
  // stall attests what it takes with a 7377 and would only hold a signature
  // that can never pair. 'unknown' (relay unreachable) skips too, costing the
  // receipt and nothing else.
  //
  // After the coupon has settled and the row is written, and NOT awaited:
  // neither call throws, and nothing they do can change the outcome of a send
  // the mint has already completed. Here rather than in the live path so a
  // send finished late by `reconcilePendingSends` is signed too.
  // NOT on a send to a gift link key (spec 3.3, Q7, pre-check build item 1): the signature's
  // `recipient` would name the link key, not whoever finally claims it, and its wrap is a second
  // message addressed to the link that the claimer would only have to ignore.
  if (pending.recipientPubkey && !pending.link) {
    const recipient = pending.recipientPubkey
    const sign = (transfer: string | undefined) =>
      merchantStatus(recipient).then((role) =>
        role === 'customer'
          ? sendTransferSignature({
              transfer,
              recipient,
              // What the receiver will credit, in the signed unit and
              // decimals, so the receipt can commit to it (see `signedPartOf`).
              amount: part?.amount ?? pending.amount,
              unit: part?.unit ?? pending.unit,
              decimals: part?.decimals ?? pending.decimals,
            })
          : false,
      )
    const signing =
      status.sent_voucher_id || !transferIdLater
        ? sign(status.sent_voucher_id)
        : transferIdLater().then(async (transfer) => {
            if (!transfer) return false
            // Onto the row written above, and into its backup, for the same D3
            // reason as there: a wiped sender rebuilds the signature from it.
            try {
              const merged = await wallet.updateTransaction(`sent:${spentTokenId}`, {
                transferId: transfer,
              } as unknown as Partial<TransactionRow>)
              if (merged) void publishTx(merged)
            } catch {
              // The receipt still goes out; only its recovery after a wipe is lost.
            }
            return sign(transfer)
          })
    // `sendTransferSignature` swallows its own failures, so this should never
    // fire. It is here because the promise is not awaited: if that contract
    // broke, the rejection would be unhandled, on a send that succeeded.
    void signing.catch((error) => console.error('[pay] transfer signature failed', error))
  }

  // #461: remembered so a second payment of the same request, or a replayed answer naming this
  // send, is refused instead of settled again.
  rememberSettledSend(payer, {
    sendId: pending.sendId,
    tokenId: spentTokenId,
    paymentRequestId: pending.paymentRequestId,
    amount: pending.amount,
    at: Date.now(),
  })

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
export function reconcilePendingSends(pubkey: string): Promise<number> {
  // One pass at a time per wallet. Login and a send can now both ask for one, and two passes
  // over the same entry would settle the same send twice.
  const running = reconcilesInFlight.get(pubkey)
  if (running) return running
  const pass = reconcileOnce(pubkey).finally(() => reconcilesInFlight.delete(pubkey))
  reconcilesInFlight.set(pubkey, pass)
  return pass
}

const reconcilesInFlight = new Map<string, Promise<number>>()

async function reconcileOnce(pubkey: string): Promise<number> {
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
        if (isStillInFlight(send)) unresolved.push(send)
        else console.error('[pay] giving up on a send that never reached a terminal state:', send.sendId)
        continue
      }

      if (status.status === 'COMPLETED') {
        if (await settleSend(api, wallet, pubkey, send, status)) settled += 1
        continue
      }

      // cashu-mint#540: refused by the mint's redemption cap. Nothing moved, so there is
      // nothing to reclaim: the coupon is marked and offered for a swap back to sats.
      if (isVoucherFullyRedeemed(status)) {
        await markFullyRedeemed(wallet, send)
        console.warn(`[pay] pending send ${send.sendId} refused: coupon redeemed in full`)
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
  candidate: Voucher,
  send: {
    /** Minor units to send FROM this coupon — a whole payment, or one part of one. */
    amount: number
    recipientPubkey: string
    memo?: string
    /**
     * Set on a merchant redemption, absent on a person-to-person send. That
     * single field is the whole difference between the two at the gateway, and
     * it is what comes back to the merchant as `request_id` on the DM so their
     * till can settle the right request — see `matchPayment`.
     */
    paymentRequestId?: string
    bundle?: BundleTag | null
  },
): Record<string, unknown> {
  return {
    token: candidate.token,
    amount: send.amount,
    recipientPubkey: send.recipientPubkey,
    memo: send.memo,
    faceValue: send.amount,
    faceUnit: candidate.face_unit,
    faceDecimals: candidate.face_decimals,
    voucherId: candidate.voucher_id,
    issuerId: candidate.issuer_id,
    ...(send.paymentRequestId ? { paymentRequestId: send.paymentRequestId } : {}),
    ...(send.bundle
      ? {
          bundleId: send.bundle.bundleId,
          bundleTotal: send.bundle.total,
          bundlePartIndex: send.bundle.index,
          bundlePartCount: send.bundle.count,
          // Format is not ours to choose: AtomicSendService rejects anything
          // but `${bundle_id}:${bundle_part_index}` with invalid_bundle_part_id.
          bundlePartId: `${send.bundle.bundleId}:${send.bundle.index}`,
          bundleAttempt: 0,
        }
      : {}),
  }
}

/** The slice of imani-apps' `api` client the send saga uses. */
type SendApi = {
  initiateAtomicSend(
    params: Record<string, unknown>,
    idempotencyKey?: string | null,
  ): Promise<{ send_id?: string; sendId?: string; status?: string }>
  getAtomicSendStatus(sendId: string): Promise<SendStatus>
  ackKeepToken(sendId: string): Promise<void>
  reclaimAtomicSend(sendId: string): Promise<{ status?: string; reclaimed_token?: string }>
}

/**
 * Bring up imani-apps' api.js as a classic script and, critically, its NIP-98
 * credentials — /api/v1/atomic-send is authenticated.
 */
async function sendApi(): Promise<SendApi> {
  const api = (await legacyApi()) as unknown as SendApi
  if (!api?.initiateAtomicSend) throw new Error('Gateway API client is not loaded.')
  return api
}

/**
 * This merchant's spendable coupons, each paired with the row behind it.
 *
 * `couponsFor` rather than a local filter, so every screen shares ONE definition
 * of "this merchant's coupons". The local filter was `v.issuer_id ===
 * merchant.pubkey`, comparing a raw issuer id against a VoucherGrouper-normalised
 * pubkey; every other comparison in the app lowercases first, so any row whose
 * issuer_id differed only in case was invisible while its coupon sat on the
 * merchant's card. It also filters expired coupons, which a send would have
 * failed on anyway.
 *
 * The ROW is kept beside each Voucher because `toVoucher` drops `token_id`, and
 * that is the only thing that can address one coupon in the store. Object
 * identity is safe as the map key because `selectVouchers` filters and sorts —
 * it never clones — so the candidates it returns are these same objects.
 *
 * Coupons still held by an unconfirmed send are left out (`withoutInFlight`, #128). The Send
 * and Pay screens apply the same filter to what they show, so the balance offered matches
 * what can be spent.
 */
async function spendableFrom(merchantPubkey: string, payer: string): Promise<{
  mine: Voucher[]
  rowOf: Map<Voucher, VoucherRow>
}> {
  // #402: a bearer split's change is locked to this wallet's own key, and gateway-core's send cannot
  // split a locked proof (LOCKED_VOUCHER_SPLIT_REQUIRES_HOLDER): a €1 send failed on a €7 change row
  // on staging, 2026-11-01. Unlock such rows first, so what the send draws on is ordinary coupons.
  // Never blocks: a row that could not be unlocked yet is simply left out below.
  await unlockSelfLockedFirst(payer)
  const rows = withoutSelfLocked(withoutInFlight(couponsFor(await listVouchers(), merchantPubkey), payer))

  /**
   * Drop anything this wallet has already spent, according to its own
   * tombstones on the relay (#45).
   *
   * `couponsFor` filters on the LOCAL row's status, which is correct and is not
   * enough: a coupon spent on another device is still `active` here until this
   * device restores. Offering it produces `SOURCE_PROOFS_NOT_UNSPENT` at the
   * gateway, and `initiateOnFirstFree` below records what that costs on this
   * stack — a send failing after the split cannot be reclaimed, so the coupon
   * is stuck rather than merely refused.
   *
   * Only ever subtracts, and never blocks: an unreachable relay answers
   * `known: false`, `withoutSpent` returns the rows untouched, and the send
   * proceeds exactly as it did before this existed.
   */
  let spendableRows = rows
  try {
    const signer = getSigner()
    spendableRows = await withoutTombstoned(rows, signer.pubkey)
  } catch (error) {
    // A locked wallet has no pubkey to scope the read by. Not an error worth
    // failing a send over — the caller is mid-payment and the local filters
    // have already run.
    console.warn('[pay] could not check tombstones; offering the holding unchanged', error)
  }

  const rowOf = new Map<Voucher, VoucherRow>()
  const mine = spendableRows.map((row) => {
    const voucher = toVoucher(row)
    rowOf.set(voucher, row)
    return voucher
  })
  return { mine, rowOf }
}

/**
 * #402: unlock this wallet's self-locked coupon rows (a split's change) before a send draws on the
 * holding. Bounded, so a slow mint or gateway never holds a payment up for long; never throws.
 */
async function unlockSelfLockedFirst(payer: string): Promise<void> {
  try {
    const app = await import('./selfLockedCouponsApp')
    await Promise.race([app.unlockSelfLockedCouponsNow(payer), new Promise((r) => setTimeout(r, 15_000))])
  } catch {
    // Left for the catch-up sweep; the rows are left out of this send below.
  }
}

/**
 * #402: rows still holding a proof locked to this wallet's own key, left out of a send: the gateway
 * would refuse to split them, after the confirmation screen had promised the payment.
 */
function withoutSelfLocked(rows: VoucherRow[]): VoucherRow[] {
  let selfPub: string
  try {
    selfPub = getSigner().pubkey
  } catch {
    return rows
  }
  return rows.filter((row) => !row.token || !hasSelfLockedProof(row.token, selfPub))
}

/**
 * Drop every coupon this wallet has tombstoned on the relay (#45).
 *
 * The one filter `payRequest` spends through and the Pay screen describes
 * through (#169 review), so the screen's "a sooner voucher is not used" note
 * never names a coupon already spent on another device. Only ever subtracts:
 * an unreachable relay leaves the rows unchanged.
 */
export async function withoutTombstoned<T extends { token_id?: string }>(
  rows: T[],
  pubkey: string,
): Promise<T[]> {
  return withoutSpent(rows, await spentTokenIds(pubkey))
}

/**
 * Drop every coupon that is the source of a send still in flight (#128).
 *
 * Such a send may already have reached its recipient: its outcome is unknown, not failed. Its
 * coupon stays in the wallet until `reconcilePendingSends` settles it, and offering it again
 * let a second tap pay the same money twice, from a coupon the gateway had not yet refused.
 */
export function withoutInFlight(rows: VoucherRow[], payer: string): VoucherRow[] {
  const held = new Set(inFlightSends(payer).map((send) => send.tokenId))
  // #402: and every coupon behind a checkout code still outstanding.
  for (const id of checkoutHeldTokenIds(payer)) held.add(id)
  return held.size === 0 ? rows : rows.filter((row) => !held.has(row.token_id))
}

/**
 * Refuse a second payment to someone whose first is still unconfirmed (#128).
 *
 * Leaving the in-flight coupon out is not enough on its own: the second payment would simply
 * draw on another coupon and pay the same person twice. The screen locks its button too, but
 * a screen is easy to leave and come back to, so the rule that protects the money lives here,
 * at the one door it leaves by. Keyed on the payment request when there is one (a redemption),
 * otherwise on the recipient.
 */
function refuseIfUnconfirmedTo(ctx: SendContext): void {
  const unconfirmed = inFlightSends(ctx.payer).find((send) =>
    ctx.paymentRequestId
      ? send.paymentRequestId === ctx.paymentRequestId
      : send.recipientPubkey?.toLowerCase() === ctx.recipient.pubkey.toLowerCase(),
  )
  if (!unconfirmed) return
  throw new SendOutcomeUnknownError(
    `Your last ${ctx.paymentRequestId ? 'payment of this request' : 'send to them'} is still going ` +
      `through (send ${unconfirmed.sendId}) and may already have arrived. Nothing has been sent ` +
      'this time — check your history in a moment before trying again.',
    unconfirmed.sendId,
  )
}

/**
 * Start the saga on the first candidate the gateway will accept.
 *
 * A coupon whose previous send is still in flight is refused outright ("An
 * active send already exists for voucher …"). On this stack that state is
 * permanent for any send that failed at DM delivery, since reclaim is
 * unavailable — so a single stuck coupon must not block a wallet that holds
 * seven good ones. Walk past the refused ones instead of failing on the first.
 */
async function initiateOnFirstFree(
  api: SendApi,
  candidates: Voucher[],
  rowOf: Map<Voucher, VoucherRow>,
  buildParams: (candidate: Voucher) => Record<string, unknown>,
  keyFor: (candidate: Voucher) => string,
  /** Told when the gateway answered for a key (accepted, or refused before anything moved). */
  answered: (key: string) => void = () => {},
): Promise<{ sendId: string; status: SendStatus; voucher: Voucher; sourceRow: VoucherRow }> {
  let lastRefusal: Error | null = null

  for (const candidate of candidates) {
    const key = keyFor(candidate)
    try {
      let initiated
      try {
        initiated = await api.initiateAtomicSend(buildParams(candidate), key)
      } catch (error) {
        // #179: only a definite refusal frees the key. A lost answer keeps it, so the retry
        // (now, or after a reload) carries the SAME key and the gateway replays the first send.
        if (gatewayAnswered(error)) answered(key)
        // #461: gateway-core refuses a second send against a single-use request it saw paid.
        // Nothing moved, so this is the same refusal the local ledger gives, never a failure.
        if ((error as { code?: unknown } | null)?.code === 'request_already_paid') {
          answered(key)
          const requestId = buildParams(candidate).paymentRequestId
          throw new RequestAlreadyPaidError(typeof requestId === 'string' ? requestId : undefined)
        }
        throw error
      }
      answered(key)
      const sendId = initiated.send_id ?? initiated.sendId
      if (!sendId) throw new Error('Gateway accepted the send but returned no send id.')
      const sourceRow = rowOf.get(candidate)
      if (!sourceRow) throw new Error('Lost track of the voucher being spent.')
      // #461: the replay markers ride along with the status, so a replayed initiate that says
      // COMPLETED at once (and is never polled) is still recognised as someone else's send.
      const answer = initiated as SendStatus
      return {
        sendId,
        status: {
          status: initiated.status,
          ...(answer.idempotent_replay !== undefined ? { idempotent_replay: answer.idempotent_replay } : {}),
          ...(answer.token_fingerprint ? { token_fingerprint: answer.token_fingerprint } : {}),
        },
        voucher: candidate,
        sourceRow,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('active send already exists')) {
        lastRefusal = error instanceof Error ? error : new Error(message)
        console.warn('[pay] coupon busy, trying the next one:', candidate.voucher_id)
        continue
      }
      // A coupon whose stored expiry could not be read is offered FIRST, in
      // case it is about to lapse (#157). If a gateway refuses it as expired
      // at initiate, nothing has moved yet (no send row exists), so trying the
      // next coupon is safe and cannot double-send: each candidate has its own
      // idempotency key. Defensive only: gateway-core's initiate does not
      // check voucher expiry today (the mint refuses at the async split), and
      // such a coupon is now rare, since storage repairs an unreadable expiry
      // from the one signed into the token (expiryStorage.ts).
      if (/voucher has expired/i.test(message)) {
        lastRefusal = error instanceof Error ? error : new Error(message)
        console.warn('[pay] coupon refused as expired, trying the next one:', candidate.voucher_id)
        continue
      }
      throw error
    }
  }

  // Every candidate refused. If the last said "expired", say that: calling an
  // expired coupon "tied up in an unfinished send" would send the customer
  // looking for a send that does not exist.
  if (lastRefusal && /voucher has expired/i.test(lastRefusal.message)) throw lastRefusal

  // A bundle part is offered exactly one coupon — the plan's arithmetic is tied
  // to that coupon's face value, so there is nothing to walk on to. Saying
  // "every voucher" there would be a lie about a wallet that may hold plenty.
  throw new Error(
    `${
      candidates.length === 1
        ? 'That voucher is'
        : 'Every voucher from this merchant is'
    } tied up in an unfinished send. ${lastRefusal?.message ?? ''}`.trim(),
  )
}

/**
 * One status read, where a read that fails leaves the status as it was.
 *
 * A failed read says nothing about the send: the saga runs at the gateway whether or not
 * this wallet can reach it for a moment. Letting it throw reported a completed part as
 * "not sent" and told the customer to send the difference again, which paid it twice
 * (#125). An outcome still unknown when the polls run out is the "still going through"
 * answer below, and the pending ledger finishes it on the next login.
 */
async function readStatusOrKeepLast(api: SendApi, sendId: string, last: SendStatus): Promise<StatusRead> {
  try {
    return { status: (await api.getAtomicSendStatus(sendId)) ?? last }
  } catch (error) {
    return { status: last, unreadable: error }
  }
}

type StatusRead = { status: SendStatus; unreadable?: unknown }

/** An HTTP answer that will not change on the next read (a 4xx other than a timeout or 429). */
function isPermanentHttpError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429
}

/** How long to wait before the next read: what a 429 asked for, never less than the poll interval. */
function nextReadDelayMs(unreadable: unknown): number {
  const retryAfterMs = (unreadable as { retryAfterMs?: unknown } | null)?.retryAfterMs
  return typeof retryAfterMs === 'number' ? Math.max(POLL_INTERVAL_MS, retryAfterMs) : POLL_INTERVAL_MS
}

/**
 * The gateway accepted the send and the wallet could not learn how it ended. NOT a failure:
 * the money may well have arrived, and must never be offered to send again. Typed, so a
 * bundle can tell this part apart from one that really failed.
 */
export class SendOutcomeUnknownError extends Error {
  constructor(
    message: string,
    readonly sendId: string,
  ) {
    super(message)
    this.name = 'SendOutcomeUnknownError'
  }
}

/**
 * Wait for the saga to reach a terminal state, then settle the local side.
 *
 * Shared by the merchant-payment and person-to-person paths deliberately: this
 * is where the money is either recorded or lost, and two copies would be two
 * chances to get the change coupon wrong.
 */
async function awaitAndSettle(
  api: SendApi,
  payer: string,
  pending: PendingSend,
  initialStatus: SendStatus,
): Promise<void> {
  // ponytail: poll rather than subscribe. The saga also streams over SSE
  // (api.subscribeAtomicSendEvents), which is what the vanilla app uses — but
  // SSE on this stack drops with ERR_INCOMPLETE_CHUNKED_ENCODING (§11.4), and a
  // dropped stream would read as a stuck payment. Swap to SSE when that is
  // fixed; the terminal-state handling below is the same either way.
  // Written to the ledger BEFORE the wait, not after it. The ledger's whole job
  // is to survive a wallet that stops looking, and the loop below is where that
  // happens: twenty seconds with the screen open is twenty seconds in which the
  // app can be closed, backgrounded to death by Android, or killed. Until this
  // moved up, a send accepted by the gateway and then abandoned here left no
  // record anywhere — the coupon sat in the wallet at full face value while the
  // mint had already burned its proofs, and nothing on the next login went
  // looking. A bundle multiplies that window by its part count, which is what
  // brought it to light.
  // #461: an initiate that already says it is describing an earlier send is refused BEFORE it
  // is written to the pending ledger. Recorded, a later reconcile would read that send's status
  // by id, without the marker, and settle it as this wallet's own.
  const replayedAtInitiate = replayedSendReason(payer, pending, initialStatus)
  if (replayedAtInitiate) {
    console.error('[pay] initiate answered with an earlier send, nothing settled:', pending.sendId, replayedAtInitiate)
    if (pending.paymentRequestId) throw new RequestAlreadyPaidError(pending.paymentRequestId, pending.sendId)
    throw new Error(
      `The gateway answered with an earlier ${pending.recipientPubkey ? 'send' : 'payment'} ` +
        `(send ${pending.sendId}). Nothing was sent this time and your voucher is unchanged.`,
    )
  }

  rememberPendingSend(payer, pending)

  let status: SendStatus = initialStatus
  let polled = false
  let unreadable: unknown
  let delayMs = POLL_INTERVAL_MS
  // The whole wait is bounded in time, not only in reads: a 429 asking for longer than is left
  // ends the wait with the outcome unknown, rather than holding the screen on "Sending".
  const waitEndsAt = Date.now() + (POLL_ATTEMPTS + 1) * POLL_INTERVAL_MS
  for (let i = 0; i < POLL_ATTEMPTS && !TERMINAL.includes(String(status.status)); i += 1) {
    if (Date.now() + delayMs > waitEndsAt) break
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    const read = await readStatusOrKeepLast(api, pending.sendId, status)
    if (read.unreadable !== undefined && unreadable === undefined) {
      console.warn('[pay] send status unreadable, still waiting:', pending.sendId, read.unreadable)
    }
    status = read.status
    unreadable = read.unreadable
    delayMs = nextReadDelayMs(unreadable)
    polled = true
    if (isPermanentHttpError(unreadable)) break
  }

  // An idempotent `initiate` can answer with a send that is ALREADY
  // COMPLETED, and then the loop above never runs and `status` is the bare
  // `{ status }` the initiate returned. The transfer signature (#91) needs
  // `sent_voucher_id`, which only the status endpoint carries, so it is asked
  // for once, AFTER the settle and not awaited by it (`settleSend`'s
  // `transferIdLater`): a slow gateway must not hold up the local row for the
  // sake of a receipt. Only that one field is taken, and a failed read costs
  // the receipt, not the send.
  const transferIdLater =
    !polled && status.status === 'COMPLETED' && pending.recipientPubkey && !status.sent_voucher_id
      ? () =>
          api.getAtomicSendStatus(pending.sendId).then(
            (full) => full.sent_voucher_id,
            () => undefined,
          )
      : undefined

  const wallet = getWallet()
  const noun = pending.recipientPubkey ? 'send' : 'payment'

  // Running out of polls is NOT a failure, and must not be reported as one. A
  // saga still mid-flight has a non-terminal status, which used to fall into the
  // branch below and tell the customer "Payment did not complete" — while the
  // recipient went on to receive the coupon moments later. `reclaim` could not
  // soften it either: a non-terminal status is not in RECLAIMABLE, so it
  // returned '' and nothing was reclaimed.
  //
  // The local coupon is deliberately left untouched: we do not know the outcome,
  // and deleting a coupon for a send that may yet fail is worse than showing one
  // that may already be spent. What is NOT left is the send itself — it goes in
  // the pending ledger so `reconcilePendingSends` can finish it on the next
  // login. Before that, a saga that completed late completed only at the
  // gateway; see that function for what it cost.
  if (!TERMINAL.includes(String(status.status))) {
    const cause =
      unreadable === undefined
        ? ''
        : ` We could not confirm it with the gateway (${unreadable instanceof Error ? unreadable.message : String(unreadable)}).`
    throw new SendOutcomeUnknownError(
      `This ${noun} is still going through at the gateway (send ${pending.sendId}, ` +
        `${status.status ?? 'no status'}). It has NOT failed and your voucher is ` +
        `unchanged here — check your history again in a moment before retrying.${cause}`,
      pending.sendId,
    )
  }

  // cashu-mint#540: the mint's redemption cap refused this coupon (90025). Terminal, never
  // retried: the holder is told it is redeemed in full and offered a swap back to sats.
  if (status.status !== 'COMPLETED' && isVoucherFullyRedeemed(status)) {
    await markFullyRedeemed(wallet, pending)
    forgetPendingSend(payer, pending.sendId)
    throw new VoucherFullyRedeemedError(pending.voucherId, pending.tokenId, pending.merchantName)
  }

  if (status.status !== 'COMPLETED') {
    // The saga has already burned the source coupon's proofs by this point and
    // is holding the replacement (TOKEN_HELD). Failing without reclaiming would
    // leave the customer's money in an escrow they cannot see — the coupon
    // would still be listed locally while being unspendable. The backend says
    // as much on DM_ERROR: "sender should reclaim via RECLAIM_FROM_DM_ERROR".
    const note = await reclaim(api, wallet, pending.sendId, pending.tokenId, status)
    forgetPendingSend(payer, pending.sendId)
    throw new Error(
      `This ${noun} did not complete (${status.status ?? 'no status'})` +
        `${status.error_message ?? status.error ? `: ${status.error_message ?? status.error}` : ''}` +
        note,
    )
  }

  // #461: an answer that describes an earlier send settles nothing, and is not reported as sent.
  const replay = replayedSendReason(payer, pending, status)
  if (replay) {
    forgetPendingSend(payer, pending.sendId)
    console.error('[pay] gateway answered with an earlier send, nothing settled:', pending.sendId, replay)
    if (pending.paymentRequestId) throw new RequestAlreadyPaidError(pending.paymentRequestId, pending.sendId)
    throw new Error(
      `The gateway answered with an earlier ${noun} (send ${pending.sendId}). Nothing was sent ` +
        'this time and your voucher is unchanged.',
    )
  }

  await settleSend(api, wallet, payer, pending, status, transferIdLater)
  forgetPendingSend(payer, pending.sendId)
  notifyWalletChanged()
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
}): Promise<SendResult> {
  // Checked HERE and not only on the screen, because this is the one door the
  // money leaves by. PayPage reads the clock when it loads — a request that
  // lapses while the customer is deciding would walk straight past that check,
  // and the coupons would go out against a request the issuer has timed out.
  if (request.expiresAt !== undefined && request.expiresAt * 1000 < Date.now()) {
    throw new Error('This payment request has expired.')
  }

  // #461: a request this wallet has already paid is refused before anything is asked of the
  // gateway, so no coupon can be touched by a second attempt.
  if (settledAgainstRequest(payer, request.paymentId) > 0) {
    throw new RequestAlreadyPaidError(request.paymentId)
  }

  const api = await sendApi()
  const { mine, rowOf } = await spendableFrom(merchant.pubkey, payer)
  // Filtered by the request's unit, which this door did not do while it spent
  // exactly one coupon and `selectVouchers` compared amounts within it. Drawing
  // across several makes a mixed-unit wallet dangerous: 300 EUR + 200 XAF add
  // up to 500 of nothing, and the request would settle for a fraction of what
  // was asked. Requests without a unit keep the old behaviour.
  const inUnit = request.unit
    ? mine.filter((v) => (v.face_unit ?? '').toUpperCase() === request.unit!.toUpperCase())
    : mine

  await logPassedOver(payer, request)

  return deliver(
    {
      api,
      payer,
      // The merchant IS the recipient of a redemption. `paymentRequestId` below
      // is what keeps the local record a payment rather than a send.
      recipient: {
        pubkey: request.issuerId,
        name: merchant.name === merchant.pubkey ? undefined : merchant.name,
      },
      merchant,
      memo: request.description,
      rowOf,
      unit: request.unit,
      paymentRequestId: request.paymentId,
    },
    inUnit,
    request.amount,
    request.unit,
  )
}

/**
 * Record in the `[pay]` log any sooner-expiring voucher this payment leaves,
 * and why (#157). The pay screen says the same in one line; the log keeps the
 * ids and raw expiries a support check needs. Never blocks a payment.
 */
async function logPassedOver(payer: string, request: NUT18VRequest): Promise<void> {
  try {
    // The pay screen's holding: live, unspent, not behind an unconfirmed send.
    const holding = toMerchants(withoutInFlight(await listVouchers(), payer)).flatMap((m) =>
      m.groups.flatMap((g) => g.vouchers),
    )
    const notes = passedOver(holding, request.amount, {
      issuer: request.issuerId,
      unit: request.unit,
    })
    for (const note of notes) {
      console.info(
        '[pay] sooner-expiring voucher passed over:',
        note.voucher.voucher_id,
        note.voucher.expires_at,
        note.reason,
        note.detail ?? '',
      )
    }
  } catch (error) {
    console.warn('[pay] could not explain voucher order', error)
  }
}

/**
 * What a send actually achieved. Returned rather than assumed, because a bundle
 * can land in pieces: see `sendVouchers`.
 */
export type SendResult = {
  /** The bundle id when several coupons were drawn, the send id when one was. */
  id: string
  /** Minor units asked for. */
  requested: number
  /** Minor units that reached the recipient. Equal to `requested` on success. */
  delivered: number
  /**
   * Minor units of a part the gateway accepted but whose outcome the wallet could not learn.
   * It may already have arrived, so it must never be offered to send again.
   */
  inFlight?: number
  parts: number
  /** Why the rest did not go (or is not confirmed), when `delivered` fell short. */
  shortfall?: string
}

/** Bundle correlation for one part. All five fields or none — the gateway rejects half a set. */
type BundleTag = { bundleId: string; total: number; index: number; count: number }

/** Everything a part needs that does not change between parts. */
type SendContext = {
  api: SendApi
  payer: string
  recipient: { pubkey: string; name?: string }
  merchant: Merchant
  memo?: string
  rowOf: Map<Voucher, VoucherRow>
  /** Fallback for a coupon with no `face_unit` — the unit being spent. */
  unit?: string
  /** Set on a send to a gift link key; see `PendingSend.link`. */
  link?: GiftLinkRecord
  /**
   * Set when this is a merchant redemption. Two things hang off it: the
   * gateway gets `paymentRequestId`, and the local row is a payment rather
   * than a send. See `sendPart`.
   */
  paymentRequestId?: string
}

/**
 * One draw: initiate, wait for the saga, settle the local side. Throws unless
 * the recipient has it.
 *
 * Each part is a whole send in its own right — its own row in the history, its
 * own change coupon, its own entry in the pending ledger. That is what makes a
 * bundle safe to interrupt without a journal: there is no half-applied bundle
 * state to recover, only sends that finished and sends that did not, which is
 * what `reconcilePendingSends` already knows how to sort out on the next login.
 * imani-apps needs `bundleSendJournal.js` for this because its parts share one
 * localStorage mutation; ours do not.
 */
async function sendPart(
  ctx: SendContext,
  candidates: Voucher[],
  amount: number,
  bundle: BundleTag | null,
): Promise<string> {
  // #179: a send whose answer was lost is retried on the coupon it was first drawn on, so the
  // retry's body matches the stored key and the gateway replays it rather than refusing it.
  const firstDrawnOn =
    bundle || ctx.paymentRequestId ? undefined : pendingIntentVoucher(ctx.payer, ctx.recipient.pubkey, amount, ctx.memo)
  const ordered = firstDrawnOn
    ? [...candidates.filter((c) => c.voucher_id === firstDrawnOn), ...candidates.filter((c) => c.voucher_id !== firstDrawnOn)]
    : candidates
  const { sendId, status, voucher, sourceRow } = await initiateOnFirstFree(
    ctx.api,
    ordered,
    ctx.rowOf,
    (candidate) =>
      buildSendParams(candidate, {
        amount,
        recipientPubkey: ctx.recipient.pubkey,
        memo: ctx.memo,
        paymentRequestId: ctx.paymentRequestId,
        bundle,
      }),
    // Keyed so a double-tap dedupes to one send while walking to the next
    // coupon does not collide with the key the refused one already used. The
    // bundle form is upstream's (`bundle:<id>:<part>:<attempt>`), which is what
    // the gateway's own retry handling expects to see, and it is per-part, so
    // it serves a bundled redemption as well as a bundled send.
    //
    // The window is what makes a RETRY distinguishable from a double-tap.
    // Without it the key was a pure function of (recipient, amount, voucher),
    // so re-sending the same coupon to the same person for the same amount —
    // which is exactly what a user does after a send fails — hit the gateway's
    // idempotency check and got back the OLD send. On a send that ended in
    // FAILED that is unrecoverable by construction: the reclaim endpoint
    // refuses a terminal state, so the wallet reported "could not be returned
    // automatically" and the coupon looked permanently stuck. It was not; the
    // request simply never reached a new saga.
    //
    // #179: the person-to-person key is now one random key per send INTENT, stored before the
    // request goes out (sendIntent.ts) and reused until the gateway answers. The 10-second window
    // it replaces gave a retry after a lost answer a NEW key once the window rolled over, or
    // after a reload, and the gateway sent twice. The FAILED-send case above still gets a fresh
    // key: a send the gateway answered for frees its intent, so pressing the button again is a
    // new send.
    (candidate) =>
      bundle
        ? `bundle:${bundle.bundleId}:${bundle.index}:0`
        : ctx.paymentRequestId
          ? // #461: keyed on the source TOKEN, not voucher_id. The change of a split keeps its
            // voucher_id, so the old key made a second payment from the change replay the first.
            `pay_${ctx.paymentRequestId}_${ctx.rowOf.get(candidate)?.token_id ?? candidate.voucher_id}`
          : keyForSend(ctx.payer, {
              recipientPubkey: ctx.recipient.pubkey,
              amount,
              voucherId: candidate.voucher_id,
              memo: ctx.memo,
            }),
    (key) => forgetSendIntent(ctx.payer, key),
  )

  await awaitAndSettle(
    ctx.api,
    ctx.payer,
    {
      sendId,
      tokenId: sourceRow.token_id,
      amount,
      unit: voucher.face_unit ?? ctx.unit ?? '',
      decimals: voucher.face_decimals ?? 2,
      merchantPubkey: ctx.merchant.pubkey,
      merchantName:
        ctx.merchant.name === ctx.merchant.pubkey ? undefined : ctx.merchant.name,
      // Omitted on a redemption, and that omission is load-bearing: `settleSend`
      // reads the presence of `recipientPubkey` to decide between a 'sent' row
      // and a 'payment' row. Setting it here — the recipient of a redemption is
      // the merchant, so it would be easy to — files money paid to a shop as a
      // transfer to a friend, and puts that shop on the home deck twice.
      ...(ctx.paymentRequestId
        ? { paymentRequestId: ctx.paymentRequestId }
        : { recipientPubkey: ctx.recipient.pubkey, recipientName: ctx.recipient.name }),
      ...(ctx.link ? { link: ctx.link } : {}),
      voucherId: voucher.voucher_id,
      memo: ctx.memo,
      sourceFaceValue: voucher.face_value ?? 0,
      at: Date.now(),
      bundleId: bundle?.bundleId,
    },
    status,
  )

  return sendId
}

/**
 * 32 lowercase hex — the width the recipient's parser matches.
 *
 * Not a stylistic choice: dm-poll's `Bundle-Id: /([0-9a-f]{32})/` is what turns
 * several arriving coupons into one receipt, and a bundle id of any other shape
 * simply does not match, leaving the recipient with N unexplained vouchers.
 */
function newBundleId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Send vouchers to another person — the customer-to-customer path.
 *
 * The same saga as `payRequest`, minus the payment request: the gateway's
 * `/api/v1/atomic-send` has always taken a plain `recipientPubkey`, and a
 * merchant redemption is only that call with a `paymentRequestId` attached. So
 * there is no second engine here, and no special case for sending TO a merchant
 * either — the difference is a line of copy on the confirmation screen.
 *
 * What DOES differ is the record: `recipientPubkey` on the pending send is what
 * makes `settleSend` write a 'sent' row instead of a 'payment' one. See
 * `buildSentTransaction` for why the issuer, not the recipient, goes in
 * `merchantId`.
 *
 * ## One coupon, or several
 *
 * One coupon is tried first and used when one will do: fewer mint splits, one
 * DM, and the path `payRequest` has already proven. Only when no single coupon
 * covers the amount does this bundle, drawing across several — which is the
 * common case for a wallet holding a handful of small coupons from one shop.
 *
 * ## Why a bundle can land in pieces
 *
 * Each part is delivered by its own saga, and a delivered part CANNOT be taken
 * back: the mint has burned its proofs and the NIP-17 DM is published. So when
 * a later part fails, the honest answer is not an exception — an error on the
 * confirmation screen reads as "nothing happened", and the customer sends
 * again, on top of money that already left. This returns what actually landed
 * and lets the screen say so.
 *
 * A first-part failure is different: nothing has moved, so it throws and the
 * wallet is exactly where it started.
 *
 * Ported from imani-apps' `bundleSendOrchestrator.send`
 * (shared/bundleSendOrchestrator.js) with its two host seams replaced rather
 * than its store: `_awaitTerminal` subscribes over SSE, which drops on this
 * stack (§11.4) and would hang every part to a five-minute timeout, so parts
 * poll through `awaitAndSettle`; and `_applyKeepToken` writes through
 * `shared/storage.js`, a second authority on the same money, so parts settle
 * through `settleSend` into `@imani/wallet-storage`. What that leaves behind is
 * upstream's journal, retryRemainder and dismissPartial — all of which exist to
 * reconstruct per-part state that this wallet already keeps per part.
 */
export async function sendVouchers({
  payer,
  recipient,
  merchant,
  unit,
  amount,
  memo,
  link,
}: {
  payer: string
  /** Who gets it. `name` is stored on the row; see `buildSentTransaction`. */
  recipient: { pubkey: string; name?: string }
  /** Whose vouchers are being spent — the issuer, chosen on the picker step. */
  merchant: Merchant
  /**
   * Which of the merchant's currencies. A merchant selling in two units holds
   * two groups, and a voucher cannot be split across them — without this,
   * "5.00" typed against a EUR group could go out as 5 SAT from whichever
   * voucher happened to sort first.
   */
  unit: string
  /** Minor units, as `parseAmountToMinor` produces. */
  amount: number
  memo?: string
  /**
   * A send to a gift link key (claim links phase 4). `recipient.pubkey` must be that link's public
   * key. The rows this writes carry the link, and no ADR 0014 transfer signature is sent (Q7).
   */
  link?: GiftLinkRecord
}): Promise<SendResult> {
  // Refused here and not only on the screen, for the same reason the expiry
  // check lives in `payRequest`: this is the door money leaves by. A send to
  // yourself is not a no-op — it burns the source voucher and hands back an
  // equal one, costing a round trip and a mint fee to end up where you started.
  if (recipient.pubkey.toLowerCase() === payer.toLowerCase()) {
    throw new Error('You cannot send a voucher to yourself.')
  }

  const api = await sendApi()
  const { mine, rowOf } = await spendableFrom(merchant.pubkey, payer)
  const inUnit = mine.filter(
    (v) => (v.face_unit ?? '').toUpperCase() === unit.toUpperCase(),
  )
  // A gift link carries only money anyone can hold: no licence, terminal credential or locked
  // voucher, and never the sender's own stall's coupons (spec 4.2 step 2, 3.2). Refused here as well
  // as on the picker, because this is the door money leaves by.
  if (link && issuerKey(merchant.pubkey) === issuerKey(payer)) throw new Error(OWN_STALL_COPY)
  const sendable = link ? inUnit.filter((v) => giftExclusion(v.token, v.issuer_id, payer) === null) : inUnit

  return deliver({ api, payer, recipient, merchant, memo, rowOf, unit, link }, sendable, amount, unit)
}

/**
 * A merchant only takes back what they themselves issued.
 *
 * A coupon is a claim on ONE stall. Sending someone else's to a merchant hands
 * them something they cannot honour, cannot redeem and cannot return — the
 * customer's money simply stops. Nothing downstream catches it: the gateway's
 * atomic send takes a plain recipient pubkey and does not care who issued what.
 *
 * Two questions, one rule. A recipient who is not trading as a merchant is a
 * customer and may be sent anything; a recipient who IS gets only their own
 * coupons back.
 *
 * Sits on `deliver` rather than on either door because both of them arrive here
 * — `sendVouchers` from the Send screen, `payRequest` from a scanned request —
 * and it must run BEFORE the first `sendPart`, while nothing has moved.
 *
 * Fail-closed: a lookup that could not reach the relay refuses the send rather
 * than waving it through. The asymmetry is what decides it — a send blocked by
 * an outage is retried a minute later, while a coupon that lands on a stall that
 * cannot honour it is money the customer no longer holds and the merchant cannot
 * give back. Only the second one is unrecoverable.
 *
 * What keeps that from being a wallet that cannot send during an outage is the
 * order of the checks. Paying the issuer their own coupon — the overwhelmingly
 * common case, and the one a market stall depends on — returns above without
 * asking anything of the network at all. It is only a send to a THIRD party,
 * whose role we genuinely do not know, that waits for the relay.
 */
export async function refuseIfWrongMerchant(recipient: string, issuer: string): Promise<void> {
  if (issuerKey(recipient) === issuerKey(issuer)) return // A redemption. Always fine.

  const status = await merchantStatus(recipient)
  if (status === 'customer') return // A customer. Anything goes.

  if (status === 'unknown') {
    throw new Error(
      'Could not check who you are sending to. Connect to the network and try ' +
        'again — nothing has been sent.',
    )
  }

  throw new Error(
    'This merchant only accepts vouchers they issued themselves. Send them one ' +
      'of their own vouchers, or send this one to a friend instead.',
  )
}

/**
 * One coupon if one will do, several if not — the driver both send doors share.
 *
 * Shared deliberately, and late: `payRequest` spent a year able to draw exactly
 * one coupon, so a customer holding two €5 coupons was told they had "no
 * voucher for that amount" when a merchant asked for €7. The money was there;
 * only this loop was missing. Keeping the two doors on one driver is what stops
 * that gap reopening on whichever door gets the next change.
 *
 * `unitLabel` only shapes the refusal message. The caller has already filtered
 * `vouchers` to one unit — this cannot check that, and adding coupons of two
 * currencies is how a request settles for a fraction of what was asked.
 */
/**
 * Every send goes through here, counted by the spend gate (#335): once logout
 * has closed it (in this tab, or another tab's logout has paused this one) a
 * send is refused before anything moves, and logout waits for one already running.
 */
function deliver(ctx: SendContext, vouchers: Voucher[], amount: number, unitLabel?: string): Promise<SendResult> {
  return withSpend(() => deliverCounted(ctx, vouchers, amount, unitLabel))
}

async function deliverCounted(
  ctx: SendContext,
  vouchers: Voucher[],
  amount: number,
  unitLabel?: string,
): Promise<SendResult> {
  await refuseIfWrongMerchant(ctx.recipient.pubkey, ctx.merchant.pubkey)
  // Ask the gateway about anything still pending BEFORE refusing: a send that has finished since
  // the wallet stopped waiting would otherwise block this person until the next login.
  await reconcilePendingSends(ctx.payer)
  refuseIfUnconfirmedTo(ctx)

  // One coupon first: fewer mint splits, one DM, and the path that has been
  // carrying every payment on this stack since the beginning.
  const single = selectVouchers(vouchers, amount)
  if (single.length > 0) {
    const sendId = await sendPart(ctx, single, amount, null)
    return { id: sendId, requested: amount, delivered: amount, parts: 1 }
  }

  const plan = planParts(vouchers, amount)
  if (plan.remaining > 0) {
    throw new Error(
      splitObstacle(vouchers, amount) ??
        `You have no ${unitLabel ? `${unitLabel} ` : ''}voucher from this merchant ` +
          'for that amount.',
    )
  }

  const bundleId = newBundleId()
  let delivered = 0
  for (const [index, part] of plan.parts.entries()) {
    try {
      await sendPart(ctx, [part.voucher], part.amount, {
        bundleId,
        total: amount,
        index,
        count: plan.parts.length,
      })
      delivered += part.amount
    } catch (error) {
      // Nothing has moved yet, so there is nothing to explain away.
      if (delivered === 0) throw error
      // Money has left. Stop — a part that failed at the mint will fail again,
      // and every further attempt risks delivering more than was intended. A part
      // whose outcome is unknown is reported as in flight, never as unsent (#125).
      const unknownOutcome = error instanceof SendOutcomeUnknownError
      return {
        id: bundleId,
        requested: amount,
        delivered,
        ...(unknownOutcome ? { inFlight: part.amount } : {}),
        parts: unknownOutcome ? index + 1 : index,
        shortfall: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return { id: bundleId, requested: amount, delivered, parts: plan.parts.length }
}
