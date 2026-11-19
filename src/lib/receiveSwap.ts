import { sha256 } from '@noble/hashes/sha2.js'

import { isKeysetInactive } from './mintRefusal'
import { isVoucherSecret, referencedDocuments } from './voucherToken'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'

import {
  forgetSwapIntent,
  pendingSwapIntents,
  rememberSwapIntent,
  type SwapInputProof,
} from './swapIntent'
import {
  blindOutputs,
  splitIntoDenominations,
  unblindOutputs,
  unblindRestored,
  type BlindSignatureResponse,
  type UnblindedProof,
} from './walletSwap'

/**
 * Receiving a coupon by swapping it at the mint ourselves.
 *
 * ## What this is FOR, and what it is not yet
 *
 * This is the MECHANISM intended to replace `POST /api/v1/wallet/receive`, where
 * the GATEWAY performs the swap. That one decision produced both open bugs: the
 * gateway chooses the output secrets, so it keeps a spendable copy of every coupon
 * received (imani-gateway-customer#133), and it is the only party holding the money
 * when a response is lost (imani-wallet#123).
 *
 * **Nothing calls this yet.** The live receive is still the gateway endpoint, so
 * neither bug is closed in a shipped build by this module alone. What remains is
 * the switch-over itself, replacing the `api.receive` call in
 * `tokenRedemption.js`, and a voucher receive, which needs the two swaps that
 * `voucherReissue.ts` provides the middle of. The transport and the token-level
 * entry point exist, so this comment no longer lists them: see the status table in
 * `imani-docs/wallet/explanation/the-wallet-swaps-its-own-receives.md`, which is kept current
 * because a comment listing "what is missing" goes stale the moment it is fixed.
 *
 * What it establishes: the wallet chooses the secrets and the blinding factors, so
 * the gateway is not in the path and there is nothing for it to hold.
 *
 * ## The order of operations IS the correctness argument
 *
 *   1. read the mint's active keyset
 *   2. blind the outputs
 *   3. PERSIST the intent, synchronously
 *   4. POST /v1/swap
 *   5. unblind
 *   6. hand the proofs to the caller
 *   7. forget the intent, once the caller has saved them
 *
 * Steps 1 and 2 touch nothing and can fail freely. From step 3 the wallet can
 * always finish, even if the page dies: the record holds the inputs for a NUT-19
 * replay and the blinded outputs for a NUT-09 restore. Anything after step 3 that
 * fails therefore KEEPS the record, because the swap may have succeeded and the
 * money may already have moved.
 *
 * `recoverInterruptedSwaps` is the other half, run when the wallet comes back.
 *
 * ## The transport is injected
 *
 * So the whole sequence can be driven against a fake mint, including the
 * failures that matter, which are exactly the ones a real mint will not produce
 * on request. `swapRecoveryProbe` covers the same flow against the live mint.
 *
 * See `imani-docs/wallet/explanation/the-wallet-swaps-its-own-receives.md`.
 */

/** A proof being received, with its witness when the coupon is locked. */
export interface ReceivableProof extends SwapInputProof {
  /**
   * The NUT-11 witness unlocking this proof, when it is locked to us.
   *
   * Supplied by the caller rather than signed here: signing needs the wallet's
   * key, and this module stays free of key access so it can be tested without
   * one. `witness.ts` is what produces these.
   */
  witness?: string
}

/** What the mint is asked, and what it answers. Injected so it can be faked. */
export interface MintTransport {
  activeKeysetId(mintUrl: string): Promise<string>
  keysetKeys(mintUrl: string, keysetId: string): Promise<Record<string, string>>
  swap(
    mintUrl: string,
    request: {
      inputs: ReceivableProof[]
      outputs: { amount: number; id: string; B_: string }[]
    },
  ): Promise<{ signatures: BlindSignatureResponse[] }>
  restore(
    mintUrl: string,
    outputs: { amount: number; id: string; B_: string }[],
  ): Promise<{
    /**
     * The subset of blinded messages the mint held a signature for, paired
     * positionally with `signatures`. Kept rather than discarded: a partial answer
     * is normal, and without these the wallet cannot tell WHICH outputs were
     * signed, so it could only take all or nothing.
     */
    outputs: { B_: string }[]
    signatures: BlindSignatureResponse[]
  }>
}

