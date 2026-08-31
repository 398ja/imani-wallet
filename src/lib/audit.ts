import { verifyEvent, type Event } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'

import { ATTESTATION_KIND, ATTESTATION_VERSION } from './attestationKind'

/**
 * The READER over the attestation stream — the audit service's whole logic.
 *
 * `attestation.ts` is the producer: it signs and publishes. This is the other
 * side, and the dependency runs ONE WAY — the producer imports from here, never
 * the reverse. That direction is the safety property: this module cannot reach
 * the key derivation, so a reader can never forge what it is meant to check,
 * and the hosted service can load it without loading a signer.
 *
 * The key-free primitives (`commitTo`, `verifyDisclosedTotal`) therefore live
 * here and are re-exported by the producer for its own callers. An earlier
 * version of this comment claimed the two modules "share nothing but the kind
 * and version constants", which stopped being true the moment those moved;
 * review caught it.
 *
 * ## Needs no key, no wallet, no account
 *
 * Every function here takes events and returns verdicts. That is what makes the
 * same code serve an auditor with no relationship to the stall, the hosted API
 * (`services/audit-api`), and a merchant auditing themselves. One implementation,
 * so an external reader cannot be told something an internal one would not be.
 *
 * ## Why parsing is defensive to the point of rudeness
 *
 * Anyone can publish a kind-7377 event. The stream is public and unauthenticated
 * by design, so a reader that trusts its shape can be fed anything: a missing
 * `n` tag, a content blob that is not JSON, a duplicate nullifier from a third
 * party who never redeemed anything. None of that is exotic — it is the normal
 * state of an open relay. Every one of those is a REJECTION with a reason
 * (`AttestationDefect`), never a throw and never a silent skip, because an audit
 * tool that quietly drops what it cannot read reports a clean ledger for a
 * broken one.
 */

/** Why one event was refused. Each value is a distinct, nameable defect. */
export type AttestationDefect =
  /** Not kind 7377. The caller filtered wrongly, or the relay ignored the filter. */
  | 'wrong_kind'
  /** BIP-340 signature does not verify. Forged, corrupted, or mis-serialised. */
  | 'bad_signature'
  /** No `n` tag. Nothing to look the redemption up by, so it audits nothing. */
  | 'missing_nullifier'
  /** Content is not JSON. */
  | 'unparseable_content'
  /** The tag and the content disagree about which redemption this is. */
  | 'nullifier_mismatch'
  /** No commitment, or not a 33-byte compressed point in hex. */
  | 'bad_commitment'
  /** A payload version this reader does not know how to read. */
  | 'unknown_version'

/** One attestation that survived every check, with who published it and when. */
export interface AuditedAttestation {
  nullifier: string
  commitment: string
  unit: string
  /** The LEDGER key, which is the merchant pseudonym — never an identity key. */
  ledgerPubkey: string
  eventId: string
  /** Epoch milliseconds. The event's own `created_at`, not the reader's clock. */
  at: number
}

export interface RejectedAttestation {
  eventId: string
  defect: AttestationDefect
}

export interface ReadResult {
  accepted: AuditedAttestation[]
  rejected: RejectedAttestation[]
}

/** A 33-byte compressed secp256k1 point, hex. Same shape `commitTo` emits. */
const COMMITMENT = /^0[23][0-9a-f]{64}$/i

/**
 * Drop nostr-tools' cached verification verdict before re-checking a signature.
 *
 * **This is a real hole, found by a test that expected a forgery to be refused
 * and watched it audit clean.** `verifyEvent` memoises its result onto the event
 * as a `Symbol(verified)` property. Symbols are copied by object spread and by
 * `Object.assign`, so
 *
 * ```ts
 * const forged = { ...genuine, sig: 'ff…' }   // carries Symbol(verified) = true
 * verifyEvent(forged)                          // true. The sig is never checked.
 * ```
 *
 * The reader takes events from a public relay and from callers, and an attacker
 * only has to hand it an object derived from any genuine event to have arbitrary
 * content accepted as signed. Measured: spreading a signed event and replacing
 * the signature verifies `true`; the same object round-tripped through JSON
 * verifies `false`, because the symbol does not survive serialisation.
 *
 * A relay's events arrive as JSON and so were never at risk in production, which
 * is exactly why this could sit unnoticed — it is unreachable until someone
 * passes an in-memory object, and then it is total. Stripping the symbol costs
 * one object copy and removes the class of bug rather than the one instance.
 */
function stripCachedVerdict(event: Event): Event {
  const copy = { ...event } as Record<string | symbol, unknown>
  for (const s of Object.getOwnPropertySymbols(copy)) delete copy[s]
  return copy as unknown as Event
}

