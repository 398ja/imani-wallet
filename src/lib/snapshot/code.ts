import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

/**
 * The snapshot code (#589 section 7): what Imani support gives a user so that one snapshot may be
 * uploaded. Crockford base32, eight random data symbols and one Luhn mod 32 check symbol, shown as
 * `SNAP-XXX-XXX-XXX`. The same Luhn rule as the checkout code (checkoutCode.ts), at a different
 * length, so a typo is caught here before any network request.
 */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const DATA_LENGTH = 8
const PREFIX = 'SNAP'

export type SnapshotCodeProblem = 'shape' | 'check'
export type NormalisedSnapshotCode = { ok: true; canonical: string } | { ok: false; problem: SnapshotCodeProblem }

const value = (c: string) => CODE_ALPHABET.indexOf(c)

function luhnSum(symbols: string, firstFactor: 1 | 2): number {
  let factor = firstFactor
  let sum = 0
  for (let i = symbols.length - 1; i >= 0; i--) {
    const a = factor * value(symbols[i])
    sum += Math.floor(a / 32) + (a % 32)
    factor = factor === 2 ? 1 : 2
  }
  return sum
}

/** The check symbol for eight data symbols. */
export function snapshotCheckSymbol(data: string): string {
  if (data.length !== DATA_LENGTH || [...data].some((c) => value(c) < 0)) throw new Error('snapshotCheckSymbol takes 8 alphabet symbols')
  return CODE_ALPHABET[(32 - (luhnSum(data, 2) % 32)) % 32]
}

/** What a person typed, as the nine canonical symbols, or why it is not a code. */
export function normaliseSnapshotCode(typed: string): NormalisedSnapshotCode {
  let s = typed.toUpperCase().replace(/[\s\-_.]/g, '')
  if (s.startsWith(PREFIX)) s = s.slice(PREFIX.length)
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1')
  if (s.length !== DATA_LENGTH + 1 || [...s].some((c) => value(c) < 0)) return { ok: false, problem: 'shape' }
  if (luhnSum(s, 1) % 32 !== 0) return { ok: false, problem: 'check' }
  return { ok: true, canonical: s }
}

/** `SNAP-XXX-XXX-XXX`. */
export function displaySnapshotCode(canonical: string): string {
  return `${PREFIX}-${canonical.slice(0, 3)}-${canonical.slice(3, 6)}-${canonical.slice(6, 9)}`
}

/** sha256 hex of the canonical form: the only way the code is ever referred to after entry. */
export function codeRef(canonical: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonical)))
}
