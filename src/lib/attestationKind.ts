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
 * Payload version. `1` is one attestation per event; a batched format would be
 * `2`, carrying a list. Present from the first event so the migration is
 * detectable rather than a guess.
 */
export const ATTESTATION_VERSION = '1'
