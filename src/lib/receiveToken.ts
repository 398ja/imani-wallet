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
 * - **An untrusted mint or a foreign unit.** Proofs at a mint we do not trust are
 *   not ours to credit, and amounts in another unit do not mean what the wallet
 *   would read them as. Checked before anything is spent.
 * - **A gateway config that has not arrived.** Deferred, NOT passed. The trusted
 *   set is not yet knowable, and treating "we cannot tell" as "fine" is how an
 *   untrusted mint gets credited during start-up.
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

import { parseVoucherToken, tokenProofs } from './voucherToken'
import { checkMintAndUnit } from './trustedMint'
import { buildWitnesses } from './witness'
import { receiveByOwnSwap, settleReceive, type MintTransport, type ReceivableProof } from './receiveSwap'
import type { UnblindedProof } from './walletSwap'

/** Why a token could not be received by our own swap. */
export type ReceiveRefusal =
  /** The gateway's config has not arrived, so the mint cannot be checked yet. Retry. */
  | 'not-ready'
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
 * <h2>Why an EXACT kind match is enough</h2>
 *
 * The comparison is case-sensitive and does not trim, which looks brittle and is
 * correct. It has to agree with cashu-lib's reader, and that reader uses
 * `Kind.valueOf(kindStr)`, which is exact: `"p2pk_voucher"` and `"P2PK_VOUCHER "`
 * both throw `Unknown secret kind`.
 *
 * So a secret this guard "misses" on a case or whitespace variation is a secret the
 * MINT will not accept as a voucher either. There is no coupon to destroy, because
 * there is no coupon. Probed rather than assumed: those two variants do evade the
 * guard, and both are unparseable as vouchers anywhere in the stack.
 *
 * Normalising here would be worse than useless. It would make this reader accept a
 * shape the rest of the system rejects, which is the disagreement that produced
 * cashu-voucher#48.
 */
function carriesVoucher(secrets: readonly string[]): boolean {
  return secrets.some((secret) => {
    // A NUT-10 secret is a JSON array whose first element names the kind. Parsing
    // is the honest test; a substring match on "VOUCHER" would also fire on a memo.
    try {
      const parsed = JSON.parse(secret) as unknown
      if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return false
      return parsed[0] === 'VOUCHER' || parsed[0] === 'P2PK_VOUCHER'
    } catch {
      // A plain bearer secret is a random string, not JSON. Not a voucher.
      return false
    }
  })
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
  let parsed: ReturnType<typeof parseVoucherToken>
  let proofs: ReturnType<typeof tokenProofs>
  try {
    parsed = parseVoucherToken(token)
    proofs = tokenProofs(token)
  } catch (cannotDecode) {
    throw new ReceiveNotPossible(
      'undecodable',
      `token could not be decoded: ${cannotDecode instanceof Error ? cannotDecode.message : String(cannotDecode)}`,
    )
  }

  const verdict = checkMintAndUnit(parsed)
  if (verdict !== 'trusted' && verdict !== 'unchecked') {
    throw new ReceiveNotPossible(
      verdict === 'not-ready' ? 'not-ready' : verdict,
      `refusing to receive: ${verdict}`,
    )
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
    { pubkey, mintUrl: parsed.mintUrl, proofs: receivable },
    transport,
  )

  return { swapId: result.swapId, proofs: result.proofs, mintUrl: parsed.mintUrl }
}

/** Drop the recovery record for a receive whose proofs are now saved. */
export function settleOwnSwap(pubkey: string, swapId: string): void {
  settleReceive(pubkey, swapId)
}
