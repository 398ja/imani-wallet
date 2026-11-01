/**
 * Which proof of a coupon to split, and into what, so a checkout part of exactly `amount` can be made
 * (#402). Pure: no network, no storage.
 *
 * ## The problem
 *
 * A checkout part is carved from a coupon's whole proofs (`checkoutCarve.ts`). A €10 coupon whose
 * proofs are worth €8, €1 and €1 cannot make €3.37: no subset adds up to it. The bearer split
 * (gateway-customer `POST /vouchers/bearer-split`) burns ONE bearer proof and signs it back as 2..20
 * parts locked to the holder, each a power of two of sats with its own `max_sats`. So: keep a subset
 * `S` of the other proofs whole, and split one proof `P` into the sats that make the rest
 * (`need = amount − face(S)`) and the sats that are left over.
 *
 * ## Whole cents only
 *
 * A proof's face share is `sats × issuance_ratio`. A part is minted from one blinded output, so it is
 * a power of two of sats, and a part whose share is a fraction of a cent cannot be offered as one
 * (the code store checks every part against its credited face value, rounded). So `P`, every part of
 * it, and therefore `need` and the leftover, must all be whole minor units. A coupon whose ratio makes
 * that impossible for `amount` is simply not split.
 */
import { faceSharesOf } from './faceSplit'
import { encodePlainTokenV4 } from './plainToken'
import { exactFaceValue, parseVoucherToken, tokenProofs, voucherOfSecret, type TokenProof } from './voucherToken'

/** Contract §3 and the gateway's own `MAX_PARTS`. */
const MAX_SPLIT_PARTS = 20

export interface SplitPlan {
  /** The bearer proof to burn. */
  proof: TokenProof
  /** The other proofs, as a token (the coupon's remainder), or null when `proof` was the only one. */
  remainder: string | null
  /** What the remainder must give the code, carved from its whole proofs (0: nothing). */
  carveAmount: number
  /** Minor units the split's first `needCount` parts make. */
  need: number
  /** The parts' sats, largest first within each group: the first `needCount` make `need`. */
  sats: number[]
  needCount: number
}

const powersOf = (n: number): number[] => {
  const out: number[] = []
  for (let bit = 2 ** Math.floor(Math.log2(n)); bit >= 1; bit /= 2) {
    if (n >= bit) {
      out.push(bit)
      n -= bit
    }
  }
  return out
}

/** The face shares the remainder's whole proofs can sum to (0 included), up to `max`. */
function carvableSums(remainder: string | null, max: number): number[] {
  if (!remainder) return [0]
  const shares = faceSharesOf(remainder)
  if (!shares) return [0]
  let sums = new Set<number>([0])
  for (const share of shares.values()) {
    if (share <= 0) continue
    const next = new Set(sums)
    for (const s of sums) if (s + share <= max) next.add(s + share)
    sums = next
  }
  return [...sums].sort((a, b) => b - a)
}

/**
 * The split that makes `amount` from this coupon, or null when none can. Prefers keeping the most
 * value in whole proofs (fewest new parts), and the largest proof to split.
 */
export function planSplit(token: string, amount: number): SplitPlan | null {
  if (!Number.isSafeInteger(amount) || amount <= 0) return null
  let parsed: ReturnType<typeof parseVoucherToken>
  let proofs: TokenProof[]
  try {
    parsed = parseVoucherToken(token)
    proofs = tokenProofs(token)
  } catch {
    return null
  }
  const ratio = parsed.voucher.issuanceRatio
  if (!(ratio > 0)) return null
  const mintUrl = parsed.mintUrl
  const plain = (ps: TokenProof[]) =>
    encodePlainTokenV4(mintUrl, 'sat', ps.map((p) => ({ amount: p.amount, id: p.id, secret: p.secret, C: p.C, ...(p.dleq ? { dleq: p.dleq } : {}) })))
  const order = [...proofs].sort((a, b) => b.amount - a.amount)
  for (const proof of order) {
    // Bearer only (the route's input), with its amount proof (the route proves the burn by it).
    const v = voucherOfSecret(proof.secret)
    if (!v || v.lockKey || !proof.dleq) continue
    let share: number
    try {
      share = exactFaceValue(parseVoucherToken(plain([proof])))
    } catch {
      continue
    }
    if (!(Math.round(share) > 0)) continue
    const whole = Math.round(share)
    const others = proofs.filter((p) => p !== proof)
    const remainder = others.length ? plain(others) : null
    // The code store credits a deposited part round(total sats × ratio) (checkout-codes
    // CreditableFaceValue, the wallet's creditableFaceValue), rounded once over the part's sats. Real
    // coupons are issued at the day's rate (staging: 1 sat = 0.0694 c), where no power of two of sats
    // is a whole cent: the first version demanded exact cents and so never split one (staging
    // 2026-11-01). So: the need parts' sats, together, must round to exactly `need`.
    const credit = (s: number) => Math.round(s * ratio)
    for (const kept of carvableSums(remainder, amount)) {
      const need = amount - kept
      if (need <= 0 || need >= whole) continue
      const parts = partsMaking(need, proof.amount, ratio, credit)
      if (!parts) continue
      return { proof, remainder, carveAmount: kept, need, sats: [...parts.need, ...parts.rest], needCount: parts.need.length }
    }
  }
  return null
}

/**
 * A sat count `n` whose value rounds to exactly `need` (as the code store credits it), split into
 * powers of two (one blinded output each), with the rest of `total` as powers of two too, within the
 * gateway's part limit. Fewest parts first. Null when none.
 */
function partsMaking(need: number, total: number, ratio: number, credit: (sats: number) => number): { need: number[]; rest: number[] } | null {
  if (!(ratio > 0)) return null
  const centre = Math.round(need / ratio)
  const span = Math.max(4, Math.ceil(1 / ratio) + 2)
  let best: { need: number[]; rest: number[] } | null = null
  for (let n = Math.max(1, centre - span); n <= Math.min(total - 1, centre + span); n++) {
    if (credit(n) !== need) continue
    const needParts = powersOf(n)
    const restParts = powersOf(total - n)
    if (needParts.length + restParts.length > MAX_SPLIT_PARTS) continue
    if (!best || needParts.length + restParts.length < best.need.length + best.rest.length) best = { need: needParts, rest: restParts }
  }
  return best
}

/** Whether a split can make `amount` from this coupon. Never throws. */
export function canSplit(token: string, amount: number): boolean {
  try {
    return planSplit(token, amount) !== null
  } catch {
    return false
  }
}
