import { describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils'
import { readFileSync } from 'node:fs'

import {
  creditableFaceValue,
  exactFaceValue,
  parseVoucherToken,
  satBoundOf,
  verifyVoucher,
} from '../voucherToken'

/**
 * A re-signed voucher proof is credited for at most the sats burnt for it
 * (imani-gateway-customer#141).
 *
 * ## The exploit this closes on the redeemer side
 *
 * A successor's sats come from the swap that mints it, and the mint cannot see
 * which blinded output carries a voucher secret. So a holder could burn a 1-sat
 * proof, get a full-face successor signed, fund it with 1024 sats bought today,
 * and be credited `min(face, 1024 × ratio)`. The gateway now signs a `max_sats`
 * into every successor, summing to at most the burn, and the redeemer credits
 * `min(face, round(Σ min(sats, max_sats) × ratio))`.
 *
 * The tokens here are built and signed over the same canonical bytes the reader
 * rebuilds, so the signature is genuine; only the sats and the bound vary.
 */

const ISSUER_PRIV = schnorr.utils.randomSecretKey()
const ISSUER_PUB = bytesToHex(schnorr.getPublicKey(ISSUER_PRIV))
const LOCK_KEY = '02' + 'b'.repeat(64)
const VOUCHER_ID = '1d4410af-70f5-4c14-8606-519404684ea7'

/** Face 10000 XAF at 0.5 XAF per sat, so 20000 sats would fill the face. */
const FACE = 10000
const RATIO = 0.5

/**
 * One signed locked-voucher secret. `maxSats` is written exactly as given, or
 * omitted when undefined, and is inside the signed bytes like any string tag.
 */
function signedSecret(nonce: string, maxSats?: string | string[]): string {
  const tags: string[][] = [
    ['voucher_id', VOUCHER_ID],
    ['issuer', ISSUER_PUB],
    ['unit', 'XAF'],
    ['face_value', String(FACE)],
    ['issuance_ratio', String(RATIO)],
  ]
  if (maxSats !== undefined) {
    tags.push(['max_sats', ...(Array.isArray(maxSats) ? maxSats : [maxSats])])
  }
  const NUMERIC = ['face_value', 'issuance_ratio']
  const rendered = tags
    .map(([key, ...values]) =>
      `["${key}"${values.map((v) => ',' + (NUMERIC.includes(key) ? v : `"${v}"`)).join('')}]`,
    )
    .join(',')
  const canonical = new TextEncoder().encode(`["P2PK_VOUCHER","${LOCK_KEY}","${nonce}",[${rendered}]]`)
  const signature = bytesToHex(schnorr.sign(sha256(canonical), ISSUER_PRIV))
  return JSON.stringify([
    'P2PK_VOUCHER',
    {
      nonce,
      data: LOCK_KEY,
      tags: [...tags, ['issuer_sig', signature], ['issuer_pubkey', ISSUER_PUB]],
    },
  ])
}

/** A TokenV4 carrying these proofs, in the CBOR the reader expects. */
function cashuB(proofs: { amount: number; secret: string }[]): string {
  const header = (major: number, length: number): number[] => {
    if (length < 24) return [(major << 5) | length]
    if (length < 256) return [(major << 5) | 24, length]
    if (length < 65536) return [(major << 5) | 25, length >> 8, length & 0xff]
    return [(major << 5) | 26, length >>> 24, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]
  }
  const text = (value: string) => {
    const bytes = new TextEncoder().encode(value)
    return [...header(3, bytes.length), ...bytes]
  }
  const bstr = (bytes: number[]) => [...header(2, bytes.length), ...bytes]
  const encoded = proofs.flatMap(({ amount, secret }) => [
    ...header(5, 3),
    ...text('a'), ...header(0, amount),
    ...text('s'), ...text(secret),
    ...text('c'), ...bstr(Array.from({ length: 33 }, (_, i) => (i === 0 ? 2 : 0xcd))),
  ])
  const entry = [
    ...header(5, 2),
    ...text('i'), ...bstr([0x00, 0xe3, 0x37, 0x2e, 0x61, 0xd0, 0x56, 0x05]),
    ...text('p'), ...header(4, proofs.length), ...encoded,
  ]
  const root = [
    ...header(5, 3),
    ...text('m'), ...text('https://mint.staging.398ja.xyz'),
    ...text('u'), ...text('sat'),
    ...text('t'), ...header(4, 1), ...entry,
  ]
  let binary = ''
  for (const byte of root) binary += String.fromCharCode(byte)
  return 'cashuB' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const nonce = (n: number) => n.toString(16).padStart(2, '0').repeat(32)

describe('a successor funded past its bound', () => {
  // The exploit: a 1-sat burn, a successor bounded to 1, funded with 1024 sats.
  it('is credited for its max_sats, not its sats', () => {
    const parsed = parseVoucherToken(cashuB([{ amount: 1024, secret: signedSecret(nonce(1), '1') }]))

    expect(parsed.tokenAmount).toBe(1024)
    expect(parsed.creditableSats).toBe(1)
    expect(creditableFaceValue(parsed).faceValue).toBe(Math.round(1 * RATIO))
    expect(exactFaceValue(parsed)).toBe(1 * RATIO)
  })

  // The bound is inside the signature, so an over-funded proof still verifies.
  it('still verifies, because the bound is signed', () => {
    const parsed = parseVoucherToken(cashuB([{ amount: 1024, secret: signedSecret(nonce(1), '1') }]))

    expect(verifyVoucher(parsed.voucher).signatureValid).toBe(true)
  })
})

describe('a successor funded within its bound', () => {
  // Under-funding (input fees) credits the sats present, not the bound.
  it('is credited for its sats', () => {
    const parsed = parseVoucherToken(cashuB([{ amount: 60, secret: signedSecret(nonce(1), '64') }]))

    expect(parsed.creditableSats).toBe(60)
    expect(creditableFaceValue(parsed).faceValue).toBe(30)
  })
})

describe('split parts in one token', () => {
  // Each proof is clamped by its own bound, then summed: 4+2+2 bounds funded 512 each.
  it('are clamped per proof and summed', () => {
    const parsed = parseVoucherToken(
      cashuB([
        { amount: 512, secret: signedSecret(nonce(1), '4') },
        { amount: 512, secret: signedSecret(nonce(2), '2') },
        { amount: 1, secret: signedSecret(nonce(3), '2') },
      ]),
    )

    expect(parsed.tokenAmount).toBe(1025)
    expect(parsed.creditableSats).toBe(4 + 2 + 1)
    expect(exactFaceValue(parsed)).toBe(7 * RATIO)
  })
})

describe('a locked voucher with no max_sats', () => {
  // The twin-secret attack: the mint signs any blinded output, so an untagged
  // locked proof's sats may be a same-secret twin funded today. Its funded
  // amount is signed nowhere, so it is credited nothing; it still verifies.
  it('credits 0 sats however many it carries', () => {
    const parsed = parseVoucherToken(cashuB([{ amount: 1024, secret: signedSecret(nonce(1)) }]))

    expect(parsed.creditableSats).toBe(0)
    expect(creditableFaceValue(parsed).faceValue).toBe(0)
    expect(exactFaceValue(parsed)).toBe(0)
    expect(verifyVoucher(parsed.voucher).signatureValid).toBe(true)
  })

  // An untagged twin riding alongside a bounded proof adds nothing.
  it('adds nothing next to a bounded proof', () => {
    const parsed = parseVoucherToken(
      cashuB([
        { amount: 4, secret: signedSecret(nonce(1), '4') },
        { amount: 1024, secret: signedSecret(nonce(2)) },
      ]),
    )

    expect(parsed.creditableSats).toBe(4)
  })

  // A hand-built ParsedVoucherToken with no creditableSats means "no bound known".
  it('built by hand without creditableSats falls back to tokenAmount', () => {
    const parsed = parseVoucherToken(cashuB([{ amount: 100, secret: signedSecret(nonce(1), '100') }]))
    const withoutBound = { ...parsed, creditableSats: undefined }

    expect(creditableFaceValue(withoutBound).faceValue).toBe(50)
  })
})

describe('a bounded voucher funded past its face', () => {
  // The face clamp still holds on top of the bound.
  it('is still clamped to its signed face', () => {
    const parsed = parseVoucherToken(cashuB([{ amount: 30000, secret: signedSecret(nonce(1), '30000') }]))

    expect(creditableFaceValue(parsed)).toEqual({ faceValue: FACE, cappedAtFaceValue: true })
  })
})

describe('a forged later proof', () => {
  /**
   * Callers verify proof 0's signature only. A later proof with the same
   * voucher_id and lock but a signature the issuer never made (self-minted,
   * untagged or carrying any bound it likes) must credit 0, not its amount.
   */
  function forged(nonceHex: string, maxSats?: string): string {
    const genuine = JSON.parse(signedSecret(nonceHex, maxSats)) as [string, { tags: string[][] }]
    genuine[1].tags = genuine[1].tags.map((t) => (t[0] === 'issuer_sig' ? ['issuer_sig', '00'.repeat(64)] : t))
    return JSON.stringify(genuine)
  }

  // Untagged and forged: the review's MEDIUM finding.
  it('credits 0 when untagged', () => {
    const parsed = parseVoucherToken(
      cashuB([
        { amount: 1, secret: signedSecret(nonce(1), '1') },
        { amount: 1024, secret: forged(nonce(2)) },
      ]),
    )

    expect(verifyVoucher(parsed.voucher).signatureValid).toBe(true)
    expect(parsed.creditableSats).toBe(1)
    expect(creditableFaceValue(parsed).faceValue).toBe(Math.round(1 * RATIO))
  })

  // Forged with a generous bound it wrote itself.
  it('credits 0 when it carries a bound of its own', () => {
    const parsed = parseVoucherToken(
      cashuB([
        { amount: 1, secret: signedSecret(nonce(1), '1') },
        { amount: 1024, secret: forged(nonce(2), '1024') },
      ]),
    )

    expect(parsed.creditableSats).toBe(1)
  })

  // Validly signed, but by a different key than proof 0's issuer.
  it('credits 0 when signed by another key', () => {
    const otherPriv = schnorr.utils.randomSecretKey()
    const otherPub = bytesToHex(schnorr.getPublicKey(otherPriv))
    const theirs = JSON.parse(signedSecret(nonce(2), '1024')) as [string, { tags: string[][] }]
    const tags = theirs[1].tags.filter((t) => t[0] !== 'issuer_sig' && t[0] !== 'issuer_pubkey')
    const rendered = tags
      .map(([key, ...values]) =>
        `["${key}"${values.map((v) => ',' + (['face_value', 'issuance_ratio'].includes(key) ? v : `"${v}"`)).join('')}]`,
      )
      .join(',')
    const canonical = new TextEncoder().encode(`["P2PK_VOUCHER","${LOCK_KEY}","${nonce(2)}",[${rendered}]]`)
    const sig = bytesToHex(schnorr.sign(sha256(canonical), otherPriv))
    theirs[1].tags = [...tags, ['issuer_sig', sig], ['issuer_pubkey', otherPub]]

    const parsed = parseVoucherToken(
      cashuB([
        { amount: 1, secret: signedSecret(nonce(1), '1') },
        { amount: 1024, secret: JSON.stringify(theirs) },
      ]),
    )

    expect(parsed.creditableSats).toBe(1)
  })
})

describe('a malformed max_sats', () => {
  // Present but unreadable is not absent: reading it as absent would be a downgrade.
  it.each([['01'], ['1e3'], ['1.0'], ['0'], ['-1'], ['+1'], [' 1'], [''], ['99999999999999999']])(
    'credits 0 sats when written as "%s"',
    (wire) => {
      const parsed = parseVoucherToken(cashuB([{ amount: 1024, secret: signedSecret(nonce(1), wire) }]))

      expect(parsed.creditableSats).toBe(0)
      expect(creditableFaceValue(parsed).faceValue).toBe(0)
    },
  )

  // Two values in one tag are two claims.
  it('credits 0 sats when the tag has two values', () => {
    const parsed = parseVoucherToken(cashuB([{ amount: 8, secret: signedSecret(nonce(1), ['1', '1024']) }]))

    expect(parsed.creditableSats).toBe(0)
  })
})

describe('satBoundOf', () => {
  // The unlocked kind keeps its fields in a blob and never carries a bound.
  it('reads a non-locked secret as absent', () => {
    expect(satBoundOf('["VOUCHER","00","n",[]]')).toEqual({ kind: 'absent' })
    expect(satBoundOf('not json')).toEqual({ kind: 'absent' })
  })

  // A second max_sats row is refused rather than first-wins or last-wins.
  it('reads two max_sats tags as malformed', () => {
    const secret = JSON.stringify([
      'P2PK_VOUCHER',
      { nonce: 'n', data: LOCK_KEY, tags: [['max_sats', '1'], ['max_sats', '1024']] },
    ])

    expect(satBoundOf(secret)).toEqual({ kind: 'malformed' })
  })
})

describe('the sender receipt figure', () => {
  // pay.ts overrides tokenAmount with the sent sats; the smaller of that and the bound wins.
  it('takes the smaller of an overridden tokenAmount and the bound', () => {
    const parsed = parseVoucherToken(cashuB([{ amount: 1024, secret: signedSecret(nonce(1), '8') }]))

    expect(creditableFaceValue({ ...parsed, tokenAmount: 4 }).faceValue).toBe(2)
    expect(creditableFaceValue({ ...parsed, tokenAmount: 100 }).faceValue).toBe(4)
  })
})

describe('a max_sats secret signed by the Java issuer', () => {
  /**
   * Cross-language canonical bytes. These secrets were signed by cashu-voucher's
   * `SignedLockedVoucher.createSigned`, the code the gateway signs successors
   * with. If the TS reader rendered `["max_sats","1"]` any differently from
   * `VoucherCanonicalBytes`, the signature would not verify here.
   */
  const fixture = JSON.parse(
    readFileSync('src/lib/__tests__/fixtures/java-max-sats-secrets.json', 'utf8'),
  ) as { bound1: string; bound64: string }

  // The Java signature covers the bound, and the TS reader agrees on the bytes.
  it('verifies in TS', () => {
    for (const secret of [fixture.bound1, fixture.bound64]) {
      const parsed = parseVoucherToken(cashuB([{ amount: 1024, secret }]))

      expect(verifyVoucher(parsed.voucher).signatureValid).toBe(true)
    }
  })

  // And the bound it carries is the one credited.
  it('is credited for its signed bound', () => {
    const parsed = parseVoucherToken(cashuB([{ amount: 1024, secret: fixture.bound1 }]))

    expect(parsed.creditableSats).toBe(1)
    expect(creditableFaceValue(parsed).faceValue).toBe(Math.round(1 * 0.5))
  })

  // Raising the bound after Java signed it breaks the signature.
  it('no longer verifies once the bound is raised', () => {
    const tampered = fixture.bound1.replace('["max_sats","1"]', '["max_sats","1024"]')
    const parsed = parseVoucherToken(cashuB([{ amount: 1024, secret: tampered }]))

    expect(tampered).not.toBe(fixture.bound1)
    expect(verifyVoucher(parsed.voucher).signatureValid).toBe(false)
  })
})
