import { readFileSync } from 'node:fs'

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'

const HOLDER_KEY = '0000000000000000000000000000000000000000000000000000000000000001'
const HOLDER_PUBKEY_XONLY = bytesToHex(schnorr.getPublicKey(hexToBytes(HOLDER_KEY)))
const HOLDER_PUBKEY_COMPRESSED = `02${HOLDER_PUBKEY_XONLY}`
const OTHER_KEY = '0000000000000000000000000000000000000000000000000000000000000002'
const OTHER_PUBKEY_COMPRESSED = `02${bytesToHex(schnorr.getPublicKey(hexToBytes(OTHER_KEY)))}`

const mockSigner = {
  pubkey: HOLDER_PUBKEY_XONLY,
  privkeyHex: () => HOLDER_KEY,
  withPrivkey: <T,>(borrow: (key: Uint8Array) => T) => borrow(hexToBytes(HOLDER_KEY)),
}

vi.mock('../nap', () => ({
  getSigner: () => mockSigner,
}))

const {
  buildWitnesses,
  isLockedSecret,
  lockedToPubkey,
  secretsFromToken,
  signWitness,
  witnessHeader,
  witnessHeaderForToken,
  xOnly,
} = await import('../witness')

const lockedSecret = (pubkeyCompressed: string, nonce = 'aa') =>
  JSON.stringify([
    'P2PK_VOUCHER',
    { nonce, data: pubkeyCompressed, tags: [['voucher_id', 'v1']] },
  ])

const bearerSecret = 'a-plain-random-secret'
const unlockedVoucher = JSON.stringify(['VOUCHER', { nonce: 'aa', data: 'ff', tags: [] }])

/** Exactly what the mint's SigningKeyCounter does. */
const mintWouldAccept = (secret: string, signatureHex: string, pubkeyCompressed: string) =>
  schnorr.verify(
    hexToBytes(signatureHex),
    sha256(utf8ToBytes(secret)),
    hexToBytes(xOnly(pubkeyCompressed)),
  )

