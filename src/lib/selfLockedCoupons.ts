/**
 * Coupons locked to this wallet's own key K, turned back into ordinary (bearer) coupons (#402).
 *
 * ## Why
 *
 * The bearer split (`voucherSplit.ts`) makes a checkout code's exact amount by burning one proof and
 * having gateway-customer sign it back as parts locked to K alone. The parts the code uses are locked
 * again to the shop; the CHANGE stays in the wallet as a row of its own, still locked to K. Such a
 * coupon is the wallet's, but no other door can spend it: gateway-core's send saga cannot split a
 * locked proof (`LOCKED_VOUCHER_SPLIT_REQUIRES_HOLDER`, imani-gateway-core#113), so the next ordinary
 * send drawn on it fails (staging, 2026-11-01: a €1 send from a €7 change row).
 *
 * ## How
 *
 * Exactly as a coupon a shop gave back (`checkoutCodeFlow.unlockReturned`): burn each proof with K
 * into outputs derived from K (SIG_INPUTS, only K can), have gateway-customer re-sign it UNLOCKED
 * (`POST /vouchers/checkout/unlock`), mint it, and write the row back with the unlocked token.
 * Everything is derived from K and the proof, so a page that dies anywhere resumes: a burn already
 * made is found by NUT-09 restore, the gateway replays the identical successor, and a minted carrier
 * is found the same way. A definite refusal after the burn keeps the value as sats (never lost).
 *
 * Proofs that are not locked to K alone are left exactly as they are.
 *
 * ## Never a licence or a terminal credential
 *
 * A subscription licence is ALSO locked to K alone (`lock_key` is the stall), and so is a terminal
 * credential. Neither is change: the lock is what makes it the stall's, and its `voucher_id` is what
 * gateway-customer's licence register watches. Burning one spends it at the mint, the gateway then
 * refuses to re-sign it (`NOT_REISSUABLE`, the rule in `VoucherLockedSplitService.isCredential`), and
 * the next licence check finds it SPENT and revokes it (staging 2026-11-02: corda's Essentials licence,
 * swapped at 06:17 by this sweep, revoked at 06:22, its value left as a sats row). So such a proof is
 * never unlockable, here or by the app's sweep.
 */
import { cashlinkSteps, type CashlinkPorts } from './cashlinkFlow'
import {
  CHECKOUT_UNLOCK_TAG,
  cashlinkAuthorization,
  derivedNonce,
  derivedOutputs,
  isSelfLocked,
  isTheSuccessorAskedFor,
  unlockedProposal,
  xOnlyPub,
} from './cashlinkLock'
import { creditableFaceValue, parseVoucherToken, tokenProofs, voucherOfProof, voucherOfSecret, type TokenProof } from './voucherToken'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

const { mintOf, proofBody, burnOutputsBody, restoreMine, swapOrRestore, signRoute, notYet, tokenOf, mintCarrier } = cashlinkSteps

export const UNLOCK_PATH = '/api/v1/wallet/vouchers/checkout/unlock'

export interface SelfLockPorts extends CashlinkPorts {
  /** The wallet key K, borrowed; the caller wipes it. Null when the wallet is locked. */
  identitySecret(): Uint8Array | null
}

/** One coupon row whose token holds at least one proof locked to K alone. */
export interface SelfLockedRow {
  tokenId: string
  token: string
}

export type RowOutcome =
  /**
   * Every K-locked proof is unlocked. Each unlocked proof is its own signed coupon (its own nonce, so
   * its own voucher blob), so `tokens` holds one token per unlocked proof, plus one for the row's
   * proofs that were never K-locked (if any). Empty when nothing of the row is left.
   */
  | { kind: 'unlocked'; tokens: string[] }
  /** Part way (the mint or gateway not ready, the key locked): the next run carries on. Nothing lost. */
  | { kind: 'pending'; why: string }

/** Whether any proof of `token` is locked to `selfPub` alone. Never throws. */
export function hasSelfLockedProof(token: string, selfPub: string): boolean {
  try {
    return tokenProofs(token).some((p) => isSelfLocked(p.secret, selfPub))
  } catch {
    return false
  }
}

/**
 * A licence or terminal credential: its metadata names a `subscription_id`, or says `terminal`. The
 * same rule as gateway-customer's `VoucherLockedSplitService.isCredential`, which refuses to re-sign
 * one, so this wallet never burns what the gateway will not give back. Read straight from the
 * `merchant_metadata` tag, as the gateway reads it, so a proof whose other tags this wallet cannot
 * parse is still recognised. Unreadable metadata is not a credential (as there). Never throws.
 */
export function isCredentialProof(secret: string): boolean {
  try {
    const raw = metadataTag(secret) ?? voucherOfSecret(secret)?.merchantMetadata
    if (!raw) return false
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const m = parsed as Record<string, unknown>
    return 'subscription_id' in m || String(m.terminal) === 'true'
  } catch {
    return false
  }
}

/** The first value of a NUT-10 secret's `merchant_metadata` tag, or undefined. Never throws. */
function metadataTag(secret: string): string | undefined {
  try {
    const body = (JSON.parse(secret) as unknown[])[1] as { tags?: unknown } | undefined
    const row = Array.isArray(body?.tags) ? (body.tags as unknown[]).find((t) => Array.isArray(t) && t[0] === 'merchant_metadata') : undefined
    return Array.isArray(row) && row[1] != null ? String(row[1]) : undefined
  } catch {
    return undefined
  }
}