/**
 * Validate one event and either accept it or say precisely why not.
 *
 * **Verifies the signature.** This is the single most important line in the
 * reader: without it, "audited" means "somebody typed this", and any observer
 * could flood a competitor's ledger key with fabricated redemptions. `verifyEvent`
 * checks the id is the correct hash of the canonical serialisation AND that the
 * BIP-340 signature is valid under the event's own pubkey — so a forged event
 * cannot borrow a real merchant's pseudonym.
 *
 * **Cross-checks the tag against the content.** The `n` tag is what relays filter
 * on; the content is what carries the commitment. A publisher who put one
 * nullifier in the tag and another in the content would be indexed under a
 * redemption they did not attest to — a way to make a coupon look honoured by
 * pointing at somebody else's record. They must agree.
 */
export function readAttestation(event: Event): AuditedAttestation | RejectedAttestation {
  const reject = (defect: AttestationDefect): RejectedAttestation => ({
    eventId: event.id,
    defect,
  })

  if (event.kind !== ATTESTATION_KIND) return reject('wrong_kind')
  if (!verifyEvent(stripCachedVerdict(event))) return reject('bad_signature')

  const tagged = event.tags.find((t) => t[0] === 'n')?.[1]
  if (!tagged) return reject('missing_nullifier')

  let content: Record<string, unknown>
  try {
    content = JSON.parse(event.content) as Record<string, unknown>
  } catch {
    return reject('unparseable_content')
  }
  if (!content || typeof content !== 'object') return reject('unparseable_content')

  // Version is read from the CONTENT, which is what is signed. The `v` tag is a
  // filtering convenience and carries no more authority than any other tag.
  //
  // A v2 (batched) event carries a LIST of attestations, so this reader would
  // mis-parse it as a single one rather than fail — which is exactly the trap
  // `attestation.ts` shipped the version marker to avoid. Refusing an unknown
  // version keeps a future migration visible instead of silently wrong.
  //
  // A batch is detected STRUCTURALLY as well as by version, and that is not
  // belt-and-braces: the staging relay really does hold a two-nullifier batch
  // published during the design work with no `v` at all (event 6a3688bf…). An
  // absent version defaults to v1, so without this check the only thing standing
  // between a batch and a mis-read is the nullifier cross-check — which happens
  // to catch it, but reports `nullifier_mismatch` and tells the operator the
  // publisher is malformed rather than ahead of this reader.
  if (Array.isArray(content.batch)) return reject('unknown_version')
  const version = content.v ?? ATTESTATION_VERSION
  if (String(version) !== ATTESTATION_VERSION) return reject('unknown_version')

  if (content.nullifier !== tagged) return reject('nullifier_mismatch')

  const commitment = content.commitment
  if (typeof commitment !== 'string' || !COMMITMENT.test(commitment)) {
    return reject('bad_commitment')
  }

  return {
    nullifier: tagged,
    commitment,
    // Falls back rather than rejecting: a missing unit makes the record useless
    // for SUMMING (blindSumFor refuses a mixed disclosure) but still perfectly
    // good for "was this coupon honoured", which is the check that matters most.
    unit: typeof content.unit === 'string' && content.unit ? content.unit : 'UNKNOWN',
    ledgerPubkey: event.pubkey,
    eventId: event.id,
    at: event.created_at * 1000,
  }
}

/**
 * How many events were refused, by reason.
 *
 * Lives here with the `AttestationDefect` vocabulary rather than in either
 * consumer: the API's `/summary` and the metrics exporter each had their own
 * copy of this reduce, which is two places to forget a new defect.
 */
export function tallyDefects(rejected: RejectedAttestation[]): Record<string, number> {
  return rejected.reduce<Record<string, number>>((acc, r) => {
    acc[r.defect] = (acc[r.defect] ?? 0) + 1
    return acc
  }, {})
}

/** Read a batch, partitioned into what audits and what does not. */
export function readAttestations(events: Event[]): ReadResult {
  const accepted: AuditedAttestation[] = []
  const rejected: RejectedAttestation[] = []
  for (const event of events) {
    const result = readAttestation(event)
    if ('defect' in result) rejected.push(result)
    else accepted.push(result)
  }
  return { accepted, rejected }
}

/**
 * The same token attested more than once — a redemption replay.
 *
 * Grouped by nullifier ACROSS ledger keys, not within one. A merchant
 * double-crediting their own coupon and two different stalls both claiming the
 * same token are both frauds, and the second is the one a per-merchant view
 * would miss entirely.
 *
 * **A duplicate is a flag, not a verdict.** `reconcileAttestations` republishes
 * a gap it finds, and republication is byte-identical by design (the blind is
 * derived, so the same redemption always produces the same commitment). So the
 * honest, expected duplicate is *same nullifier, same commitment, same author*,
 * and it is reported separately from the case that actually indicates fraud.
 */
