import { describe, expect, it, vi } from 'vitest';

import { TokenRedeemer } from '../src/processing/TokenRedeemer';

/**
 * What TokenRedeemer hands the redemption adapter.
 *
 * The bug this pins: `eventId` was destructured off the TokenDm and then left
 * out of the options object, so it reached no redemption path. It is the only
 * stable id both parties share for one delivery, and a settlement receipt has
 * to be keyed on it — without it the recipient cannot tell the sender WHICH
 * coupon was claimed, and the sender's "Voucher Claimed" notification never
 * fires at all.
 *
 * It failed in the worst way available: the consumer guards a missing id by
 * returning quietly, which is correct for a best-effort call and makes a
 * dropped field indistinguishable from a wallet with nothing to report.
 */
describe('TokenRedeemer redemption options', () => {
  function redeemerWith(redeem: ReturnType<typeof vi.fn>) {
    return new TokenRedeemer({
      redemptionAdapter: { redeem },
      getTokenFingerprint: (token: string) => `fp-${token}`,
      cryptoAdapter: {} as never,
    } as never);
  }

  const TOKEN_DM = {
    eventId: 'dca74270326812668b9d0fe06aafef530dd92ca0acc2394d91a2daa55e798900',
    senderPubkey: '35f7a28b6adc9a923686a4506a02cae0fcf634cb32f42675872a5bd07d67af47',
    token: 'cashuAtoken',
    metadata: { voucherId: 'v-1', faceValue: 150, faceUnit: 'GBP' },
    createdAt: 1789152856,
  };

  it('carries the gift-wrap event id through to the adapter', async () => {
    const redeem = vi.fn(async () => ({ voucher_id: 'v-1' }));

    await redeemerWith(redeem).redeem(TOKEN_DM as never);

    expect(redeem).toHaveBeenCalledTimes(1);
    const [, options] = redeem.mock.calls[0] as [string, Record<string, unknown>];
    expect(options.deliveryEventId).toBe(TOKEN_DM.eventId);
  });

  /**
   * Named separately because it is the pair: a receipt needs BOTH to be
   * addressable. Having one without the other still posts nothing.
   */
  it('carries the sender pubkey alongside it', async () => {
    const redeem = vi.fn(async () => ({ voucher_id: 'v-1' }));

    await redeemerWith(redeem).redeem(TOKEN_DM as never);

    const [, options] = redeem.mock.calls[0] as [string, Record<string, unknown>];
    expect(options.senderPubkey).toBe(TOKEN_DM.senderPubkey);
  });

  /**
   * The fields live at the TOP LEVEL of the options, not inside `metadata`.
   * `toLegacyMetadata` rewrites metadata into snake_case and takes the sender
   * as a separate argument, so a consumer reading `metadata.senderPubkey` finds
   * undefined — which is precisely the mistake this test exists to prevent
   * recurring.
   */
  it('puts them at the top level, not inside metadata', async () => {
    const redeem = vi.fn(async () => ({ voucher_id: 'v-1' }));

    await redeemerWith(redeem).redeem(TOKEN_DM as never);

    const [, options] = redeem.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(options)).toEqual(
      expect.arrayContaining(['deliveryEventId', 'senderPubkey']),
    );
  });
});
