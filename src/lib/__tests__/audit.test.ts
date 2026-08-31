import { describe, expect, it } from 'vitest'
import { finalizeEvent, type Event } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import {
  ABSENCE_SLA_MS,
  checkCoupon,
  findDuplicates,
  readAttestation,
  readAttestations,
  summarise,
  type AuditedAttestation,
} from '../audit'

/**
 * The reader's job is to be UNFOOLABLE by a public relay.
 *
 * Every test here is an attack or a false report. The reader is the whole audit
 * product: if it accepts a forgery, "verified against a public record" is a lie,
 * and if it reports a gap too eagerly it accuses honest stalls. Both failures
 * are worse than having no audit service at all.
 *
 * Events are built with REAL keys and REAL signatures rather than stubs —
 * `verifyEvent` is the security boundary, and a mocked signature would test
 * nothing about it.
 *
 * The forgeries are built by SPREADING a genuine event, which is deliberate and
 * is what caught the live defect documented on `stripCachedVerdict`: nostr-tools
 * caches its verdict in a `Symbol(verified)` property, spread copies symbols, and
 * so a tampered event arrived pre-stamped as verified. Building forgeries from
 * JSON instead would have passed while the reader accepted forgeries.
 */

const LEDGER_A = hexToBytes('a'.repeat(64))
const LEDGER_B = hexToBytes('b'.repeat(64))
const pubOf = (sk: Uint8Array) => bytesToHex(schnorr.getPublicKey(sk))

/** A commitment-shaped value. Not a real Pedersen point; the reader checks shape. */
const commitment = (seed: string) => `02${seed.repeat(64).slice(0, 64)}`

function attest(
  sk: Uint8Array,
  fields: { nullifier: string; commitment?: string; unit?: string; v?: string },
  overrides: { tagNullifier?: string; content?: string; createdAt?: number } = {},
): Event {
  const c = fields.commitment ?? commitment('1')
  return finalizeEvent(
    {
      kind: 7377,
      created_at: overrides.createdAt ?? Math.floor(Date.now() / 1000),
      tags: [
        ['n', overrides.tagNullifier ?? fields.nullifier],
        ['unit', fields.unit ?? 'XAF'],
        ['v', fields.v ?? '1'],
      ],
      content:
        overrides.content ??
        JSON.stringify({
          v: fields.v ?? '1',
          nullifier: fields.nullifier,
          commitment: c,
          unit: fields.unit ?? 'XAF',
        }),
    },
    sk,
  )
}

const accept = (e: Event) => {
  const r = readAttestation(e)
  if ('defect' in r) throw new Error(`expected accepted, got ${r.defect}`)
  return r
}
const defectOf = (e: Event) => {
  const r = readAttestation(e)
  return 'defect' in r ? r.defect : 'accepted'
}

describe('a forged record must never audit', () => {
  it('rejects an event whose signature does not verify', () => {
    // THE test. Without it, anyone could publish redemptions under a
    // competitor's ledger key, or fabricate proof that a coupon was honoured.
    const event = attest(LEDGER_A, { nullifier: 'n1' })
    const forged = { ...event, sig: 'f'.repeat(128) }
    expect(defectOf(forged)).toBe('bad_signature')
  })

  it('rejects an event whose content was edited after signing', () => {
    // The id is the hash of the canonical serialisation, so tampering with the
    // content invalidates it even though the signature bytes are untouched.
    const event = attest(LEDGER_A, { nullifier: 'n1' })
    const tampered = {
      ...event,
      content: JSON.stringify({ v: '1', nullifier: 'n1', commitment: commitment('9'), unit: 'XAF' }),
    }
    expect(defectOf(tampered)).toBe('bad_signature')
  })

  it('rejects a record indexed under a redemption it does not attest to', () => {
    // Tag says one coupon, content commits to another. A relay filters on the
    // TAG, so this record would be returned to a customer checking `n1` while
    // actually attesting `n2` — making somebody else's redemption look like
    // proof that this coupon was honoured.
    const event = attest(LEDGER_A, { nullifier: 'n2' }, { tagNullifier: 'n1' })
    expect(defectOf(event)).toBe('nullifier_mismatch')
  })

  it('accepts a genuine record, and reports the publisher as the LEDGER key', () => {
    const event = attest(LEDGER_A, { nullifier: 'n1', unit: 'EUR' })
    const read = accept(event)
    expect(read.nullifier).toBe('n1')
    expect(read.unit).toBe('EUR')
    expect(read.ledgerPubkey).toBe(pubOf(LEDGER_A))
    // Milliseconds, from the event's OWN clock — a reader that stamped its own
    // arrival time would date a swept republication as if it were the sale.
    expect(read.at).toBe(event.created_at * 1000)
  })
})

