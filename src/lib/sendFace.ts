/**
 * What a send from one coupon really takes, before it is sent (the NGN overcharge).
 *
 * A coupon part is a whole number of sats and a sat cannot be divided. Where one sat is worth less
 * than a minor unit (EUR, USD: about 0.08 c) any amount can be sent exactly. Where it is worth more
 * (NGN at about 128 kobo per sat, KES at about 12 c) it cannot: gateway-core sends the fewest sats
 * worth at least the request, which are worth up to a sat more, and reports the change those sats
 * leave (`VoucherSplitCalculator`, `SplitFaces`). The customer's balance then falls by that figure,
 * not by the request. This mirrors the gateway's rule so the confirmation screen and the history
 * can say what really leaves, and so the transfer signature commits to the sats really sent.
 *
 * Mirrors, and must stay in step with:
 *   - `CouponRate` (exact value of `sats` as `sats * face / mintedSats` when the coupon's minted
 *     sats are provable from its signed face and ratio, else on the ratio as written);
 *   - `VoucherSplitCalculator.previewSplit` (PROPORTIONAL: fewest sats worth the request, change
 *     restated to its sats' shown value once it is more than one unit short; other strategies:
 *     the configured FLOOR).
 *
 * Pure: no network, no storage. Never throws.
 */
import { parseVoucherToken, type ParsedVoucherToken } from './voucherToken'

export interface SendFace {
  /** Minor units that leave the sender's coupon: the request, or up to a sat more. */
  sendFace: number
  /** Minor units the change is worth (0 on a full send). */
  keepFace: number
  /** Sats in the part sent. */
  sendSats: number
  /** Whether the whole coupon goes. */
  fullSend: boolean
}

/** Above this, neighbouring sat counts can share one double ratio (CouponRate.MAX_PROVABLE_SATS). */
const MAX_PROVABLE_SATS = 2 ** 52

type Rounding = 'floor' | 'halfUp' | 'ceil'

/** A coupon's rate, as `CouponRate.of(signedFace, ratio)` reads it. */
class Rate {
  private constructor(
    private readonly face: bigint,
    private readonly minted: bigint,
    private readonly ratio: number,
  ) {}

  static of(signedFace: number, ratio: number): Rate | null {
    if (!(ratio > 0) || !Number.isFinite(ratio)) return null
    const plain = new Rate(0n, 0n, ratio)
    if (!(signedFace > 0) || !Number.isSafeInteger(signedFace)) return plain
    const quotient = signedFace / ratio
    if (!Number.isFinite(quotient) || quotient < 0.5 || quotient >= MAX_PROVABLE_SATS) return plain
    const sats = Math.round(quotient)
    const signs = (s: number) => s > 0 && signedFace / s === ratio
    const proven = signs(sats) && !signs(sats - 1) && !signs(sats + 1)
    return proven ? new Rate(BigInt(signedFace), BigInt(sats), ratio) : plain
  }

  private exact(): boolean {
    return this.minted > 0n
  }

  /** Value of `sats`, rounded as asked. */
  value(sats: number, rounding: Rounding): number {
    if (this.exact()) return Number(divide(BigInt(sats) * this.face, this.minted, rounding))
    const v = sats * this.ratio
    return rounding === 'floor' ? Math.floor(v) : rounding === 'ceil' ? Math.ceil(v) : Math.floor(v + 0.5)
  }

  /** CouponRate.fewestSatsWorth: the fewest sats whose floor value is at least `face`. */
  fewestSatsWorth(face: number): number {
    let sats = this.exact()
      ? Number(divide(BigInt(face) * this.minted, this.face, 'ceil'))
      : Math.ceil(face / this.ratio)
    while (this.value(sats, 'floor') < face) sats += 1
    return sats
  }

  /** CouponRate.satsFor, or null on a coupon whose minted sats are not proven. */
  satsFor(face: number, rounding: Rounding): number | null {
    if (!this.exact()) return null
    return Number(divide(BigInt(face) * this.minted, this.face, rounding))
  }
}

function divide(n: bigint, d: bigint, rounding: Rounding): bigint {
  const q = n / d
  const r = n % d
  if (r === 0n) return q
  if (rounding === 'floor') return q
  if (rounding === 'ceil') return q + 1n
  return 2n * r >= d ? q + 1n : q
}

/**
 * What sending `amount` minor units from this coupon token takes, or undefined when the token is
 * not a readable voucher or the gateway would refuse the split (more than the coupon, a change
 * worth nothing). Undefined means "no better answer than the request".
 */
export function sendFaceOf(token: string | undefined, amount: number): SendFace | undefined {
  if (!token || !Number.isSafeInteger(amount) || amount <= 0) return undefined
  let parsed: ParsedVoucherToken
  try {
    parsed = parseVoucherToken(token)
  } catch {
    return undefined
  }
  return splitOf(parsed, amount)
}

/** The same, on a token already parsed. Exported for `signedPartOf`. */
export function splitOf(parsed: ParsedVoucherToken, amount: number): SendFace | undefined {
  const v = parsed.voucher
  const rate = Rate.of(v.faceValue, v.issuanceRatio)
  const available = parsed.tokenAmount
  if (!rate || !(available > 0) || !Number.isSafeInteger(amount) || amount <= 0) return undefined
  const parent = rate.value(available, 'halfUp')
  const proportional = String(v.backingStrategy ?? '').toUpperCase() === 'PROPORTIONAL'

  let sendSats: number
  if (proportional) {
    sendSats = rate.fewestSatsWorth(amount)
    // The double till (`creditsAtLeast`): floor(sats * ratio) in IEEE doubles.
    while (Math.floor(sendSats * v.issuanceRatio) < amount) sendSats += 1
    if (sendSats > available && amount <= parent) sendSats = available
  } else {
    sendSats = rate.satsFor(amount, 'floor') ?? Math.floor(amount / v.issuanceRatio)
  }
  if (sendSats > available) return undefined

  let fullSend = sendSats >= available
  let keepSats = available - sendSats
  let sendFace = fullSend ? parent : Math.min(rate.value(sendSats, 'halfUp'), parent)
  let keepFace = fullSend || keepSats === 0 ? 0 : Math.max(0, parent - sendFace)
  if (proportional && !fullSend) {
    sendFace = amount
    keepFace = Math.max(0, parent - amount)
    const keepShown = Math.min(rate.value(keepSats, 'halfUp'), keepFace)
    if (keepFace - keepShown > 1) {
      keepFace = keepShown
      sendFace = parent - keepShown
    }
  }
  if (!fullSend && keepFace === 0 && keepSats > 0) {
    if (amount !== parent) return undefined
    sendSats = available
    keepSats = 0
    sendFace = parent
    fullSend = true
  }
  return { sendFace, keepFace, sendSats, fullSend }
}

/**
 * The confirmation screen's line when a send takes more than its amount, or null when it takes
 * exactly the amount. Said before the tap, because afterwards it reads as a missing few kobo.
 */
export function debitNote(amount: number, debit: number, format: (minor: number) => string): string | null {
  if (!(debit > amount)) return null
  return (
    `Your vouchers cannot make exactly ${format(amount)}: the nearest they can send is ` +
    `${format(debit)}, so ${format(debit - amount)} more leaves your balance and goes to the recipient.`
  )
}
