import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, concatBytes } from '@noble/hashes/utils'

/**
 * The two one-way transforms of #589 section 2, and the pseudonym table of section 2b.
 *
 * - H(x): salted hash, for values nobody should ever match (token ids, proof ids). The salt is
 *   random per snapshot and never written anywhere, so H values are useless outside one file.
 * - K(x): HMAC under `k_corr`, for public ids support may need to match against gateway logs.
 *   `k_corr` travels only in the encrypted handoff DM.
 *
 * Neither value is ever written to `data/`: there every identifier is a pseudonym (`send#14`).
 * The pseudonym to K map is `envelope/correlation.json`, which only support's code reads.
 */
const enc = new TextEncoder()

export function saltedHash(salt: Uint8Array, x: string): string {
  return bytesToHex(sha256(concatBytes(enc.encode('imani-snapshot-v1'), salt, enc.encode(x)))).slice(0, 16)
}

export function correlate(kCorr: Uint8Array, x: string): string {
  return bytesToHex(hmac(sha256, kCorr, enc.encode('imani-snapshot-corr-v1' + x))).slice(0, 16)
}

export type PseudonymType =
  | 'stall' | 'customer' | 'terminal' | 'send' | 'voucher' | 'event' | 'payment' | 'purchase'
  | 'bundle' | 'template' | 'request' | 'tx' | 'gift_link' | 'party' | 'token' | 'proof' | 'cashlink' | 'code'

/**
 * Pseudonyms for one snapshot. Collect every real id first (`see`), then `freeze` numbers them per
 * type in sorted order of their K value, so the same data under the same key gives the same names
 * (determinism, criterion 10) while a new key renumbers everything (no linking across snapshots).
 */
export class Pseudonyms {
  private readonly seen = new Map<string, { type: PseudonymType; real: string }>()
  private names: Map<string, string> | null = null
  readonly realIds = new Set<string>()

  constructor(private readonly kCorr: Uint8Array, readonly selfPubkey: string) {
    this.realIds.add(selfPubkey.toLowerCase())
  }

  private key(type: PseudonymType, real: string) {
    return type + '\u0000' + real
  }

  see(type: PseudonymType, real: string | undefined | null): void {
    if (real === undefined || real === null || real === '') return
    const r = String(real)
    if (this.names) throw new Error('Pseudonyms: see() after freeze()')
    if (r.toLowerCase() === this.selfPubkey.toLowerCase()) return
    this.seen.set(this.key(type, r), { type, real: r })
    if (r.length >= 6) this.realIds.add(r)
  }

  freeze(): void {
    const byType = new Map<PseudonymType, Array<{ real: string; k: string }>>()
    for (const { type, real } of this.seen.values()) {
      const list = byType.get(type) ?? []
      list.push({ real, k: correlate(this.kCorr, real) })
      byType.set(type, list)
    }
    this.names = new Map()
    for (const [type, list] of byType) {
      list.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.real < b.real ? -1 : 1))
      list.forEach(({ real }, i) => this.names!.set(this.key(type, real), `${type}#${i + 1}`))
    }
  }

  /** The pseudonym for a real id, `self` for this wallet. Unknown ids are a bug, so they throw. */
  name(type: PseudonymType, real: string | undefined | null): string | undefined {
    if (real === undefined || real === null || real === '') return undefined
    if (!this.names) throw new Error('Pseudonyms: name() before freeze()')
    if (String(real).toLowerCase() === this.selfPubkey.toLowerCase()) return 'self'
    const n = this.names.get(this.key(type, String(real)))
    if (!n) throw new Error(`Pseudonyms: ${type} id was not collected`)
    return n
  }

  /** pseudonym -> K(real id), for `envelope/correlation.json`. Pure hash ids (token, proof) excluded. */
  correlationMap(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const { type, real } of this.seen.values()) {
      if (type === 'token' || type === 'proof' || type === 'code' || type === 'cashlink') continue
      out[this.name(type, real)!] = correlate(this.kCorr, real)
    }
    out.self = correlate(this.kCorr, this.selfPubkey)
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
  }
}
