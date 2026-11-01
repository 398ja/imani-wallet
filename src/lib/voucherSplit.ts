/**
 * Splitting one of the customer's coupons so a checkout code can be made for an amount its proofs
 * cannot make whole (#402). gateway-customer `POST /vouchers/bearer-split` signs the parts; the mint
 * swaps; nothing here holds anybody else's money.
 *
 * ## The seven steps, and why they are crash-safe
 *
 *   1. Plan (`voucherSplitPlan.ts`) and DERIVE everything from the wallet key K: the burn's outputs,
 *      every part's nonce, the authorisation, and the blinding factor of every part's carrier. The
 *      request is therefore the same bytes on every run, which is what the gateway replays.
 *   2. Ask the dry run (`/bearer-split/check`). A gateway without the route, or one that would refuse,
 *      is found out here, while the coupon is untouched.
 *   3. PERSIST the intent (`voucherSplitsKey`), synchronously, before anything moves. Logout stays off
 *      while it exists (`moneyInFlight`).
 *   4. Burn the bearer proof into the derived outputs, witnessed by K over the swap. A lost answer is
 *      found by NUT-09 restore of the same outputs.
 *   5. Ask `/bearer-split` with the SAME body, again while it says "not yet" (409/429/5xx). A
 *      definite refusal after the burn keeps the burnt sats as a swapped-to-sats row: never lost.
 *   6. Mint each signed part into its derived carrier; an earlier run's mint is found by NUT-09.
 *   7. Write the rows (the parts, then the source row as its remainder) and forget the intent.
 *
 * `finishVoucherSplits` runs the same steps for every intent a page that died left behind.
 */
import { cashlinkSteps, type CashlinkPorts, type KeptCoupon } from './cashlinkFlow'
import {
  bearerSplitAuthorization,
  derivedCarrier,
  derivedNonce,
  derivedOutputs,
  isTheSplitPartAskedFor,
  secretHash,
  sigAllWitness,
  splitPartProposal,
  xOnlyPub,
} from './cashlinkLock'
import { voucherSplitsKey } from './inFlightMoney'
import { planSplit } from './voucherSplitPlan'
import { creditableFaceValue, parseVoucherToken, voucherOfSecret, type TokenProof } from './voucherToken'
import type { BlindedOutput, UnblindedProof } from './walletSwap'

const { mintOf, proofBody, burnOutputsBody, restoreMine, swapOrRestore, signRoute, notYet, refusalOf, tokenOf, keepAsSats } = cashlinkSteps

export const BEARER_SPLIT_PATH = '/api/v1/wallet/vouchers/bearer-split'
export const BEARER_SPLIT_CHECK_PATH = '/api/v1/wallet/vouchers/bearer-split/check'

export interface SplitPorts extends CashlinkPorts {
  /** The wallet key K, borrowed; the caller wipes it. Null when the wallet is locked. */
  identitySecret(): Uint8Array | null
  /**
   * The split landed: write `parts` as coupon rows carrying the coupon's issuer, unit and expiry, then
   * the source row as `remainder` (removed when null). Idempotent: a second call with the same tokens
   * (a run that died after writing) writes nothing new. Returns the rows' ids. Must throw if it could
   * not write.
   */
  commit(sourceTokenId: string, remainder: string | null, parts: string[]): Promise<{ partIds: string[]; remainderId: string | null }>
  /** Keep the burnt sats when the parts could not be had, and take the burnt proof off the source row. */
  keep(row: KeptCoupon): Promise<void>
}

/** One split part way, as persisted before the burn. */
export interface SplitIntent {
  id: string
  sourceTokenId: string
  mintUrl: string
  proof: TokenProof
  remainder: string | null
  sats: number[]
  needCount: number
  carveAmount: number
  need: number
  burnKeyset: string
  /** The signed parts once the gateway has answered, so a page that dies mints them without asking. */
  signed?: string[]
  at: number
}

/** A checkout part made from a split: the row, and what it draws. */
export interface SplitPart {
  tokenId: string
  token: string
  amount: number
  faceValue: number
}

export type SplitOutcome =
  /** The rows are written. `parts` replace the split coupon in the code: they draw exactly its amount. */
  | { kind: 'split'; parts: SplitPart[] }
  /** Nothing moved: the coupon is exactly as it was. */
  | { kind: 'refused'; why: string }
  /** The coupon was burnt and could not be split; its value is kept as sats in the wallet. */
  | { kind: 'kept_as_sats'; why: string }
  /** Part way: the next run finishes it. Nothing is lost. */
  | { kind: 'pending'; why: string }

// --- The intent ledger --------------------------------------------------------

export function loadSplitIntents(pubkey: string): SplitIntent[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(voucherSplitsKey(pubkey)) ?? '[]') as unknown
    return Array.isArray(parsed) ? (parsed as SplitIntent[]) : []
  } catch {
    return []
  }
}

/** Throws when it cannot be written: nothing may burn until it can. */
function saveIntent(pubkey: string, intent: SplitIntent): void {
  const rest = loadSplitIntents(pubkey).filter((i) => i.id !== intent.id)
  localStorage.setItem(voucherSplitsKey(pubkey), JSON.stringify([...rest, intent]))
}