export interface Duplicate {
  nullifier: string
  occurrences: AuditedAttestation[]
  /**
   * True when every copy agrees on commitment AND author — a republished sweep,
   * not a second redemption. False means two DIFFERENT claims over one token,
   * which is the finding an auditor has to act on.
   */
  benign: boolean
}

export function findDuplicates(attestations: AuditedAttestation[]): Duplicate[] {
  const byNullifier = new Map<string, AuditedAttestation[]>()
  for (const a of attestations) {
    const list = byNullifier.get(a.nullifier)
    if (list) list.push(a)
    else byNullifier.set(a.nullifier, [a])
  }

  const duplicates: Duplicate[] = []
  for (const [nullifier, occurrences] of byNullifier) {
    if (occurrences.length < 2) continue
    const first = occurrences[0]
    const benign = occurrences.every(
      (o) => o.commitment === first.commitment && o.ledgerPubkey === first.ledgerPubkey,
    )
    duplicates.push({ nullifier, occurrences, benign })
  }
  return duplicates
}

/**
 * How long a redemption may be missing from the relay before absence means
 * anything. **One hour**, and the number is a product decision, not a constant
 * someone picked to make a test pass.
 *
 * `docs/research/redemption-attestation-privacy.md` is emphatic that a gap has
 * innocent explanations — the tab closed mid-publish, a relay dropped the event,
 * the sweep has not run yet. Reporting those as a dishonest merchant makes the
 * tool a false-accusation generator and destroys exactly the trust the feature
 * exists to build.
 *
 * So absence is only reportable once the merchant has had a fair chance to
 * close the gap themselves. An hour is long enough for a wallet to reopen and
 * sweep, and short enough that a same-day dispute still gets an answer.
 */
export const ABSENCE_SLA_MS = 60 * 60 * 1000

/** What the ledger can honestly say about one coupon. */
export type CouponVerdict =
  /** Attested. The stall published a record of honouring this coupon. */
  | 'honoured'
  /** Attested more than once with conflicting claims. Needs a human. */
  | 'conflicting'
  /** Not attested, and not yet late. Says nothing; ask again later. */
  | 'pending'
  /** Not attested and past the SLA. Evidence, and reportable as a gap. */
  | 'missing'

export interface CouponCheck {
  verdict: CouponVerdict
  /** The matching records, newest first. Empty for pending and missing. */
  attestations: AuditedAttestation[]
  /** When the verdict may change from `pending` to `missing`. */
  reportableAt?: number
}

/**
 * Was this specific redemption honoured?
 *
 * The one question the audit service exists to answer, and the only one whose
 * answer must never overstate. Note the asymmetry: `honoured` is proof (a signed
 * record exists), while `missing` is only ever EVIDENCE — see `ABSENCE_SLA_MS`.
 *
 * `redeemedAt` is when the redemption is believed to have happened, and the SLA
 * runs from it. A caller that does not know cannot get a `missing` verdict at
 * all, which is the correct failure direction: no timestamp, no accusation.
 */
export function checkCoupon(
  nullifier: string,
  attestations: AuditedAttestation[],
  redeemedAt?: number,
  now: number = Date.now(),
): CouponCheck {
  const matches = attestations
    .filter((a) => a.nullifier === nullifier)
    .sort((a, b) => b.at - a.at)

  if (matches.length > 0) {
    // Conflicting claims over one token are not a "yes". A customer told
    // "honoured" while two stalls claim the same coupon has been given a clean
    // answer to a dirty situation.
    const first = matches[0]
    const agreed = matches.every(
      (m) => m.commitment === first.commitment && m.ledgerPubkey === first.ledgerPubkey,
    )
    return { verdict: agreed ? 'honoured' : 'conflicting', attestations: matches }
  }

  if (redeemedAt === undefined) return { verdict: 'pending', attestations: [] }

  const reportableAt = redeemedAt + ABSENCE_SLA_MS
  return {
    verdict: now >= reportableAt ? 'missing' : 'pending',
    attestations: [],
    reportableAt,
  }
}

/** Aggregate health of one ledger key's stream, for a dashboard or a report. */
export interface LedgerSummary {
  ledgerPubkey: string
  redemptions: number
  /** Units seen, sorted. A stall trading in one currency has exactly one. */
  units: string[]
  /** Conflicting duplicates only — benign republications are not findings. */
  conflicts: number
  firstAt?: number
  lastAt?: number
}

/**
 * Summarise one merchant's stream WITHOUT opening a single amount.
 *
 * Cardinality, units and timing are all readable from the stream by anyone; the
 * design document lists them as accepted residual leaks. Amounts are not here
 * because they are not knowable — that is the point of the commitments, and this
 * function is the honest ceiling on what an external reader gets unaided.
 */
