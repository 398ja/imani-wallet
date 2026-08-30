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
let signerThrows = false
vi.mock('../nap', () => ({
  getSigner: () => {
    // What a locked wallet — or an auditor with no wallet at all — looks like.
    if (signerThrows) throw new Error('No signer — the wallet has not been unlocked.')
    return { privkeyHex: () => currentKey, pubkey: 'ff'.repeat(32) }
  },
}))

const published: unknown[] = []
let publishThrows = false
/** What the relay answers a publish with. Zero = nobody took the record. */
let publishOk = 1
// `id` and `created_at` are read by the sweep to build a receipt (DEV-246), so
// a stub relay has to carry them as a real event would.
let relayHas: { id?: string; created_at?: number; tags: string[][]; content: string }[] = []

vi.mock('../relay', () => ({
  publish: async (event: unknown) => {
    if (publishThrows) throw new Error('relay down')
    if (publishOk > 0) published.push(event)
    return { ok: publishOk, total: 1, errors: publishOk === 0 ? ['refused'] : [] }
  },
  allEvents: async () => relayHas,
}))

const {
  ATTESTATION_KIND,
  attestRedemption,
  blindSumFor,
  commitTo,
  couponCheckFilter,
  ledgerPubkey,
  nullifierFor,
  reconcileAttestations,
  verifyDisclosedTotal,
  verifyOwnCommitment,
} = await import('../attestation')

beforeEach(() => {
  currentKey = MERCHANT_A
  published.length = 0
  publishThrows = false
  publishOk = 1
  signerThrows = false
})

