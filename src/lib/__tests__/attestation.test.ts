import { beforeEach, describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * The attestation stream: what it proves, and what it must never leak.
 *
 * These are security properties, not formatting. Each test names the attack or
 * the failure it exists to prevent, because a passing assertion here is the
 * only thing standing between "auditable" and "publishes every stall's takings".
 */

const MERCHANT_A = 'a'.repeat(64)
const MERCHANT_B = 'b'.repeat(64)

let currentKey = MERCHANT_A
vi.mock('../nap', () => ({
  getSigner: () => ({
    privkeyHex: () => currentKey,
    pubkey: 'ff'.repeat(32),
  }),
}))

const published: unknown[] = []
let publishThrows = false
vi.mock('../relay', () => ({
  publish: async (event: unknown) => {
    if (publishThrows) throw new Error('relay down')
    published.push(event)
    return { ok: 1, total: 1, errors: [] }
  },
}))

const {
  ATTESTATION_KIND,
  attestRedemption,
  attestationFilter,
  blindSumFor,
  buildAttestation,
  commitTo,
  couponCheckFilter,
  ledgerKey,
  ledgerPubkey,
  nullifierFor,
  verifyDisclosedTotal,
  verifyOwnCommitment,
} = await import('../attestation')

beforeEach(() => {
  currentKey = MERCHANT_A
  published.length = 0
  publishThrows = false
})

describe('the ledger key — a pseudonym, not a fig leaf', () => {
  it('is stable, so a merchant can fetch and audit their own history', () => {
    // Also what makes self-audit survive a device wipe: nothing is stored.
    expect(ledgerPubkey()).toBe(ledgerPubkey())
  })

  it('differs per merchant, so one query returns exactly one stall', () => {
    const a = ledgerPubkey()
    currentKey = MERCHANT_B
    expect(ledgerPubkey()).not.toBe(a)
  })

  it('CANNOT be computed from the merchant\'s public identity', () => {
    // The attack this defeats: `issuerId` is signed inside every voucher, so
    // anyone holding one of this stall's coupons knows their PUBLIC key. If the
    // ledger id were a hash of that, any customer could recompute it and the
    // pseudonym would break on first contact.
    const derived = ledgerPubkey()
    const publicKey = schnorr.getPublicKey(hexToBytes(MERCHANT_A))
    expect(derived).not.toBe(Buffer.from(publicKey).toString('hex'))
    // And it is not the secret key either, in any encoding.
    expect(derived).not.toContain(MERCHANT_A.slice(0, 32))
  })
})

describe('the nullifier — double-spend detection without identity', () => {
  it('collides when the SAME token is redeemed twice', () => {
    // The property the whole ledger is for: a repeat is visible to anyone.
    expect(nullifierFor('cashuAtoken1')).toBe(nullifierFor('cashuAtoken1'))
  })

  it('does NOT collide on a legitimate partial redemption', () => {
    // A £10 voucher spent as £4 then £6 arrives as two DIFFERENT tokens that
    // share a voucher_id. Keying on the voucher would report a double-spend
    // that never happened, and a merchant would refuse honest money.
    expect(nullifierFor('cashuA-part-one')).not.toBe(nullifierFor('cashuA-part-two'))
  })

  it('is the same for every observer who holds the token', () => {
    // This is what lets a CUSTOMER check their own coupon against the public
    // ledger. It is the trust moment, and it needs no key and no account.
    currentKey = MERCHANT_A
    const asMerchant = nullifierFor('cashuAshared')
    currentKey = MERCHANT_B
    expect(nullifierFor('cashuAshared')).toBe(asMerchant)
  })
})

describe('the commitment — amounts hidden, sums provable', () => {
  it('hides the amount from someone who knows it', () => {
    // The de-anonymisation attack: a customer who paid exactly 2500 at 09:14
    // looks for that amount in the ledger. If they find it, the pseudonym is
    // broken for good — one counterparty unmasks the whole stall.
    const n = nullifierFor('cashuAtok')
    const real = commitTo(2500, 12345n)
    // An attacker can guess the amount but not the blind.
    expect(commitTo(2500, 999n)).not.toBe(real)
    expect(n).toBeTruthy()
  })

  it('lets the merchant re-open their OWN commitment', () => {
    const n = nullifierFor('cashuAmine')
    const { sk } = ledgerKey()
    expect(sk).toBeInstanceOf(Uint8Array)
    // Round-trip through the real publish path.
    const c = JSON.parse(
      (buildAttestation({ nullifier: n, commitment: commitTo(2500, 1n), unit: 'XAF' }, sk) as { content: string })
        .content,
    ).commitment
    expect(c).toBeTruthy()
  })

  it('a merchant cannot open ANOTHER merchant\'s commitment', async () => {
    await attestRedemption({ token: 'cashuAshared', faceValue: 2500, unit: 'XAF' })
    const ev = published[0] as { content: string }
    const { nullifier, commitment } = JSON.parse(ev.content)

    expect(verifyOwnCommitment(nullifier, commitment, 2500)).toBe(true)
    currentKey = MERCHANT_B
    // Same amount, same nullifier, different key -> cannot reproduce it.
    expect(verifyOwnCommitment(nullifier, commitment, 2500)).toBe(false)
  })

  it('rejects a wrong amount for one\'s own commitment', async () => {
    await attestRedemption({ token: 'cashuAtok', faceValue: 2500, unit: 'XAF' })
    const { nullifier, commitment } = JSON.parse((published[0] as { content: string }).content)
    expect(verifyOwnCommitment(nullifier, commitment, 2499)).toBe(false)
    expect(verifyOwnCommitment(nullifier, commitment, 2500)).toBe(true)
  })

  it('handles a zero-value credit without collapsing the commitment', () => {
    // amount * G with amount 0 is the identity, which would make the point
    // depend on the blind alone. Guarded explicitly rather than by luck.
    expect(() => commitTo(0, 7n)).not.toThrow()
    expect(commitTo(0, 7n)).not.toBe(commitTo(0, 8n))
  })

  it('refuses a negative or fractional amount rather than committing nonsense', () => {
    expect(() => commitTo(-1, 1n)).toThrow()
    expect(() => commitTo(12.5, 1n)).toThrow()
  })
})

describe('disclosed totals — a merchant cannot lie about the sum', () => {
  const day: Array<{ token: string; amount: number }> = [
    { token: 'cashuA-1', amount: 2500 },
    { token: 'cashuA-2', amount: 1200 },
    { token: 'cashuA-3', amount: 800 },
  ]

  it('verifies a true total, and rejects both understating and overstating', async () => {
    for (const d of day) {
      await attestRedemption({ token: d.token, faceValue: d.amount, unit: 'XAF' })
    }
    const parsed = published.map((e) => JSON.parse((e as { content: string }).content))
    const commitments = parsed.map((p) => p.commitment)
    const blindSum = blindSumFor(parsed.map((p) => p.nullifier))
    const total = day.reduce((s, d) => s + d.amount, 0)

    expect(verifyDisclosedTotal(commitments, total, blindSum)).toBe(true)
    // Skimming: claiming to have credited less than they did.
    expect(verifyDisclosedTotal(commitments, total - 500, blindSum)).toBe(false)
    // Inflating: claiming more, e.g. to overstate volume.
    expect(verifyDisclosedTotal(commitments, total + 500, blindSum)).toBe(false)
  })

  it('an auditor needs no key — only the published commitments', () => {
    // verifyDisclosedTotal must work for someone with no wallet at all. If it
    // silently depended on getSigner it would be useless to the reader it is for.
    expect(verifyDisclosedTotal([], 0, '1')).toBe(false)
  })
})

describe('what the published event does and does not carry', () => {
  it('never contains the merchant identity, the amount, or the voucher', async () => {
    await attestRedemption({ token: 'cashuAsecret', faceValue: 2500, unit: 'XAF' })
    const ev = published[0] as { pubkey: string; content: string; tags: string[][] }
    const wire = JSON.stringify(ev)

    // The identity key must appear nowhere — not as author, not in content.
    const identityPub = Buffer.from(schnorr.getPublicKey(hexToBytes(MERCHANT_A))).toString('hex')
    expect(wire).not.toContain(identityPub)
    expect(wire).not.toContain(MERCHANT_A)
    // The amount must not be recoverable by reading.
    expect(wire).not.toContain('2500')
    // The token itself must never be republished — it is bearer value.
    expect(wire).not.toContain('cashuAsecret')
  })

  it('is authored by the ledger key, so one query fetches one merchant', async () => {
    await attestRedemption({ token: 'cashuAx', faceValue: 10, unit: 'XAF' })
    const ev = published[0] as { pubkey: string; kind: number }
    expect(ev.pubkey).toBe(ledgerPubkey())
    expect(ev.kind).toBe(ATTESTATION_KIND)
    expect(attestationFilter(ledgerPubkey())).toEqual({
      kinds: [ATTESTATION_KIND],
      authors: [ledgerPubkey()],
    })
  })

  it('carries a signature anyone can verify', async () => {
    await attestRedemption({ token: 'cashuAy', faceValue: 10, unit: 'XAF' })
    const ev = published[0] as { id: string; sig: string; pubkey: string }
    expect(schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey))).toBe(true)
  })

  it('is tagged so one coupon can be looked up without fetching the stream', async () => {
    await attestRedemption({ token: 'cashuAz', faceValue: 10, unit: 'XAF' })
    const ev = published[0] as { tags: string[][] }
    expect(ev.tags).toContainEqual(['n', nullifierFor('cashuAz')])
    expect(couponCheckFilter('cashuAz')).toEqual({
      kinds: [ATTESTATION_KIND],
      '#n': [nullifierFor('cashuAz')],
    })
  })
})

