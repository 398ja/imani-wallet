/**
 * Receiving a token by swapping it ourselves, as the thing a caller actually holds.
 *
 * `receiveByOwnSwap` takes decoded proofs at a known mint. Every caller in this app
 * holds a TOKEN STRING. This module is the join: decode, check, sign, swap. It exists
 * so that seam is written once and tested, rather than repeated at each call site
 * where one of the checks could quietly be left out.
 *
 * ## What it refuses, and why each refusal is here rather than later
 *
 * A receive is the moment value enters the wallet, so it is the last point at which
 * refusing costs nothing. After it, the proofs are ours and a mistake is a wrong
 * balance somebody has to reconcile.
 *
 * - **Anything but a mint we positively trust.** This path takes the token's OWN
 *   mint URL and sends money there, so the mint is not a field we record but the
 *   address we act on. An attacker-supplied token naming a mint they control
 *   would be swapped at that mint, and the wallet would hold proofs nobody
 *   trusts while believing them good (#133). So it FAILS CLOSED: an untrusted
 *   mint, a foreign unit, a trusted set that is not yet known, and a deployment
 *   that names no mint at all are all refused. The crediting paths are allowed
 *   to accept `unchecked`, because there the money is already held and refusing
 *   would strand it; here nothing has moved yet, and refusing costs only a
 *   fallback to the gateway receive.
 * - **A voucher.** Deliberate, and the subtlest refusal here, so it has its own
 *   section below.
 *
 * ## Why a voucher cannot go through this path yet
 *
 * `blindOutputs` generates RANDOM secrets. That is correct for plain ecash, where a
 * secret is just an unpredictable string, and destructive for a voucher, whose
 * secret carries its id, face value, lock key, issuer signature and warrant.
 *
 * Pushing a voucher through would return the right number of SATS with no coupon
 * attached, and nothing would fail: the mint balances sats and never reads the
 * coupon, so the swap succeeds and the coupon evaporates. That is a silent loss of
 * everything the coupon promised, which is worse than any error.
 *
 * The voucher path needs the gateway to sign each fresh secret, which now exists
 * (imani-gateway-customer#135) but is not wired here. Until it is, a voucher is
 * refused loudly and the caller falls back to the gateway receive it uses today.
 */

import { isVoucherSecret, tokenProofs } from './voucherToken'
import { checkMintAndUnit, readTokenBacking, type TokenBacking } from './trustedMint'
import { buildWitnesses } from './witness'
import { receiveByOwnSwap, settleReceive, type MintTransport, type ReceivableProof } from './receiveSwap'
import type { UnblindedProof } from './walletSwap'

/** Why a token could not be received by our own swap. */
export type ReceiveRefusal =
  /** The gateway's config has not arrived, so the mint cannot be checked yet. Retry. */
  | 'not-ready'
  /** This deployment names no trusted mint, so there is nowhere this path may swap. */
  | 'no-trusted-mint'
  /** The proofs are at a mint this build does not trust. */
  | 'untrusted-mint'
  /** The proofs are not denominated in the unit this wallet understands. */
  | 'wrong-unit'
  /** The token carries a voucher, whose secret this path would destroy. */
  | 'voucher-unsupported'
  /** The token could not be decoded as a TokenV4. */
  | 'undecodable'

export class ReceiveNotPossible extends Error {
  constructor(readonly refusal: ReceiveRefusal, message: string) {
    super(message)
    this.name = 'ReceiveNotPossible'
  }
}

export interface OwnSwapReceipt {
  swapId: string
  proofs: UnblindedProof[]
  mintUrl: string
}

/**
 * Whether this token carries a voucher, on the evidence of the proofs themselves.
 *
 * Reads the SECRETS rather than the token's metadata, because metadata is a claim
 * about the token and the secret is the thing this path would overwrite. A token
 * whose metadata says nothing but whose proofs carry voucher secrets is exactly the
 * case that must not slip through.
 *
 * Any voucher-carrying proof condemns the whole token. A mixed token cannot be
 * partially received here: taking the plain proofs and leaving the voucher ones
 * would split one token across two mechanisms and leave the coupon in limbo.
 *
 * The per-secret judgement is `isVoucherSecret`, shared with the swap itself.
 * Both used to have their own, with different algorithms, which is a guard
 * protecting two different sets and calling itself one.
 */
function carriesVoucher(secrets: readonly string[]): boolean {
  return secrets.some(isVoucherSecret)
}

/**
 * Receive a token by swapping its proofs for fresh ones only this wallet can spend.
 *
 * Throws {@link ReceiveNotPossible} when this path must not be used, which the
 * caller should treat as "use the gateway receive", not as a failure. Throws
 * anything else when the swap itself went wrong; in that case the intent is on
 * disk and a later sweep can finish it.
 *
 * The caller MUST save the returned proofs and then call {@link settleOwnSwap}.
 * Settling inside this function would clear the recovery record while the proofs
 * were still only in memory, which is the window the whole mechanism covers.
 */
export async function receiveTokenByOwnSwap(
  token: string,
  pubkey: string,
  transport: MintTransport,
): Promise<OwnSwapReceipt> {
  // `readTokenBacking`, not `parseVoucherToken`: the latter reads only vouchers,
  // and plain ecash, the one thing this path may receive, made it throw. The gate
  // below then never saw the tokens it exists to judge.
  let backing: TokenBacking
  let proofs: ReturnType<typeof tokenProofs>
  try {
    backing = readTokenBacking(token)
    proofs = tokenProofs(token)
  } catch (cannotDecode) {
    throw new ReceiveNotPossible(
      'undecodable',
      `token could not be decoded: ${cannotDecode instanceof Error ? cannotDecode.message : String(cannotDecode)}`,
    )
  }

  const verdict = checkMintAndUnit(backing)
  if (verdict !== 'trusted') {
    // `unchecked` is a refusal HERE, unlike on the crediting paths: with no mint
    // to compare against, the only mint on offer is the one the token names.
    const refusal: ReceiveRefusal = verdict === 'unchecked' ? 'no-trusted-mint' : verdict
    throw new ReceiveNotPossible(refusal, `refusing to swap at ${backing.mintUrl || 'an unnamed mint'}: ${refusal}`)
  }

  const secrets = proofs.map((proof) => proof.secret)
  if (carriesVoucher(secrets)) {
    throw new ReceiveNotPossible(
      'voucher-unsupported',
      'this token carries a voucher, whose secret a wallet-chosen swap would destroy',
    )
  }

  // Witnesses for any locked proof. Built for ALL secrets in one call because
  // `buildWitnesses` decides per secret whether a witness is needed and whether
  // this wallet can produce one; a caller filtering first would have to reproduce
  // that judgement.
  const witnessesBySecret = buildWitnesses(secrets)
  const receivable: ReceivableProof[] = proofs.map((proof) => {
    const witness = witnessesBySecret[proof.secret]
    return witness ? { ...proof, witness: JSON.stringify({ signatures: witness }) } : proof
  })

  const result = await receiveByOwnSwap(
    { pubkey, mintUrl: backing.mintUrl, proofs: receivable },
    transport,
  )

  return { swapId: result.swapId, proofs: result.proofs, mintUrl: backing.mintUrl }
}

/** Drop the recovery record for a receive whose proofs are now saved. */
export function settleOwnSwap(pubkey: string, swapId: string): void {
  settleReceive(pubkey, swapId)
}
