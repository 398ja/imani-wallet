import { bytesToHex, concatBytes, fromUtf8, hexToBytes, utf8 } from './bytes'

/**
 * Tag-length-value codec, byte-for-byte the Java `Tlv`: each field is
 * `varint tag, varint length, bytes`, LEB128 varints, tags written in ascending order.
 */

/** Upper bound on any one field, as Java `Tlv.MAX_FIELD`. Enforced on write and on read. */
export const MAX_FIELD = 1024 * 1024

export interface TlvField {
  tag: number
  value: Uint8Array
}

export function encodeVarint(v: number | bigint): Uint8Array {
  let n = BigInt(v)
  if (n < 0n) throw new Error('varint must be non-negative')
  if (n > 0x7fffffffffffffffn) throw new Error('varint exceeds a Java long')
  const out: number[] = []
  while (n > 0x7fn) {
    out.push(Number((n & 0x7fn) | 0x80n))
    n >>= 7n
  }
  out.push(Number(n))
  return Uint8Array.from(out)
}

/**
 * Reads a varint at `pos`. Mirrors Java `readVarint`: at most 9 groups of 7 bits (shift <= 56),
 * non-minimal encodings tolerated. The value is returned as a bigint masked to 64 bits.
 */
export function readVarint(data: Uint8Array, pos: number): [bigint, number] {
  let result = 0n
  let shift = 0n
  for (;;) {
    if (pos >= data.length || shift > 56n) throw new Error('malformed varint')
    const b = data[pos++]
    result |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7n
  }
  return [BigInt.asIntN(64, result), pos]
}

/** A varint field's value as a safe integer. Throws on trailing bytes or a value beyond 2^53. */
export function fieldVarint(f: TlvField): number {
  const [v, end] = readVarint(f.value, 0)
  if (end !== f.value.length) throw new Error(`trailing bytes in varint field ${f.tag}`)
  if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`varint field ${f.tag} out of range`)
  return Number(v)
}

export const fieldUtf8 = (f: TlvField): string => fromUtf8(f.value)
export const fieldHex = (f: TlvField): string => bytesToHex(f.value)

export class TlvWriter {
  private parts: Uint8Array[] = []
  private lastTag = 0

  bytes(tag: number, value: Uint8Array): this {
    if (tag < this.lastTag) throw new Error('tags must be written in ascending order')
    if (value.length > MAX_FIELD) throw new Error(`field ${tag} exceeds ${MAX_FIELD} bytes`)
    this.lastTag = tag
    this.parts.push(encodeVarint(tag), encodeVarint(value.length), value)
    return this
  }

  /** Skips null/undefined, as Java `Writer.hex(tag, null)`. */
  hex(tag: number, hex: string | null | undefined): this {
    return hex == null ? this : this.bytes(tag, hexToBytes(hex))
  }

  utf8(tag: number, s: string | null | undefined): this {
    return s == null ? this : this.bytes(tag, utf8(s))
  }

  varint(tag: number, v: number | bigint): this {
    return this.bytes(tag, encodeVarint(v))
  }

  /** Appends already-encoded fields without order checks, as Java `Writer.raw`. */
  raw(encoded: Uint8Array): this {
    this.parts.push(encoded)
    return this
  }

  toBytes(): Uint8Array {
    return concatBytes(...this.parts)
  }
}

export function readTlv(data: Uint8Array): TlvField[] {
  const fields: TlvField[] = []
  let pos = 0
  while (pos < data.length) {
    let tag: bigint
    let len: bigint
    ;[tag, pos] = readVarint(data, pos)
    ;[len, pos] = readVarint(data, pos)
    // Java compares signed longs: a negative length or tag would wrap. Reject both.
    if (tag < 0n || tag > 0x7fffffffn || len < 0n || len > BigInt(MAX_FIELD) || pos + Number(len) > data.length) {
      throw new Error('malformed field')
    }
    const n = Number(len)
    fields.push({ tag: Number(tag), value: data.slice(pos, pos + n) })
    pos += n
  }
  return fields
}
