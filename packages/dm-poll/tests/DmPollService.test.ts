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
    // Accepts every token: these tests are about dedup and races, not the mint gate
    // (that is src/core/backingGate.test.ts).
    checkBacking: vi.fn(() => ({ outcome: 'accept' as const })),
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

    it('leaves the blocked copy unprocessed, so it survives a failure of the first (imani-wallet#204)', async () => {
      // The first redemption fails retryably. Its copy must still be offered
      // again, and so must the duplicate that was turned away meanwhile.
      (redemptionAdapter.redeem as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('HTTP 502'));
      const service = new DmPollService({
        recipientPubkey: 'recipient-pub',
        recipientPrivkey: 'recipient-priv',
        nostrdbAdapter,
        cryptoAdapter,
        redemptionAdapter,
        enableAutoRedemption: true,
        fetchRecentOnStart: false,
      });

      await Promise.all([
        service.processGiftWrap(createMockGiftWrap({ id: 'first-copy' })),
        service.processGiftWrap(createMockGiftWrap({ id: 'second-copy' })),
      ]);

      expect(service.hasProcessed('first-copy')).toBe(false);
      expect(service.hasProcessed('second-copy')).toBe(false);
      // And it redeems on the next offer.
      expect(await service.processGiftWrap(createMockGiftWrap({ id: 'second-copy' }))).not.toBeNull();
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

  /**
   * #110: which path resubmits a token whose swap already SUCCEEDED.
   *
   * tokenRedemption throws RedemptionSaveError when the swap succeeds and the
   * local write fails. Its message is not an "already redeemed" one, so
   * redeemToken rethrows, processGiftWrap files the wrap in the failed tracker
   * and never marks the token received, and the replay (retry cooldown, or a
   * catch-up once the cooldown passes) calls redeem() with the SAME token. That
   * is the resubmission; the wallet's fix is that it now carries the same
   * idempotency key (see src/lib/__tests__/receiveIdempotency.test.ts).
   */
  describe('re-submission of a settled token (#110)', () => {
    it('a save failure after a successful swap is replayed with the same token', async () => {
      const saveError = Object.assign(
        new Error('Voucher swap succeeded but local save failed; proofs are recoverable on next boot'),
        { name: 'RedemptionSaveError', receiveId: '0c707915' },
      );
      const redeem = redemptionAdapter.redeem as ReturnType<typeof vi.fn>;
      redeem.mockRejectedValueOnce(saveError);
      const storageAdapter = createMockStorageAdapter();

      const service = new DmPollService({
        recipientPubkey: 'recipient-pub',
        recipientPrivkey: 'recipient-priv',
        nostrdbAdapter,
        cryptoAdapter,
        redemptionAdapter,
        storageAdapter,
        enableAutoRedemption: true,
        fetchRecentOnStart: false,
        retryCooldownMs: 0,
      });

      const event = createMockGiftWrap({ id: 'settled-then-save-failed' });
      expect(await service.processGiftWrap(event)).toBeNull();
      expect(storageAdapter.markTokenAsReceived).not.toHaveBeenCalled();
      expect(service.getFailedEvents().map((f) => f.eventId)).toEqual(['settled-then-save-failed']);

      await service.replayEvent('settled-then-save-failed');
      expect(redeem).toHaveBeenCalledTimes(2);
      expect(redeem.mock.calls[1][0]).toBe(redeem.mock.calls[0][0]);
    });

    /**
     * And not only after the hour's cooldown: fetchRecentDms does not consult
     * the failed tracker, so the very next catch-up (SSE reconnect, tab
     * visible, back online) resubmits it within seconds, which fits the 3.4 s
     * gap between the two receives on staging.
     */
    it('the next catch-up resubmits a failed wrap immediately, ignoring the cooldown', async () => {
      const redeem = redemptionAdapter.redeem as ReturnType<typeof vi.fn>;
      redeem.mockRejectedValueOnce(new Error('Voucher swap succeeded but local save failed'));
      const event = createMockGiftWrap({ id: 'caught-up-again' });
      nostrdbAdapter.setEvents([event]);

      const service = new DmPollService({
        recipientPubkey: 'recipient-pubkey-456',
        recipientPrivkey: 'recipient-priv',
        nostrdbAdapter,
        cryptoAdapter,
        redemptionAdapter,
        enableAutoRedemption: true,
        fetchRecentOnStart: false,
      });

      await service.fetchRecentDms();
      await service.fetchRecentDms();
      expect(redeem).toHaveBeenCalledTimes(2);
    });

    /**
     * Review of #111, item 3: a receive the gateway settled whose value is NOT
     * in this wallet is terminal for re-swapping but must never read as a
     * success: not marked received, no redemption:success, a distinct
     * redemption:unsaved carrying the receive_id for reconciliation.
     */
    it.each([
      ['tokenRedemption settled-not-saved', { code: 'RECEIVE_SETTLED_NOT_SAVED', receiveId: '0c707915', reason: 'replay-without-token' }],
      ["the gateway's raw 409", { code: 'RECEIVE_ALREADY_SETTLED', status: 409, receiveId: '0c707915' }],
    ])('%s: terminal, not success, not marked received, surfaced as unsaved', async (_name, extra) => {
      // Worded like an already-spent error on purpose: the code must win.
      const err = Object.assign(new Error('Proof already used (settled)'), extra);
      (redemptionAdapter.redeem as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err);
      const storageAdapter = createMockStorageAdapter();

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
      const success = vi.fn();
      const unsaved = vi.fn();
      service.on('redemption:success', success);
      service.on('redemption:unsaved', unsaved);

      await service.processGiftWrap(createMockGiftWrap({ id: 'settled-unsaved' }));

      expect(storageAdapter.markTokenAsReceived).not.toHaveBeenCalled();
      expect(success).not.toHaveBeenCalled();
      expect(unsaved).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'settled-unsaved', receiveId: '0c707915' }));
      expect(service.getFailedEvents()).toEqual([]);
    });

    /**
     * #560: a replay of a receive this account ACKNOWLEDGED (saved on another
     * device, or before a logout) is already received. tokenRedemption reports
     * it as "already been redeemed"; a raw 409 names the status in details.
     * Either way: marked received, no redemption:unsaved.
     */
    it.each([
      ['tokenRedemption acknowledged replay', new Error('This token has already been redeemed')],
      [
        "the gateway's raw 409 with status=ACKNOWLEDGED",
        Object.assign(new Error('Conflict'), {
          code: 'RECEIVE_ALREADY_SETTLED',
          status: 409,
          data: { error: { details: 'receive_id=9f729968 status=ACKNOWLEDGED' } },
        }),
      ],
    ])('%s: no redemption:unsaved, marked received', async (_name, err) => {
      (redemptionAdapter.redeem as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err);
      const storageAdapter = createMockStorageAdapter();
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
      const unsaved = vi.fn();
      service.on('redemption:unsaved', unsaved);

      await service.processGiftWrap(createMockGiftWrap({ id: 'acked-elsewhere' }));

      expect(unsaved).not.toHaveBeenCalled();
      expect(storageAdapter.markTokenAsReceived).toHaveBeenCalled();
      expect(service.getFailedEvents()).toEqual([]);
    });

    /**
     * #111 delta review: a receive the wallet deferred itself (pacer reset on
     * logout, per-token call budget spent) is retried later, quietly: no error
     * toast, no redemption:error, no success, not marked received.
     */
    it('a deferred receive (RECEIVE_DEFERRED) is retried later without an error toast', async () => {
      const err = Object.assign(new Error('receive pacer was reset'), { code: 'RECEIVE_DEFERRED' });
      const redeem = redemptionAdapter.redeem as ReturnType<typeof vi.fn>;
      redeem.mockRejectedValueOnce(err);
      const storageAdapter = createMockStorageAdapter();
      const showErrorNotification = vi.fn();

      const service = new DmPollService({
        recipientPubkey: 'recipient-pub',
        recipientPrivkey: 'recipient-priv',
        nostrdbAdapter,
        cryptoAdapter,
        redemptionAdapter,
        storageAdapter,
        uiAdapter: { showErrorNotification } as never,
        enableAutoRedemption: true,
        fetchRecentOnStart: false,
        retryCooldownMs: 0,
      });
      const success = vi.fn();
      const failure = vi.fn();
      service.on('redemption:success', success);
      service.on('redemption:error', failure);

      expect(await service.processGiftWrap(createMockGiftWrap({ id: 'deferred' }))).toBeNull();

      expect(showErrorNotification).not.toHaveBeenCalled();
      expect(failure).not.toHaveBeenCalled();
      expect(success).not.toHaveBeenCalled();
      expect(storageAdapter.markTokenAsReceived).not.toHaveBeenCalled();
      // Kept for a retry, not marked processed.
      expect(service.getFailedEvents().map((f) => f.eventId)).toEqual(['deferred']);

      await service.replayEvent('deferred');
      expect(redeem).toHaveBeenCalledTimes(2);
    });
  });
});