describe('malformed records are refused with a reason, never dropped silently', () => {
  it('refuses an event with no nullifier tag', () => {
    const event = finalizeEvent(
      { kind: 7377, created_at: 1, tags: [['unit', 'XAF']], content: '{}' },
      LEDGER_A,
    )
    expect(defectOf(event)).toBe('missing_nullifier')
  })

  it('refuses content that is not JSON', () => {
    expect(defectOf(attest(LEDGER_A, { nullifier: 'n1' }, { content: 'not json' }))).toBe(
      'unparseable_content',
    )
  })

  it('refuses a commitment that is not a compressed point', () => {
    // A reader that accepted arbitrary strings here would hand
    // `verifyDisclosedTotal` garbage and report "does not reconcile" against an
    // honest merchant.
    expect(defectOf(attest(LEDGER_A, { nullifier: 'n1', commitment: 'nope' }))).toBe(
      'bad_commitment',
    )
  })

  it('refuses a payload version it cannot read, rather than mis-parsing it', () => {
    // The batching migration: a v2 event carries a LIST. Parsing it as a single
    // attestation would silently read one redemption out of a batch of twenty
    // and report the other nineteen as missing.
    expect(defectOf(attest(LEDGER_A, { nullifier: 'n1', v: '2' }))).toBe('unknown_version')
  })

  it('refuses a BATCH that carries no version at all', () => {
    // Not hypothetical: the staging relay holds exactly this event (6a3688bf…),
    // published while verifying that a relay matches `#n` across a batch. It has
    // two `n` tags and no `v`, so a version-only check defaults it to v1 and the
    // reader would fall through to comparing one nullifier against a batch.
    const event = finalizeEvent(
      {
        kind: 7377,
        created_at: 1,
        tags: [
          ['n', 'first'],
          ['n', 'second'],
          ['unit', 'XAF'],
        ],
        content: JSON.stringify({ batch: [{ nullifier: 'first' }, { nullifier: 'second' }] }),
      },
      LEDGER_A,
    )
    expect(defectOf(event)).toBe('unknown_version')
  })

  it('refuses another kind entirely', () => {
    const event = finalizeEvent(
      { kind: 7376, created_at: 1, tags: [['n', 'n1']], content: '{}' },
      LEDGER_A,
    )
    expect(defectOf(event)).toBe('wrong_kind')
  })

  it('partitions a batch instead of failing the whole read', () => {
    // One bad event on a public relay must not blind an auditor to the good
    // ones — an audit tool that throws on hostile input can be silenced by
    // anyone who can publish.
    const { accepted, rejected } = readAttestations([
      attest(LEDGER_A, { nullifier: 'good' }),
      { ...attest(LEDGER_A, { nullifier: 'bad' }), sig: 'f'.repeat(128) },
    ])
    expect(accepted.map((a) => a.nullifier)).toEqual(['good'])
    expect(rejected[0].defect).toBe('bad_signature')
  })
})