export interface ReceiveRequest {
  /** Whose wallet this is. Scopes the intent record. */
  pubkey: string
  mintUrl: string
  proofs: ReceivableProof[]
  /**
   * Swap a voucher's proofs into plain sats on purpose, giving up the coupon.
   *
   * Only `swapBack.ts` sets this, for a coupon the mint refused as redeemed in full
   * (cashu-mint#540): the coupon can no longer be spent as one, and the holder chose to
   * take its sats. Everywhere else a voucher is refused, because stripping one by
   * accident is a silent loss of everything the coupon promised.
   */
  releaseVoucher?: true
}

export interface ReceiveResult {
  swapId: string
  proofs: UnblindedProof[]
}

/**
 * Identifies a swap by WHAT IT SPENDS, rather than randomly.
 *
 * A random id would give a retried receive of the same coupon a second record,
 * and the first would then be recovered separately into proofs the wallet has
 * already saved. Deriving it from the inputs means a retry overwrites, which is
 * what `rememberSwapIntent` keys on.
 *
 * The input secrets are the natural identity: they are exactly what this swap
 * destroys, so two swaps with the same id are the same swap.
 */
function swapIdFor(proofs: ReceivableProof[]): string {
  const material = proofs.map((proof) => `${proof.id}:${proof.amount}:${proof.secret}`).join('|')
  return bytesToHex(sha256(utf8ToBytes(material))).slice(0, 32)
}

/**
 * The id a receive of these proofs is recorded under, so a caller can tag its own record with it
 * BEFORE the swap and find it again when the recovery sweep hands back that swap's proofs.
 */
export const receiveSwapId = swapIdFor

/** The outputs as the mint wants them: blinded messages, nothing else. */
function asMintOutputs(outputs: { amount: number; id: string; B_: string }[]) {
  return outputs.map((output) => ({ amount: output.amount, id: output.id, B_: output.B_ }))
}

/**
 * Receives a coupon by swapping its proofs for fresh ones only we can spend.
 *
 * Throws when the receive could not be completed. The intent is left on disk in
 * every case where the swap MIGHT have gone through, so the caller can retry and
 * a later sweep can finish it. The caller must save the returned proofs and then
 * call `settleReceive`.
 */
