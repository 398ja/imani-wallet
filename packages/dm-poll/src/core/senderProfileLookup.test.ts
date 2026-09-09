/**
 * The sender profile is decoration for a notification, so it should not be
 * fetched when there is nothing configured to show one.
 *
 * This is not only a wasted request. Coupon DMs are gift-wrapped by the
 * GATEWAY's own identity rather than the merchant's, and the gateway is
 * infrastructure that publishes no kind-0 profile — so the lookup normally
 * 404s. A 404 is drawn in the browser console by the network layer itself,
 * which no `catch` in our code can suppress. The wallet configures no
 * uiAdapter, so it was printing a red console line under every SUCCESSFUL
 * coupon receipt and looking broken while working perfectly.
 *
 * Lives under src/ deliberately: packages/dm-poll/tests/ is outside the
 * vitest `include` globs, so a test written next to DmPollService.test.ts
 * would never have run.
 */

import { describe, it, expect, vi } from 'vitest';

import { DmPollService } from './DmPollService';
import type { CryptoAdapter } from '../adapters/CryptoAdapter';
import type { NostrdbAdapter } from '../types/adapters';
import type { RedemptionAdapter } from '../adapters/RedemptionAdapter';
import type { StorageAdapter } from '../adapters/StorageAdapter';
import type { GiftWrapEvent, UnwrappedDm } from '../types';

const SENDER = 'f'.repeat(64);

function cryptoAdapter(): CryptoAdapter {
  return {
    unwrapNip17Dm: vi.fn(
      async (_e: GiftWrapEvent, _k: string): Promise<UnwrappedDm> => ({
        senderPubkey: SENDER,
        content: 'cashuAeyJ0b2tlbiI6InRlc3QifQ here is your coupon',
        createdAt: Math.floor(Date.now() / 1000),
      }),
    ),
    extractToken: vi.fn(() => 'cashuAeyJ0b2tlbiI6InRlc3QifQ'),
    parseTokenTransferMessage: vi.fn(() => ({ face_value: 100, face_unit: 'SAT' })),
    getTokenFingerprint: vi.fn(() => 'fingerprint-abc123'),
  };
}

function redemptionAdapter(): RedemptionAdapter {
  return {
    redeem: vi.fn(async () => ({
      voucher_id: 'v-1',
      token: 'cashuAeyJ0b2tlbiI6InRlc3QifQ',
      face_value: 100,
      face_unit: 'SAT',
      status: 'active' as const,
      created_at: new Date().toISOString(),
    })),
  };
}

function storageAdapter(): StorageAdapter {
  const received = new Set<string>();
  let processed: string[] = [];
  return {
    saveVoucher: vi.fn(async () => {}),
    hasTokenBeenReceived: vi.fn(async (fp: string) => received.has(fp)),
    markTokenAsReceived: vi.fn(async (fp: string) => void received.add(fp)),
    getProcessedEventIds: vi.fn(async () => [...processed]),
    saveProcessedEventIds: vi.fn(async (ids: string[]) => {
      processed = [...ids];
    }),
  };
}

/** Only getProfile matters here; the rest satisfies the port. */
function nostrdbAdapter(): NostrdbAdapter {
  return {
    getProfile: vi.fn(async () => null),
    getProfiles: vi.fn(async () => []),
    queryEvents: vi.fn(async () => []),
    subscribe: vi.fn(() => ({ id: 's', stop: () => {}, isActive: () => false })),
    isAvailable: vi.fn(() => true),
  } as unknown as NostrdbAdapter;
}

function giftWrap(id: string): GiftWrapEvent {
  return {
    id,
    pubkey: 'e'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind: 1059,
    tags: [],
    content: 'encrypted',
    sig: 'sig',
  } as unknown as GiftWrapEvent;
}

function service(extra: Record<string, unknown> = {}) {
  const nostrdb = nostrdbAdapter();
  return {
    nostrdb,
    svc: new DmPollService({
      recipientPubkey: 'a'.repeat(64),
      recipientPrivkey: 'b'.repeat(64),
      nostrdbAdapter: nostrdb,
      cryptoAdapter: cryptoAdapter(),
      redemptionAdapter: redemptionAdapter(),
      storageAdapter: storageAdapter(),
      enableAutoRedemption: true,
      fetchRecentOnStart: false,
      ...extra,
    }),
  };
}

describe('sender profile is only fetched when something will show it', () => {
  it('does not look it up when no uiAdapter is configured', async () => {
    const { nostrdb, svc } = service();
    const succeeded = vi.fn();
    svc.on('redemption:success', succeeded);

    await svc.processGiftWrap(giftWrap('no-ui-adapter'));

    // The receipt still succeeds — this is the case the wallet actually runs.
    expect(succeeded).toHaveBeenCalled();
    expect(nostrdb.getProfile).not.toHaveBeenCalled();
  });

  it('still looks it up when a uiAdapter is there to render it', async () => {
    const { nostrdb, svc } = service({
      uiAdapter: { showReceivedNotification: vi.fn() },
    });

    await svc.processGiftWrap(giftWrap('with-ui-adapter'));

    expect(nostrdb.getProfile).toHaveBeenCalledWith(SENDER);
  });
});