describe('the ledger key — a pseudonym, not a fig leaf', () => {
  it('is re-derivable from the key alone, on a device that stores nothing', () => {
    // Asserting the DERIVATION, not that a pure function is pure. A wiped
    // device has only the merchant's key; if the ledger identity depended on
    // anything else, it could not be rebuilt and the merchant would lose
    // access to their own published history.
    const onThisDevice = ledgerPubkey()
    currentKey = MERCHANT_B // simulate another wallet entirely
    expect(ledgerPubkey()).not.toBe(onThisDevice)
    currentKey = MERCHANT_A // restore: same key in, same identity out
    expect(ledgerPubkey()).toBe(onThisDevice)
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

  it('lets the merchant re-open their OWN commitment', async () => {
    // Through the public surface: `ledgerKey` is module-private now, because a
    // function handing out the raw ledger SECRET is a footgun no matter who
    // currently calls it. Re-opening is what a merchant actually does, and
    // `verifyOwnCommitment` is the API for it.
    await attestRedemption({ token: 'cashuAmine', faceValue: 2500, unit: 'XAF', signatureValid: true })
    const { nullifier, commitment } = JSON.parse((published[0] as { content: string }).content)
    expect(verifyOwnCommitment(nullifier, commitment, 2500)).toBe(true)
    expect(verifyOwnCommitment(nullifier, commitment, 2501)).toBe(false)
  })

  it('derives the SAME ledger identity from uppercase hex, so a restore cannot orphan history', () => {
    // Hashing the hex STRING binds the pseudonym to an encoding: `privkeyHex()`
    // returns whatever was passed to setKey, which does not normalise case. A
    // merchant restoring their key in uppercase would have silently become a
    // different ledger and lost their whole published history.
    const lower = ledgerPubkey()
    currentKey = currentKey.toUpperCase()
    expect(ledgerPubkey()).toBe(lower)
  })

  it('a merchant cannot open ANOTHER merchant\'s commitment', async () => {
    await attestRedemption({ token: 'cashuAshared', faceValue: 2500, unit: 'XAF', signatureValid: true })
    const ev = published[0] as { content: string }
    const { nullifier, commitment } = JSON.parse(ev.content)

    expect(verifyOwnCommitment(nullifier, commitment, 2500)).toBe(true)
    currentKey = MERCHANT_B
    // Same amount, same nullifier, different key -> cannot reproduce it.
    expect(verifyOwnCommitment(nullifier, commitment, 2500)).toBe(false)
  })

  it('rejects a wrong amount for one\'s own commitment', async () => {
    await attestRedemption({ token: 'cashuAtok', faceValue: 2500, unit: 'XAF', signatureValid: true })
    const { nullifier, commitment } = JSON.parse((published[0] as { content: string }).content)
    expect(verifyOwnCommitment(nullifier, commitment, 2499)).toBe(false)
    expect(verifyOwnCommitment(nullifier, commitment, 2500)).toBe(true)
  })

  it('handles a zero-value credit without collapsing the commitment', () => {
    // The zero branch avoids an EXCEPTION, not an identity point: verified on
    // @noble/curves that `multiply(0n)` throws "invalid scalar: out of range"
    // rather than returning the identity. So a zero-value commitment has to
    // skip the G term entirely, and what it commits to is the blind alone —
    // which is correct, since 0*G contributes nothing anyway.
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
      await attestRedemption({ token: d.token, faceValue: d.amount, unit: 'XAF', signatureValid: true })
    }
    const parsed = published.map((e) => JSON.parse((e as { content: string }).content))
    const commitments = parsed.map((p) => p.commitment)
    const blindSum = blindSumFor(parsed.map((p) => ({ nullifier: p.nullifier, unit: p.unit })))
    const total = day.reduce((s, d) => s + d.amount, 0)

    expect(verifyDisclosedTotal(commitments, total, blindSum)).toBe(true)
    // Skimming: claiming to have credited less than they did.
    expect(verifyDisclosedTotal(commitments, total - 500, blindSum)).toBe(false)
    // Inflating: claiming more, e.g. to overstate volume.
    expect(verifyDisclosedTotal(commitments, total + 500, blindSum)).toBe(false)
  })

  it('an auditor needs no key — verified with the signer removed entirely', async () => {
    // The earlier version of this test passed an empty array and hit the
    // length-0 early return, so it would have passed even if the next line
    // called getSigner(). This drives the REAL path with a signer that throws,
    // which is what an auditor with no wallet actually looks like.
    for (const d of day) {
      await attestRedemption({ token: d.token, faceValue: d.amount, unit: 'XAF', signatureValid: true })
    }
    const parsed = published.map((e) => JSON.parse((e as { content: string }).content))
    const commitments = parsed.map((p) => p.commitment)
    const blindSum = blindSumFor(parsed.map((p) => ({ nullifier: p.nullifier, unit: p.unit })))
    const total = day.reduce((s, d) => s + d.amount, 0)

    signerThrows = true
    expect(verifyDisclosedTotal(commitments, total, blindSum)).toBe(true)
    expect(verifyDisclosedTotal(commitments, total + 1, blindSum)).toBe(false)
  })
})

describe('what the published event does and does not carry', () => {
  it('never contains the merchant identity, the amount, or the voucher', async () => {
    await attestRedemption({ token: 'cashuAsecret', faceValue: 2500, unit: 'XAF', signatureValid: true })
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
    await attestRedemption({ token: 'cashuAx', faceValue: 10, unit: 'XAF', signatureValid: true })
    const ev = published[0] as { pubkey: string; kind: number }
    expect(ev.pubkey).toBe(ledgerPubkey())
    expect(ev.kind).toBe(ATTESTATION_KIND)
  })

  it('carries a signature anyone can verify', async () => {
    await attestRedemption({ token: 'cashuAy', faceValue: 10, unit: 'XAF', signatureValid: true })
    const ev = published[0] as { id: string; sig: string; pubkey: string }
    expect(schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey))).toBe(true)
  })

  it('is tagged so one coupon can be looked up without fetching the stream', async () => {
    await attestRedemption({ token: 'cashuAz', faceValue: 10, unit: 'XAF', signatureValid: true })
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
      attestRedemption({ token: 'cashuAfail', faceValue: 10, unit: 'XAF', signatureValid: true }),
      // Null, not a throw AND not a receipt: nothing was published, so there is
      // nothing to record on the row.
    ).resolves.toBeNull()
    expect(published).toHaveLength(0)
  })

  describe('the receipt it hands back (DEV-246)', () => {
    it('names the event that was published, so the row can point at it', async () => {
      const receipt = await attestRedemption({
        token: 'cashuA-receipted',
        faceValue: 2500,
        unit: 'XAF',
        signatureValid: true,
      })
      const event = published[0] as { id: string; created_at: number }
      expect(receipt).toEqual({
        nullifier: nullifierFor('cashuA-receipted'),
        eventId: event.id,
        // Milliseconds, converted from the event's own `created_at` seconds —
        // NOT `Date.now()`. A sweep can publish long after the redemption, and
        // the receipt has to date the publication.
        at: event.created_at * 1000,
      })
    })

    it('gives NO receipt when no relay accepted the record', async () => {
      // The load-bearing case. A row stamped from this would claim a public
      // record that nothing holds — worse than showing nothing, because it
      // tells a merchant they are covered when they are not. The sweep is what
      // finds this later.
      publishOk = 0
      await expect(
        attestRedemption({ token: 'cashuA-nobody', faceValue: 10, unit: 'XAF', signatureValid: true }),
      ).resolves.toBeNull()
    })

    it('gives no receipt for a coupon that never qualified', async () => {
      // Plain ecash carries no issuer claim, so nothing is published and there
      // is nothing to receipt. A UI keyed on the receipt therefore shows no
      // ledger line here, which is correct.
      await expect(
        attestRedemption({ token: 'cashuAplain', faceValue: 10, unit: 'XAF', signatureValid: false }),
      ).resolves.toBeNull()
      expect(published).toHaveLength(0)
    })
  })

  describe('what a disclosure refuses to do', () => {
    it('refuses to sum blinds across two currencies', () => {
      // The sum would verify perfectly and mean nothing: the curve does not
      // know what the scalars denominate, so a "total" over XAF and EUR is
      // arithmetic on unlike things. Only catchable here — by the time an
      // auditor sees the total, the units are gone.
      expect(() =>
        blindSumFor([
          { nullifier: nullifierFor('a'), unit: 'XAF' },
          { nullifier: nullifierFor('b'), unit: 'EUR' },
        ]),
      ).toThrow(/one unit/)
    })

    it('rejects an uncompressed commitment rather than silently failing to reconcile', () => {
      // Point.fromHex accepts 65-byte uncompressed input, but the comparison is
      // against toHex(true). An honestly-formatted uncompressed commitment
      // would report "does not reconcile" for a CORRECT set, which is worse
      // than refusing the input.
      // A GENUINE point in uncompressed form. An earlier version of this test
      // used '04' + garbage, which fromHex rejects as "not on curve" — so it
      // passed while the guard was removed, and proved nothing. Caught by
      // mutation-testing the guard away.
      const real = commitTo(2500, 7n)
      const uncompressed = schnorr.Point.fromHex(real).toHex(false)
      expect(uncompressed).toHaveLength(130)
      expect(verifyDisclosedTotal([uncompressed], 2500, '7')).toBe(false)
    })

    it('reconciles a blind sum that was not reduced mod n', () => {
      // An out-of-range scalar from a tool that does not reduce is
      // arithmetically equal to the reduced one; failing it would be a false
      // negative against a correct disclosure.
      const n = nullifierFor('cashuA-modn')
      const c = commitTo(2500, 7n)
      const overflowed = (7n + schnorr.Point.Fn.ORDER).toString(16)
      expect(n).toBeTruthy()
      expect(verifyDisclosedTotal([c], 2500, overflowed)).toBe(true)
    })
  })

  describe('the reconciliation sweep that makes absence meaningful', () => {
    beforeEach(() => {
      relayHas = []
    })

    it('republishes only the redemptions the relay never received', async () => {
      const present = nullifierFor('cashuA-landed')
      const gap = nullifierFor('cashuA-lost')
      relayHas = [{ tags: [['n', present]], content: '{}' }]

      const out = await reconcileAttestations([
        { attestationNullifier: present, attestedValue: 2500, attestedUnit: 'XAF' },
        { attestationNullifier: gap, attestedValue: 1800, attestedUnit: 'XAF' },
      ])

      expect(out).toEqual({ checked: 2, missing: 1, republished: 1 })
      expect(published).toHaveLength(1)
      expect(JSON.parse((published[0] as { content: string }).content).nullifier).toBe(gap)
    })

    it('reproduces a byte-identical commitment, so a republish cannot conflict', async () => {
      // The idempotence claim in the comment: derived (not random) blinds mean
      // a retry after a partial relay failure republishes the SAME commitment
      // rather than a second, contradictory one for the same redemption.
      const n = nullifierFor('cashuA-retry')
      const row = { attestationNullifier: n, attestedValue: 2500, unit: 'XAF' }
      await reconcileAttestations([row])
      await reconcileAttestations([row])
      const [a, b] = published as { content: string }[]
      expect(JSON.parse(a.content).commitment).toBe(JSON.parse(b.content).commitment)
    })

    it('commits the attested face value, never the row amount, when they differ', async () => {
      // The row's `amount` comes off the voucher (token_amount); the
      // attestation committed `meta.faceValue`. Where they disagree, a sweep
      // reading `amount` republishes a SECOND, conflicting commitment for one
      // redemption — strictly worse than the gap it meant to close.
      const n = nullifierFor('cashuA-divergent')
      await reconcileAttestations([
        { attestationNullifier: n, attestedValue: 2500, attestedUnit: 'XAF', amount: 9999 },
      ])
      const { commitment } = JSON.parse((published[0] as { content: string }).content)
      expect(verifyOwnCommitment(n, commitment, 2500)).toBe(true)
      expect(verifyOwnCommitment(n, commitment, 9999)).toBe(false)
    })

    it('skips rows with no nullifier instead of reporting them as gaps', async () => {
      // Rows predating the feature, or that never qualified. Counting these as
      // gaps would make the sweep report permanent phantom omissions.
      const out = await reconcileAttestations([
        { attestedValue: 2500, attestedUnit: 'XAF' },
        { attestedValue: 900, attestedUnit: 'XAF' },
      ])
      expect(out).toEqual({ checked: 0, missing: 0, republished: 0 })
      expect(published).toHaveLength(0)
    })

    it('does not republish a gap whose amount is no longer known locally', async () => {
      // A nullifier alone attests nothing; there is no commitment to make.
      const out = await reconcileAttestations([
        { attestationNullifier: nullifierFor('cashuA-amountless') },
      ])
      expect(out).toEqual({ checked: 1, missing: 1, republished: 0 })
      expect(published).toHaveLength(0)
    })

    describe('stamping the receipt back onto the row (DEV-246)', () => {
      it('stamps a gap it republished, so the row can show its record', async () => {
        const gap = nullifierFor('cashuA-swept')
        const stamped: [string, { nullifier: string; eventId: string; at: number }][] = []

        await reconcileAttestations(
          [{ id: 'received:r1', attestationNullifier: gap, attestedValue: 1800, attestedUnit: 'XAF' }],
          async (id, receipt) => void stamped.push([id, receipt]),
        )

        const event = published[0] as { id: string; created_at: number }
        expect(stamped).toEqual([
          ['received:r1', { nullifier: gap, eventId: event.id, at: event.created_at * 1000 }],
        ])
      })

      it('stamps a row whose attestation was ALREADY published but never recorded', async () => {
        // Every redemption from before this feature is in this state: the
        // record is on the relay, the row does not know where. Without this the
        // sweep would report "all published" and those rows would never show a
        // receipt, because they are not gaps and nothing else ever visits them.
        const n = nullifierFor('cashuA-orphan')
        relayHas = [{ id: 'ev-existing', created_at: 1000, tags: [['n', n]], content: '{}' }]
        const stamped: [string, { eventId: string; at: number }][] = []

        const out = await reconcileAttestations(
          [{ id: 'received:r2', attestationNullifier: n, attestedValue: 2500, attestedUnit: 'XAF' }],
          async (id, receipt) => void stamped.push([id, receipt]),
        )

        expect(out).toEqual({ checked: 1, missing: 0, republished: 0 })
        expect(stamped).toEqual([['received:r2', { nullifier: n, eventId: 'ev-existing', at: 1000000 }]])
      })

      it('does NOT stamp a republish that no relay accepted', async () => {
        // The row must never claim a public record that does not exist. The
        // next sweep finds it as a gap again, which is the honest outcome.
        publishOk = 0
        const stamped: unknown[] = []

        await reconcileAttestations(
          [
            {
              id: 'received:r3',
              attestationNullifier: nullifierFor('cashuA-refused'),
              attestedValue: 1200,
              attestedUnit: 'XAF',
            },
          ],
          async (id, receipt) => void stamped.push([id, receipt]),
        )

        expect(stamped).toHaveLength(0)
      })

      it('leaves a row that already carries a receipt alone', async () => {
        // Rewriting it churns the row, and a relay holding a later duplicate
        // would move the date off the first time this redemption was recorded.
        const n = nullifierFor('cashuA-already')
        relayHas = [{ id: 'ev-new', created_at: 9000, tags: [['n', n]], content: '{}' }]
        const stamped: unknown[] = []

        await reconcileAttestations(
          [
            {
              id: 'received:r4',
              attestationNullifier: n,
              attestationEventId: 'ev-old',
              attestedValue: 2500,
              attestedUnit: 'XAF',
            },
          ],
          async (id, receipt) => void stamped.push([id, receipt]),
        )

        expect(stamped).toHaveLength(0)
      })

      it('dates a receipt from the OLDEST attestation when the relay holds duplicates', async () => {
        // An earlier sweep can republish, leaving two events for one
        // redemption. The receipt should name when the redemption was first
        // recorded, not the most recent retry.
        const n = nullifierFor('cashuA-dupes')
        relayHas = [
          { id: 'ev-late', created_at: 5000, tags: [['n', n]], content: '{}' },
          { id: 'ev-first', created_at: 2000, tags: [['n', n]], content: '{}' },
        ]
        const stamped: { eventId: string; at: number }[] = []

        await reconcileAttestations(
          [{ id: 'received:r5', attestationNullifier: n, attestedValue: 2500, attestedUnit: 'XAF' }],
          async (_id, receipt) => void stamped.push(receipt),
        )

        expect(stamped[0]).toMatchObject({ eventId: 'ev-first', at: 2000000 })
      })

      it('carries on sweeping when one write-back fails', async () => {
        // A local storage failure must not abort the rest of the sweep — the
        // publishing half is the part that matters, and it has already
        // succeeded by the time the stamp is attempted.
        const a = nullifierFor('cashuA-w1')
        const b = nullifierFor('cashuA-w2')
        const seen: string[] = []

        const out = await reconcileAttestations(
          [
            { id: 'r-a', attestationNullifier: a, attestedValue: 100, attestedUnit: 'XAF' },
            { id: 'r-b', attestationNullifier: b, attestedValue: 200, attestedUnit: 'XAF' },
          ],
          async (id) => {
            seen.push(id)
            if (id === 'r-a') throw new Error('IndexedDB is gone')
          },
        )

        expect(out.republished).toBe(2)
        expect(seen).toEqual(['r-a', 'r-b'])
      })

      it('sweeps exactly as before when no stamp callback is given', async () => {
        // The parameter is optional, and the sweep's own contract must not
        // depend on it — LedgerPage passes one, tests and any other caller may
        // not.
        const out = await reconcileAttestations([
          { attestationNullifier: nullifierFor('cashuA-nostamp'), attestedValue: 500, attestedUnit: 'XAF' },
        ])
        expect(out).toEqual({ checked: 1, missing: 1, republished: 1 })
      })
    })
  })

  it('stamps a payload version on both the tags and the content', async () => {
    // A producer shipping ahead of its reader. Events already published cannot
    // be amended, so if a batched v2 ever lands, v1 events must be
    // distinguishable rather than mis-parsed. Pinned here so the wire format
    // cannot drift silently.
    await attestRedemption({ token: 'cashuAv1', faceValue: 2500, unit: 'XAF', signatureValid: true })
    const [ev] = published as { tags: string[][]; content: string }[]
    expect(ev.tags).toContainEqual(['v', '1'])
    expect(JSON.parse(ev.content).v).toBe('1')
  })

  it('publishes NOTHING for a coupon whose signature did not verify', async () => {
    // The guard that stops a merchant signing "I credited N" for a number the
    // SENDER supplied. Asserted on the published stream, not on the argument,
    // so removing the guard fails here rather than passing quietly.
    await attestRedemption({
      token: 'cashuA-unverified',
      faceValue: 999999,
      unit: 'XAF',
      signatureValid: false,
    })
    expect(published).toHaveLength(0)
  })

  it('ignores a call with nothing to attest rather than publishing junk', async () => {
    await attestRedemption({ token: '', faceValue: 10, unit: 'XAF', signatureValid: true })
    await attestRedemption({ token: 'cashuAt', faceValue: Number.NaN, unit: 'XAF', signatureValid: true })
    await attestRedemption({ token: 'cashuAt', faceValue: -1, unit: 'XAF', signatureValid: true })
    expect(published).toHaveLength(0)
  })
})