describe('witness', () => {
  beforeEach(() => {
    mockSigner.pubkey = HOLDER_PUBKEY_XONLY
  })

  describe('recognising a lock', () => {
    it('recognises the kinds the mint enforces', () => {
      expect(isLockedSecret(lockedSecret(HOLDER_PUBKEY_COMPRESSED))).toBe(true)
      expect(isLockedSecret('["P2PK",{"nonce":"aa","data":"02ab","tags":[]}]')).toBe(true)
    })

    // A plain voucher and a bearer secret need no signature, and asking for one
    // would be work the customer never has to authorise.
    it('leaves unlocked secrets alone', () => {
      expect(isLockedSecret(unlockedVoucher)).toBe(false)
      expect(isLockedSecret(bearerSecret)).toBe(false)
    })

    it('reads the key a secret is locked to', () => {
      expect(lockedToPubkey(lockedSecret(HOLDER_PUBKEY_COMPRESSED))).toBe(
        HOLDER_PUBKEY_COMPRESSED,
      )
      expect(lockedToPubkey(unlockedVoucher)).toBeNull()
    })

    // A secret we cannot parse is one we cannot sign for. The mint will refuse
    // it, and saying so plainly beats guessing.
    it('returns null for a malformed secret', () => {
      expect(lockedToPubkey('["P2PK_VOUCHER", not json')).toBeNull()
    })
  })

  describe('signing', () => {
    // The property that matters: the mint must accept what we produce.
    it('produces a signature the mint accepts', () => {
      const secret = lockedSecret(HOLDER_PUBKEY_COMPRESSED)

      const signature = signWitness(secret)

      expect(mintWouldAccept(secret, signature, HOLDER_PUBKEY_COMPRESSED)).toBe(true)
    })

    // BIP-340 signs the digest. Signing the raw message verifies against
    // nothing, and the mint reports it as a missing signature rather than a
    // malformed one, so it is worth pinning explicitly.
    it('signs the sha256 of the secret, not the raw bytes', () => {
      const secret = lockedSecret(HOLDER_PUBKEY_COMPRESSED)

      const signature = signWitness(secret)

      expect(
        schnorr.verify(
          hexToBytes(signature),
          utf8ToBytes(secret),
          hexToBytes(HOLDER_PUBKEY_XONLY),
        ),
      ).toBe(false)
    })

    // Each output of a split carries its own nonce, which is what stops one
    // signature unlocking all of them.
    it('binds a signature to its own secret', () => {
      const first = lockedSecret(HOLDER_PUBKEY_COMPRESSED, 'aa')
      const second = lockedSecret(HOLDER_PUBKEY_COMPRESSED, 'bb')

      const signature = signWitness(first)

      expect(mintWouldAccept(second, signature, HOLDER_PUBKEY_COMPRESSED)).toBe(false)
    })
  })

  describe('building the request', () => {
    it('signs every locked secret, keyed by the secret itself', () => {
      const first = lockedSecret(HOLDER_PUBKEY_COMPRESSED, 'aa')
      const second = lockedSecret(HOLDER_PUBKEY_COMPRESSED, 'bb')

      const witnesses = buildWitnesses([first, second])

      expect(Object.keys(witnesses)).toHaveLength(2)
      expect(mintWouldAccept(first, witnesses[first][0], HOLDER_PUBKEY_COMPRESSED)).toBe(true)
      expect(mintWouldAccept(second, witnesses[second][0], HOLDER_PUBKEY_COMPRESSED)).toBe(true)
    })

    it('skips unlocked secrets', () => {
      const witnesses = buildWitnesses([bearerSecret, unlockedVoucher])

      expect(witnesses).toEqual({})
    })

    // Signing with a key that cannot satisfy the condition would make a spend
    // look authorised when it is not.
    it('skips a secret locked to somebody else', () => {
      const theirs = lockedSecret(OTHER_PUBKEY_COMPRESSED)

      const witnesses = buildWitnesses([theirs])

      expect(witnesses).toEqual({})
    })
  })

  describe('#160: a co-spender in the pubkeys tag', () => {
    /** A terminal credential: locked to the device in `data`, the stall in `pubkeys`. */
    const coLocked = (data: string, pubkeys: string[], nSigs = '1') =>
      JSON.stringify([
        'P2PK_VOUCHER',
        {
          nonce: 'cc',
          data,
          tags: [['n_sigs', nSigs], ['pubkeys', ...pubkeys], ['voucher_id', 'cred']],
        },
      ])

    // The owner's wallet holds the stall key, which is in `pubkeys`, not
    // `data`. It must sign, or the owner could never revoke a lost device.
    it('signs a secret whose pubkeys tag holds this wallet\'s key', () => {
      const credential = coLocked(OTHER_PUBKEY_COMPRESSED, [HOLDER_PUBKEY_COMPRESSED])

      const witnesses = buildWitnesses([credential])

      expect(Object.keys(witnesses)).toEqual([credential])
      expect(mintWouldAccept(credential, witnesses[credential][0], HOLDER_PUBKEY_COMPRESSED)).toBe(
        true,
      )
    })

    // With n_sigs 2, one signature from this wallet cannot spend it, so it
    // must not pretend to.
    it('does not sign when one signature cannot satisfy n_sigs', () => {
      const credential = coLocked(OTHER_PUBKEY_COMPRESSED, [HOLDER_PUBKEY_COMPRESSED], '2')

      expect(buildWitnesses([credential])).toEqual({})
    })

    // The device and stall are both someone else: nothing to sign.
    it('skips a co-locked secret holding neither of our keys', () => {
      const third = `02${bytesToHex(schnorr.getPublicKey(hexToBytes('03'.padStart(64, '0'))))}`
      const credential = coLocked(OTHER_PUBKEY_COMPRESSED, [third])

      expect(buildWitnesses([credential])).toEqual({})
    })
  })

  describe('the header', () => {
    it('is omitted entirely when there is nothing to sign', () => {
      expect(witnessHeader([bearerSecret])).toBeNull()
    })

    it('carries the witnesses when there are any', () => {
      const secret = lockedSecret(HOLDER_PUBKEY_COMPRESSED)

      const header = witnessHeader([secret])

      expect(header).not.toBeNull()
      const parsed = JSON.parse(header as string) as Record<string, string[]>
      expect(mintWouldAccept(secret, parsed[secret][0], HOLDER_PUBKEY_COMPRESSED)).toBe(true)
    })
  })

  describe('xOnly', () => {
    it('strips the parity prefix and is idempotent', () => {
      expect(xOnly(HOLDER_PUBKEY_COMPRESSED)).toBe(HOLDER_PUBKEY_XONLY)
      expect(xOnly(HOLDER_PUBKEY_XONLY)).toBe(HOLDER_PUBKEY_XONLY)
      expect(xOnly(`0x${HOLDER_PUBKEY_COMPRESSED}`)).toBe(HOLDER_PUBKEY_XONLY)
    })
  })


  /**
   * Reading the secrets out of an encoded token, and signing them.
   *
   * This is the step that was missing: the witness signer existed and was
   * tested, but nothing could get the secrets out of a cashuB token, so no
   * locked coupon could actually be redeemed through the UI.
   *
   * The tokens here are built with the app's OWN CBOR encoder rather than
   * hand-rolled fixtures, so the test exercises the same codec the wire uses.
   */
  describe('reading secrets off a token', () => {
    // shared/nut18v.js is a classic script that assigns to window; the app
    // loads it the same way in main.tsx.
    const loadCbor = () => {
      const scope = globalThis as unknown as {
        window?: unknown
        NUT18V?: { _CBOR: { encode(v: unknown): Uint8Array } }
      }
      scope.window = scope
      new Function(
        readFileSync(new URL('../../../shared/nut18v.js', import.meta.url), 'utf8'),
      )()
      return scope.NUT18V!._CBOR
    }

    const encodeToken = (secrets: string[]) => {
      const bytes = loadCbor().encode({
        t: [{ p: secrets.map((s) => ({ s })) }],
        m: 'https://mint.example',
        u: 'sat',
      })
      let base64 = btoa(String.fromCharCode(...bytes))
      base64 = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      return `cashuB${base64}`
    }

    it('extracts every proof secret', () => {
      const first = lockedSecret(HOLDER_PUBKEY_COMPRESSED, 'a1')
      const second = lockedSecret(HOLDER_PUBKEY_COMPRESSED, 'a2')

      expect(secretsFromToken(encodeToken([first, second]))).toEqual([first, second])
    })

    it('tolerates the cashu: URI prefix', () => {
      const secret = lockedSecret(HOLDER_PUBKEY_COMPRESSED)

      expect(secretsFromToken(`cashu:${encodeToken([secret])}`)).toEqual([secret])
    })

    it('returns nothing for a token it cannot read', () => {
      // Garbage must not throw. An unreadable token is the gateway's problem
      // to report, and throwing here would break an ordinary bearer receive.
      expect(secretsFromToken('cashuBnot-valid-base64!!')).toEqual([])
      expect(secretsFromToken('cashuAlegacy')).toEqual([])
      expect(secretsFromToken('')).toEqual([])
    })

    it('signs a token locked to this wallet', () => {
      const secret = lockedSecret(HOLDER_PUBKEY_COMPRESSED)

      const header = witnessHeaderForToken(encodeToken([secret]))

      expect(header).not.toBeNull()
      const parsed = JSON.parse(header!) as Record<string, string[]>
      expect(Object.keys(parsed)).toEqual([secret])
      // A real BIP-340 signature over sha256(secret), verifiable against the
      // x-only key exactly as the mint checks it.
      expect(
        schnorr.verify(hexToBytes(parsed[secret][0]), sha256(utf8ToBytes(secret)), hexToBytes(HOLDER_PUBKEY_XONLY)),
      ).toBe(true)
    })

    it('sends no header for a bearer token', () => {
      // The whole point of null: an ordinary receive stays byte-identical to
      // what it was before locked coupons existed.
      expect(witnessHeaderForToken(encodeToken([bearerSecret]))).toBeNull()
    })

    it('sends no header for a coupon locked to somebody else', () => {
      expect(witnessHeaderForToken(encodeToken([lockedSecret(OTHER_PUBKEY_COMPRESSED)]))).toBeNull()
    })
  })

  // The gateway signs the same bytes in Java (P2pkWitnessSigner). Schnorr is
  // non-deterministic, so the signatures cannot be compared — but the digest
  // can, and it is the only place the two implementations could silently
  // diverge. Produced by running Utils.sha256 over the identical secret; if
  // this constant ever has to change, one side has drifted and locked coupons
  // stop being spendable from whichever client is wrong.
  it('hashes a secret to the same digest the Java signer does', () => {
    const secret =
      '["P2PK_VOUCHER",{"nonce":"aa","data":"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798","tags":[]}]'

    expect(bytesToHex(sha256(utf8ToBytes(secret)))).toBe(
      '44382b746d7c4621b494d751d5e9b964486fb8de6ced1386577cd44435839570',
    )
  })
})
