/**
 * #145: a refused coupon's event says which payment it belonged to, so the
 * wallet can show the refusal on that payment and not only in a toast.
 *
 * Under src/ for the same reason as senderProfileLookup.test.ts: the
 * package's tests/ directory is outside the vitest include globs.
 */

import { describe, it, expect, vi } from 'vitest';

import { DmPollService } from './DmPollService';
import { RedemptionRefusedError } from '../errors';
import type { CryptoAdapter } from '../adapters/CryptoAdapter';
import type { NostrdbAdapter } from '../types/adapters';
import type { StorageAdapter } from '../adapters/StorageAdapter';
import type { GiftWrapEvent, UnwrappedDm } from '../types';

const BUNDLE = 'c'.repeat(32);

function cryptoAdapter(): CryptoAdapter {
  return {
    unwrapNip17Dm: vi.fn(
      async (): Promise<UnwrappedDm> => ({
        senderPubkey: 'f'.repeat(64),
        content: 'cashuAeyJ0b2tlbiI6InRlc3QifQ',
        createdAt: Math.floor(Date.now() / 1000),
      }),
    ),
    extractToken: vi.fn(() => 'cashuAeyJ0b2tlbiI6InRlc3QifQ'),
    parseTokenTransferMessage: vi.fn(() => ({
      voucherId: '19c4fed1',
      senderPubkey: 'c'.repeat(64),
      bundleId: BUNDLE,
      bundlePartIndex: 1,
      bundlePartCount: 2,
      bundleTotal: 105,
      requestId: 'req-1',
    })),
    getTokenFingerprint: vi.fn(() => 'fingerprint-refused'),
  } as unknown as CryptoAdapter;
}

function storageAdapter(): StorageAdapter {
  return {
    saveVoucher: vi.fn(async () => {}),
    hasTokenBeenReceived: vi.fn(async () => false),
    markTokenAsReceived: vi.fn(async () => {}),
    getProcessedEventIds: vi.fn(async () => []),
    saveProcessedEventIds: vi.fn(async () => {}),
  };
}

describe('redemption:refused names its payment (#145)', () => {
  /** The bundle id, its declared part count and the request id ride on the refused event. */
  it('carries the bundle and request the refused coupon belonged to', async () => {
    // Arrange
    const svc = new DmPollService({
      recipientPubkey: 'a'.repeat(64),
      recipientPrivkey: 'b'.repeat(64),
      nostrdbAdapter: { getProfile: vi.fn(async () => null) } as unknown as NostrdbAdapter,
      cryptoAdapter: cryptoAdapter(),
      redemptionAdapter: {
        redeem: vi.fn(async () => {
          throw new RedemptionRefusedError('spent', '19c4fed1', 89, 100);
        }),
      },
      storageAdapter: storageAdapter(),
      enableAutoRedemption: true,
      fetchRecentOnStart: false,
    });
    const refused = vi.fn();
    svc.on('redemption:refused', refused);

    // Act
    await svc.processGiftWrap({ id: 'wrap-1', kind: 1059, tags: [], content: 'x' } as unknown as GiftWrapEvent);

    // Assert
    expect(refused).toHaveBeenCalledWith(
      expect.objectContaining({
        voucherId: '19c4fed1',
        bundleId: BUNDLE,
        bundlePartCount: 2,
        requestId: 'req-1',
        // The payload's payer, not the gift wrap's signer (the gateway).
        payerPubkey: 'c'.repeat(64),
      }),
    );
  });
});
