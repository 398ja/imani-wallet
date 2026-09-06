/**
 * The CBOR byte-string decoder must read lengths from the right offset.
 *
 * Issue #58. `shared/nut18v.js` carries the only CBOR decoder in the app, and
 * `_decodeByteString` read its length from `state.offset - 1` — the header
 * byte itself — rather than from `state.offset`.
 *
 * For a short string the length is packed into the header and both readings
 * agree, so every vreq payload decoded fine and the bug stayed invisible. For
 * anything longer the length came back wrong, the string was sliced to the
 * wrong width, and every subsequent value was read from a shifted offset. The
 * failure surfaced as "Unsupported CBOR major type: 6" pointing at a byte in
 * the middle of an unrelated field, hundreds of bytes from the real cause.
 *
 * A TokenV4 proof carries a 32-byte C, so this broke every cashuB token in
 * existence: no client code could read the secrets out of one. That matters
 * now because a locked coupon can only be redeemed by signing its secrets in
 * the browser, and the browser could not read them.
 *
 * These tests use the byte patterns a real token actually contains rather than
 * a token fixture, so they stay meaningful without a live mint.
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let CBOR: any

beforeAll(() => {
  // nut18v.js is a classic script that assigns to `window`, exactly as the app
  // loads it, so the shim is exercised the same way in the test. `window` is
  // pointed at globalThis first because this suite runs without a DOM.
  const scope = globalThis as unknown as { window?: unknown; NUT18V?: { _CBOR: unknown } }
  scope.window = scope
  const source = readFileSync(new URL('../../../shared/nut18v.js', import.meta.url), 'utf8')
  new Function(source)()
  CBOR = scope.NUT18V!._CBOR
})

describe('CBOR byte strings', () => {
  it('decodes a 32-byte string without eating the next key', () => {
    // {"s": <32 bytes>, "c": 1}. The 0x58 0x20 header is a byte string whose
    // length lives in the FOLLOWING byte, which is the case that used to be
    // misread: the secret came back 35 bytes long and "c" vanished entirely.
    const payload = new Array(32).fill(0xab)
    const encoded = new Uint8Array([
      0xa2, 0x61, 0x73, 0x58, 0x20, ...payload, 0x61, 0x63, 0x01,
    ])

    const decoded = CBOR.decode(encoded)

    expect(decoded.s).toHaveLength(32)
    expect(Object.keys(decoded)).toEqual(['s', 'c'])
    expect(decoded.c).toBe(1)
  })

  it('still decodes a short byte string whose length is in the header', () => {
    // 0x48: additionalInfo 8, so eight bytes follow inline. This is the keyset
    // id in every token, and it always worked — pinned so the fix does not
    // regress the path that vreq depends on.
    const encoded = new Uint8Array([0x48, 0x00, 0xe3, 0x37, 0x2e, 0x61, 0xd0, 0x56, 0x05])

    const decoded = CBOR.decode(encoded)

    expect(Array.from(decoded)).toEqual([0x00, 0xe3, 0x37, 0x2e, 0x61, 0xd0, 0x56, 0x05])
  })

  it('decodes a two-byte length without running past it', () => {
    // 0x59 takes a 16-bit length. The misread length here was enormous, and a
    // slice past the end of the array silently truncates — so this is wrapped
    // in a map with a key AFTER it, where a wrong offset cannot hide.
    const payload = new Array(300).fill(0x07)
    const encoded = new Uint8Array([
      0xa2, 0x61, 0x73, 0x59, 0x01, 0x2c, ...payload, 0x61, 0x63, 0x01,
    ])

    const decoded = CBOR.decode(encoded)

    expect(decoded.s).toHaveLength(300)
    expect(decoded.c).toBe(1)
  })

  it('decodes a TokenV4-shaped proof', () => {
    // The real shape: a proof map of amount, secret and a 33-byte C, inside
    // the array/map nesting a token uses. Reading a secret out of this is the
    // whole point — a locked coupon cannot be redeemed without it.
    const secret = '["P2PK_VOUCHER",{"nonce":"abc"}]'
    const secretBytes = Array.from(new TextEncoder().encode(secret))
    const c = new Array(33).fill(0x02)
    const proof = [
      0xa3,
      0x61, 0x61, 0x18, 0x80,                        // "a": 128
      0x61, 0x73, 0x78, secretBytes.length, ...secretBytes, // "s": text
      0x61, 0x63, 0x58, 0x21, ...c,                  // "c": 33 bytes
      0x61, 0x64, 0x01,                              // "d": 1, a trailing key
    ]

    const decoded = CBOR.decode(new Uint8Array([0xa4, ...proof.slice(1)]))

    expect(decoded.a).toBe(128)
    expect(decoded.s).toBe(secret)
    expect(decoded.c).toHaveLength(33)
    // The trailing key is the real check: a byte string read at the wrong
    // width swallows whatever follows it, and C is otherwise last in the map.
    expect(decoded.d).toBe(1)
  })
})
