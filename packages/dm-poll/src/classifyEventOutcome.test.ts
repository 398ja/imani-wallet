/**
 * Vitest for classifyEventOutcome (T012f).
 *
 * One assertion per row of FR-019's outcome table. If the spec adds a
 * new row, the corresponding test case MUST also land here — drift
 * between spec.md and the classifier is the bug class this test exists
 * to prevent.
 */

import { describe, it, expect } from 'vitest';
import { classifyEventOutcome } from './classifyEventOutcome';
import type { EventOutcome } from './classifyEventOutcome';

interface ExpectedRow {
  outcome: EventOutcome;
  shouldMarkProcessed: boolean;
  shouldAdvanceWatermark: boolean;
  retryEligible: boolean;
  specDescription: string;
}

const ROWS: ReadonlyArray<ExpectedRow> = [
  {
    outcome: 'decryption_failure',
    shouldMarkProcessed: true,
    shouldAdvanceWatermark: true,
    retryEligible: false,
    specDescription: 'Decryption failure (foreign gift wrap, wrong recipient) → ADD, YES, No',
  },
  {
    outcome: 'malformed_payload',
    shouldMarkProcessed: true,
    shouldAdvanceWatermark: true,
    retryEligible: false,
    specDescription: 'Malformed payload (parseTokenTransferMessage returns null) → ADD, YES, No',
  },
  {
    outcome: 'non_token_dm',
    shouldMarkProcessed: true,
    shouldAdvanceWatermark: true,
    retryEligible: false,
    specDescription: 'Non-token-DM kind-1059 (other app, ack envelope) → ADD, YES, No',
  },
  {
    outcome: 'duplicate_event',
    shouldMarkProcessed: true,
    shouldAdvanceWatermark: true,
    retryEligible: false,
    specDescription: 'Duplicate (event_id already in processedEventIds) → (already in), YES, No',
  },
  {
    outcome: 'transient_receive_within_budget',
    shouldMarkProcessed: false,
    shouldAdvanceWatermark: false,
    retryEligible: true,
    specDescription: 'Transient api.receive failure within retry budget → NOT YET, NO, YES',
  },
  {
    outcome: 'transient_receive_budget_exhausted',
    shouldMarkProcessed: false,
    shouldAdvanceWatermark: false,
    retryEligible: true,
    specDescription: 'Transient api.receive failure, retry budget exhausted → NOT YET, NO, YES (next trigger restarts the budget)',
  },
  {
    outcome: 'terminal_receive',
    shouldMarkProcessed: true,
    shouldAdvanceWatermark: true,
    retryEligible: false,
    specDescription: 'Terminal api.receive failure (already_spent, bad_signature, RedemptionSaveError, RedemptionClaimContendedError) → ADD, YES, No',
  },
  {
    outcome: 'success',
    shouldMarkProcessed: true,
    shouldAdvanceWatermark: true,
    retryEligible: false,
    specDescription: 'Successful api.receive + atomic voucher+tx write succeeds → ADD, YES, No',
  },
  {
    outcome: 'atomic_write_failed',
    shouldMarkProcessed: false,
    shouldAdvanceWatermark: false,
    retryEligible: true,
    specDescription: 'Successful api.receive + walletStorage.atomicallyWrite throws (BOTH rows absent) → NOT YET, NO, YES',
  },
];

describe('classifyEventOutcome', () => {
  for (const row of ROWS) {
    it(`row "${row.outcome}": ${row.specDescription}`, () => {
      const decision = classifyEventOutcome(row.outcome);
      expect(decision.shouldMarkProcessed).toBe(row.shouldMarkProcessed);
      expect(decision.shouldAdvanceWatermark).toBe(row.shouldAdvanceWatermark);
      expect(decision.retryEligible).toBe(row.retryEligible);
    });
  }

  it('rejects unknown outcomes with a spec-prompting error', () => {
    // @ts-expect-error — intentionally invalid value to exercise the guard.
    expect(() => classifyEventOutcome('something_new')).toThrow(/Add the row to spec\.md FR-019/);
  });

  it('mutation attempts on the returned decision do not corrupt the table', () => {
    // The lookup table entries are Object.freeze'd — direct mutation either
    // throws (strict mode) or silently no-ops (sloppy mode). Either way, the
    // canonical decision is unchanged on the next call. Pin THAT invariant
    // rather than relying on the mode-dependent throw behaviour.
    const a = classifyEventOutcome('success');
    try {
      // @ts-expect-error — intentional mutation attempt
      a.shouldMarkProcessed = false;
    } catch {
      /* strict mode threw — fine */
    }
    expect(classifyEventOutcome('success').shouldMarkProcessed).toBe(true);
  });
});