export function summarise(attestations: AuditedAttestation[], ledgerPubkey: string): LedgerSummary {
  const mine = attestations.filter((a) => a.ledgerPubkey === ledgerPubkey)
  const times = mine.map((a) => a.at)
  return {
    ledgerPubkey,
    redemptions: mine.length,
    units: [...new Set(mine.map((a) => a.unit))].sort(),
    conflicts: findDuplicates(mine).filter((d) => !d.benign).length,
    firstAt: times.length ? Math.min(...times) : undefined,
    lastAt: times.length ? Math.max(...times) : undefined,
  }
}

/**
 * The commitment primitives, and the auditor's half of a disclosure.
 *
 * These live HERE rather than in `attestation.ts` because they need no key.
 * That is the whole distinction the module split is drawn on: the producer signs
 * and therefore must never be loaded by the hosted service, while everything an
 * auditor can do unaided belongs to the reader. `verifyDisclosedTotal` in
 * particular is the auditor's side by definition — it was stranded in the
 * signing module, which is why the hosted API could not offer it and the
 * capability table's "read one merchant's totals — only on disclosure" row was
 * not deliverable by anyone.
 *
 * `attestation.ts` re-exports them, so the merchant-side callers are unchanged.
 */
const CURVE_ORDER = schnorr.Point.Fn.ORDER
const G = schnorr.Point.BASE

let cachedH: typeof G | undefined
/**
 * A second generator with unknown discrete log wrt G.
 *
 * If anyone knew `x` with `H = x*G` they could open a commitment to any value
 * they liked and the binding property would be worthless. Hash-and-increment
 * from a fixed string gives a point nobody chose.
 */
function pedersenH(): typeof G {
  if (cachedH) return cachedH
  for (let i = 0; i < 256; i++) {
    try {
      cachedH = schnorr.Point.fromHex(`02${bytesToHex(sha256(utf8ToBytes(`imani-pedersen-H:${i}`)))}`)
      return cachedH
    } catch {
      // x was not on the curve; try the next counter. Expected about half the
      // time, which is why this loops rather than asserting.
    }
  }
  throw new Error('could not derive the Pedersen H point')
}

/** `C = amount*G + r*H` — hides the amount, but is additively homomorphic. */
export function commitTo(amountMinorUnits: number, blind: bigint): string {
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits < 0) {
    throw new Error(`commitTo needs a non-negative integer amount, got ${amountMinorUnits}`)
  }
  const point =
    amountMinorUnits === 0
      ? pedersenH().multiply(blind)
      : G.multiply(BigInt(amountMinorUnits)).add(pedersenH().multiply(blind))
  return point.toHex(true)
}

/**
 * Check a merchant's claimed total against their published commitments.
 *
 * Needs no key and no wallet, which is what makes it an audit rather than a
 * favour: the merchant discloses `claimedTotal` and the summed blind, and the
 * arithmetic either reconciles or does not.
 *
 * **Binds the total to the commitments DISCLOSED, not to a period.** The
 * merchant chooses which nullifiers go in, so omitting a redemption and its
 * blind reconciles perfectly at a lower total. Set completeness must come from
 * elsewhere — a counterparty presenting a nullifier absent from the disclosure,
 * for instance. An earlier version of this comment claimed the stronger
 * property; a review caught it.
 *
 * @param commitments the published `C` values for the period
 * @param claimedTotal the total the merchant says they credited
 * @param blindSumHex the scalar they disclosed alongside it
 */
export function verifyDisclosedTotal(
  commitments: string[],
  claimedTotal: number,
  blindSumHex: string,
): boolean {
  try {
    if (commitments.length === 0) return false
    // Reject anything that is not a 33-byte compressed point BEFORE parsing.
    // `Point.fromHex` also accepts 65-byte uncompressed input, but the
    // comparison below is against `toHex(true)`, so an auditor pasting an
    // honestly-formatted uncompressed commitment would silently false-negative
    // — a verification tool reporting "does not reconcile" for a correct set is
    // worse than one that refuses the input.
    if (!commitments.every((c) => /^[0-9a-fA-F]{66}$/.test(c))) return false

    const sum = commitments.map((c) => schnorr.Point.fromHex(c)).reduce((a, b) => a.add(b))

    // Reduce mod n, matching what `blindSumFor` emits. Without it an
    // out-of-range scalar (hand-assembled, or summed by another tool that does
    // not reduce) fails against a blind sum that is arithmetically equal.
    const blindSum = BigInt(`0x${blindSumHex}`) % CURVE_ORDER

    return sum.toHex(true) === commitTo(Math.round(claimedTotal), blindSum)
  } catch {
    return false
  }
}
