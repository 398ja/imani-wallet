/**
 * #300: a failed receive names the payment request it answered.
 *
 * The till can show Paid on gateway-core's verdict before the coupon arrives. When the receive
 * then fails, the till has to say so on THAT request, and the only link is the request id the
 * DM carried. So `redemption:error` and `redemption:unsaved` now pass it on, as
 * `redemption:refused` already did (#145).
 */
import { describe, it, expect, vi } from 'vitest';
import { DmPollService } from '../src/core/DmPollService';
import { MockNostrdbAdapter, createMockGiftWrap } from './mocks';
import type { CryptoAdapter } from '../src/adapters/CryptoAdapter';
import type { RedemptionAdapter } from '../src/adapters/RedemptionAdapter';

function crypto(): CryptoAdapter {
  return {
    unwrapNip17Dm: vi.fn(async () => ({
      senderPubkey: 'sender',
      content: 'cashuAeyJ0b2tlbiI6InRlc3QifQ',
      createdAt: Math.floor(Date.now() / 1000),
    })),
    extractToken: vi.fn(() => 'cashuAeyJ0b2tlbiI6InRlc3QifQ'),
    parseTokenTransferMessage: vi.fn(() => ({ face_value: 650, face_unit: 'GBP', requestId: 'pr-0123456789abcdef' })),
    getTokenFingerprint: vi.fn(() => 'fp'),
  } as unknown as CryptoAdapter;
}

function service(redeem: RedemptionAdapter['redeem']) {
  return new DmPollService({
    recipientPubkey: 'recipient',
    recipientPrivkey: 'priv',
    nostrdbAdapter: new MockNostrdbAdapter(),
    cryptoAdapter: crypto(),
    redemptionAdapter: { checkBacking: vi.fn(() => ({ outcome: 'accept' as const })), redeem } as RedemptionAdapter,
    enableAutoRedemption: true,
    fetchRecentOnStart: false,
  });
}

describe('a failed receive carries its request id (#300)', () => {
  // A receive that fails outright: the till must be able to tell which sale it was.
  it('redemption:error names the request', async () => {
    const s = service(vi.fn(async () => {
      throw new Error('Network timeout');
    }));
    const seen: unknown[] = [];
    s.on('redemption:error', (e) => seen.push(e));
    await s.processGiftWrap(createMockGiftWrap({ id: 'e1' }));
    expect(seen).toEqual([expect.objectContaining({ eventId: 'e1', requestId: 'pr-0123456789abcdef' })]);
  });

  // Settled at the gateway but not saved here: the coupon is the merchant's and needs
  // reconciliation, on the request it paid.
  it('redemption:unsaved names the request', async () => {
    const s = service(vi.fn(async () => {
      throw Object.assign(new Error('settled, not saved'), { code: 'RECEIVE_SETTLED_NOT_SAVED', receiveId: 'r1' });
    }));
    const seen: unknown[] = [];
    s.on('redemption:unsaved', (e) => seen.push(e));
    await s.processGiftWrap(createMockGiftWrap({ id: 'e2' }));
    expect(seen).toEqual([
      expect.objectContaining({ eventId: 'e2', receiveId: 'r1', requestId: 'pr-0123456789abcdef' }),
    ]);
  });
});
