import type { VoucherRow } from '@imani/wallet-storage'

import { legacyApi } from './legacyBridge'
import { isRedeemed, issuerKey } from './merchants'
import { getWallet, listVouchers, notifyWalletChanged } from './wallet'

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
    console.error('[burn] redeemed coupon not burnt — it stays spendable until the next login', {
      token_id: row.token_id,
      error,
    })
    return false
  }
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
    for (const row of await listVouchers()) {
      if (await burnIfSelfIssued(row, pubkey)) burnt += 1
    }
    return burnt
  } catch (error) {
    console.error('[burn] could not sweep redeemed coupons', error)
    return 0
  }
}
