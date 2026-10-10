import { hexToBytes } from '@noble/hashes/utils'

import type { UnblindedProof } from './walletSwap'

/**
 * Plain ecash proofs as a TokenV4 (`cashuB…`) string.
 *
 * The wallet reads TokenV4 everywhere (`voucherToken.ts`) and, until "Swap back to sats", never
 * had to write one: every token it holds was encoded by a gateway or by the mint's client. A swap
 * back produces fresh proofs in the wallet itself, and they are kept as a token so they can be
 * copied, shown as a QR, or pasted into any Cashu wallet.
 *
 * NUT-00 V4: a CBOR map `{m: mint, u: unit, t: [{i: keyset id bytes, p: [{a, s, c}]}]}`, proofs
 * grouped by keyset. Definite lengths only, which is what every reader accepts.
 */
export function encodePlainTokenV4(mintUrl: string, unit: string, proofs: UnblindedProof[]): string {
  if (proofs.length === 0) throw new Error('a token needs at least one proof')

  const byKeyset = new Map<string, UnblindedProof[]>()
  for (const proof of proofs) {
    const list = byKeyset.get(proof.id) ?? []
    list.push(proof)
    byKeyset.set(proof.id, list)
  }

  const entries = [...byKeyset.entries()].map(([keysetId, group]) =>
    concat(
      head(5, 2),
      text('i'),
      byteString(hexToBytes(keysetId)),
      text('p'),
      head(4, group.length),
      ...group.map((proof) =>
        concat(
          head(5, 3),
          text('a'),
          head(0, proof.amount),
          text('s'),
          text(proof.secret),
          text('c'),
          byteString(hexToBytes(proof.C)),
        ),
      ),
    ),
  )

  const root = concat(head(5, 3), text('m'), text(mintUrl), text('u'), text(unit), text('t'), head(4, entries.length), ...entries)
  return `cashuB${base64Url(root)}`
}

function head(major: number, n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new Error(`cannot encode ${n} as a CBOR length`)
  if (n < 24) return new Uint8Array([(major << 5) | n])
  if (n < 0x100) return new Uint8Array([(major << 5) | 24, n])
  if (n < 0x10000) return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff])
  if (n <= 0xffffffff) {
    return new Uint8Array([(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
  }
  throw new Error(`cannot encode ${n}: larger than this encoder handles`)
}

function text(s: string): Uint8Array {
  const b = new TextEncoder().encode(s)
  return concat(head(3, b.length), b)
}

function byteString(b: Uint8Array): Uint8Array {
  return concat(head(2, b.length), b)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function base64Url(b: Uint8Array): string {
  let bin = ''
  for (const byte of b) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
