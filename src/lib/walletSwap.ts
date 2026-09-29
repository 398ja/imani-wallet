import { blindMessage, constructProofFromPromise, serializeProof } from '@cashu/crypto/modules/client'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, randomBytes } from '@noble/hashes/utils'

/**
 * The wallet's own half of a swap: choose the outputs, blind them, unblind the
 * mint's answer.
 *
 * ## Why this exists
 *
 * The gateway used to do this. That is the single decision behind two bugs:
 * it kept a spendable copy of every coupon anyone received
 * (imani-gateway-customer#133), and when a receive response was lost it was the
 * only party holding the money (imani-wallet#123).
 *
 * Both follow from one fact. A proof is spendable by whoever knows its secret
 * and can compute `C`, and `C = C_ - rK` needs the blinding factor `r`. So
 * whoever generates the secrets and the blinding factors owns the money. Moving
 * that generation into the wallet is not a mitigation of those bugs, it removes
 * the condition they both depend on.
 *
 * It also means a gateway that helps with a voucher receive is doing a signing
 * step rather than holding custody: it may see an output secret, and it still
 * cannot spend the proof, because `r` never leaves here.
 *
 * See `docs/explanation/the-wallet-swaps-its-own-receives.md`.
 *
 * ## What this module is not
 *
 * No network calls and no storage. It is the arithmetic either side of the
 * request, kept separate so it can be tested without a mint and so the caller
 * owns the one thing that must be durable: `r` and the secrets, written down
 * before the request goes out. A lost response is only recoverable because the
 * caller still holds those.
 */

/** One output the wallet has blinded and is about to ask the mint to sign. */
export interface BlindedOutput {
  amount: number
  /** The keyset the mint should sign under. */
  id: string
  /** The blinded message, compressed hex. This is all the mint is given. */
  B_: string
  /**
   * The secret this output will carry once unblinded, as the text the mint
   * hashes. Must be persisted before the request: it is half of the proof.
   */
  secret: string
  /**
   * The blinding factor, hex.
   *
   * **The one value that must never be sent anywhere.** Without it the mint's
   * answer cannot be turned into a spendable proof, by us or by anybody who
   * intercepted it. With it, and only with it, a lost response is recoverable.
   */
  r: string
}

/** A proof the wallet built from the mint's blind signature. */
export interface UnblindedProof {
  amount: number
  id: string
  secret: string
  /** The unblinded signature, compressed hex. */
  C: string
}

/** A blind signature as the mint returns it. */
export interface BlindSignatureResponse {
  id: string
  amount: number
  C_: string
}

/**
 * An amount as the powers of two that sum to it, largest first.
 *
 * The mint holds one key per power-of-two denomination and signs one blinded
 * message per proof, so an amount has to be expressed as a set of those. The
 * binary expansion is the fewest proofs that add up, which matters because every
 * extra proof is another signature to request, store and later spend.
 */
export function splitIntoDenominations(amount: number): number[] {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`amount must be a positive integer, got ${amount}`)
  }
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`amount is too large to split exactly: ${amount}`)
  }
  const parts: number[] = []
  // `amount & bit` would be wrong here, and silently so. Bitwise operators coerce
  // to int32, so any amount at or above 2^32 loses its high bits: 2^32 + 7 splits
  // as [1, 2, 4], which passes every guard downstream because the mint signs
  // exactly what it was asked for. The result is billions of sats burnt for seven.
  // Division keeps full precision across the whole safe-integer range.
  for (let bit = 1; bit <= amount; bit *= 2) {
    if (Math.floor(amount / bit) % 2 === 1) parts.push(bit)
  }
  return parts.reverse()
}

/**
 * Blind one output per denomination, keeping the secrets and blinding factors.
 *
 * The secret is a 32-byte random value rendered as HEX, and the hex matters. The
 * mint hashes the secret STRING to derive `Y`, so handing it raw bytes produces a
 * `Y` the two sides disagree about. `burnProbe.test.ts` records that costing an
 * hour to find, which is the kind of thing worth paying for once.
 */
export function blindOutputs(denominations: number[], keysetId: string): BlindedOutput[] {
  if (!keysetId) throw new Error('cannot blind outputs without a keyset id')
  if (denominations.length === 0) throw new Error('a swap needs at least one output')

  return denominations.map((amount) => {
    const secret = bytesToHex(randomBytes(32))
    const blinded = blindMessage(new TextEncoder().encode(secret), undefined)
    return {
      amount,
      id: keysetId,
      B_: blinded.B_.toHex(true),
      secret,
      r: blinded.r.toString(16).padStart(64, '0'),
    }
  })
}

/**
 * The mint's blind signatures, plus the factors we kept, as spendable proofs.
 *
 * Pairs signatures with outputs POSITIONALLY, which is what NUT-03 specifies, so
 * the guards below are not defensive noise. A count or amount that does not line
 * up means this is not an answer to the request we made, and pairing on past it
 * would mint a proof claiming an amount its signature does not cover. The mint
 * would then refuse it at the next spend, with nothing left to explain why.
 *
 * For a SWAP that positional rule is right. NUT-09 restore is different: it omits
 * the messages it has no signature for, so its answer is a SUBSET and must be
 * paired by `B_` instead. Use `unblindRestored` for that.
 */