/**
 * The #98/#99 review's M1, on the path the wallet actually runs. A held wrap
 * (`UnwrappedDm.hold`) must be offered again on every fetch, and must not stop
 * a fetch reaching events after it, however many there are. `fetchRecentDms`
 * has no watermark (it pages the whole window, newest first), so this pins
 * down that it stays that way.
 */
describe('DmPollService.fetchRecentDms: a held wrap neither starves later events nor is lost', () => {
  it('reaches a coupon more than 1000 wraps after a held one, and still re-offers the held one', async () => {
    const now = Math.floor(Date.now() / 1000);
    const events: GiftWrapEvent[] = [createMockGiftWrap({ id: 'held', created_at: now - 86400 })];
    for (let i = 0; i < 1200; i++) events.push(createMockGiftWrap({ id: `j${i}`, created_at: now - 86000 + i * 10 }));
    events.push(createMockGiftWrap({ id: 'COUPON', created_at: now - 100 }));
    // A relay that honours since/until/limit, newest first, as the gateway does.
    const queried: number[] = [];
    const nostrdb = {
      isAvailable: () => true,
      queryEvents: async (f: { since?: number; until?: number; limit?: number }) => {
        const page = events
          .filter((e) => (f.since === undefined || e.created_at >= f.since) && (f.until === undefined || e.created_at <= f.until))
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, f.limit ?? events.length);
        queried.push(page.length);
        return page;
      },
      subscribeEvents: () => ({ id: 'x', stop: () => {}, isActive: () => false }),
      getProfile: async () => null,
    };
    const offered: string[] = [];
    const crypto = createMockCryptoAdapter();
    crypto.unwrapNip17Dm = vi.fn(async (event: GiftWrapEvent): Promise<UnwrappedDm> => {
      offered.push(event.id);
      if (event.id === 'held') return { eventId: event.id, senderPubkey: '', content: '', createdAt: event.created_at, hold: true };
      return { eventId: event.id, senderPubkey: 's', content: event.id === 'COUPON' ? 'coupon' : '', createdAt: event.created_at };
    });
    crypto.extractToken = vi.fn((content: string) => (content === 'coupon' ? 'cashuA-coupon' : null));
    const storage = createMockStorageAdapter();
    const service = new DmPollService({
      recipientPubkey: 'recipient-pubkey-456',
      recipientPrivkey: 'priv',
      nostrdbAdapter: nostrdb as never,
      cryptoAdapter: crypto,
      storageAdapter: storage,
      enableAutoRedemption: false,
      fetchRecentOnStart: false,
      recentDmsSince: 7 * 86400,
      maxProcessedEvents: 5000,
    });

    const first = await service.fetchRecentDms();
    expect(first.map((d) => d.eventId)).toEqual(['COUPON']);
    expect(offered).toContain('held');

    offered.length = 0;
    await service.fetchRecentDms();
    // Offered again (it is still unprocessed), and only it: everything else
    // is answered from the processed set without an unwrap.
    expect(offered).toEqual(['held']);
    expect(await storage.getProcessedEventIds()).not.toContain('held');
  });
});

