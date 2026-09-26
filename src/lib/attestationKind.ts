/**
 * The wire constants of the attestation stream, and nothing else.
 *
 * Split out of `attestation.ts` so a NODE process can read them. The producer
 * module reaches `./nap` and `./relay` for signing and publishing, which reach
 * `@imani/nap-client-web` and `import.meta.env` — a browser dependency graph and
 * a Vite-only global. The hosted audit API has neither, so importing the producer
 * to learn a kind number would drag the whole wallet into a service that must
 * never be able to sign anything.
 *
 * These are DECLARED here and re-exported by `attestation.ts`, rather than
 * copied. One definition, so the producer and every reader cannot disagree about
 * what is on the wire — a duplicated kind number is the kind of drift that is
 * invisible until a reader silently matches nothing.
 */

/**
 * A regular kind, like 7376 — relays keep every copy rather than replacing by
 * `d`. Append-only is exactly right for a redemption ledger; a replaceable kind
 * would let a later publish quietly erase an earlier redemption.
 *
 * 7377 sits beside NIP-60's 7375 (token) and 7376 (history) rather than in the
 * application range, because it is the same family of record. It is not a
 * registered NIP-60 kind; if one is standardised for this, move to it.
 */
export const ATTESTATION_KIND = 7377

/**
 * Payload version.
 *
 * - `1` — `{nullifier, commitment, unit}`. One attestation per event.
 * - `2` — adds `issuer`, a hiding commitment to the pubkey of the stall that
 *   ISSUED the coupon. See `issuerTagFor` in `attestation.ts`.
 *
 * **Why v2 exists.** A v1 attestation says "I credited N against some coupon"
 * and names no issuer, so a stall redeeming a coupon it never issued produced a
 * ledger entry indistinguishable from an honest one. That is Finding 4 of
 * `docs/research/audit-double-spend-inflation-review.md`, and it is why Finding
 * 1 was invisible to the ledger however carefully the reader looked.
 *
 * **Why the issuer is COMMITTED and not written plainly.** `issuerId` is the
 * stall's real Nostr pubkey. Publishing it beside a pseudonymous ledger key
 * would link the two for every coupon a merchant ever issued to themselves,
 * which is precisely the de-anonymisation the ledger key exists to prevent —
 * the design document calls a `ledgerPubkey -> stall` mapping "the single
 * artefact whose breach de-anonymises every merchant at once". A cleartext
 * issuer would be that mapping, published voluntarily, one row at a time.
 *
 * **The migration this forces, stated plainly.** `readAttestation` refuses a
 * version it does not know, which is the correct behaviour and also means a
 * reader older than v2 refuses every v2 event — it will report them as
 * `unknown_version` rather than mis-parsing, so nothing is silently wrong, but
 * a stale deployment of the audit API will show a stream that appears to stop.
 * Acceptable only because no attestation stream is in production yet. Deploy the
 * reader before, or with, any wallet that publishes v2.
 */
export const ATTESTATION_VERSION = '2'

/**
 * Versions this build's reader can read.
 *
 * Kept separate from the version it WRITES, because those are different
 * questions and conflating them is what forces a flag day: a reader must accept
 * the whole history on the relay, while a producer emits exactly one shape.
 * Every v1 event ever published stays readable.
 */
export const READABLE_ATTESTATION_VERSIONS = ['1', '2'] as const

/**
 * A customer's receipt of a customer-to-customer transfer (#91).
 *
 * NOT a 7377, and must never become one. A 7377 means "I honoured this
 * coupon", which only a stall does, and `reconcileAttestations` and the audit
 * reader treat every 7377 under a ledger key as a redemption. A customer who
 * was handed a gift honoured nothing, so their claim ("I received this from
 * the holder of that key") gets its own kind, beside its family for the same
 * reason 7377 sits beside 7375/7376. Regular, so append-only.
 *
 * Design, keys and disclosure: `docs/adr/0014-a-customer-transfer-is-signed-by-both-parties.md`.
 */
export const TRANSFER_RECEIPT_KIND = 7378

/**
 * Payload version of both the sender's signature and the receipt.
 *
 * 2: the sender's public signature binds the receiver's per-transfer key and
 * the commitment, per-transfer keys are identity keys tweaked by the secret
 * nonce, and the nonce is derived from the sender's key. Version 1 is refused
 * everywhere: its public half signed only the tag, so a receipt could be
 * copied under another author with a shifted commitment (ADR 0014).
 */
export const TRANSFER_SIGNATURE_VERSION = 2
