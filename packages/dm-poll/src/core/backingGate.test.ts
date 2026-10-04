/**
 * imani-wallet#131: dm-poll asks where a token's value is before it redeems.
 *
 * Under src/ for the same reason as refusedPayment.test.ts: the package's tests/
 * directory is outside the app's vitest include globs, and this is a money gate.
 */

import { describe, it, expect, vi } from 'vitest';

import { DmPollService } from './DmPollService';
import { TokenRedeemer } from '../processing/TokenRedeemer';
import type { BackingVerdict, RedemptionAdapter } from '../adapters/RedemptionAdapter';
import type { CryptoAdapter } from '../adapters/CryptoAdapter';
import type { NostrdbAdapter } from '../types/adapters';
import type { StorageAdapter } from '../adapters/StorageAdapter';
import type { GiftWrapEvent, UnwrappedDm } from '../types';

const TOKEN = 'cashuB-from-somewhere';

function cryptoAdapter(): CryptoAdapter {
  return {
    unwrapNip17Dm: vi.fn(
      async (): Promise<UnwrappedDm> => ({
        senderPubkey: 'f'.repeat(64),
        content: 'envelope',
        createdAt: Math.floor(Date.now() / 1000),
      }),
    ),
    extractToken: vi.fn(() => TOKEN),
    parseTokenTransferMessage: vi.fn(() => ({ voucherId: 'v-131' })),
    getTokenFingerprint: vi.fn(() => 'fingerprint-131'),
  } as unknown as CryptoAdapter;
}

function storageAdapter() {
  return {
    saveVoucher: vi.fn(async () => {}),
    hasTokenBeenReceived: vi.fn(async () => false),
    markTokenAsReceived: vi.fn(async () => {}),
    getProcessedEventIds: vi.fn(async () => []),
    saveProcessedEventIds: vi.fn(async () => {}),
  } satisfies StorageAdapter;
}

function adapterSaying(verdict: BackingVerdict | (() => never)) {
  return {
    checkBacking: vi.fn(typeof verdict === 'function' ? verdict : () => verdict),
    redeem: vi.fn(async () => ({
      voucher_id: 'v-131',
      token: TOKEN,
      face_value: 100,
      face_unit: 'SAT',
      status: 'active' as const,
      created_at: new Date().toISOString(),
    })),
  } satisfies RedemptionAdapter;
}

function serviceWith(adapter: RedemptionAdapter, storage = storageAdapter()) {
  const svc = new DmPollService({
    recipientPubkey: 'a'.repeat(64),
    recipientPrivkey: 'b'.repeat(64),
    nostrdbAdapter: { getProfile: vi.fn(async () => null) } as unknown as NostrdbAdapter,
    cryptoAdapter: cryptoAdapter(),
    redemptionAdapter: adapter,
    storageAdapter: storage,
    enableAutoRedemption: true,
    fetchRecentOnStart: false,
  });
  const refused = vi.fn();
  const succeeded = vi.fn();
  svc.on('redemption:refused', refused);
  svc.on('redemption:success', succeeded);
  return { svc, refused, succeeded, storage };
}

const wrap = (id: string) => ({ id, kind: 1059, tags: [], content: 'x' }) as unknown as GiftWrapEvent;

describe('the backing gate on the live redemption path (DmPollService)', () => {
  /**
   * The finding: a token at a rogue mint was swapped and credited because nothing
   * asked where its value was. It is now refused before the swap, terminally, and
   * the stall is told why.
   */
  it('refuses a rogue-mint token without redeeming it', async () => {
    const adapter = adapterSaying({ outcome: 'refuse', reason: 'untrusted-mint', detail: 'rogue mint' });
    const { svc, refused, succeeded } = serviceWith(adapter);

    await svc.processGiftWrap(wrap('wrap-rogue'));

    expect(adapter.checkBacking).toHaveBeenCalledWith(TOKEN);
    expect(adapter.redeem).not.toHaveBeenCalled();
    expect(succeeded).not.toHaveBeenCalled();
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ reason: 'untrusted-mint', voucherId: 'v-131' }));
  });

  /** A token in the wrong unit is refused the same way, with its own reason. */
  it('refuses a wrong-unit token without redeeming it', async () => {
    const adapter = adapterSaying({ outcome: 'refuse', reason: 'wrong-unit', detail: 'usd' });
    const { svc, refused } = serviceWith(adapter);

    await svc.processGiftWrap(wrap('wrap-usd'));

    expect(adapter.redeem).not.toHaveBeenCalled();
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ reason: 'wrong-unit' }));
  });

  /**
   * "Cannot tell yet" must not consume the delivery. The gift wrap stays
   * unprocessed, so the next poll offers it again once the trusted list has loaded,
   * and nothing is announced to the stall as a refusal.
   */
  it('defers when the wallet cannot judge the backing yet, leaving the delivery for a later poll', async () => {
    const adapter = adapterSaying({ outcome: 'defer', detail: 'trusted mints not loaded' });
    const { svc, refused, storage } = serviceWith(adapter);

    await svc.processGiftWrap(wrap('wrap-early'));

    expect(adapter.redeem).not.toHaveBeenCalled();
    expect(refused).not.toHaveBeenCalled();
    expect(storage.markTokenAsReceived).not.toHaveBeenCalled();

    adapter.checkBacking.mockReturnValue({ outcome: 'accept' });
    await svc.processGiftWrap(wrap('wrap-early'));
    expect(adapter.redeem).toHaveBeenCalledTimes(1);
  });

  /** A gate whose own check throws defers; it never fails open into a redeem. */
  it('defers rather than redeems when the backing check itself throws', async () => {
    const adapter = adapterSaying(() => {
      throw new Error('bug in the check');
    });
    const { svc } = serviceWith(adapter);

    await svc.processGiftWrap(wrap('wrap-bug'));

    expect(adapter.redeem).not.toHaveBeenCalled();
  });

  /** The control: an accepted token is redeemed as before. */
  it('redeems a token whose backing is accepted', async () => {
    const adapter = adapterSaying({ outcome: 'accept' });
    const { svc, succeeded } = serviceWith(adapter);

    await svc.processGiftWrap(wrap('wrap-good'));

    expect(adapter.redeem).toHaveBeenCalledTimes(1);
    expect(succeeded).toHaveBeenCalledTimes(1);
  });
});

describe('the backing gate on TokenRedeemer', () => {
  const tokenDm = { eventId: 'e'.repeat(64), senderPubkey: 'f'.repeat(64), token: TOKEN, metadata: {}, createdAt: 1 };
  const redeemerWith = (adapter: RedemptionAdapter) =>
    new TokenRedeemer({ redemptionAdapter: adapter, getTokenFingerprint: (t: string) => `fp-${t}` });

  /** The second call site in the package refuses a rogue-mint token too. */
  it('refuses a rogue-mint token without redeeming it', async () => {
    const adapter = adapterSaying({ outcome: 'refuse', reason: 'untrusted-mint', detail: 'rogue mint' });

    const result = await redeemerWith(adapter).redeem(tokenDm as never);

    expect(result.success).toBe(false);
    expect(adapter.redeem).not.toHaveBeenCalled();
  });

  /** And redeems an accepted one. */
  it('redeems a token whose backing is accepted', async () => {
    const adapter = adapterSaying({ outcome: 'accept' });

    const result = await redeemerWith(adapter).redeem(tokenDm as never);

    expect(result.success).toBe(true);
    expect(adapter.redeem).toHaveBeenCalledTimes(1);
  });
});
