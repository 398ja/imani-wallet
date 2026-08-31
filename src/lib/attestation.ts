import { finalizeEvent, type Event, type EventTemplate } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'

import { ATTESTATION_KIND, ATTESTATION_VERSION } from './attestationKind'
import { getSigner } from './nap'
import { allEvents, publish } from './relay'

/**
 * Public, pseudonymous proof that a coupon was redeemed.
 *
 * The sealed kind-7376 history (`txRecords.ts`) is the merchant's own record,
 * NIP-44 encrypted to their own key. Excellent for privacy, useless for audit:
 * nobody else can read it, so there is no way for a customer to check that the
 * stall really honoured their coupon, and no way for an auditor to see that the
 * books add up.
 *
 * This is the other half. One small unencrypted event per redemption, carrying
 * only what an audit needs and nothing that identifies the stall or its takings.
 *
 * ## What is published
 *
 * - `nullifier` — an opaque tag, unique per redeemed token
 * - `C` — a Pedersen commitment to the face value credited
 * - signed by a per-merchant LEDGER KEY that is not their identity key
 *
 * ## What it deliberately does NOT carry
 *
 * No merchant pubkey, no amount, no voucher id, no customer. A merchant
 * publishes a kind-0 naming their stall, so putting their identity key on a
 * public redemption record would let anyone compute that stall's revenue,
 * basket size and trading hours with a `GROUP BY`. The whole design exists to
 * avoid that.
 *
 * ## Why this is not redundant with the mint
 *
 * The mint prevents double-spend, but it operates on PROOFS and has no concept
 * of a voucher. It cannot distinguish a merchant crediting 2,500 XAF from one
 * crediting 1,800 against the same coupon — both burn 2,500 sats identically.
 * The face value credited lives only here.
 *
 * ## Publication cadence: one event per redemption
 *
 * A deliberate choice, not an oversight, and the one thing here that is
 * expected to change.
 *
 * Per-redemption publication is the simplest thing that works and the only
 * shape that lets a customer check their coupon the moment they are handed it —
 * which is the point of the feature. The cost is that even with an opaque
 * payload, the TIMING of the events is itself information: an observer
 * watching one ledger key learns that stall's trading hours and rhythm, and
 * roughly how busy it is, without ever reading an amount or a name.
 *
 * Batching (say, one event per day carrying many nullifiers) collapses that to
 * "traded on this day". It is a strictly better privacy position and a strictly
 * worse product one: a customer cannot verify a coupon that has not been
 * published yet, so the trust check would go from instant to next-day.
 *
 * Left per-redemption until someone decides that trade differently. What that
 * migration costs, checked against the staging relay rather than assumed:
 *
 * - The CUSTOMER check survives untouched. A batched event carries one `n` tag
 *   per nullifier, and a relay matches a `#n` filter against ALL of them —
 *   verified: a filter for a single nullifier matched an event carrying two.
 *   So `couponCheckFilter` keeps working across the change.
 * - The AUDITOR reader does NOT. Its content shape goes from one
 *   `{nullifier, commitment}` to a list, and a reader written for one breaks on
 *   the other. Whoever builds the reader should handle both from the start, or
 *   the migration needs a version tag.
 *
 * Design and the verification behind every claim:
 * `docs/research/redemption-attestation-privacy.md`.
 */

/**
 * The wire constants live in `attestationKind.ts` and are re-exported here so
 * every existing importer is unaffected.
 *
 * They had to move because this module cannot be loaded outside a browser: it
 * reaches `./nap` and `./relay` to sign and publish, and those reach
 * `@imani/nap-client-web` and `import.meta.env`. The hosted audit API is a Node
 * process that needs the kind number and must never be able to sign — so it
 * imports the constants without importing the signer.
 *
 * Re-exported rather than copied. One definition, so a reader and the producer
 * cannot drift apart about what is on the wire.
 */
export { ATTESTATION_KIND, ATTESTATION_VERSION } from './attestationKind'

/** Domain separators. Versioned, so a future scheme change cannot collide. */
const LEDGER_KEY_TAG = 'imani-ledger-key-v1'
const NULLIFIER_TAG = 'imani-redeem-v1'
const BLIND_TAG = 'imani-blind-v1'

