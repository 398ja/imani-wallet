import type { VoucherRow } from '@imani/wallet-storage'

import { FULLY_REDEEMED_STATUS } from './fullyRedeemed'
import { createMintTransport } from './mintTransport'
import { encodePlainTokenV4 } from './plainToken'
import {
  receiveByOwnSwap,
  receiveSwapId,
  settleReceive,
  type MintTransport,
  type ReceivableProof,
  type ReceiveResult,
} from './receiveSwap'
import { checkMintAndUnit, readTokenBacking } from './trustedMint'
import { tokenProofs } from './voucherToken'
import { buildWitnesses } from './witness'
import { getWallet, notifyWalletChanged } from './wallet'
import { beginReceive, isReceiveDeferred } from './receiveGate'

/**
 * "Swap back to sats": a coupon the mint refused as redeemed in full, turned into plain ecash.
 *
 * ## When
 *
 * Only for a row marked `fully_redeemed` (cashu-mint#540, design §2.13). The mint's redemption
 * cap refused to credit this coupon to a stall, because someone has already redeemed its full
 * value, most likely through a relabelled copy. The holder's proofs were never touched, but they
 * cannot be spent as a coupon any more. What they still are is sats at the mint.
 *
 * ## How, and what it must never do (D9)
 *
 * The wallet's own swap, at the coupon's own (trusted) mint, with random output secrets: the
 * voucher is given up on purpose and the sats come back as plain proofs only this wallet holds.
 *
 * It sends **no redemption declaration**. `X-Cashu-Voucher-Redemption` and
 * `X-Cashu-Voucher-Redeemer` are the crediting redeemers' (the gateways'), and a wallet holds no
 * redeemer token. So a swap back consumes none of the coupon's cap: the cap counts credits to a
 * stall, and this credits nobody. `mintTransport.ts` sends only `Content-Type`, which the D9 guard
 * tests pin.
 *
 * ## Losing nothing on the way
 *
 * Same intent record as every wallet-side receive (`receiveSwap.ts`): if the page dies after the
 * mint signed, the start-up sweep restores the outputs. The row is tagged with the swap's id
 * BEFORE the swap, so {@link saveRecoveredSwapBack} can put recovered proofs back on it.
 */

/** The status of a coupon whose sats now live in its `sats_token`. */
export const SWAPPED_TO_SATS_STATUS = 'swapped_to_sats'

/** What a swap back produced. */
export interface SwapBackResult {
  /** The plain sats, as a `cashuB` token only this wallet has seen. */
  token: string
  sats: number
}

/** Why a coupon cannot be swapped back. */
export class SwapBackNotPossible extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SwapBackNotPossible'
  }
}

/** Swap a fully redeemed coupon's proofs into plain sats held by this wallet. */
export async function swapBackToSats(
  row: VoucherRow,
  pubkey: string,
  transport: MintTransport = createMintTransport(),
): Promise<SwapBackResult> {
  if ((row.status ?? '').toLowerCase() !== FULLY_REDEEMED_STATUS) {
    throw new SwapBackNotPossible('Only a coupon refused as redeemed in full can be swapped back to sats.')
  }

  const backing = readTokenBacking(row.token)
  const verdict = checkMintAndUnit(backing)
  if (verdict !== 'trusted') {
    throw new SwapBackNotPossible(`This coupon's mint cannot be used for a swap back (${verdict}).`)
  }

  const proofs = tokenProofs(row.token)
  const witnesses = buildWitnesses(proofs.map((proof) => proof.secret))
  const receivable: ReceivableProof[] = proofs.map((proof) => {
    const witness = witnesses[proof.secret]
    return witness ? { ...proof, witness: JSON.stringify({ signatures: witness }) } : proof
  })

  // The receive gate (review of #334, D2): this is a mint swap whose fresh proofs
  // are saved afterwards, so once logout has started it must not begin, and one
  // that began first is counted until it has saved. Before the tag write, so a
  // deferred swap back changes nothing.
  let endReceive: () => void
  try {
    endReceive = beginReceive()
  } catch (e) {
    if (isReceiveDeferred(e)) throw new SwapBackNotPossible(SWAP_BACK_PAUSED_MESSAGE)
    throw e
  }
  try {
    const wallet = getWallet()
    const swapId = receiveSwapId(receivable)
    // Tagged first: from the swap onwards the recovery sweep may be the one to finish this.
    await wallet.saveVoucher({ ...row, swap_back_id: swapId, updated_at: new Date().toISOString() })

    const result = await receiveByOwnSwap(
      { pubkey, mintUrl: backing.mintUrl, proofs: receivable, releaseVoucher: true },
      transport,
    )
    const saved = await keepSats(row, backing.mintUrl, result)
    settleReceive(pubkey, result.swapId)
    notifyWalletChanged()
    return saved
  } finally {
    endReceive()
  }
}

/** Shown when a swap back is asked for while this wallet is logging out. Nothing was swapped. */
export const SWAP_BACK_PAUSED_MESSAGE =
  'This wallet is logging out, so nothing was swapped. The coupon is still here. Try again after you log in.'

/**
 * The recovery sweep's save for a swap back interrupted after the mint signed.
 *
 * @returns false when this swap is not a swap back, so the caller can treat it as before
 */
export async function saveRecoveredSwapBack(swap: ReceiveResult, mintUrlOf: (row: VoucherRow) => string = (r) => readTokenBacking(r.token).mintUrl): Promise<boolean> {
  const rows = await getWallet().getAllVouchers()
  const row = rows.find((r) => r.swap_back_id === swap.swapId)
  if (!row) return false
  await keepSats(row, mintUrlOf(row), swap)
  notifyWalletChanged()
  return true
}

async function keepSats(row: VoucherRow, mintUrl: string, result: ReceiveResult): Promise<SwapBackResult> {
  const sats = result.proofs.reduce((sum, proof) => sum + proof.amount, 0)
  const token = encodePlainTokenV4(mintUrl, 'sat', result.proofs)
  await getWallet().saveVoucher({
    ...row,
    status: SWAPPED_TO_SATS_STATUS,
    sats_token: token,
    sats_amount: sats,
    updated_at: new Date().toISOString(),
  })
  return { token, sats }
}
