/**
 * FR-019 — per-event outcome classifier.
 *
 * Pure function returning the watermark + processed-set + retry policy
 * for one gift-wrap processing outcome. Replaces ad-hoc per-call-site
 * decisions in `shared/dmPoll.js` so the policy lives in one
 * canonical, table-tested place (see classifyEventOutcome.test.ts —
 * one assertion per row of FR-019).
 *
 * Spec mapping: spec.md FR-018 / FR-019.
 */

/**
 * Enum-of-strings discriminator for the FR-019 rows. Each value maps to
 * exactly one row of the table in spec.md.
 */
export type EventOutcome =
  | 'decryption_failure'
  | 'malformed_payload'
  | 'non_token_dm'
  | 'duplicate_event'
  | 'transient_receive_within_budget'
  | 'transient_receive_budget_exhausted'
  | 'terminal_receive'
  | 'success'
  | 'atomic_write_failed';

/**
 * Outcome of the classifier — the trio of decisions a per-event
 * finalizer makes.
 *
 *  - `shouldMarkProcessed`: add the event_id to processedEventIds so
 *    future ticks skip it via the dedup gate.
 *  - `shouldAdvanceWatermark`: advance the catch-up cursor past this
 *    event's createdAt.
 *  - `retryEligible`: the next trigger should re-fetch this event and
 *    try again. (When false, the event is either handled or dropped
 *    permanently.)
 */
export interface OutcomeDecision {
  shouldMarkProcessed: boolean;
  shouldAdvanceWatermark: boolean;
  retryEligible: boolean;
}

/**
 * The FR-019 outcome table, encoded as a const map. Reading this in
 * source is the single canonical reference for what each outcome means.
 * The test file pins every row against spec.md.
 */
const OUTCOME_TABLE: Readonly<Record<EventOutcome, OutcomeDecision>> = Object.freeze({
  decryption_failure: Object.freeze({ shouldMarkProcessed: true, shouldAdvanceWatermark: true, retryEligible: false }),
  malformed_payload: Object.freeze({ shouldMarkProcessed: true, shouldAdvanceWatermark: true, retryEligible: false }),
  non_token_dm: Object.freeze({ shouldMarkProcessed: true, shouldAdvanceWatermark: true, retryEligible: false }),
  duplicate_event: Object.freeze({ shouldMarkProcessed: true, shouldAdvanceWatermark: true, retryEligible: false }),
  transient_receive_within_budget: Object.freeze({ shouldMarkProcessed: false, shouldAdvanceWatermark: false, retryEligible: true }),
  transient_receive_budget_exhausted: Object.freeze({ shouldMarkProcessed: false, shouldAdvanceWatermark: false, retryEligible: true }),
  terminal_receive: Object.freeze({ shouldMarkProcessed: true, shouldAdvanceWatermark: true, retryEligible: false }),
  success: Object.freeze({ shouldMarkProcessed: true, shouldAdvanceWatermark: true, retryEligible: false }),
  atomic_write_failed: Object.freeze({ shouldMarkProcessed: false, shouldAdvanceWatermark: false, retryEligible: true }),
});

/**
 * Classify an event outcome into the FR-019 decision triplet. Pure
 * lookup, no side effects.
 *
 * @throws Error when `outcome` is not a known FR-019 value (forces the
 *         caller to add the new row to spec.md + this map BEFORE the
 *         pipeline can produce it).
 */
export function classifyEventOutcome(outcome: EventOutcome): OutcomeDecision {
  const decision = OUTCOME_TABLE[outcome];
  if (!decision) {
    throw new Error(
      `classifyEventOutcome: unknown outcome "${outcome}". ` +
        `Add the row to spec.md FR-019 and OUTCOME_TABLE in classifyEventOutcome.ts before producing it.`
    );
  }
  return decision;
}
