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

/** A proof being spent as a swap input, in the shape the mint expects. */
export interface SwapInputProof {
  amount: number
  id: string
  secret: string
  C: string
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

/** How many unfinished swaps to keep. Matches the pending-send cap. */
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
    Array.isArray(intent.outputs) &&
    intent.outputs.length > 0 &&
    // Every output must carry the two fields recovery cannot do without. An
    // output missing `r` cannot be unblinded and one missing `B_` cannot be
    // restored, so a record containing either is not a usable record.
    intent.outputs.every(
      (output) => typeof output?.r === 'string' && typeof output?.B_ === 'string',
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
  save(pubkey, [intent, ...others].slice(0, MAX_INTENTS))
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