export function unblindOutputs(
  outputs: BlindedOutput[],
  signatures: BlindSignatureResponse[],
  keysetKeys: Record<string, string>,
): UnblindedProof[] {
  if (signatures.length !== outputs.length) {
    throw new Error(
      `mint returned ${signatures.length} signature(s) for ${outputs.length} output(s)`,
    )
  }

  return outputs.map((output, index) => {
    const signature = signatures[index]
    if (signature.amount !== output.amount) {
      throw new Error(
        `mint signed amount ${signature.amount} for an output of ${output.amount}`,
      )
    }
    // The keyset must match too. A signature returned under a different keyset is
    // the same class of wrong answer as a mismatched amount, and it is the one
    // field that used to go unchecked: the proof took the OUTPUT's id, so a
    // signature made under keyset B would be recorded against keyset A and fail
    // at the next spend with nothing to explain why.
    if (signature.id !== output.id) {
      throw new Error(
        `mint signed under keyset ${signature.id} for an output of keyset ${output.id}`,
      )
    }
    const mintKey = keysetKeys[String(output.amount)]
    if (!mintKey) {
      throw new Error(`keyset has no public key for amount ${output.amount}`)
    }
    return buildProof(output, signature, mintKey)
  })
}

/** What a restore recovered, and which outputs the mint had never signed. */
export interface RestoredProofs {
  proofs: UnblindedProof[]
  /** The outputs the mint held no signature for. Still ours to retry or abandon. */
  unmatched: BlindedOutput[]
}

/**
 * A NUT-09 restore answer as proofs, pairing by `B_` rather than by position.
 *
 * Restore returns only the messages it HAS signatures for, alongside those
 * signatures, so a partial answer is normal rather than a fault. The mint creates
 * that state deliberately: a swap that fails partway through still spends its
 * inputs and leaves the earlier outputs durably signed, recoverable only here.
 *
 * So this must take what it can and report the rest. An earlier version reused
 * `unblindOutputs`, whose positional count check threw on any partial answer,
 * which abandoned every signature the mint really had issued. That is money the
 * wallet owns and cannot otherwise reach.
 */
export function unblindRestored(
  outputs: BlindedOutput[],
  restored: { outputs: { B_: string }[]; signatures: BlindSignatureResponse[] },
  keysetKeys: Record<string, string>,
): RestoredProofs {
  if (restored.outputs.length !== restored.signatures.length) {
    throw new Error(
      `restore paired ${restored.outputs.length} output(s) with ` +
        `${restored.signatures.length} signature(s)`,
    )
  }

  const signatureFor = new Map<string, BlindSignatureResponse>()
  restored.outputs.forEach((output, index) => {
    signatureFor.set(output.B_.toLowerCase(), restored.signatures[index])
  })

  const proofs: UnblindedProof[] = []
  const unmatched: BlindedOutput[] = []

  for (const output of outputs) {
    const signature = signatureFor.get(output.B_.toLowerCase())
    if (!signature) {
      unmatched.push(output)
      continue
    }
    if (signature.amount !== output.amount) {
      throw new Error(
        `restore returned amount ${signature.amount} for an output of ${output.amount}`,
      )
    }
    if (signature.id !== output.id) {
      throw new Error(
        `restore returned keyset ${signature.id} for an output of keyset ${output.id}`,
      )
    }
    const mintKey = keysetKeys[String(output.amount)]
    if (!mintKey) {
      throw new Error(`keyset has no public key for amount ${output.amount}`)
    }
    proofs.push(buildProof(output, signature, mintKey))
  }

  return { proofs, unmatched }
}

/** One blinded output plus the mint's signature over it, as a spendable proof. */
function buildProof(
  output: BlindedOutput,
  signature: BlindSignatureResponse,
  mintKey: string,
): UnblindedProof {
  // `@cashu/crypto` bundles its own @noble/curves, so its Point type is nominally
  // different from the one this repo resolves even though the runtime values are
  // identical. Cast at this seam only, as burnProbe does. `as unknown as` rather
  // than `as never`: never is assignable to everything, so it would also silence a
  // real signature change on a future @cashu/crypto bump.
  const point = (hex: string) =>
    secp256k1.Point.fromHex(hex) as unknown as Parameters<typeof constructProofFromPromise>[3]
  const proof = constructProofFromPromise(
    { id: signature.id, amount: signature.amount, C_: point(signature.C_) },
    BigInt('0x' + output.r),
    new TextEncoder().encode(output.secret),
    point(mintKey),
  )
  return {
    amount: output.amount,
    id: output.id,
    secret: output.secret,
    C: serializeProof(proof).C,
  }
}
