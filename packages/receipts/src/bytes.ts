/**
 * Byte helpers matching the Java `ReceiptKeys` hex rules: input hex may carry a `0x` prefix and
 * either case, output hex is always lowercase.
 */

const HEX_RE = /^[0-9a-fA-F]*$/

export function hexToBytes(hex: string): Uint8Array {
  let h = hex.trim()
  if (h.startsWith('0x') || h.startsWith('0X')) h = h.slice(2)
  if (h.length % 2 !== 0 || !HEX_RE.test(h)) throw new Error('invalid hex')
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export const utf8 = (s: string): Uint8Array => enc.encode(s)
/** Lenient like Java's `new String(bytes, UTF_8)`: malformed input becomes U+FFFD. */
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b)

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** base64url without padding, as Java's `Base64.getUrlEncoder().withoutPadding()`. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63]
  }
  return out
}

/**
 * base64url decode, as Java's `Base64.getUrlDecoder()`: URL alphabet only, padding optional,
 * a dangling single character rejected.
 */
export function fromBase64Url(text: string): Uint8Array {
  let t = text
  const pad = t.indexOf('=')
  if (pad >= 0) {
    const padding = t.slice(pad)
    if (!/^={1,2}$/.test(padding) || (t.length % 4) !== 0) throw new Error('invalid base64url')
    t = t.slice(0, pad)
  }
  if (t.length % 4 === 1) throw new Error('invalid base64url')
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const ch of t) {
    const v = B64.indexOf(ch)
    if (v < 0) throw new Error('invalid base64url')
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}