export async function receiveByOwnSwap(
  request: ReceiveRequest,
  transport: MintTransport,
): Promise<ReceiveResult> {
  const { pubkey, mintUrl, proofs } = request
  if (!mintUrl) throw new Error('cannot receive without a mint URL')
  if (proofs.length === 0) throw new Error('cannot receive with no proofs')

  // Vouchers are refused here, loudly, rather than handled badly.
  //
  // This path generates RANDOM output secrets, which is correct for plain ecash
  // and destroys a voucher. A voucher's secret carries its id, face value, lock
  // key, issuer signature and warrant, so swapping one into a random secret would
  // hand back proofs of the right SATS with no coupon attached: the face value,
  // the warrant and the issuer's attestation all silently gone. The customer
  // would hold ecash worth a fraction of the coupon they were paid.
  //
  // Doing it properly needs the issuer to sign each fresh secret, which is the
  // one place the design keeps the gateway (see the explanation doc). Until that
  // endpoint exists a voucher receive must keep using the old path, so this
  // refuses instead of failing quietly or corrupting money.
  const voucherInput = proofs.find((proof) => isVoucherSecret(proof.secret))
  if (voucherInput && request.releaseVoucher !== true) {
    throw new Error(
      'cannot receive a voucher by wallet-side swap yet: its fresh secret needs the ' +
        'issuer signature, so this path would strip the voucher and its warrant',
    )
  }

  // A by-reference voucher input without its document can never be swapped (the mint needs it in
  // `vouchers`). Refused here, before an intent is written for a request that cannot succeed.
  referencedDocuments(proofs)

  const total = proofs.reduce((sum, proof) => sum + proof.amount, 0)
  // `splitIntoDenominations` refuses a non-positive total, but reaching it via
  // this path would mean an intent had already been written for a swap that can
  // never be made. Check before anything is recorded.
  if (!Number.isInteger(total) || total <= 0) {
    throw new Error(`cannot receive a non-positive amount: ${total}`)
  }

  // Before anything is written. A failure here has spent nothing and recorded
  // nothing, so it is an ordinary retryable error.
  const swapId = swapIdFor(proofs)

  // A retry RESUMES the first attempt rather than starting a new one, and this is
  // the difference between a recoverable interruption and permanent loss.
  //
  // The intent is keyed on the inputs, so a retry of the same coupon finds the
  // record the first attempt wrote. Blinding fresh outputs here and overwriting
  // would discard the only copy of the `r` values for the outputs the mint may
  // ALREADY have signed. The second swap is then refused as "already spent", the
  // next sweep restores against the NEW blinded messages, the mint returns nothing
  // for them, and that reads as "never signed, nothing was spent" and deletes the
  // record. The money becomes unreachable for ever, with an INFO log saying it was
  // fine. Found by a security reviewer, who proved it with a test.
  //
  // Reusing the existing outputs also makes the retry a byte-identical request,
  // which is what lets NUT-19 return the original response instead of refusing.
  const existing = pendingSwapIntents(pubkey).find((intent) => intent.swapId === swapId)
  if (existing) {
    console.info('[receiveSwap] resuming an earlier attempt at this receive, not restarting it', {
      swapId,
    })
  }

  const keysetId = existing?.keysetId ?? (await transport.activeKeysetId(mintUrl))
  // The mint's ACTIVE keyset, deliberately, not the input's. Receiving into a
  // retired keyset produces proofs whose keys the mint may stop serving, which
  // is how a coupon becomes unspendable weeks after it was safely received.
  const outputs = existing?.outputs ?? blindOutputs(splitIntoDenominations(total), keysetId)

  // The line the design turns on. After this the wallet can always finish.
  rememberSwapIntent(pubkey, {
    ...intentFor(request, swapId, keysetId),
    // The witness and the voucher document are carried in the inputs (see `intentFor`). A
    // NUT-19 replay must be byte-identical, and a locked input without its witness is both a
    // different request and one the mint would refuse. Likewise the document of a
    // by-reference input (cashu-voucher#64), which the replay carries in `vouchers`.
    outputs,
  })

  try {
    let swapped: { signatures: BlindSignatureResponse[] }
    try {
      swapped = await transport.swap(mintUrl, {
        inputs: proofs,
        outputs: asMintOutputs(outputs),
      })
    } catch (failure) {
      // Only a refusal of the SWAP ITSELF with 12002 qualifies, and a thrown swap carries no
      // signatures. A failure after any signature came back (unblinding, the keys) is outside
      // this catch, so it can never lead to re-blinding over outputs the mint may have signed.
      if (!isKeysetInactive(failure)) throw failure
      return await reblindAfterRotation(request, transport, swapId, keysetId)
    }
    const keys = await transport.keysetKeys(mintUrl, keysetId)
    const unblinded = unblindOutputs(outputs, swapped.signatures, keys)
    return { swapId, proofs: unblinded }
  } catch (failure) {
    // The intent STAYS. From here the swap may have succeeded, so this record is
    // the only route back to money that has already moved. Said loudly because a
    // silent unfinished receive is how the loss in #110 went unnoticed.
    console.warn(
      '[receiveSwap] receive unfinished, so the swap may have gone through: intent kept for recovery',
      { swapId, mintUrl, reason: failure instanceof Error ? failure.message : String(failure) },
    )
    throw failure
  }
}

/**
 * Retries a receive whose outputs the mint refused as being on a retired keyset (#248).
 *
 * A receive resumed across a keyset rotation replays its stored outputs, as it must for a
 * NUT-19 byte-identical replay, and the mint then refuses them with `12002 keyset_inactive`
 * on every attempt. That refusal happens at validation, before any input is spent and with
 * no signature issued, so the stored blinding factors cannot be needed for anything: no
 * signature exists for them. They are dropped, the active keyset is read fresh, and the
 * receive is made again with new outputs.
 *
 * The swap id is kept. It is derived from the inputs, which have not changed, and callers
 * (swap back) tag their own record with it before the swap so the recovery sweep can match
 * the result. The new intent overwrites the old one under that id, which is the point: the
 * old outputs were never signed and must not be restored against.
 *
 * Done once. A second 12002 against the keyset the mint has just called active is not a
 * rotation, so it is thrown like any other refusal, keeping the (new) intent.
 */
