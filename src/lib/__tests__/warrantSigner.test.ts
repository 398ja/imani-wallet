/**
 * Signing a warrant at the counter.
 *
 * The property that matters here is not "a signature is produced" but "the
 * signature verifies against `issuerId`". Those come apart on a terminal, whose
 * device key is disposable and is not the stall's, and a build that signed
 * anyway would mint coupons that are refused at redemption by the merchant who
 * issued them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import { buildIssuanceWarrant } from '../warrantSigner'
import { parseIssuanceWarrant, verifyIssuanceWarrant } from '../issuanceWarrant'
import type { Actor } from '../actor'

const STALL_SK = 'c'.repeat(63) + '3'
const STALL = bytesToHex(schnorr.getPublicKey(hexToBytes(STALL_SK)))

const OTHER_SK = 'd'.repeat(63) + '4'
const OTHER = bytesToHex(schnorr.getPublicKey(hexToBytes(OTHER_SK)))

const owner: Actor = { kind: 'owner', stallPubkey: STALL }
const terminal: Actor = {
  kind: 'terminal',
  stallPubkey: STALL,
  terminalPubkey: OTHER,
  role: 'issue-and-redeem',
} as Actor

/** The coupon a warrant is checked against: EUR, 2 decimals, given value. */
function coupon(faceValueMinor: number, unit = 'EUR', faceDecimals = 2) {
  return { faceValueMinor, unit, faceDecimals }
}

/** A signer standing in for an unlocked wallet holding `sk`. */
function signerFor(sk: string) {
  return {
    pubkey: bytesToHex(schnorr.getPublicKey(hexToBytes(sk))),
    // Named `borrow` rather than `use` only because eslint's react-hooks rule
    // reads a bare `use(...)` call as a React hook. The real signature in
    // signer.ts names it `use`; this is a lint artefact, not a difference.
    withPrivkey: <T,>(borrow: (key: Uint8Array) => T): T => borrow(hexToBytes(sk)),
  }
}

let mockSigner: ReturnType<typeof signerFor> | null = signerFor(STALL_SK)

vi.mock('../nap', () => ({
  getSigner: () => {
    if (!mockSigner) throw new Error('No signer — the wallet has not been unlocked.')
    return mockSigner
  },
}))

