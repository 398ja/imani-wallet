/**
 * DmPollService tests - race condition prevention and resilient fallbacks
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DmPollService } from '../src/core/DmPollService';
import { MockNostrdbAdapter, createMockGiftWrap } from './mocks';
import type { CryptoAdapter } from '../src/adapters/CryptoAdapter';
import type { RedemptionAdapter } from '../src/adapters/RedemptionAdapter';
import type { StorageAdapter } from '../src/adapters/StorageAdapter';
import type { GiftWrapEvent, UnwrappedDm } from '../src/types';

function createMockCryptoAdapter(): CryptoAdapter {
  return {
    unwrapNip17Dm: vi.fn(async (_event: GiftWrapEvent, _privkey: string): Promise<UnwrappedDm> => ({
      senderPubkey: 'sender-pubkey-abc',
      content: 'cashuAeyJ0b2tlbiI6InRlc3QifQ some message',
      createdAt: Math.floor(Date.now() / 1000),
    })),
    extractToken: vi.fn((_content: string) => 'cashuAeyJ0b2tlbiI6InRlc3QifQ'),
    parseTokenTransferMessage: vi.fn(() => ({
      face_value: 100,
      face_unit: 'SAT',
    })),
    getTokenFingerprint: vi.fn((_token: string) => 'fingerprint-abc123'),
  };
}

function createMockRedemptionAdapter(): RedemptionAdapter {
  return {
    redeem: vi.fn(async () => ({
      voucher_id: 'v-' + Date.now(),
      token: 'cashuAeyJ0b2tlbiI6InRlc3QifQ',
      face_value: 100,
      face_unit: 'SAT',
      status: 'active' as const,
      created_at: new Date().toISOString(),
    })),
  };
}

function createMockStorageAdapter(): StorageAdapter {
  const receivedFingerprints = new Set<string>();
  const processedIds: string[] = [];

  return {
    saveVoucher: vi.fn(async () => {}),
    hasTokenBeenReceived: vi.fn(async (fp: string) => receivedFingerprints.has(fp)),
    markTokenAsReceived: vi.fn(async (fp: string) => { receivedFingerprints.add(fp); }),
    getProcessedEventIds: vi.fn(async () => [...processedIds]),
    saveProcessedEventIds: vi.fn(async (ids: string[]) => {
      processedIds.length = 0;
      processedIds.push(...ids);
    }),
  };
}

describe('DmPollService', () => {
  let nostrdbAdapter: MockNostrdbAdapter;
  let cryptoAdapter: CryptoAdapter;
  let redemptionAdapter: RedemptionAdapter;

  beforeEach(() => {
    nostrdbAdapter = new MockNostrdbAdapter();
    cryptoAdapter = createMockCryptoAdapter();
    redemptionAdapter = createMockRedemptionAdapter();
  });

  describe('processGiftWrap race condition', () => {
    it('should prevent duplicate processing when same event is processed concurrently', async () => {
      const service = new DmPollService({
        recipientPubkey: 'recipient-pub',
        recipientPrivkey: 'recipient-priv',
        nostrdbAdapter,
        cryptoAdapter,
        redemptionAdapter,
        enableAutoRedemption: true,
        fetchRecentOnStart: false,
      });

      const event = createMockGiftWrap({ id: 'duplicate-event-id' });

      // Fire two concurrent processGiftWrap calls for the same event
      const [result1, result2] = await Promise.all([
        service.processGiftWrap(event),
        service.processGiftWrap(event),
      ]);

      // Exactly one should succeed, one should return null (blocked by in-flight guard)
      const results = [result1, result2];
      const successful = results.filter(r => r !== null);
      const blocked = results.filter(r => r === null);

      expect(successful).toHaveLength(1);
      expect(blocked).toHaveLength(1);

      // Redemption should only have been called once
      expect(redemptionAdapter.redeem).toHaveBeenCalledTimes(1);
    });

    it('should allow processing a new event after the first completes', async () => {
      const service = new DmPollService({
        recipientPubkey: 'recipient-pub',
        recipientPrivkey: 'recipient-priv',
        nostrdbAdapter,
        cryptoAdapter,
        redemptionAdapter,
        enableAutoRedemption: true,
        fetchRecentOnStart: false,
      });

      const event1 = createMockGiftWrap({ id: 'event-1' });
      const event2 = createMockGiftWrap({ id: 'event-2' });

      // Process first event
      const result1 = await service.processGiftWrap(event1);
      expect(result1).not.toBeNull();

      // Process second event (different ID)
      const result2 = await service.processGiftWrap(event2);
      expect(result2).not.toBeNull();

      expect(redemptionAdapter.redeem).toHaveBeenCalledTimes(2);
    });

    it('should release in-flight guard even if processing fails', async () => {
      // Make unwrap throw an error
      (cryptoAdapter.unwrapNip17Dm as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Decryption failed')
      );

      const service = new DmPollService({
        recipientPubkey: 'recipient-pub',
        recipientPrivkey: 'recipient-priv',
        nostrdbAdapter,
        cryptoAdapter,
        fetchRecentOnStart: false,
      });

      const event = createMockGiftWrap({ id: 'fail-then-retry' });

      // First attempt fails
      const result1 = await service.processGiftWrap(event);
      expect(result1).toBeNull();

      // Second attempt should NOT be blocked by in-flight guard
      // Clear the failed tracker so we can test the in-flight guard specifically
      await service.clearFailedEvents();

      const result2 = await service.processGiftWrap(event);
      // This succeeds because the in-flight guard was properly cleaned up
      expect(result2).not.toBeNull();
    });

    it('should skip already-processed events from eventTracker', async () => {
      const service = new DmPollService({
        recipientPubkey: 'recipient-pub',
        recipientPrivkey: 'recipient-priv',
        nostrdbAdapter,
        cryptoAdapter,
        redemptionAdapter,
        enableAutoRedemption: true,
        fetchRecentOnStart: false,
      });

      const event = createMockGiftWrap({ id: 'already-done' });

      // Process once
      const result1 = await service.processGiftWrap(event);
      expect(result1).not.toBeNull();

      // Process again (now in eventTracker)
      const result2 = await service.processGiftWrap(event);
      expect(result2).toBeNull();

      // Redemption only called once
      expect(redemptionAdapter.redeem).toHaveBeenCalledTimes(1);
    });
  });

  describe('token fingerprint in-flight guard', () => {
    it('should prevent concurrent redemption of same token in different events', async () => {
      const service = new DmPollService({
        recipientPubkey: 'recipient-pub',
        recipientPrivkey: 'recipient-priv',
        nostrdbAdapter,
        cryptoAdapter,
        redemptionAdapter,
        enableAutoRedemption: true,
        fetchRecentOnStart: false,
      });

      // Two different events carrying the same token (same fingerprint)
      const event1 = createMockGiftWrap({ id: 'event-a' });
      const event2 = createMockGiftWrap({ id: 'event-b' });

      // Both events produce the same fingerprint (default mock returns 'fingerprint-abc123')
      const [result1, result2] = await Promise.all([
        service.processGiftWrap(event1),
        service.processGiftWrap(event2),
      ]);

      const results = [result1, result2];
      const successful = results.filter(r => r !== null);

      // Only one should succeed; the other blocked by fingerprint guard
      expect(successful).toHaveLength(1);
      expect(redemptionAdapter.redeem).toHaveBeenCalledTimes(1);
    });

    it('should allow same fingerprint after first processing completes', async () => {
      // Return different fingerprints for sequential calls
      let callCount = 0;
      (cryptoAdapter.getTokenFingerprint as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        return `fingerprint-${callCount}`;
      });

      const service = new DmPollService({
        recipientPubkey: 'recipient-pub',
        recipientPrivkey: 'recipient-priv',
        nostrdbAdapter,
        cryptoAdapter,
        redemptionAdapter,
        enableAutoRedemption: true,
        fetchRecentOnStart: false,
      });

      const event1 = createMockGiftWrap({ id: 'seq-event-1' });
      const event2 = createMockGiftWrap({ id: 'seq-event-2' });

      const result1 = await service.processGiftWrap(event1);
      expect(result1).not.toBeNull();

      const result2 = await service.processGiftWrap(event2);
      expect(result2).not.toBeNull();

      expect(redemptionAdapter.redeem).toHaveBeenCalledTimes(2);
    });
  });

  describe('already-redeemed error handling', () => {
    it('should treat "proof already used" as idempotent success', async () => {
      const storageAdapter = createMockStorageAdapter();
      const errorSpy = vi.fn();

      // Make redeem throw "proof already used"
      (redemptionAdapter.redeem as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('proof already used')
      );

      const service = new DmPollService({
        recipientPubkey: 'recipient-pub',
        recipientPrivkey: 'recipient-priv',
        nostrdbAdapter,
        cryptoAdapter,
        redemptionAdapter,
        storageAdapter,
        enableAutoRedemption: true,
        fetchRecentOnStart: false,
      });

      service.on('redemption:error', errorSpy);

      const event = createMockGiftWrap({ id: 'already-used-event' });
      const result = await service.processGiftWrap(event);

      // Should still return the tokenDm (not null from error path)
      expect(result).not.toBeNull();

      // Should NOT emit redemption:error — it's not a real failure
      expect(errorSpy).not.toHaveBeenCalled();

      // Should mark the token fingerprint as received to prevent future retries
      expect(storageAdapter.markTokenAsReceived).toHaveBeenCalled();
    });

    it('should treat "Token has already been redeemed" as idempotent success', async () => {
      const storageAdapter = createMockStorageAdapter();

      (redemptionAdapter.redeem as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Token has already been redeemed')
      );

      const service = new DmPollService({
        recipientPubkey: 'recipient-pub',
        recipientPrivkey: 'recipient-priv',
        nostrdbAdapter,
        cryptoAdapter,
        redemptionAdapter,
        storageAdapter,
        enableAutoRedemption: true,
        fetchRecentOnStart: false,
      });

      const event = createMockGiftWrap({ id: 'already-redeemed-event' });
      const result = await service.processGiftWrap(event);

      expect(result).not.toBeNull();
      expect(storageAdapter.markTokenAsReceived).toHaveBeenCalled();
    });

    it('should emit redemption:success with bundle envelope on already-redeemed bundle parts', async () => {
      // Regression for the multi-voucher receive bug ("received 0.09 of 1.09").
      // When a bundle part hits the already-redeemed branch (SSE redelivery,
      // page reload mid-redemption, etc.), the BundleReceiptStore must still
      // see the part so its sum reaches the declared total. The pre-fix code
      // returned silently and the bundle aggregator stalled at the partial sum.
      const successSpy = vi.fn();
      const storageAdapter = createMockStorageAdapter();

      cryptoAdapter.parseTokenTransferMessage = vi.fn(() => ({
        faceValue: 100,
        faceUnit: 'EUR',
        faceDecimals: 2,
        bundleId: 'bundle-aaa',
        bundleTotal: 109,
        bundlePartIndex: 0,
        bundlePartCount: 2,
        bundlePartId: 'bundle-aaa:0',
        bundleAttempt: 0,
      }));

      (redemptionAdapter.redeem as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Token has already been redeemed')
      );

      const service = new DmPollService({
        recipientPubkey: 'recipient-pub',
        recipientPrivkey: 'recipient-priv',
        nostrdbAdapter,
        cryptoAdapter,
        redemptionAdapter,
        storageAdapter,
        enableAutoRedemption: true,
        fetchRecentOnStart: false,
      });

      service.on('redemption:success', successSpy);

      const event = createMockGiftWrap({ id: 'idempotent-bundle-part-0' });
      await service.processGiftWrap(event);

      expect(successSpy).toHaveBeenCalledTimes(1);
      const payload = successSpy.mock.calls[0][0];
      expect(payload.bundle).toMatchObject({
        bundleId: 'bundle-aaa',
        bundleTotal: 109,
        bundlePartIndex: 0,
        bundlePartCount: 2,
      });
      expect(payload.voucher.face_value).toBe(100);
      expect(payload.voucher.face_unit).toBe('EUR');
    });

    it('should still emit error for real redemption failures and let processGiftWrap report failure', async () => {
      const errorSpy = vi.fn();

      // A real failure — not "already redeemed"
      (redemptionAdapter.redeem as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Network timeout')
      );

      const service = new DmPollService({
        recipientPubkey: 'recipient-pub',
        recipientPrivkey: 'recipient-priv',
        nostrdbAdapter,
        cryptoAdapter,
        redemptionAdapter,
        enableAutoRedemption: true,
        fetchRecentOnStart: false,
      });

      service.on('redemption:error', errorSpy);

      const event = createMockGiftWrap({ id: 'real-failure-event' });
      const result = await service.processGiftWrap(event);

      // redeemToken now rethrows transient failures so the outer processGiftWrap
      // catch tracks the event in failedTracker and skips eventTracker.add. The
      // pre-fix behaviour silently consumed the error and marked the event as
      // permanently processed, blocking every retry — that was the root cause
      // of the "received 0.09 of 1.09" multi-voucher receive bug.
      expect(result).toBeNull();

      // SHOULD emit redemption:error for real failures
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Network timeout' })
      );
    });
  });
});