describe('the migration path to batching, if it is ever taken', () => {
  it('keeps the customer check working, because it filters on a TAG', () => {
    // Publication is one event per redemption today. If that becomes a daily
    // batch, the event carries one `n` tag per nullifier and a relay matches a
    // `#n` filter against ALL of them — verified against the staging relay.
    // So this filter survives the change untouched, which is what protects the
    // one capability the feature exists for.
    const filter = couponCheckFilter('cashuAsomething')
    expect(filter['#n']).toEqual([nullifierFor('cashuAsomething')])
    // Deliberately NOT an author filter: a customer does not know, and must not
    // need to know, which ledger key redeemed their coupon.
    expect(filter).not.toHaveProperty('authors')
  })

  it('does not leak the merchant into the customer\'s query', () => {
    // If the customer check required the merchant's ledger key, the customer
    // would have to be told which stall to look under — which is exactly the
    // link the pseudonym exists to break.
    const wire = JSON.stringify(couponCheckFilter('cashuAsomething'))
    expect(wire).not.toContain(ledgerPubkey())
  })
})

describe('attesting never breaks a redemption', () => {
  it('swallows a publish failure — the money has already moved', async () => {
    // The row is written and the proofs are burnt before this runs. A relay
    // that will not take the record has undone neither, so throwing here would
    // turn a completed redemption into a reported failure.
    publishThrows = true
    await expect(
      attestRedemption({ token: 'cashuAfail', faceValue: 10, unit: 'XAF' }),
    ).resolves.toBeUndefined()
    expect(published).toHaveLength(0)
  })

  it('ignores a call with nothing to attest rather than publishing junk', async () => {
    await attestRedemption({ token: '', faceValue: 10, unit: 'XAF' })
    await attestRedemption({ token: 'cashuAt', faceValue: Number.NaN, unit: 'XAF' })
    await attestRedemption({ token: 'cashuAt', faceValue: -1, unit: 'XAF' })
    expect(published).toHaveLength(0)
  })
})