function forgetIntent(pubkey: string, id: string): void {
  try {
    const left = loadSplitIntents(pubkey).filter((i) => i.id !== id)
    if (left.length === 0) localStorage.removeItem(voucherSplitsKey(pubkey))
    else localStorage.setItem(voucherSplitsKey(pubkey), JSON.stringify(left))
  } catch {
    // Left listed: logout stays off, and the next run finds the rows written and clears it.
  }
}

// --- Derivation -----------------------------------------------------------------

const partAnchor = (proof: TokenProof, n: number) => `${proof.secret}#split/${n}`
const burnOutputsOf = (K: Uint8Array, intent: Pick<SplitIntent, 'proof' | 'burnKeyset'>) =>
  derivedOutputs(K, 'split-burn', intent.proof.secret, intent.proof.amount, intent.burnKeyset)

function proposalsOf(K: Uint8Array, intent: Pick<SplitIntent, 'proof' | 'sats'>): string[] {
  const selfPub = xOnlyPub(K)
  return intent.sats.map((sats, n) => splitPartProposal(intent.proof.secret, selfPub, sats, derivedNonce(K, 'split-part', partAnchor(intent.proof, n))))
}

function bodyOf(K: Uint8Array, intent: SplitIntent, outputs: BlindedOutput[]) {
  const parts = proposalsOf(K, intent)
  return {
    predecessor_secret: intent.proof.secret,
    predecessor_proof: proofBody(intent.proof),
    parts,
    burn_outputs: burnOutputsBody(outputs),
    authorization: bearerSplitAuthorization(K, intent.proof.secret, parts, outputs),
  }
}

// --- Running ----------------------------------------------------------------------

/** Split the coupon row `tokenId` (its token `token`) so `amount` can be carved from it. Never throws. */
export async function splitVoucher(ports: SplitPorts, pubkey: string, req: { tokenId: string; token: string; amount: number }): Promise<SplitOutcome> {
  const plan = planSplit(req.token, req.amount)
  if (!plan) return { kind: 'refused', why: 'not_splittable' }
  const id = `${req.tokenId}:${secretHash(plan.proof.secret)}`
  const existing = loadSplitIntents(pubkey).find((i) => i.id === id)
  if (existing) return finishOne(ports, pubkey, existing)
  const K = ports.identitySecret()
  if (!K) return { kind: 'refused', why: 'the wallet key is locked' }
  try {
    const mintUrl = mintOf(req.token)
    let burnKeyset: string
    try {
      burnKeyset = await ports.mint.activeKeysetId(mintUrl)
    } catch {
      return { kind: 'refused', why: 'the mint is unreachable' }
    }
    const intent: SplitIntent = {
      id,
      sourceTokenId: req.tokenId,
      mintUrl,
      proof: plan.proof,
      remainder: plan.remainder,
      sats: plan.sats,
      needCount: plan.needCount,
      carveAmount: plan.carveAmount,
      need: plan.need,
      burnKeyset,
      at: ports.now(),
    }
    // 2. The dry run, while nothing has moved. Its 204 is the one answer that lets the burn go ahead.
    let dry
    try {
      dry = await ports.gateway.call('POST', BEARER_SPLIT_CHECK_PATH, bodyOf(K, intent, burnOutputsOf(K, intent)))
    } catch {
      return { kind: 'refused', why: 'the gateway is unreachable' }
    }
    if (dry.status !== 204) return { kind: 'refused', why: dry.status === 404 || dry.status === 405 ? 'split_route_unavailable' : refusalOf(dry) }
    // 3. Written before the burn, or there is no burn.
    try {
      saveIntent(pubkey, intent)
    } catch {
      return { kind: 'refused', why: 'this device could not save the split' }
    }
  } finally {
    K.fill(0)
  }
  return finishOne(ports, pubkey, loadSplitIntents(pubkey).find((i) => i.id === id)!)
}

/** Every split a page left part way, finished or left for the next run. Never throws. */
export async function finishVoucherSplits(ports: SplitPorts, pubkey: string): Promise<number> {
  let done = 0
  for (const intent of loadSplitIntents(pubkey)) {
    const out = await finishOne(ports, pubkey, intent)
    if (out.kind !== 'pending') done += 1
  }
  return done
}

async function finishOne(ports: SplitPorts, pubkey: string, intent: SplitIntent): Promise<SplitOutcome> {
  const K = ports.identitySecret()
  if (!K) return { kind: 'pending', why: 'the wallet key is locked' }
  try {
    return await run(ports, pubkey, intent, K)
  } catch (error) {
    return { kind: 'pending', why: error instanceof Error ? error.message : String(error) }
  } finally {
    K.fill(0)
  }
}

