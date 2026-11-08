import { encodePlainTokenV4 } from './plainToken'
import { decodeCbor, tokenProofs, voucherOfProof, type TokenProof } from './voucherToken'

/**
 * A TokenV4 cut into one token per voucher (and lock key), proofs in their original order.
 *
 * A Cashlink of several coupons was locked into ONE token holding every coupon's proofs (staging,
 * 2026-11-05). `parseVoucherToken` refuses such a token ("mixes proofs from more than one
 * voucher"), so the link's own gift was dropped by every reader: neither the claimer nor the
 * issuer could find it. Each proof is fine on its own, so the reader cuts the token instead of
 * dropping it, and the arm now writes one token per voucher. A token of one voucher, or one this
 * cannot read, is returned as it is.
 *
 * Its own module, not in `voucherToken.ts`: the purchase-issuer, subscription and wallet-api images
 * copy `voucherToken.ts` alone, so that file must import nothing they do not copy (v0.55.3's
 * purchase-issuer build failed its load check on `./plainToken`).
 */
export function splitTokenByVoucher(token: string): string[] {
  try {
    const proofs = tokenProofs(token)
    const groups = new Map<string, TokenProof[]>()
    for (const p of proofs) {
      const v = voucherOfProof(p)
      if (!v) return [token]
      const key = `${v.voucherId}\u0000${v.lockKey ?? ''}`
      groups.set(key, [...(groups.get(key) ?? []), p])
    }
    if (groups.size <= 1) return [token]
    const root = decodeCbor(base64UrlBytes(token.slice(6))) as Record<string, unknown>
    const mintUrl = String(root.m ?? '')
    const unit = String(root.u ?? 'sat')
    return [...groups.values()].map((group) => encodePlainTokenV4(mintUrl, unit, group))
  } catch {
    return [token]
  }
}

function base64UrlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))
}
