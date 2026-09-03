import type { Voucher } from '@imani/voucher-send'
import type { VoucherRow } from '@imani/wallet-storage'

import { getWallet, listVouchers, notifyWalletChanged } from './wallet'
import { legacyApi } from './legacyBridge'
import { couponsFor, issuerKey, toVoucher, type Merchant } from './merchants'
import { merchantStatus } from './merchant'
import { buildPaymentTransaction, buildSentTransaction } from './transactions'
import type { NUT18VRequest } from './nap'
import { tokenIdFrom } from '../../packages/wallet-storage/src/tokenId'

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
  type SplitCheck,
  type SendPart,
  type SendPlan,
} from '@imani/wallet-core'
import { planParts, selectVouchers, splitObstacle } from '@imani/wallet-core'

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
          })
        : buildPaymentTransaction({ ...common, bundleId: pending.bundleId }),
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
 */
async function spendableFrom(merchantPubkey: string): Promise<{
  mine: Voucher[]
  rowOf: Map<Voucher, VoucherRow>
}> {
  const rows = couponsFor(await listVouchers(), merchantPubkey)
  const rowOf = new Map<Voucher, VoucherRow>()
  const mine = rows.map((row) => {
    const voucher = toVoucher(row)
    rowOf.set(voucher, row)
    return voucher
  })
  return { mine, rowOf }
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
): Promise<{ sendId: string; status?: string; voucher: Voucher; sourceRow: VoucherRow }> {
  let lastRefusal: Error | null = null

  for (const candidate of candidates) {
    try {
      const initiated = await api.initiateAtomicSend(buildParams(candidate), keyFor(candidate))
      const sendId = initiated.send_id ?? initiated.sendId
      if (!sendId) throw new Error('Gateway accepted the send but returned no send id.')
      const sourceRow = rowOf.get(candidate)
      if (!sourceRow) throw new Error('Lost track of the voucher being spent.')
      return { sendId, status: initiated.status, voucher: candidate, sourceRow }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('active send already exists')) throw error
      lastRefusal = error instanceof Error ? error : new Error(message)
      console.warn('[pay] coupon busy, trying the next one:', candidate.voucher_id)
    }
  }

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
  initialStatus: string | undefined,
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
  rememberPendingSend(payer, pending)

  let status: SendStatus = { status: initialStatus }
  for (let i = 0; i < POLL_ATTEMPTS && !TERMINAL.includes(String(status.status)); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    status = await api.getAtomicSendStatus(pending.sendId)
  }

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
    throw new Error(
      `This ${noun} is still going through at the gateway (send ${pending.sendId}, ` +
        `${status.status ?? 'no status'}). It has NOT failed and your voucher is ` +
        `unchanged here — check your history again in a moment before retrying.`,
    )
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

  await settleSend(api, wallet, pending, status)
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

  const api = await sendApi()
  const { mine, rowOf } = await spendableFrom(merchant.pubkey)
  // Filtered by the request's unit, which this door did not do while it spent
  // exactly one coupon and `selectVouchers` compared amounts within it. Drawing
  // across several makes a mixed-unit wallet dangerous: 300 EUR + 200 XAF add
  // up to 500 of nothing, and the request would settle for a fraction of what
  // was asked. Requests without a unit keep the old behaviour.
  const inUnit = request.unit
    ? mine.filter((v) => (v.face_unit ?? '').toUpperCase() === request.unit!.toUpperCase())
    : mine

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
  parts: number
  /** Why the rest did not go, when `delivered` fell short. */
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
  const { sendId, status, voucher, sourceRow } = await initiateOnFirstFree(
    ctx.api,
    candidates,
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
    (candidate) =>
      bundle
        ? `bundle:${bundle.bundleId}:${bundle.index}:0`
        : ctx.paymentRequestId
          ? `pay_${ctx.paymentRequestId}_${candidate.voucher_id}`
          : `c2c_${ctx.recipient.pubkey}_${amount}_${candidate.voucher_id}`,
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
        ? {}
        : { recipientPubkey: ctx.recipient.pubkey, recipientName: ctx.recipient.name }),
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
}): Promise<SendResult> {
  // Refused here and not only on the screen, for the same reason the expiry
  // check lives in `payRequest`: this is the door money leaves by. A send to
  // yourself is not a no-op — it burns the source voucher and hands back an
  // equal one, costing a round trip and a mint fee to end up where you started.
  if (recipient.pubkey.toLowerCase() === payer.toLowerCase()) {
    throw new Error('You cannot send a voucher to yourself.')
  }

  const api = await sendApi()
  const { mine, rowOf } = await spendableFrom(merchant.pubkey)
  const inUnit = mine.filter(
    (v) => (v.face_unit ?? '').toUpperCase() === unit.toUpperCase(),
  )

  return deliver({ api, payer, recipient, merchant, memo, rowOf, unit }, inUnit, amount, unit)
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
async function deliver(
  ctx: SendContext,
  vouchers: Voucher[],
  amount: number,
  unitLabel?: string,
): Promise<SendResult> {
  await refuseIfWrongMerchant(ctx.recipient.pubkey, ctx.merchant.pubkey)

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
      // and every further attempt risks delivering more than was intended.
      return {
        id: bundleId,
        requested: amount,
        delivered,
        parts: index,
        shortfall: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return { id: bundleId, requested: amount, delivered, parts: plan.parts.length }
}
