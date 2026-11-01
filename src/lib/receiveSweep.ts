/**
 * Finishing receives that were interrupted after the mint had already signed.
 *
 * ## The money this is about
 *
 * A receive swaps somebody's proofs for fresh ones only this wallet can spend. If
 * the page dies between the mint signing and the wallet saving, the proofs exist
 * and are spendable by nobody: the sender's are burnt, and ours were never written
 * down. That is imani-wallet#123, and it is the reason the swap records its intent
 * before it asks.
 *
 * ## Why this takes a `save` callback rather than persisting for itself
 *
 * `recoverInterruptedSwaps` returns the recovered proofs and then FORGETS the
 * intent, on the documented understanding that the caller saves them. So a caller
 * that merely counts the result destroys the only record of money it then drops.
 * The first draft of this module did exactly that, which is worth recording
 * because the mistake reads as harmless: the function returned a plausible number
 * and logged a success.
 *
 * Making the caller supply `save` means that cannot compile away. There is no
 * arrangement of this module that recovers proofs and forgets to hand them over,
 * because handing them over is the only thing it does with them.
 *
 * ## Where the failure handling actually lives
 *
 * Not here. `recoverInterruptedSwaps` catches per intent and keeps the record, so
 * an unreachable mint yields an empty array rather than a rejection and the next
 * start-up tries again. This module had an outer try/catch for that, and a
 * mutation check showed it was unreachable: making it rethrow changed nothing,
 * because nothing ever reaches it.
 *
 * It is gone rather than kept "just in case". Dead defensive code reads as a
 * handled failure mode and is worse than none, because the next reader believes
 * the failure is covered here instead of looking where it is.
 *
 * What remains is the save loop, which genuinely can fail, and does so per swap
 * for the same reason: each intent is a separate piece of somebody's money.
 */

import { recoverInterruptedSwaps, type ReceiveResult } from './receiveSwap'
import { createMintTransport } from './mintTransport'

/**
 * Takes custody of proofs recovered from an interrupted receive.
 *
 * Called once per recovered swap. Throwing is reported and does not stop the
 * others, but the proofs for that swap are then lost: the intent has already been
 * forgotten by the time this runs, because the mint's answer is what made it
 * redundant. An implementation should therefore write before it does anything
 * that can fail.
 */
export type SaveRecovered = (recovered: ReceiveResult) => Promise<void> | void

/**
 * Recover every receive this wallet left unfinished, handing each to `save`.
 *
 * Returns the number of swaps whose proofs were recovered AND saved. Zero is the
 * ordinary answer and is not an error: it means either nothing was interrupted, or
 * the mint never signed the outputs, in which case nothing was spent and the
 * coupon can simply be received again.
 *
 * Never rejects.
 */
export async function sweepInterruptedReceives(
  pubkey: string,
  save: SaveRecovered,
): Promise<number> {
  const recovered = await recoverInterruptedSwaps(pubkey, createMintTransport())

  let saved = 0
  for (const swap of recovered) {
    try {
      await save(swap)
      saved += 1
    } catch (cannotSave) {
      // ERROR, and the loudest line in this file. The intent is already gone, so
      // these proofs have no second route: they are spendable, owned by this
      // wallet, and now recorded nowhere. The amount is logged because it is the
      // only remaining trace of what was lost.
      console.error('[receiveSweep] recovered proofs could not be saved and are now unrecorded', {
        swapId: swap.swapId,
        amount: swap.proofs.reduce((sum, proof) => sum + proof.amount, 0),
        reason: cannotSave instanceof Error ? cannotSave.message : String(cannotSave),
      })
    }
  }

  // WARN, not INFO. Reaching here means money was stranded and has been
  // retrieved, which is the system working as designed and also a sign that
  // something interrupted a receive. An operator seeing this regularly is
  // seeing a symptom worth chasing.
  if (saved > 0) {
    console.warn(
      '[receiveSweep] recovered proofs from receives that were interrupted after the mint signed',
      { count: saved },
    )
  }
  return saved
}