describe('duplicates: a replay is a finding, a republished sweep is not', () => {
  const audited = (n: string, sk: Uint8Array, c = commitment('1')): AuditedAttestation =>
    accept(attest(sk, { nullifier: n, commitment: c }))

  it('does not flag a sweep republishing the same redemption', () => {
    // Derived blinds make republication byte-identical BY DESIGN. Reporting it
    // as a double-spend would make the reconciliation sweep — the thing that
    // makes absence meaningful — look like fraud every time it ran.
    const [d] = findDuplicates([audited('n1', LEDGER_A), audited('n1', LEDGER_A)])
    expect(d.benign).toBe(true)
  })

  it('flags the SAME token attested by two different stalls', () => {
    // The cross-merchant fraud a per-merchant view cannot see: one token, two
    // stalls both claiming to have honoured it.
    const [d] = findDuplicates([audited('n1', LEDGER_A), audited('n1', LEDGER_B)])
    expect(d.benign).toBe(false)
  })

  it('flags one stall attesting the same token at two different values', () => {
    const [d] = findDuplicates([
      audited('n1', LEDGER_A, commitment('1')),
      audited('n1', LEDGER_A, commitment('7')),
    ])
    expect(d.benign).toBe(false)
  })

  it('says nothing about coupons redeemed once', () => {
    expect(findDuplicates([audited('n1', LEDGER_A), audited('n2', LEDGER_A)])).toEqual([])
  })
})

describe('checking one coupon: absence is not evidence until the SLA passes', () => {
  const at = 1_000_000_000_000
  const present = [accept(attest(LEDGER_A, { nullifier: 'n1' }))]

  it('reports a published redemption as honoured', () => {
    expect(checkCoupon('n1', present).verdict).toBe('honoured')
  })

  it('will NOT call a fresh gap missing', () => {
    // The false-accusation guard. A publish lost 30 seconds ago is
    // indistinguishable from a dishonest merchant, and the sweep has not had a
    // chance to run. Saying "this stall has no record of your coupon" here is
    // the failure mode the design document forbids outright.
    const check = checkCoupon('n1', [], at, at + ABSENCE_SLA_MS - 1)
    expect(check.verdict).toBe('pending')
    expect(check.reportableAt).toBe(at + ABSENCE_SLA_MS)
  })

  it('calls it missing once an hour has passed', () => {
    expect(checkCoupon('n1', [], at, at + ABSENCE_SLA_MS).verdict).toBe('missing')
  })

  it('refuses to accuse at all when the redemption time is unknown', () => {
    // No timestamp, no SLA, no accusation. Fails in the safe direction rather
    // than assuming "now" and reporting every unknown coupon as missing.
    expect(checkCoupon('n1', [], undefined, at + ABSENCE_SLA_MS * 100).verdict).toBe('pending')
  })

  it('does not answer "honoured" when two stalls claim the same coupon', () => {
    // A clean answer to a dirty situation is the wrong answer: the customer's
    // coupon is caught up in a conflict and a human has to look.
    const conflicting = [
      accept(attest(LEDGER_A, { nullifier: 'n1', commitment: commitment('1') })),
      accept(attest(LEDGER_B, { nullifier: 'n1', commitment: commitment('7') })),
    ]
    expect(checkCoupon('n1', conflicting).verdict).toBe('conflicting')
  })
})

describe('summarising a stall: everything except the money', () => {
  it('counts redemptions and units without opening an amount', () => {
    const events = [
      accept(attest(LEDGER_A, { nullifier: 'n1', unit: 'XAF', createdAt: 100 } as never)),
      accept(attest(LEDGER_A, { nullifier: 'n2', unit: 'XAF' })),
      accept(attest(LEDGER_B, { nullifier: 'n3', unit: 'EUR' })),
    ]
    const summary = summarise(events, pubOf(LEDGER_A))

    // Scoped to ONE ledger key: merchant B's redemption must not leak into
    // merchant A's totals, or the pseudonyms are pooled and worthless.
    expect(summary.redemptions).toBe(2)
    expect(summary.units).toEqual(['XAF'])
    expect(summary.conflicts).toBe(0)
    // No amount is exposed anywhere on the summary — the type has no field for
    // one, which is the point.
    expect(Object.keys(summary)).not.toContain('total')
  })
})
