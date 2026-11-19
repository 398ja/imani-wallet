import type { VoucherRow } from '@imani/wallet-storage'

import { legacyApi } from './legacyBridge'
import { isRedeemed, issuerKey } from './merchants'
import { getWallet, listVouchers, notifyWalletChanged } from './wallet'
import { CALLS_PER_BURN, PacerResetError, receivePacer } from './receivePacer'

/**
 * Burning a coupon the merchant themselves issued, the moment it comes back.
 *
 * A coupon paid to a merchant arrives as a NIP-17 DM, and imani-apps'
 * `TokenRedemption.redeem` swaps it at the mint into FRESH proofs owned by the
 * merchant, written to their own IndexedDB as an ordinary `status: 'active'`
 * row. That row is money: it counted towards the balance, it was listed as a
 * coupon, its detail screen still rendered the redemption QR, and `pay.ts`
 * would happily spend it. A redeemed coupon could go straight back into
 * circulation.
 *
 * So the redemption is completed here: the proofs are SPENT at the mint and the
 * row is kept only as a receipt.
 *
 * **The burn is a second swap.** `api.receive(token)` is the mint swap — it
 * spends the proofs it is given and hands back new ones. Receiving the
 * merchant's own token and throwing the result away therefore leaves the
 * redeemed token verifiably spent: NUT-07, through
 * `/api/v1/wallet/token/validate`, reports `SPENT` for it afterwards. No new
 * gateway endpoint, and no melt (that needs a bolt11 invoice and would pay the
 * value out rather than destroy it).
 *
 * **Only coupons this merchant issued.** Another merchant's coupon taken as
 * payment is live money this merchant may spend or redeem in turn; burning it
 * would destroy someone else's backing. `issuer_id === own pubkey` is exact on
 * its own — a customer never issues anything, so only a merchant can match it.
 */

/** What `burn` needs of imani-apps' classic-script API client. */
interface BurnApi {
  receive(
    token: string,
    options?: { idempotencyKey?: string },
  ): Promise<{ receive_id?: string; receiveId?: string } | null>
  acknowledgeReceive(receiveId: string): Promise<void>
  /** NUT-07 checkstate. `state` is 'UNSPENT' | 'PENDING' | 'SPENT'. */
  validateToken(token: string): Promise<{ valid?: boolean; state?: string } | null>
}

/**
 * Is this coupon's value already gone from the mint?
 *
 * The question the failure path has to answer, because the two reasons a burn
 * fails need opposite handling:
 *
 *  - the gateway is unreachable, so the proofs are still live. The row must
 *    stay `active` and be retried — it is still money.
 *  - the proofs are ALREADY SPENT, which is what a second burn of the same
 *    coupon looks like. Retrying can never succeed, and leaving the row
 *    `active` counts value on the merchant's balance that exists nowhere.
 *
 * Without this the second case retried on every `saveVoucher` for the life of
 * the row and failed identically each time, which is precisely what a reported
 * `[burn] redeemed coupon not burnt` on a repeat looked like.
 *
 * Never throws: an unreachable gateway cannot distinguish either, and the
 * caller's own fallback (leave it active, sweep later) is the safe answer.
 */
async function alreadySpent(api: BurnApi, token: string): Promise<boolean> {
  try {
    const result = await api.validateToken(token)
    // Only an explicit SPENT settles it. `PENDING` is in flight and `UNSPENT`
    // is live money; treating either as burnt would write off a real coupon.
    return (result?.state ?? '').toUpperCase() === 'SPENT'
  } catch {
    return false
  }
}

/**
 * How long to wait before retrying a burn the gateway refused as in-flight.
 *
 * Long enough for a swap to finish — the observed one settled ~1.2s after its
 * claim — and short enough that a sweep does not stall. A single retry, not a
 * loop: if it is still contended, the other caller will finish the burn and
 * the next sweep sees it as already spent.
 */
const RETRY_AFTER_CONFLICT_MS = 1_500

/**
 * The longest `Retry-After` a burn will sit out before its single retry (#110).
 *
 * The gateway's limiter is a one-minute window, so a 429 usually says 60s.
 * Honoured up to a little past that; anything longer is not worth holding a
 * `saveVoucher` caller for, and the row stays `active` for `sweepBurnable` at
 * the next login, exactly as before.
 */
const MAX_RATE_LIMIT_WAIT_MS = 65_000

/** When the 429 carries no usable Retry-After: the window the gateway uses. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000

/**
 * How long to wait before the one retry, or undefined for "do not retry".
 *
 * 409: the burn is already running (see below). 429: the per-pubkey budget is
 * spent — on staging an 8-part bundle's redeems ate it, and every burn caught
 * behind them fell through to "not burnt", leaving a redeemed coupon counted as
 * money until the next login. Both resolve by waiting, so both get one retry.
 */