/**
 * The merchant's ledger key — a pseudonym that is also a fetch handle.
 *
 * Attestations are signed by this key, so `{ authors: [ledgerPubkey] }` fetches
 * exactly one merchant's set. That is what makes "audit any merchant's numbers"
 * a single relay query rather than a scan.
 *
 * DERIVED FROM THE SECRET KEY, not the public one. This is the difference
 * between a pseudonym and a fig leaf: `issuerId` is signed inside every voucher
 * this merchant issues, so anyone holding one of their coupons knows their
 * public key. A ledger id hashed from that public key is recomputable by any of
 * their customers, and the pseudonym is broken by the first person who looks.
 *
 * Deterministic, so a merchant who wipes their device re-derives the same
 * identity and can still find and audit their own history.
 *
 * Hashes the key's BYTES, not its hex string. Hashing the string binds the
 * pseudonym to an ENCODING rather than to a key: `privkeyHex()` returns
 * whatever the caller passed to `createWalletSigner`/`setKey` verbatim, and
 * neither normalises case. So restoring the same key in uppercase would derive
 * a different ledger identity and silently orphan the whole published history —
 * the exact failure the "wipes their device" line above promises against.
 * Measured before fixing: uppercase moved the pubkey from 9d3309d7… to
 * 92dac1d2…; hashing bytes gives a6170926… for both.
 *
 * Not back-compatible with the string form, which is fine: no attestation has
 * ever been published from a released build.
 */
function ledgerKey(): { sk: Uint8Array; pubkey: string } {
  const priv = hexToBytes(getSigner().privkeyHex())
  const tag = utf8ToBytes(`${LEDGER_KEY_TAG}:`)
  const input = new Uint8Array(tag.length + priv.length)
  input.set(tag)
  input.set(priv, tag.length)
  const sk = sha256(input)
  // The raw secret never leaves this module: `ledgerKey` is module-private and
  // callers get `ledgerPubkey()`. Exporting a function that returns a secret
  // key is a footgun regardless of who currently calls it.
  priv.fill(0)
  input.fill(0)
  return { sk, pubkey: bytesToHex(schnorr.getPublicKey(sk)) }
}

/**
 * The tag that makes a repeat redemption visible.
 *
 * Same token redeemed twice → same nullifier → anyone can see it. Monero calls
 * this a key image, for the same reason: it detects a double-spend without
 * revealing what was spent or by whom.
 *
 * **Keyed on the TOKEN, never on the voucher.** A £10 voucher legitimately
 * comes back as £4 and then £6 — `redemptionLedger.ts` says as much, "cashu
 * tokens can legitimately share the same voucher_id" — and a split preserves
 * voucher identity byte-for-byte. A voucher-keyed tag therefore collides on an
 * honest partial redemption and reports a double-spend that did not happen.
 *
 * **Bound to the token's own bytes, which are secret.** `token_id` is
 * `sha256(token)` and appears in the merchant's UI, so a tag derived from ids
 * alone could be computed — and PUBLISHED FIRST — by anyone who had seen the
 * coupon, framing an honest redemption as a replay. The full token is held only
 * by the parties to the payment.
 *
 * A customer who held the coupon can therefore recompute this themselves and
 * confirm their own redemption appears in the public ledger. That check is the
 * point of the whole feature.
 */
export function nullifierFor(token: string): string {
  return bytesToHex(sha256(utf8ToBytes(`${NULLIFIER_TAG}:${token}`)))
}

/**
 * secp256k1 generator, and a second point with unknown discrete log wrt it.
 *
 * `H` must be a nothing-up-my-sleeve point: if anyone knew `x` such that
 * `H = x*G`, they could open a commitment to any value they liked and the
 * binding property would be worthless. Hash-and-increment from a fixed string
 * gives a point nobody chose.
 */
const CURVE_ORDER = schnorr.Point.Fn.ORDER
const G = schnorr.Point.BASE

let cachedH: typeof G | undefined
function pedersenH(): typeof G {
  if (cachedH) return cachedH
  for (let i = 0; i < 256; i++) {
    try {
      cachedH = schnorr.Point.fromHex(`02${bytesToHex(sha256(utf8ToBytes(`imani-pedersen-H:${i}`)))}`)
      return cachedH
    } catch {
      // x was not on the curve; try the next counter. Expected roughly half the
      // time, which is why this loops rather than asserting.
    }
  }
  throw new Error('could not derive the Pedersen H point')
}