/**
 * A held coupon is remembered by the time its sender wrote it (the rumor), but
 * the relay filters on the GIFT WRAP's created_at, which NIP-59 backdates by up
 * to two days. Re-offering from the rumor time alone missed every wrap that had
 * been backdated, so a coupon held for more than a week could never be released
 * (#175 final review). The wrap here is two days older than its rumor and must
 * still be found.
 */
describe('DmPollService.reofferEvents: a backdated gift wrap is still found', () => {
  it('re-offers a held delivery whose wrap is two days older than its rumor', async () => {
    const now = Math.floor(Date.now() / 1000);
    const rumorCreatedAt = now - 10 * 86400;
    const wrap = createMockGiftWrap({ id: 'held-backdated', created_at: rumorCreatedAt - 2 * 86400 });
    const nostrdb = new MockNostrdbAdapter();
    nostrdb.addEvent(wrap);
    const crypto = createMockCryptoAdapter();
    const offered: string[] = [];
    crypto.unwrapNip17Dm = vi.fn(async (event: GiftWrapEvent): Promise<UnwrappedDm> => {
      offered.push(event.id);
      return { eventId: event.id, senderPubkey: 's', content: 'coupon', createdAt: rumorCreatedAt };
    });
    const service = new DmPollService({
      recipientPubkey: 'recipient-pubkey-456',
      recipientPrivkey: 'priv',
      nostrdbAdapter: nostrdb,
      cryptoAdapter: crypto,
      storageAdapter: createMockStorageAdapter(),
      redemptionAdapter: createMockRedemptionAdapter(),
      fetchRecentOnStart: false,
    });

    // What the wallet passes: the held record's (rumor) createdAt, less a minute.
    await service.reofferEvents(['held-backdated'], rumorCreatedAt - 60);

    expect(offered).toEqual(['held-backdated']);
  });
});
