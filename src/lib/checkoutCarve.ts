import { faceSharesOf } from './faceSplit'
import { encodePlainTokenV4 } from './plainToken'
import { parseVoucherToken, tokenProofs } from './voucherToken'

/**
 * The proofs of a coupon whose face shares add up to exactly `amount`, largest first. A coupon's
 * proofs are powers of two of sats under one voucher secret each, so a part can be carved without a
 * mint call by taking some of them whole. Null when no subset makes the amount.
 */
export function carveProofs(token: string, amount: number): { part: string; rest: string | null } | null {
  const shares = faceSharesOf(token)
  if (!shares) return null
  const mintUrl = parseVoucherToken(token).mintUrl
  const proofs = tokenProofs(token).sort((a, b) => (shares.get(b.secret) ?? 0) - (shares.get(a.secret) ?? 0))
  const pick = (from: number, left: number): number[] | null => {
    if (left === 0) return []
    for (let n = from; n < proofs.length; n++) {
      const share = shares.get(proofs[n].secret) ?? 0
      if (share > 0 && share <= left) {
        const more = pick(n + 1, left - share)
        if (more) return [n, ...more]
      }
    }
    return null
  }
  const chosen = pick(0, amount)
  if (!chosen || chosen.length === 0) return null
  const plain = (ps: typeof proofs) => encodePlainTokenV4(mintUrl, 'sat', ps.map((p) => ({ amount: p.amount, id: p.id, secret: p.secret, C: p.C, ...(p.dleq ? { dleq: p.dleq } : {}), ...(p.document ? { document: p.document } : {}) })))
  const taken = new Set(chosen)
  const rest = proofs.filter((_, n) => !taken.has(n))
  return { part: plain(proofs.filter((_, n) => taken.has(n))), rest: rest.length ? plain(rest) : null }
}

/**
 * Whether a part of exactly `amount` can be carved from this coupon's own proofs (#402). The
 * planner offers only amounts that pass, so the code is never refused at the carve step with
 * 'this amount cannot be taken from that coupon' after the user has pressed Get code.
 */
export function canCarve(token: string, amount: number): boolean {
  try {
    return carveProofs(token, amount) !== null
  } catch {
    return false
  }
}
