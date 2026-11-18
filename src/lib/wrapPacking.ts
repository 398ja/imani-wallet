import { encodePlainTokenV4 } from './plainToken'
import { decodeCbor, tokenProofs, type TokenProof } from './voucherToken'
import { OversizeEventError, WRAP_BUDGET_BYTES, wrapEventBytes } from './wrapSize'

/**
 * #532: one voucher's token cut into self-contained tokens whose NIP-17 wraps each fit the relay
 * budget, by the shared size model (no encryption per try). The split unit is the PROOF, never the
 * byte: every part is a valid `cashuB` of the same voucher and mint, spendable on its own, so a
 * reader that sees only some parts still holds what they carry.
 *
 * `contentOf(token)` is the rumor content the token travels in (it differs by path: a link wrap, an
 * `imani_gift_sent`). Proofs keep their order, so the cut is the same on every run and a retry
 * publishes the same parts. A token that already fits comes back as it is, byte for byte.
 *
 * Throws {@link OversizeEventError} when one proof alone does not fit: that is permanent.
 */
export function packTokenForWraps(token: string, contentOf: (token: string) => string, budget = WRAP_BUDGET_BYTES): string[] {
  const whole = wrapEventBytes(contentOf(token))
  if (whole <= budget) return [token]
  const root = decodeCbor(base64UrlBytes(token.slice(6))) as Record<string, unknown>
  const mintUrl = String(root.m ?? '')
  const unit = String(root.u ?? '')
  const proofs = tokenProofs(token)
  const encode = (group: TokenProof[]) => encodePlainTokenV4(mintUrl, unit || 'sat', group)
  const parts: string[] = []
  let current: TokenProof[] = []
  for (const proof of proofs) {
    const next = [...current, proof]
    if (wrapEventBytes(contentOf(encode(next))) <= budget) {
      current = next
      continue
    }
    if (current.length === 0) throw new OversizeEventError(wrapEventBytes(contentOf(encode([proof]))), budget, 'one proof in a gift wrap')
    parts.push(encode(current))
    current = [proof]
    const alone = wrapEventBytes(contentOf(encode(current)))
    if (alone > budget) throw new OversizeEventError(alone, budget, 'one proof in a gift wrap')
  }
  if (current.length > 0) parts.push(encode(current))
  return parts
}

function base64UrlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))
}
