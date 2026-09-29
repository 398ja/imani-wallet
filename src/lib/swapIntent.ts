import type { TokenProof } from './voucherToken'
import type { BlindedOutput } from './walletSwap'

/**
 * What the wallet writes down before it asks the mint to swap.
 *
 * ## The ordering is the whole design
 *
 * A swap destroys the input proofs and returns BLIND signatures. Those are
 * worthless without the blinding factors, which exist only in the page that
 * generated them. So:
 *
 *   persist the intent  ->  POST /v1/swap  ->  unblind  ->  save proofs  ->  forget
 *
 * A page that navigates after the first step can rebuild the proofs from what it
 * wrote down. A page that navigates before it has asked the mint to burn real
 * money in exchange for something nobody can reconstruct.
 *
 * That second case IS imani-wallet#123. Under the old design the gateway held
 * the only copy and the escrow kept nothing, so a lost response lost the coupon.
 * Moving the swap into the wallet does not fix that on its own. This does.
 *
 * ## Why localStorage rather than IndexedDB
 *
 * IndexedDB is asynchronous, and this write must have LANDED before the request
 * goes out. An async write racing a navigation is precisely the failure being
 * prevented, so building on one would reintroduce it in a subtler form.
 * `localStorage` is synchronous: when `rememberSwapIntent` returns, it is on
 * disk. `pay.ts` stores pending sends the same way and for the same reason.
 *
 * The cost is honest and worth stating: these records hold the secrets and
 * blinding factors of live money in cleartext, in a store any script on the
 * origin can read. They are already no worse than the coupon tokens beside them,
 * they are short-lived, and `forgetSwapIntent` removes each one as soon as its
 * proofs are saved.
 *
 * See `docs/explanation/the-wallet-swaps-its-own-receives.md`.
 */

/**
 * A proof being spent as a swap input.
 *
 * Extends `TokenProof`, which is what `tokenProofs()` already returns, so a decoded
 * token flows into a receive without a re-declaration the two could drift apart on.
 */
export interface SwapInputProof extends TokenProof {
  /**
   * The NUT-11 witness unlocking this proof, when it is locked.
   *
   * Persisted because a NUT-19 replay must be BYTE-IDENTICAL: the mint
   * fingerprints the whole request, and a locked input without its witness is
   * both a different request and one the mint would refuse anyway. Dropping this
   * made replay silently unavailable for exactly the transfer case the design
   * cares most about.
   */
  witness?: string
}

/** Everything needed to finish, or to recover, one swap. */
export interface SwapIntent {
  /** Identifies this swap locally. A retry reuses it, so records cannot pile up. */
  swapId: string
  /** Which mint to ask. Recorded because by recovery time nothing else knows. */
  mintUrl: string
  keysetId: string
  /**
   * The inputs, verbatim, so the swap can be REPLAYED byte for byte. NUT-19
   * returns the original response for an identical request, which is the cheaper
   * of the two recoveries and the only one that works before the keyset is read.
   */
  inputs: SwapInputProof[]
  /**
   * The outputs, with their secrets and blinding factors.
   *
   * `B_` is what NUT-09 restore is keyed on, and `r` is what turns the mint's
   * answer into a spendable proof. A record missing either looks complete and
   * recovers nothing.
   */
  outputs: BlindedOutput[]
  /** When this was written, for the recovery window below. */
  at: number
}

// Same `imani-wallet:` prefix and pubkey scoping as pending sends, the profile
// and payment requests. An intent holds live secrets, so two accounts on one
// device must never read each other's.
const intentsKey = (pubkey: string) => `imani-wallet:swap-intents:${pubkey}`

/**
 * How long an unfinished swap is still worth trying to recover.
 *
 * Bounded by what the MINT can still answer. NUT-19's replay cache has a TTL
 * (900s on staging), and restore depends on the keyset still being served. An
 * hour is comfortably past the replay window while staying well inside any
 * plausible keyset rotation, so a record older than this is secrets with no
 * remaining use.
 *
 * Deliberately far shorter than `PENDING_SEND_LIFETIME_MS` (7 days): a pending
 * send waits on a gateway saga that may genuinely take days, while a swap waits
 * on one HTTP request that either answered or did not.
 */
export const SWAP_INTENT_LIFETIME_MS = 60 * 60 * 1000

/**
 * How many unfinished swaps to keep.
 *
 * A cap is necessary, and evicting on COUNT is the same hazard `pendingSwapIntents`
 * refuses to accept on a clock read: the record dropped may be the only copy of
 * the blinding factors for money the mint has already moved. `pay.ts` can afford
 * its identical cap because losing a pending-send record loses a status lookup;
 * losing a swap intent loses the coupon.
 *
 * So eviction takes EXPIRED records first and only warns if it has to touch a live
 * one. See `capIntents`.
 */