async function run(ports: SplitPorts, pubkey: string, intent: SplitIntent, K: Uint8Array): Promise<SplitOutcome> {
  const { mint } = ports
  const mintUrl = intent.mintUrl
  let outs = burnOutputsOf(K, intent)

  // 4. Burn, or find our earlier burn.
  let burnt: UnblindedProof[]
  const [state] = await mint.states(mintUrl, [intent.proof.secret])
  if (state === 'UNSPENT') {
    let done = await swapOrRestore(mint, mintUrl, [{ ...intent.proof, witness: sigAllWitness(K, intent.proof.secret, intent.proof.C, outs) }], outs)
    if (done.kind === 'refused' && done.answer.kind === 'inactive') {
      // Archived since the intent was written: nothing was signed. Same B_, the active keyset.
      intent.burnKeyset = await mint.activeKeysetId(mintUrl)
      saveIntent(pubkey, intent)
      outs = burnOutputsOf(K, intent)
      done = await swapOrRestore(mint, mintUrl, [{ ...intent.proof, witness: sigAllWitness(K, intent.proof.secret, intent.proof.C, outs) }], outs)
    }
    if (done.kind === 'gone') return gone(pubkey, intent)
    if (done.kind === 'refused') {
      const code = done.answer.kind === 'refused' ? done.answer.code : undefined
      if (code === 11002 || code === 11004) return { kind: 'pending', why: 'the burn is pending at the mint' }
      // Refused outright: nothing burnt, the coupon is as it was.
      forgetIntent(pubkey, intent.id)
      return { kind: 'refused', why: `the mint refused the split (${done.answer.kind})` }
    }
    burnt = done.proofs
  } else if (state === 'SPENT') {
    burnt = await restoreMine(mint, mintUrl, outs)
    if (burnt.length === 0) return gone(pubkey, intent)
    if (burnt.length !== outs.length) return { kind: 'pending', why: 'the burn is only partly signed' }
  } else {
    return { kind: 'pending', why: 'the mint could not say whether the coupon is spent' }
  }

  // 5. The parts, asked with the same body until the gateway answers for good.
  const bearer = voucherOfSecret(intent.proof.secret)!
  const proposals = proposalsOf(K, intent)
  let signed = intent.signed
  if (!signed) {
    const answer = await signRoute(ports, BEARER_SPLIT_PATH, bodyOf(K, intent, outs))
    const parts = answer.body?.signed_parts
    if (answer.status === 200 && Array.isArray(parts) && parts.length === proposals.length &&
      parts.every((s, n) => typeof s === 'string' && isTheSplitPartAskedFor(s, proposals[n], bearer))) {
      signed = parts as string[]
      intent.signed = signed
      saveIntent(pubkey, intent)
    } else if (notYet(answer.status) || answer.status === 404 || answer.status === 0) {
      return { kind: 'pending', why: `the split is not available yet (${refusalOf(answer)})` }
    } else {
      // A definite refusal (or an answer that is not what was asked) after the burn: keep the sats.
      const [burntState] = await mint.states(mintUrl, [burnt[0].secret])
      if (burntState === 'SPENT') return { kind: 'pending', why: 'the burn was spent by an earlier run' }
      await keepAsSats(ports, mintUrl, intent.proof, burnt, 'returned')
      await ports.commit(intent.sourceTokenId, intent.remainder, [])
      forgetIntent(pubkey, intent.id)
      return { kind: 'kept_as_sats', why: answer.status === 200 ? 'UNEXPECTED_PARTS' : refusalOf(answer) }
    }
  }

  // 6. Mint each part into its derived carrier, or find an earlier run's.
  const keyset = burnt[0].id
  const carriers = signed.map((s, n) => derivedCarrier(K, 'split-mint', partAnchor(intent.proof, n), s, intent.sats[n], keyset))
  let minted: UnblindedProof[]
  const [burntState] = await mint.states(mintUrl, [burnt[0].secret])
  if (burntState === 'SPENT') {
    minted = await restoreMine(mint, mintUrl, carriers)
    if (minted.length !== carriers.length) return { kind: 'pending', why: 'the parts are not found yet' }
  } else {
    const done = await swapOrRestore(mint, mintUrl, burnt, carriers)
    if (done.kind !== 'proofs') return { kind: 'pending', why: `the parts could not be minted (${done.kind})` }
    minted = done.proofs
  }

  // 7. Rows, then forget.
  const need = tokenOf(mintUrl, minted.slice(0, intent.needCount))
  const rest = minted.length > intent.needCount ? tokenOf(mintUrl, minted.slice(intent.needCount)) : null
  const ids = await ports.commit(intent.sourceTokenId, intent.remainder, rest ? [need, rest] : [need])
  forgetIntent(pubkey, intent.id)
  const parts: SplitPart[] = [{ tokenId: ids.partIds[0], token: need, amount: intent.need, faceValue: faceOf(need) }]
  if (intent.carveAmount > 0 && intent.remainder && ids.remainderId) {
    parts.push({ tokenId: ids.remainderId, token: intent.remainder, amount: intent.carveAmount, faceValue: faceOf(intent.remainder) })
  }
  return { kind: 'split', parts }
}

const faceOf = (token: string) => creditableFaceValue(parseVoucherToken(token)).faceValue

/** Spent, and not into our outputs: the coupon left this wallet some other way. */
function gone(pubkey: string, intent: SplitIntent): SplitOutcome {
  forgetIntent(pubkey, intent.id)
  return { kind: 'refused', why: 'this coupon was already spent' }
}
