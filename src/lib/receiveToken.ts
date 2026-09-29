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
 * <h2>Why this mirrors cashu-lib's acceptance rather than using JSON.parse alone</h2>
 *
 * The two readers must agree about what IS a voucher, and they nearly did not.
 * cashu-lib gates on `trimmed.startsWith("[") && trimmed.endsWith("]")` and then
 * hands the string to Jackson, which **stops at the first complete value and
 * ignores trailing content**. `JSON.parse` does not: it rejects the whole string.
 *
 * So a secret like `["VOUCHER",{...}] ]`, with a stray bracket after the array, is
 * a voucher to the mint and to the gateway, and was NOT a voucher to this guard.
 * That is the exact silent destruction this module exists to prevent, and a
 * security reviewer proved it. Divergence between two readers of the same bytes is
 * the same class of bug as cashu-voucher#48.
 *
 * The fix is to read what cashu-lib reads: take the leading complete JSON value
 * and ignore what follows. And to fail CLOSED on anything that looks structured
 * and will not parse, because "I cannot read this" is not evidence that it is a
 * bearer secret, and guessing bearer is the guess that loses the coupon.
 *
 * The kind comparison stays EXACT, which is correct for the opposite reason:
 * cashu-lib's `Kind.valueOf` is exact too, so `p2pk_voucher` is not a voucher
 * anywhere in the stack and there is no coupon to protect.
 */
function carriesVoucher(secrets: readonly string[]): boolean {
  return secrets.some(isVoucherLike)
}

/**
 * Whether one secret would be read as a voucher by anything downstream.
 *
 * Errs towards yes. Refusing a plain token costs a fallback to the gateway
 * receive; accepting a voucher costs the coupon.
 */
export function isVoucherSecretForTest(secret: string): boolean {
  return isVoucherLike(secret)
}

function isVoucherLike(secret: string): boolean {
  const trimmed = secret.trim()
  // The same gate cashu-lib applies before it tries to parse at all. A secret
  // failing this is a NUT-00 bearer string, which is genuinely not a voucher.
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return false

  const parsed = leadingJsonValue(trimmed)
  if (parsed === undefined) {
    // Bracketed and unparseable. cashu-lib would fall back to a bearer secret and
    // so could we, but the downside is not symmetric: if any reader anywhere
    // disagrees and sees a voucher, this path destroys it. Refusing costs a
    // fallback to the gateway receive, which is the cheaper mistake.
    return true
  }

  return Array.isArray(parsed) && (parsed[0] === 'VOUCHER' || parsed[0] === 'P2PK_VOUCHER')
}

/**
 * The first complete JSON value in `text`, ignoring anything after it.
 *
 * This is what Jackson's `readValue` does and what `JSON.parse` refuses to do,
 * and that difference is the whole reason this function exists. Implemented by
 * retrying shorter prefixes rather than by writing a parser, because a
 * hand-written one would be a third reader with its own disagreements.
 */
function leadingJsonValue(text: string): unknown {
  for (let end = text.length; end > 1; end--) {
    if (text[end - 1] !== ']') continue
    try {
      return JSON.parse(text.slice(0, end)) as unknown
    } catch {
      // Not a complete value at this length; try a shorter prefix.
    }
  }
  return undefined
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