function retryDelayMs(error: unknown): number | undefined {
  const e = error as { status?: number; retryAfterMs?: number | null } | undefined
  if (e?.status === 409) return RETRY_AFTER_CONFLICT_MS
  if (e?.status === 429) {
    const hinted = typeof e.retryAfterMs === 'number' && e.retryAfterMs >= 0 ? e.retryAfterMs : DEFAULT_RATE_LIMIT_WAIT_MS
    return Math.min(hinted, MAX_RATE_LIMIT_WAIT_MS)
  }
  return undefined
}

/**
 * Spend this coupon's proofs at the mint and mark the row redeemed. Never throws.
 *
 * Order is the whole safety property: the status is written only AFTER the mint
 * call has succeeded, so a row that says "redeemed" always has burnt proofs
 * behind it. A failure leaves it `active` — still spendable, still visibly
 * money, and picked up again by `sweepBurnable` at the next login. The
 * alternative direction, marking first, would show the merchant a used coupon
 * whose value is quietly still live.
 */
export async function burnIfSelfIssued(row: VoucherRow, ownPubkey: string): Promise<boolean> {
  if (!row.token || !row.token_id || isRedeemed(row)) return false
  // Both sides must be REAL ids. `issuerKey` maps anything missing to
  // `'unknown'`, so an unopened wallet or a coupon that arrived without an
  // issuer would otherwise match itself and burn money nobody issued.
  if (!row.issuer_id || !ownPubkey) return false
  if (issuerKey(row.issuer_id) !== issuerKey(ownPubkey)) return false

  try {
    const api = (await legacyApi()) as unknown as BurnApi
    // A burn's receive spends the same per-pubkey budget as redemptions
    // (#110), so it waits its turn in the same pacer. Its ack is exempt from
    // the limit (imani-gateway-customer#120) and is not paced.
    await receivePacer().acquire(CALLS_PER_BURN)
    const result = await api.receive(row.token, {
      // Keyed on the coupon, so a burn retried after a lost response is the
      // same call rather than a second swap.
      idempotencyKey: `burn_${row.token_id}`,
    })

    // The fresh proofs are deliberately dropped on the floor — that is the
    // burn. The escrow behind them must still be acknowledged: spec-021's
    // recovery sweep reclaims UNACKNOWLEDGED escrows on the next boot and would
    // hand the value straight back as a new coupon. A failed ack is survivable
    // rather than fatal: what it reclaims is a self-issued row like any other,
    // so the next `sweepBurnable` burns that too.
    const receiveId = result?.receive_id ?? result?.receiveId
    if (receiveId) await api.acknowledgeReceive(receiveId).catch(() => undefined)

    // Through the wrapped writer, so the kind-7375 backup is republished
    // carrying the new status and the receipt survives a logout.
    await getWallet().saveVoucher({ ...row, status: 'redeemed' })
    notifyWalletChanged()
    return true
  } catch (error) {
    // Logged out while waiting for the pacer: nothing was sent. The next
    // login's sweepBurnable retries it; no "not burnt" alarm, no spend check.
    if (error instanceof PacerResetError) return false

    // A 409 can mean the burn is ALREADY RUNNING, not that it failed.
    //
    // The gateway claims the idempotency key before the irreversible swap, so
    // a duplicate arriving while the winner is mid-swap is refused — the row
    // is CLAIMED, and there is no outcome to replay yet. Observed live: the
    // escrow was created at 08:44:22.95 and the duplicate arrived 90ms later,
    // settling at 08:44:24. It was seconds from succeeding.
    //
    // Reporting that as "redeemed coupon not burnt" is wrong twice: the coupon
    // usually IS burnt a moment later, and the operator is told to act on
    // something that resolves itself. One retry after a short pause turns the
    // common case into a success; anything still contended falls through to
    // the honest failure below.
    //
    // A 429 gets the same single retry, after the gateway's Retry-After
    // (#110). The key is stable (`burn_<token_id>`), so the retry is the same
    // call, never a second swap.
    const delay = retryDelayMs(error)
    if (delay !== undefined) {
      await new Promise((r) => setTimeout(r, delay))
      try {
        const api = (await legacyApi()) as unknown as BurnApi
        await receivePacer().acquire(CALLS_PER_BURN)
        const replay = await api.receive(row.token, {
          idempotencyKey: `burn_${row.token_id}`,
        })
        const receiveId = replay?.receive_id ?? replay?.receiveId
        if (receiveId) await api.acknowledgeReceive(receiveId).catch(() => undefined)
        await getWallet().saveVoucher({ ...row, status: 'redeemed' })
        notifyWalletChanged()
        return true
      } catch {
        // Still contended, or a different failure. Fall through.
      }
    }

    // Already burnt? Then the row is a receipt, not money, and the burn has
    // in effect succeeded — mark it so, or it is retried forever and keeps
    // counting towards a balance the mint no longer backs.
    try {
      const api = (await legacyApi()) as unknown as BurnApi
      if (await alreadySpent(api, row.token)) {
        // #261: one checkstate decided this, so the row says so and when. `sweepBurnable` reads it
        // again on a later pass; an UNSPENT answer then puts the row back to `active` and burns it.
        await getWallet().saveVoucher({
          ...row,
          status: 'redeemed',
          redeemed_reason: REDEEMED_ON_SPENT_READ,
          redeemed_spent_seen_at: new Date().toISOString(),
        } as VoucherRow)
        notifyWalletChanged()
        console.warn('[burn] proofs were already spent — row settled as redeemed', {
          token_id: row.token_id,
        })
        return true
      }
    } catch {
      // Fall through to the honest failure below. Nothing was written.
    }

    // The FIELDS, not the object. `shared/api.js` throws an Error carrying
    // `status`, `code` and a server message, and logging the bare object
    // renders as "Error" in the console with every one of them hidden — which
    // is exactly what a report of this line looked like: a failure nobody
    // could act on. An already-spent token (the benign case, see below) and a
    // dead gateway are indistinguishable without them.
    const e = error as { message?: string; status?: number; code?: string }
    console.error('[burn] redeemed coupon not burnt — it stays spendable until the next login', {
      token_id: row.token_id,
      status: e?.status,
      code: e?.code,
      message: e?.message ?? String(error),
    })
    return false
  }
}