beforeEach(() => {
  mockSigner = signerFor(STALL_SK)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('an owner signs a verifiable merchant warrant', () => {
  it('produces a warrant that verifies against the stall', async () => {
    const json = await buildIssuanceWarrant(owner, 2500, 2, 'EUR')
    expect(json).toBeDefined()

    const warrant = parseIssuanceWarrant(json)
    expect(warrant.state).toBe('present')

    // The round trip that matters: signed here, verified by the same code a
    // redeeming merchant runs.
    expect(verifyIssuanceWarrant(warrant, STALL, coupon(2500))).toEqual({ verdict: 'verified' })
  })

  it('covers the SALE, so every part of a split still verifies', async () => {
    // One sale, three coupons. The device could not know there would be three.
    const json = await buildIssuanceWarrant(owner, 2500, 2, 'EUR')
    const warrant = parseIssuanceWarrant(json)

    for (const part of [834, 833, 833]) {
      expect(verifyIssuanceWarrant(warrant, STALL, coupon(part)).verdict).toBe('verified')
    }
  })

  it('does not authorise a coupon larger than the sale', async () => {
    const json = await buildIssuanceWarrant(owner, 2500, 2, 'EUR')
    const warrant = parseIssuanceWarrant(json)

    expect(verifyIssuanceWarrant(warrant, STALL, coupon(5_000_000)).verdict).toBe('failed')
  })

  it('uses a fresh nonce per sale', async () => {
    // Two identical sales must not share a digest, or a warrant observed on the
    // first authorises coupons from the second.
    const a = parseIssuanceWarrant(await buildIssuanceWarrant(owner, 2500, 2, 'EUR'))
    const b = parseIssuanceWarrant(await buildIssuanceWarrant(owner, 2500, 2, 'EUR'))

    expect(a.state).toBe('present')
    expect(b.state).toBe('present')
    if (a.state !== 'present' || b.state !== 'present') return
    expect(a.saleNonce).not.toBe(b.saleNonce)
  })
})

describe('a terminal cannot sign a merchant warrant, and says so', () => {
  it('emits a signed `none` rather than a signature that cannot verify', async () => {
    // A terminal's key is disposable and is NOT the stall's. Signing with it
    // would produce coupons refused at redemption by the merchant who issued
    // them - worse than issuing unwarranted.
    mockSigner = signerFor(OTHER_SK)

    const json = await buildIssuanceWarrant(terminal, 2500, 2, 'EUR')

    expect(parseIssuanceWarrant(json)).toEqual({ state: 'declared-none' })
  })

  it('`none` is distinguishable from an absent warrant', async () => {
    // The whole reason `none` exists. Absent means the coupon predates
    // warrants; `none` is a statement the issuer signed.
    mockSigner = signerFor(OTHER_SK)
    const json = await buildIssuanceWarrant(terminal, 2500, 2, 'EUR')

    expect(parseIssuanceWarrant(json).state).toBe('declared-none')
    expect(parseIssuanceWarrant(undefined).state).toBe('absent-legacy')
  })
})

describe('refusing to sign something unverifiable', () => {
  it('emits `none` when the signer is not the issuing stall', async () => {
    // Defensive: an owner actor whose signer has drifted from the stall key.
    // Signing here would mint coupons nobody can redeem, so issue unwarranted.
    mockSigner = signerFor(OTHER_SK)

    const json = await buildIssuanceWarrant(owner, 2500, 2, 'EUR')

    expect(parseIssuanceWarrant(json)).toEqual({ state: 'declared-none' })
  })

  it('omits the warrant entirely when the wallet is locked', async () => {
    // Not a `none`: we could not have signed the alternative either. The sale
    // proceeds unwarranted, which is the status quo.
    mockSigner = null

    expect(await buildIssuanceWarrant(owner, 2500, 2, 'EUR')).toBeUndefined()
  })
})

describe('the digest binds what it claims to bind', () => {
  it('a warrant for one currency does not verify for another', async () => {
    const json = await buildIssuanceWarrant(owner, 2500, 2, 'EUR')
    const warrant = parseIssuanceWarrant(json)
    expect(warrant.state).toBe('present')
    if (warrant.state !== 'present') return

    // Rewrite only the unit, keeping the signature. The digest moves.
    const tampered = parseIssuanceWarrant(
      JSON.stringify({
        form: 'merchant',
        sale_total: warrant.saleTotalMinor,
        face_decimals: warrant.faceDecimals,
        unit: 'XAF',
        nonce: warrant.saleNonce,
        sig: warrant.signature,
      }),
    )

    expect(verifyIssuanceWarrant(tampered, STALL, coupon(2500)).verdict).toBe('failed')
  })
})


describe('an actor must be real, not fabricated at the call site', () => {
  // Found in review. The cashback page built `{ kind: 'owner', stallPubkey }`
  // by hand to sign with, which asserts owner-ness of whatever device is
  // running - including a terminal, whose key is NOT the stall's. That bypasses
  // the kind check below entirely.
  //
  // It was fail-safe, because the signer ALSO compares its own pubkey to the
  // stall and falls back. But relying on the defensive check instead of the
  // deliberate one is how a later edit removes the backstop and nobody notices,
  // so both are pinned here.
  it('refuses to sign as the stall when the signer is a terminal key', async () => {
    mockSigner = signerFor(OTHER_SK)

    // A fabricated owner actor, exactly as the buggy call site built one.
    const fabricated = { kind: 'owner', stallPubkey: STALL } as Actor

    const json = await buildIssuanceWarrant(fabricated, 2500, 2, 'EUR')

    // The pubkey mismatch catches it even though the actor claims otherwise.
    expect(parseIssuanceWarrant(json)).toEqual({ state: 'declared-none' })
  })

  it('a real terminal actor never reaches the signing path at all', async () => {
    // The deliberate guard, which is the one that should be doing this work.
    mockSigner = signerFor(STALL_SK)

    const json = await buildIssuanceWarrant(terminal, 2500, 2, 'EUR')

    expect(parseIssuanceWarrant(json)).toEqual({ state: 'declared-none' })
  })
})