/** Locked to `selfPub` alone AND not a licence or credential: change this wallet may unlock. */
export function isUnlockableSelfLocked(secret: string, selfPub: string): boolean {
  return isSelfLocked(secret, selfPub) && !isCredentialProof(secret)
}

/** Whether any proof of `token` is change this wallet may unlock. Never throws. */
export function hasUnlockableProof(token: string, selfPub: string): boolean {
  try {
    return tokenProofs(token).some((p) => isUnlockableSelfLocked(p.secret, selfPub))
  } catch {
    return false
  }
}

/** NUT-11 SIG_INPUTS witness: K over `sha256(secret)`. */
function inputWitness(key: Uint8Array, secret: string): string {
  return JSON.stringify({ signatures: [bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(secret)), key))] })
}

/**
 * Unlock every proof of one row that is locked to K alone. The row's other proofs are kept as they
 * are, in the returned token. `keep` records value that had to be kept as sats.
 */
export async function unlockSelfLockedRow(ports: SelfLockPorts, row: SelfLockedRow): Promise<RowOutcome> {
  const K = ports.identitySecret()
  if (!K) return { kind: 'pending', why: 'the wallet key is locked' }
  try {
    const selfPub = xOnlyPub(K)
    const mintUrl = mintOf(row.token)
    const untouched: TokenProof[] = []
    const tokens: string[] = []
    for (const proof of tokenProofs(row.token)) {
      if (!isUnlockableSelfLocked(proof.secret, selfPub)) {
        untouched.push(proof)
        continue
      }
      const step = await unlockOne(ports, mintUrl, proof, K)
      if (step.kind === 'pending') return step
      if (step.kind === 'unlocked') tokens.push(tokenOf(mintUrl, [step.proof as never]))
      // 'kept_as_sats' and 'gone': not part of this row any more.
    }
    if (untouched.length) tokens.unshift(tokenOf(mintUrl, untouched as never))
    return { kind: 'unlocked', tokens }
  } catch (error) {
    return { kind: 'pending', why: error instanceof Error ? error.message : String(error) }
  } finally {
    K.fill(0)
  }
}

type Step = { kind: 'unlocked'; proof: TokenProof } | { kind: 'kept_as_sats' } | { kind: 'gone' } | { kind: 'pending'; why: string }

async function unlockOne(ports: SelfLockPorts, mintUrl: string, proof: TokenProof, K: Uint8Array): Promise<Step> {
  const keyset = await ports.mint.activeKeysetId(mintUrl)
  // Derived from K and the proof: the same outputs on every run, so a lost answer is found by NUT-09.
  let outs = derivedOutputs(K, 'self-unlock-burn', proof.secret, proof.amount, keyset)
  const [state] = await ports.mint.states(mintUrl, [proof.secret])
  let plain
  if (state === 'UNSPENT') {
    const done = await swapOrRestore(ports.mint, mintUrl, [{ ...proof, witness: inputWitness(K, proof.secret) }], outs)
    if (done.kind === 'gone') return { kind: 'gone' }
    if (done.kind === 'refused') return { kind: 'pending', why: 'the mint refused the burn' }
    plain = done.proofs
  } else if (state === 'SPENT') {
    plain = await restoreMine(ports.mint, mintUrl, outs)
    if (plain.length === 0) {
      // Burnt under the proof's own keyset by an earlier run before a rotation.
      outs = derivedOutputs(K, 'self-unlock-burn', proof.secret, proof.amount, proof.id)
      plain = await restoreMine(ports.mint, mintUrl, outs)
    }
    if (plain.length === 0) return { kind: 'gone' }
    outs = outs.map((o, n) => ({ ...o, id: plain![n].id }))
  } else {
    return { kind: 'pending', why: 'the mint could not say whether the coupon is spent' }
  }

  const proposed = unlockedProposal(proof.secret, derivedNonce(K, 'self-unlock', proof.secret))
  const answer = await signRoute(ports, UNLOCK_PATH, {
    predecessor_secret: proof.secret,
    proposed_secret: proposed,
    authorization: cashlinkAuthorization(K, CHECKOUT_UNLOCK_TAG, proof.secret, proposed),
    predecessor_proof: proofBody(proof),
    burn_outputs: burnOutputsBody(outs),
  })
  const signed = answer.body?.signed_secret
  const locked = voucherOfProof(proof)!
  if (answer.status === 200 && typeof signed === 'string' && isTheSuccessorAskedFor(signed, locked)) {
    // An earlier run may have minted it already: mintCarrier restores before it swaps.
    const coupon = await mintCarrier(ports, mintUrl, plain, signed, K, 'self-unlock-mint', proof)
    if (!coupon) return { kind: 'pending', why: 'the unlocked coupon could not be minted yet' }
    return { kind: 'unlocked', proof: coupon as unknown as TokenProof }
  }
  if (notYet(answer.status) || answer.status === 404) return { kind: 'pending', why: `the gateway answered ${answer.status}` }
  // A definite refusal after the burn: the burnt sats are ours, kept as sats. Never lost.
  await cashlinkSteps.keepAsSats(ports, mintUrl, proof, plain, 'returned', faceShare(proof))
  return { kind: 'kept_as_sats' }
}

function faceShare(proof: TokenProof): number | undefined {
  try {
    return creditableFaceValue(parseVoucherToken(tokenOf('', [proof as never]))).faceValue
  } catch {
    return undefined
  }
}
