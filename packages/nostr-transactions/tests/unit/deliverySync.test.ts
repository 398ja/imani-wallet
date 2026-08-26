/**
 * Spec 014 (T071c) — FR-014 cross-device sync verification.
 *
 * Asserts the new delivery fields (deliveryState, deliveredAt,
 * deliveryConfirmedParts) ride the existing NIP-60 history-event
 * sync round-trip cleanly. A new device replaying the same history
 * MUST end up with the badge state intact.
 */

import { describe, it, expect } from 'vitest';
import {
  transactionToHistoryContent,
  historyContentToTransaction,
} from '../../src/sync/types';
import {
  createTransaction,
  TransactionType,
  TransactionDirection,
} from '../../src/types/transaction';

describe('FR-014 cross-device sync of delivery state (014 T071c)', () => {
  it('round-trips delivery fields for a single-voucher confirmed send', () => {
    const tx = createTransaction({
      type: TransactionType.SENT,
      direction: TransactionDirection.OUT,
      tokenAmount: 1000,
      faceValue: 100,
      faceUnit: 'EUR',
      voucherId: 'cashuAabc',
      counterparty: 'recipient-pubkey',
    });
    tx.deliveryState = 'confirmed';
    tx.deliveredAt = 1746288000;

    const content = transactionToHistoryContent(tx);
    expect(content.delivery_state).toBe('confirmed');
    expect(content.delivered_at).toBe(1746288000);
    expect(content.delivery_confirmed_parts).toBeUndefined();

    const restored = historyContentToTransaction(content, 'evt-1', 1746288100);
    expect(restored.deliveryState).toBe('confirmed');
    expect(restored.deliveredAt).toBe(1746288000);
    expect(restored.deliveryConfirmedParts).toBeUndefined();
  });

  it('round-trips a partial-state bundle row mid-flight', () => {
    const tx = createTransaction({
      type: TransactionType.SENT,
      direction: TransactionDirection.OUT,
      tokenAmount: 3000,
      faceValue: 300,
      faceUnit: 'EUR',
      counterparty: 'recipient-pubkey',
      bundleId: 'bundle-1',
      bundlePartCount: 3,
    });
    tx.deliveryState = 'partial';
    tx.deliveryConfirmedParts = 2;

    const content = transactionToHistoryContent(tx);
    expect(content.delivery_state).toBe('partial');
    expect(content.delivery_confirmed_parts).toBe(2);
    expect(content.delivered_at).toBeUndefined();

    const restored = historyContentToTransaction(content, 'evt-2', 1746288100);
    expect(restored.deliveryState).toBe('partial');
    expect(restored.deliveryConfirmedParts).toBe(2);
    expect(restored.deliveredAt).toBeUndefined();
  });

  it('legacy / pre-014 records survive the round-trip cleanly', () => {
    const tx = createTransaction({
      type: TransactionType.SENT,
      direction: TransactionDirection.OUT,
      tokenAmount: 500,
      faceValue: 50,
      faceUnit: 'EUR',
      voucherId: 'cashuAlegacy',
      counterparty: 'recipient-pubkey',
    });
    // No delivery fields on this tx (pre-014).
    const content = transactionToHistoryContent(tx);
    expect(content.delivery_state).toBeUndefined();
    expect(content.delivered_at).toBeUndefined();
    expect(content.delivery_confirmed_parts).toBeUndefined();

    const restored = historyContentToTransaction(content, 'evt-3', 1746288100);
    expect(restored.deliveryState).toBeUndefined();
    expect(restored.deliveredAt).toBeUndefined();
    expect(restored.deliveryConfirmedParts).toBeUndefined();
  });

  it('a synced peer sees the same delivery_state regardless of device', () => {
    // Device A: marks delivered.
    const tx = createTransaction({
      type: TransactionType.SENT,
      direction: TransactionDirection.OUT,
      tokenAmount: 1000,
      faceValue: 100,
      faceUnit: 'EUR',
      voucherId: 'cashuAabc',
      counterparty: 'recipient-pubkey',
    });
    tx.deliveryState = 'confirmed';
    tx.deliveredAt = 1746288000;

    // → emit history event content.
    const content = transactionToHistoryContent(tx);

    // Device B: sees the event for the first time.
    const restoredB = historyContentToTransaction(content, 'evt-shared', 1746288100);

    // Device C: sees the same event after device B has already
    // applied it. The sync content is idempotent — same delivery
    // state regardless of who's reading.
    const restoredC = historyContentToTransaction(content, 'evt-shared', 1746288200);

    expect(restoredB.deliveryState).toBe(restoredC.deliveryState);
    expect(restoredB.deliveredAt).toBe(restoredC.deliveredAt);
    expect(restoredB.deliveryState).toBe('confirmed');
  });
});