const MAX_INTENTS = 20

/** Is this shape usable for a recovery, rather than merely present? */
function isUsable(value: unknown): value is SwapIntent {
  if (!value || typeof value !== 'object') return false
  const intent = value as Partial<SwapIntent>
  return (
    typeof intent.swapId === 'string' &&
    typeof intent.mintUrl === 'string' &&
    typeof intent.keysetId === 'string' &&
    Array.isArray(intent.inputs) &&
    intent.inputs.length > 0 &&
    Array.isArray(intent.outputs) &&
    intent.outputs.length > 0 &&
    // Every output must carry the four fields recovery cannot do without. Without
    // `r` it cannot be unblinded, without `B_` it cannot be restored, and without
    // `amount` or `id` a returned signature cannot be matched to it. A record
    // missing any of them throws inside `unblindRestored` on every sweep, is
    // caught, kept, and retried until it expires, which reads as an unreachable
    // coupon rather than a malformed record.
    intent.outputs.every(
      (output) =>
        typeof output?.r === 'string' &&
        typeof output?.B_ === 'string' &&
        typeof output?.amount === 'number' &&
        typeof output?.id === 'string',
    ) &&
    typeof intent.at === 'number'
  )
}

/**
 * Every intent on disk, including ones too old to act on.
 *
 * Never throws. This is read on the receive path, so an exception over one
 * damaged record would stop a customer receiving a coupon that has nothing to do
 * with it. Entries are filtered INDIVIDUALLY, because each is a separate piece of
 * money and one unusable neighbour is no reason to discard the rest.
 */
export function loadSwapIntents(pubkey: string): SwapIntent[] {
  try {
    const raw = localStorage.getItem(intentsKey(pubkey))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isUsable)
  } catch {
    return []
  }
}

/**
 * The intents still worth recovering.
 *
 * Expiry decides what is OFFERED, never what is deleted. A record that outlived
 * the window is left on disk, because deleting a money-bearing record on a clock
 * read would destroy the only copy of a proof nobody has rebuilt yet, and a clock
 * can be wrong.
 */
export function pendingSwapIntents(pubkey: string): SwapIntent[] {
  const now = Date.now()
  return loadSwapIntents(pubkey).filter((intent) => now - intent.at < SWAP_INTENT_LIFETIME_MS)
}

/**
 * Trims to the cap, sacrificing records that can no longer be acted on first.
 *
 * Expired records are past the window in which the mint will still answer for
 * them, so they are the honest thing to lose. Only when there are more than
 * `MAX_INTENTS` LIVE records does this drop one that might still be recoverable,
 * and then it says so, because that is money going out of reach.
 */
function capIntents(intents: SwapIntent[]): SwapIntent[] {
  if (intents.length <= MAX_INTENTS) return intents

  const now = Date.now()
  const live = intents.filter((intent) => now - intent.at < SWAP_INTENT_LIFETIME_MS)
  if (live.length <= MAX_INTENTS) return live

  console.warn(
    '[swapIntent] more unfinished receives than the store holds, so the oldest is being ' +
      'dropped and its proofs may not be recoverable afterwards',
    { held: live.length, cap: MAX_INTENTS, dropping: live.length - MAX_INTENTS },
  )
  return live.slice(0, MAX_INTENTS)
}

function save(pubkey: string, intents: SwapIntent[]): void {
  if (intents.length === 0) localStorage.removeItem(intentsKey(pubkey))
  else localStorage.setItem(intentsKey(pubkey), JSON.stringify(intents))
}

/**
 * Writes an intent down, synchronously. Call this BEFORE the swap request.
 *
 * Keyed on `swapId`, so a retry of the same swap overwrites rather than
 * accumulating. Newest first, capped, matching `rememberPendingSend`.
 */
export function rememberSwapIntent(pubkey: string, intent: SwapIntent): void {
  const others = loadSwapIntents(pubkey).filter((held) => held.swapId !== intent.swapId)
  save(pubkey, capIntents([intent, ...others]))
}

/**
 * Drops an intent once its proofs are safely saved, and not before.
 *
 * The record exists only to rebuild proofs that might otherwise be lost. Once
 * they are stored it is a set of live secrets with no purpose, so removing it
 * promptly is part of the design rather than tidiness.
 */
export function forgetSwapIntent(pubkey: string, swapId: string): void {
  save(
    pubkey,
    loadSwapIntents(pubkey).filter((intent) => intent.swapId !== swapId),
  )
}