async function reblindAfterRotation(
  request: ReceiveRequest,
  transport: MintTransport,
  swapId: string,
  staleKeysetId: string,
): Promise<ReceiveResult> {
  const { pubkey, mintUrl, proofs } = request
  const keysetId = await transport.activeKeysetId(mintUrl)
  console.info('[receiveSwap] the mint retired this receive’s keyset, re-blinding against the active one', {
    swapId,
    from: staleKeysetId,
    to: keysetId,
  })
  if (keysetId === staleKeysetId) {
    throw new Error(`the mint refused keyset ${keysetId} as inactive but still lists it as active`)
  }
  const total = proofs.reduce((sum, proof) => sum + proof.amount, 0)
  const outputs = blindOutputs(splitIntoDenominations(total), keysetId)
  rememberSwapIntent(pubkey, { ...intentFor(request, swapId, keysetId), outputs })

  const { signatures } = await transport.swap(mintUrl, { inputs: proofs, outputs: asMintOutputs(outputs) })
  const keys = await transport.keysetKeys(mintUrl, keysetId)
  return { swapId, proofs: unblindOutputs(outputs, signatures, keys) }
}

/** The parts of an intent that do not depend on the outputs. */
function intentFor(request: ReceiveRequest, swapId: string, keysetId: string) {
  return {
    swapId,
    mintUrl: request.mintUrl,
    keysetId,
    inputs: request.proofs.map(({ amount, id, secret, C, witness, document }) => ({
      amount,
      id,
      secret,
      C,
      ...(witness === undefined ? {} : { witness }),
      ...(document === undefined ? {} : { document }),
    })),
    at: Date.now(),
  }
}

/**
 * Drops the record for a receive whose proofs the caller has now saved.
 *
 * Separate from `receiveByOwnSwap` on purpose. Forgetting inside it would clear
 * the record while the proofs were still only in memory, which is the window this
 * whole mechanism exists to cover.
 */
export function settleReceive(pubkey: string, swapId: string): void {
  forgetSwapIntent(pubkey, swapId)
}

/**
 * Finishes every swap that was interrupted, by asking the mint what it signed.
 *
 * Uses NUT-09 restore, NOT a second swap. The inputs of an interrupted swap are
 * already burnt, so re-swapping would either be refused or, worse, succeed as a
 * second spend. Restore is a lookup keyed on the blinded messages, which is
 * exactly why the intent stores them.
 *
 * A restore that returns nothing means the mint never signed those outputs, so
 * the swap never happened and the coupon can simply be received again. That
 * record is dropped rather than retried for ever (#127).
 *
 * Failures are per-intent. Each one is a separate piece of somebody's money, so
 * one unreachable mint must not abandon the rest.
 */
export async function recoverInterruptedSwaps(
  pubkey: string,
  transport: MintTransport,
): Promise<ReceiveResult[]> {
  const recovered: ReceiveResult[] = []

  for (const intent of pendingSwapIntents(pubkey)) {
    try {
      const restored = await transport.restore(intent.mintUrl, asMintOutputs(intent.outputs))

      if (restored.signatures.length === 0) {
        console.info(
          '[receiveSwap] the mint never signed this swap, so nothing was spent: dropping it',
          { swapId: intent.swapId },
        )
        forgetSwapIntent(pubkey, intent.swapId)
        continue
      }

      const keys = await transport.keysetKeys(intent.mintUrl, intent.keysetId)
      // Paired by `B_`, taking whatever the mint has. A PARTIAL answer is a state
      // the mint creates deliberately: a swap that fails partway still spends its
      // inputs and leaves the earlier outputs signed and recoverable only here.
      // Insisting on a complete answer would abandon those signatures, which is
      // money the wallet owns and has no other route to.
      const { proofs, unmatched } = unblindRestored(intent.outputs, restored, keys)
      if (unmatched.length > 0) {
        console.warn(
          '[receiveSwap] the mint signed only part of this swap, taking what it did sign',
          {
            swapId: intent.swapId,
            recovered: proofs.length,
            neverSigned: unmatched.length,
            recoveredAmount: proofs.reduce((sum, proof) => sum + proof.amount, 0),
          },
        )
      }
      recovered.push({ swapId: intent.swapId, proofs })
      // Safe to forget: the proofs are in the returned array and the caller saves
      // them. A caller that drops them can still restore again, because restore
      // is idempotent for as long as the mint serves the keyset.
      forgetSwapIntent(pubkey, intent.swapId)
      console.info('[receiveSwap] recovered an interrupted receive', {
        swapId: intent.swapId,
        amount: proofs.reduce((sum, proof) => sum + proof.amount, 0),
      })
    } catch (failure) {
      // KEPT, so a later sweep tries again. A mint that is unreachable now is
      // not a coupon that is gone.
      console.warn('[receiveSwap] could not recover this receive yet, keeping it', {
        swapId: intent.swapId,
        reason: failure instanceof Error ? failure.message : String(failure),
      })
    }
  }

  return recovered
}