/**
 * The blinding factor for one attestation, DERIVED rather than random.
 *
 * This is the choice that makes self-audit survive a device wipe. A random
 * blind would have to be stored, and a merchant who lost it could never re-open
 * their own commitment — they would be locked out of auditing their own
 * history by the very mechanism meant to protect it.
 *
 * Derived from the ledger key, so only this merchant can reproduce it: a
 * customer who knows the amount cannot locate the record, which is what stops
 * one known purchase from unmasking the pseudonym permanently.
 */
function blindFor(ledgerSk: Uint8Array, nullifier: string): bigint {
  const raw = BigInt(`0x${bytesToHex(sha256(utf8ToBytes(`${BLIND_TAG}:${bytesToHex(ledgerSk)}:${nullifier}`)))}`)
  // Never zero: a zero blind is no blind at all, and the commitment would
  // reduce to `amount * G`, which anyone could brute-force over plausible
  // amounts.
  return (raw % (CURVE_ORDER - 1n)) + 1n
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
 * Proof that one redemption reached the public ledger.
 *
 * Written onto the transaction row so the merchant's receipt can say the
 * redemption was published, and give an auditor something to look it up by.
 *
 * Deliberately NOT the commitment. A reader holding the row already knows the
 * amount, and the commitment is recomputable from it — printing it beside the
 * amount invites treating a public value as though it were a private one.
 * `verifyOwnCommitment` is the supported way to re-open it.
 *
 * `at` is the EVENT's own `created_at`, not the row's timestamp and not "now".
 * A sweep can publish an attestation months after the redemption, and the
 * receipt has to date the publication rather than the sale.
 */
export interface AttestationReceipt {
  /** The `#n` tag: what an auditor or the customer's own check looks it up by. */
  nullifier: string
  /** Addresses the event directly, for a reader fetching by `ids`. */
  eventId: string
  /** Epoch milliseconds, converted from the event's `created_at` seconds. */
  at: number
}

/** What one attestation says, before it is signed. */
export interface Attestation {
  /** Opaque per-token tag. A repeat is a duplicate here. */
  nullifier: string
  /** Pedersen commitment to the credited face value. */
  commitment: string
  /** The unit, needed to audit sums. Not identifying on its own. */
  unit: string
}

/**
 * Build the event, signed by the LEDGER key rather than the wallet's identity.
 *
 * `finalizeEvent` rather than `signer.signEvent`, deliberately: the signer signs
 * as the merchant, and signing this as the merchant is precisely what the
 * design exists to avoid. Publishing the event IS the attestation — `pubkey`
 * and `sig` are a BIP-340 claim over the canonical serialisation, the same
 * scheme as the voucher signatures this wallet already verifies. No second
 * signature layer.
 */
export function buildAttestation(a: Attestation, ledgerSk: Uint8Array): Event {
  const template: EventTemplate = {
    kind: ATTESTATION_KIND,
    created_at: Math.floor(Date.now() / 1000),
    // The nullifier is a tag as well as content so an auditor can look up one
    // coupon with a filter instead of fetching and parsing the whole stream —
    // which is exactly what a customer checking their own coupon does.
    tags: [
      ['n', a.nullifier],
      ['unit', a.unit],
      // The payload version, as a TAG so a reader can filter on it without
      // parsing content.
      //
      // The one thing a producer shipping ahead of its reader has to get
      // right. If publication ever batches (see the cadence note above), the
      // content shape goes from one {nullifier, commitment} to a list, and a
      // reader written for v1 must be able to tell the difference rather than
      // silently mis-parsing. Cheap now, impossible retrofitting later —
      // events already published cannot be amended.
      ['v', ATTESTATION_VERSION],
    ],
    content: JSON.stringify({
      v: ATTESTATION_VERSION,
      nullifier: a.nullifier,
      commitment: a.commitment,
      unit: a.unit,
    }),
  }
  return finalizeEvent(template, ledgerSk)
}

/**
 * Attest one redemption. NEVER THROWS.
 *
 * Returns a RECEIPT when a relay took the record, and `null` otherwise —
 * including when the coupon never qualified. The caller writes that receipt
 * onto the row so the merchant's transaction detail can show the redemption
 * was published (DEV-246).
 *
 * `null` on `result.ok === 0` is the load-bearing case: the row must not claim
 * a public record that nothing holds. The gap is real, and
 * `reconcileAttestations` is what finds and stamps it later.
 *
 * The money has already moved and the row is already written when this runs. A
 * relay that will not take the record has undone neither, so a failure here
 * must not turn a completed redemption into a reported error — the same rule
 * `publishVoucher` and `announceArrival` follow.
 *
 * The cost of a lost publish is one gap in the public ledger, which
 * `reconcileAttestations` (below, reachable from Settings > Redemption ledger)
 * republishes later. A review caught this comment naming that sweep while no
 * such code existed anywhere — it was describing an intention as a mechanism.
 * The sweep is real now, and it is only possible because the nullifier is
 * stamped onto the row: it hashes the RECEIVED token, which is burnt by this
 * point and cannot be recovered.
 *
 * That is also why "absent" must never be presented to a customer as proof of a
 * dishonest merchant without the sweep having run first.
 */
export async function attestRedemption(params: {
  token: string
  faceValue: number
  unit: string
  /**
   * Whether the issuer's signature over this coupon verified.
   *
   * REQUIRED, and the attestation is skipped without it. `faceValue` for a
   * coupon with no verified voucher comes off the DM envelope, which the SENDER
   * writes — `dmCrypto` says so directly: "a genuine low-value token could be
   * announced at any face value at all". Committing to that number would have
   * the merchant signing "I credited N" where N is a figure a counterparty
   * supplied and nobody established.
   *
   * The card forbids exactly this shape: "A merchant may attest to what they
   * redeemed; they may not mint a voucher on the issuer's behalf." A signature
   * over an unestablished claim is the same error as the fabricated child
   * voucher that retired the old ledger — it just looks more respectable.
   *
   * Plain ecash therefore produces no attestation. It carries no issuer claim,
   * so there is nothing to attest to; this is the same distinction
   * `hasValidationClaim` already draws for the Checks badge.
   */
  signatureValid: boolean
}): Promise<AttestationReceipt | null> {
  try {
    const { token, faceValue, unit, signatureValid } = params
    if (!signatureValid) return null
    if (!token || !Number.isFinite(faceValue) || faceValue < 0) return null

    const { sk } = ledgerKey()
    const nullifier = nullifierFor(token)
    const attestation: Attestation = {
      nullifier,
      commitment: commitTo(Math.round(faceValue), blindFor(sk, nullifier)),
      unit: unit || 'UNKNOWN',
    }

    const event = buildAttestation(attestation, sk)
    const result = await publish(event)
    if (result.ok === 0) {
      console.warn('[attestation] no relay accepted the record', result.errors)
      return null
    }
    return { nullifier, eventId: event.id, at: event.created_at * 1000 }
  } catch (error) {
    console.error('[attestation] redemption not attested', error)
  }
  return null
}

/**
 * Re-open one's own commitment — the merchant self-audit primitive.
 *
 * Returns true when `amount` is what this attestation committed to.
 *
 * **Needs the nullifier, and that is the constraint.** The blind is derived
 * from `(ledgerSk, nullifier)`, so a merchant can re-derive it on any device —
 * but only for a nullifier they still have. The nullifier is
 * `H(tag | received token)`, and the received token is gone after redemption:
 * `TokenRedemption.redeem` SWAPS it at the mint, so the stored row is keyed on
 * a different token's fingerprint (`legacyBridge.ts`), and `txRecords`
 * deliberately never writes a token to a relay because it is bearer value.
 *
 * So `attestationNullifier` is stamped onto the transaction row at redemption
 * time — see `dmPoll`. That is a hash, not bearer value: it is already
 * published, so keeping a local copy discloses nothing new, and without it
 * self-audit after a device wipe is simply unreachable. Reviewed and caught
 * before this shipped; the derived-blind design exists precisely to make that
 * case work, and it would have enabled nothing.
 *
 * Only works for one's own attestations: another merchant's blind comes from
 * their ledger key, so the same amount produces a different commitment.
 */
export function verifyOwnCommitment(
  nullifier: string,
  commitment: string,
  amountMinorUnits: number,
): boolean {
  try {
    const { sk } = ledgerKey()
    return commitTo(Math.round(amountMinorUnits), blindFor(sk, nullifier)) === commitment
  } catch {
    return false
  }
}

/**
 * Prove a period total without revealing any single amount.
 *
 * Sums the blinds so an auditor can check `sum(C) == commit(total, sum(r))`.
 * The merchant discloses `total` and this scalar; the published commitments do
 * the rest.
 *
 * **Binds the total to the commitments DISCLOSED, not to the period.** An
 * earlier version of this comment claimed the merchant "cannot understate or
 * overstate", and that is wrong: the merchant chooses which nullifiers go into
 * the list, so omitting a redemption and its blind reconciles perfectly at a
 * lower total. The homomorphic sum proves the disclosed set adds up; set
 * COMPLETENESS has to come from elsewhere — a counterparty presenting a
 * nullifier absent from the disclosure, for instance.
 */
export function blindSumFor(entries: { nullifier: string; unit: string }[]): string {
  // ONE currency per disclosure. A day mixing XAF and EUR sums to a number that
  // verifies perfectly and means nothing: the curve does not know what the
  // scalars denominate, so "total 5000" over both is arithmetic on unlike
  // things. Refusing here is the only place it can be caught — by the time an
  // auditor sees the total, the units are gone.
  const units = new Set(entries.map((e) => e.unit))
  if (units.size !== 1) throw new Error('blindSumFor: one unit per disclosure')

  const { sk } = ledgerKey()
  const sum = entries.reduce((acc, e) => (acc + blindFor(sk, e.nullifier)) % CURVE_ORDER, 0n)
  return sum.toString(16)
}

/**
 * The auditor's side of the same check. Needs no key and no wallet.
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

/**
 * This merchant's ledger id, hex, matching how the relay carries keys.
 *
 * The disclosure point for the whole scheme: `ledgerSk` is derived inside this
 * wallet and nowhere else, so without a merchant surfacing this, "fetch any
 * merchant's attestations" is not something an auditor can actually do for a
 * merchant they can name. Shown and copyable at Settings > Redemption ledger.
 */
export function ledgerPubkey(): string {
  return ledgerKey().pubkey
}

/**
 * The filter a CUSTOMER would use to check one coupon they hold.
 *
 * NOT CALLED, and it CANNOT be called from a customer's wallet today. An earlier
 * version of this comment said the omission was a sequencing decision — waiting
 * for the reconciliation sweep — and that was the lesser reason. The sweep now
 * exists; this is still unreachable.
 *
 * **The customer never holds the token that was redeemed.** `nullifierFor` binds
 * to the bytes the merchant RECEIVED, and on the atomic-send path those are the
 * gateway's `send_token`, produced by the split and handed straight to the gift
 * wrap. `AtomicSendResponse` states it outright: *"The send_token is NEVER
 * returned during the saga — it stays server-side. Only returned via reclaim."*
 * What the customer gets back is `keep_token`, their change. So the input this
 * function needs does not exist in the wallet that would want to call it.
 *
 * Fixing it is a small gateway change — return the send token's NULLIFIER (a
 * hash, not bearer value) to the sender on COMPLETED — and it has its own card.
 * Until then a customer-facing check cannot be built, honestly or otherwise.
 *
 * Kept, rather than deleted, because it pins two properties the design depends
 * on and which are easy to lose: it filters on a TAG (so it survives a move to
 * batched events) and it carries no author (so a customer never has to know
 * which stall redeemed their coupon). Both are asserted in the tests.
 */
export function couponCheckFilter(token: string) {
  return { kinds: [ATTESTATION_KIND], '#n': [nullifierFor(token)] }
}

/**
 * Reconciliation sweep: which local redemptions have no attestation on the
 * relay, and republish them.
 *
 * **This is the gate that makes absence mean anything.** Until it runs, a
 * missing attestation has innocent explanations — the tab closed before the
 * publish landed, a relay dropped the event, the coupon carried no verified
 * issuer claim and correctly had nothing to attest. A reader that treats a gap
 * as a merchant omitting deliberately is a false-accusation generator, which
 * is why `docs/research/redemption-attestation-privacy.md` orders the work
 * producer -> sweep -> reader, and why no customer-facing check ships first.
 *
 * The set-difference is on nullifiers, and only works because the nullifier is
 * stamped onto the row at redemption time (`attestationNullifier`): it cannot
 * be recomputed later, since `redeem()` swaps the token at the mint.
 *
 * Rows with no `attestationNullifier` are SKIPPED, not treated as gaps: they
 * predate this feature or never qualified for attestation, and republishing
 * them is impossible anyway (the amount's blind needs a nullifier).
 *
 * `stamp` writes a receipt back onto a row (DEV-246). Two rows need it, and the
 * second is easy to miss:
 *
 *  1. a gap this sweep republishes, which had no receipt by definition;
 *  2. a row whose attestation is ALREADY published but which carries no
 *     receipt — every redemption from before this feature, and any whose
 *     write-back was lost. The event is right there in `published`, so
 *     stamping it costs nothing and is the only way those rows ever show one.
 *
 * Passed in rather than imported: this module publishes to relays and knows
 * nothing about storage, and `wallet.ts` already imports the publishing side.
 */
export async function reconcileAttestations(
  // Deliberately the raw stored row (index-signature `unknown`), not
  // `WalletTransaction`: the figures this needs are the ones stamped at
  // redemption, and the mapped transaction type does not carry them.
  rows: Record<string, unknown>[],
  stamp?: (rowId: string, receipt: AttestationReceipt) => Promise<void>,
): Promise<{ checked: number; missing: number; republished: number }> {
  const local = rows.filter((r) => typeof r.attestationNullifier === 'string')
  if (local.length === 0) return { checked: 0, missing: 0, republished: 0 }

  const { sk, pubkey } = ledgerKey()
  const published = await allEvents(pubkey, ATTESTATION_KIND)
  // Keyed by nullifier rather than collected as a Set: the EVENT is what a
  // receipt is made of, so a set of nullifiers could answer "is it published?"
  // but not "publish what". Oldest wins — an attestation republished by an
  // earlier sweep has duplicates on the relay, and the receipt should name the
  // first time this redemption was recorded, not the most recent retry.
  const seen = new Map<string, { id: string; created_at: number }>()
  for (const e of published) {
    const n = e.tags.find((t) => t[0] === 'n')?.[1]
    if (!n) continue
    const prior = seen.get(n)
    if (!prior || e.created_at < prior.created_at) seen.set(n, e)
  }

  /** Never throws: a failed local write must not abort the rest of the sweep. */
  const writeReceipt = async (row: Record<string, unknown>, receipt: AttestationReceipt) => {
    if (!stamp) return
    // Already carries one. Rewriting it would churn the row and, worse, could
    // move the date if the relay returned a later duplicate.
    if (typeof row.attestationEventId === 'string') return
    const id = typeof row.id === 'string' ? row.id : undefined
    if (!id) return
    try {
      await stamp(id, receipt)
    } catch (error) {
      console.error('[attestation] receipt not written back', error)
    }
  }

  // Rows whose attestation was already on the relay, but which never got a
  // receipt. Case 2 above.
  for (const row of local) {
    const event = seen.get(row.attestationNullifier as string)
    if (!event) continue
    await writeReceipt(row, {
      nullifier: row.attestationNullifier as string,
      eventId: event.id,
      at: event.created_at * 1000,
    })
  }

  const gaps = local.filter((r) => !seen.has(r.attestationNullifier as string))
  let republished = 0
  for (const row of gaps) {
    // `attestedValue`, NOT the row's `amount`. The attestation commits
    // `meta.faceValue` while `amount` comes off the voucher's `token_amount`,
    // and where those differ, reading `amount` would republish a SECOND,
    // conflicting commitment for one redemption — worse than the gap.
    const value = row.attestedValue
    // Only republishable when that figure is still known locally; a nullifier
    // alone attests nothing, since there is no amount to commit to.
    if (typeof value !== 'number') continue
    const nullifier = row.attestationNullifier as string
    const attestation: Attestation = {
      nullifier,
      commitment: commitTo(Math.round(value), blindFor(sk, nullifier)),
      unit: typeof row.attestedUnit === 'string' && row.attestedUnit ? row.attestedUnit : 'UNKNOWN',
    }
    // Derived blinds make this idempotent: republishing after a partial relay
    // failure reproduces byte-identical content rather than a second,
    // conflicting commitment for the same redemption.
    const event = buildAttestation(attestation, sk)
    const result = await publish(event)
    // Only on success. A row must never claim a public record that no relay
    // accepted — the next sweep finds it as a gap again, which is correct.
    if (result.ok > 0) {
      republished++
      await writeReceipt(row, {
        nullifier,
        eventId: event.id,
        at: event.created_at * 1000,
      })
    }
  }

  return { checked: local.length, missing: gaps.length, republished }
}