/** #261: `redeemed_reason` of a row marked redeemed on one SPENT checkstate, not by its own burn. */
export const REDEEMED_ON_SPENT_READ = 'mint-spent'

/** #261: how long after the first SPENT read the second is due. */
export const REDEEMED_RECHECK_AFTER_MS = 10 * 60 * 1000

type SpentReadRow = VoucherRow & {
  redeemed_reason?: string
  redeemed_spent_seen_at?: string
  redeemed_verified_at?: string
}

/**
 * #261: read a row marked redeemed on one SPENT checkstate again. SPENT again confirms it
 * (`redeemed_verified_at`, never read again). UNSPENT undoes it: the row goes back to `active`,
 * with the reason recorded, so it counts as money and the burn below can finish it. Anything else
 * (no answer, PENDING) leaves it for the next pass. Never throws. Returns the row to sweep on.
 */
export async function recheckSpentRead(row: VoucherRow, nowMs = Date.now()): Promise<VoucherRow> {
  const r = row as SpentReadRow
  if (!isRedeemed(r) || r.redeemed_reason !== REDEEMED_ON_SPENT_READ || r.redeemed_verified_at) return row
  const seen = Date.parse(r.redeemed_spent_seen_at ?? '')
  if (Number.isFinite(seen) && nowMs - seen < REDEEMED_RECHECK_AFTER_MS) return row
  try {
    const api = (await legacyApi()) as unknown as BurnApi
    const state = ((await api.validateToken(row.token))?.state ?? '').toUpperCase()
    if (state === 'SPENT') {
      const confirmed = { ...r, redeemed_verified_at: new Date(nowMs).toISOString() } as VoucherRow
      await getWallet().saveVoucher(confirmed)
      return confirmed
    }
    if (state === 'UNSPENT') {
      const { redeemed_reason: _r, redeemed_spent_seen_at: _s, ...rest } = r
      void _r
      void _s
      const live = { ...rest, status: 'active', redeemed_undone_at: new Date(nowMs).toISOString() } as VoucherRow
      await getWallet().saveVoucher(live)
      notifyWalletChanged()
      console.warn('[burn] a coupon marked redeemed on one SPENT read is UNSPENT now; back to active', { token_id: row.token_id })
      return live
    }
  } catch {
    // Read again next pass.
  }
  return row
}

/**
 * Burn anything a previous attempt missed. Never throws. Returns the count.
 *
 * The retry for a redemption taken while the gateway was unreachable, which
 * would otherwise leave a self-issued coupon spendable forever. Safe as a blunt
 * sweep because a merchant has no other reason to hold a coupon they issued:
 * `issue.ts` writes only a transaction row for one it hands out
 * (`transactions.ts`, `buildIssueTransaction`).
 */
export async function sweepBurnable(pubkey: string): Promise<number> {
  try {
    let burnt = 0
    for (const stored of await listVouchers()) {
      // #261: a redeemed row that rests on one SPENT read is read again first; undone, it is burnt.
      const row = await recheckSpentRead(stored)
      if (await burnIfSelfIssued(row, pubkey)) burnt += 1
    }
    return burnt
  } catch (error) {
    console.error('[burn] could not sweep redeemed coupons', error)
    return 0
  }
}
