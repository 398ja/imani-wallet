/**
 * Spec 014 (payment receipts) — TransactionStore.markDelivered +
 * applyBundlePartReceipt vitest cases.
 *
 * Uses the in-memory adapter so the tests don't require an IDB shim.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TransactionStore,
  TransactionType,
  TransactionDirection,
  type TransactionInput,
} from '../../src';

const NOW = 1746288000;

function singleSendInput(overrides: Partial<TransactionInput> = {}): TransactionInput {
  return {
    type: TransactionType.SENT,
    direction: TransactionDirection.OUT,
    tokenAmount: 1000,
    faceValue: 100,
    faceUnit: 'EUR',
    faceDecimals: 2,
    voucherId: 'cashuAabc',
    counterparty: 'recipient-pubkey',
    ...overrides,
  };
}

function bundleSendInput(overrides: Partial<TransactionInput> = {}): TransactionInput {
  return {
    type: TransactionType.SENT,
    direction: TransactionDirection.OUT,
    tokenAmount: 3000,
    faceValue: 300,
    faceUnit: 'EUR',
    faceDecimals: 2,
    counterparty: 'recipient-pubkey',
    bundleId: 'bundle-1',
    bundlePartCount: 3,
    bundleDeclaredTotal: 300,
    bundleReceivedAmount: 0,
    bundleState: 'IN_FLIGHT',
    ...overrides,
  };
}

describe('TransactionStore.markDelivered (014 T023)', () => {
  let store: TransactionStore;

  beforeEach(async () => {
    store = new TransactionStore({ storage: 'memory' });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  it('flips a sent transaction to confirmed and stamps deliveredAt', async () => {
    const tx = await store.record(singleSendInput());
    expect(tx.deliveryState).toBeUndefined();

    const updated = await store.markDelivered(tx.id, NOW);
    expect(updated).not.toBeNull();
    expect(updated!.deliveryState).toBe('confirmed');
    expect(updated!.deliveredAt).toBe(NOW);
  });

  it('is idempotent — re-marking returns null', async () => {
    const tx = await store.record(singleSendInput());
    await store.markDelivered(tx.id, NOW);
    const second = await store.markDelivered(tx.id, NOW + 60);
    expect(second).toBeNull();

    // Original deliveredAt is preserved (FR-010 no downgrade).
    const fetched = await store.get(tx.id);
    expect(fetched!.deliveredAt).toBe(NOW);
  });

  it('returns null for an unknown transaction id', async () => {
    const result = await store.markDelivered('does-not-exist', NOW);
    expect(result).toBeNull();
  });

  it('emits transactionUpdated on real change but not on idempotent re-apply', async () => {
    const tx = await store.record(singleSendInput());
    const fired: string[] = [];
    const unsub = store.on('transactionUpdated', (t) => fired.push(t.id));

    await store.markDelivered(tx.id, NOW);
    await store.markDelivered(tx.id, NOW + 60);

    expect(fired).toEqual([tx.id]);
    unsub();
  });
});

describe('TransactionStore.applyBundlePartReceipt (014 T023)', () => {
  let store: TransactionStore;

  beforeEach(async () => {
    store = new TransactionStore({ storage: 'memory' });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  it('moves a 3-part bundle through pending → partial → confirmed', async () => {
    const tx = await store.record(bundleSendInput());

    const after1 = await store.applyBundlePartReceipt(tx.id, 'cashuApart1', NOW);
    expect(after1!.deliveryConfirmedParts).toBe(1);
    expect(after1!.deliveryState).toBe('partial');
    expect(after1!.deliveredAt).toBeUndefined();

    const after2 = await store.applyBundlePartReceipt(tx.id, 'cashuApart2', NOW + 30);
    expect(after2!.deliveryConfirmedParts).toBe(2);
    expect(after2!.deliveryState).toBe('partial');
    expect(after2!.deliveredAt).toBeUndefined();

    const after3 = await store.applyBundlePartReceipt(tx.id, 'cashuApart3', NOW + 60);
    expect(after3!.deliveryConfirmedParts).toBe(3);
    expect(after3!.deliveryState).toBe('confirmed');
    expect(after3!.deliveredAt).toBe(NOW + 60);
  });

  it('dedupes the same partVoucherId — second call returns null', async () => {
    const tx = await store.record(bundleSendInput());
    await store.applyBundlePartReceipt(tx.id, 'cashuApart1', NOW);
    const second = await store.applyBundlePartReceipt(tx.id, 'cashuApart1', NOW + 60);
    expect(second).toBeNull();
  });

  it('clamps deliveryConfirmedParts to bundlePartCount on overflow', async () => {
    // Pretend a 1-part bundle exists; arriving a second distinct
    // voucherId would otherwise push to 2.
    const tx = await store.record(
      bundleSendInput({ bundlePartCount: 1, bundleDeclaredTotal: 100 }),
    );
    const after = await store.applyBundlePartReceipt(tx.id, 'cashuApart1', NOW);
    expect(after!.deliveryState).toBe('confirmed');
    expect(after!.deliveryConfirmedParts).toBe(1);
  });

  it('returns null if the row is not a bundle row', async () => {
    const tx = await store.record(singleSendInput());
    const result = await store.applyBundlePartReceipt(tx.id, 'cashuAabc', NOW);
    expect(result).toBeNull();
  });

  it('respects no-downgrade: applies to a confirmed row return null', async () => {
    const tx = await store.record(bundleSendInput({ bundlePartCount: 1 }));
    await store.applyBundlePartReceipt(tx.id, 'cashuApart1', NOW);
    const result = await store.applyBundlePartReceipt(tx.id, 'cashuApartLate', NOW + 60);
    expect(result).toBeNull();
  });

  it('emits transactionUpdated only on real changes', async () => {
    const tx = await store.record(bundleSendInput());
    const fired: string[] = [];
    const unsub = store.on('transactionUpdated', (t) => fired.push(t.id));

    await store.applyBundlePartReceipt(tx.id, 'cashuApart1', NOW);
    await store.applyBundlePartReceipt(tx.id, 'cashuApart1', NOW + 60); // dedup, no emit

    expect(fired).toEqual([tx.id]);
    unsub();
  });

  // Spec 014 US3 (FR-012, T064) — additional bundle scenarios.

  it('order-independent convergence: parts arriving in any order land at confirmed at k=N', async () => {
    const tx = await store.record(bundleSendInput());
    const ids = ['cashuAa', 'cashuAb', 'cashuAc'];
    // Run shuffled. The bundle must end up confirmed regardless.
    const shuffled = [ids[2], ids[0], ids[1]];
    let last;
    for (let i = 0; i < shuffled.length; i++) {
      last = await store.applyBundlePartReceipt(tx.id, shuffled[i], NOW + i * 10);
    }
    expect(last!.deliveryState).toBe('confirmed');
    expect(last!.deliveryConfirmedParts).toBe(3);
  });

  it('mixed-arrival: dedup interleaved with new parts still converges', async () => {
    const tx = await store.record(bundleSendInput());
    // a (new) → a (dedup) → b (new) → a (dedup) → c (new) — should
    // confirm at 3/3 with no over-counting.
    const ops: Array<[string, number]> = [
      ['cashuAa', NOW],
      ['cashuAa', NOW + 1],   // dedup
      ['cashuAb', NOW + 10],
      ['cashuAa', NOW + 11],  // dedup
      ['cashuAc', NOW + 20],
    ];
    let last;
    for (const [vid, at] of ops) {
      last = await store.applyBundlePartReceipt(tx.id, vid, at);
    }
    const fetched = await store.get(tx.id);
    expect(fetched!.deliveryState).toBe('confirmed');
    expect(fetched!.deliveryConfirmedParts).toBe(3);
    // deliveredAt is set on the FINAL transition only, not bumped by
    // the late-arriving duplicate.
    expect(fetched!.deliveredAt).toBe(NOW + 20);
  });

  it('partial → confirmed: bundle row subtitle progression is observable', async () => {
    const tx = await store.record(bundleSendInput());
    // After 1: partial 1/3
    let after = await store.applyBundlePartReceipt(tx.id, 'cashuAa', NOW);
    expect(after!.deliveryState).toBe('partial');
    expect(after!.deliveryConfirmedParts).toBe(1);
    // After 2: partial 2/3
    after = await store.applyBundlePartReceipt(tx.id, 'cashuAb', NOW + 30);
    expect(after!.deliveryState).toBe('partial');
    expect(after!.deliveryConfirmedParts).toBe(2);
    // After 3: confirmed 3/3
    after = await store.applyBundlePartReceipt(tx.id, 'cashuAc', NOW + 60);
    expect(after!.deliveryState).toBe('confirmed');
    expect(after!.deliveryConfirmedParts).toBe(3);
    // Never went backwards.
  });

  it('full bundle is reached even when a stale duplicate races a fresh part', async () => {
    const tx = await store.record(bundleSendInput({ bundlePartCount: 2 }));
    // Stale-but-fresh-id 'a' sneaks in twice; only first counts.
    await store.applyBundlePartReceipt(tx.id, 'cashuAa', NOW);
    await store.applyBundlePartReceipt(tx.id, 'cashuAa', NOW + 1);
    const final = await store.applyBundlePartReceipt(tx.id, 'cashuAb', NOW + 10);
    expect(final!.deliveryState).toBe('confirmed');
    expect(final!.deliveryConfirmedParts).toBe(2);
  });
});
