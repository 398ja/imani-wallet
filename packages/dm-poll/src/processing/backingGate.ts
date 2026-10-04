/**
 * The backing gate both redemption call sites run before they redeem (imani-wallet#131).
 *
 * dm-poll has two places that call `redemptionAdapter.redeem` (see
 * tests/redemptionCallSites.test.ts), and a check applied at only one of them is
 * the mistake that file exists to catch. So the gate lives here, once, and each
 * call site asks it the same question before anything is swapped.
 */

import type { RedemptionAdapter } from '../adapters/RedemptionAdapter';
import { RedemptionRefusedError } from '../errors';

/**
 * A redemption the recipient could not judge yet: its trusted-mint list has not
 * loaded. Carries `code: 'RECEIVE_DEFERRED'`, the code `DmPollService` already
 * treats as "leave the delivery unconsumed and retry on a later poll, quietly".
 */
export class BackingDeferredError extends Error {
  readonly code = 'RECEIVE_DEFERRED';

  constructor(detail: string) {
    super(`redemption deferred: ${detail}`);
    this.name = 'BackingDeferredError';
  }
}

/**
 * Throw unless the adapter accepts this token's backing.
 *
 * - refuse -> `RedemptionRefusedError` (terminal: never retried, nothing swapped).
 * - defer, or an adapter that throws -> `BackingDeferredError` (retried later).
 *
 * An adapter that throws is deferred rather than accepted: a gate that fails open
 * on its own bug is not a gate.
 */
export function assertBackingAccepted(adapter: RedemptionAdapter, token: string, voucherId: string): void {
  let verdict: ReturnType<RedemptionAdapter['checkBacking']>;
  try {
    verdict = adapter.checkBacking(token);
  } catch (error) {
    throw new BackingDeferredError(
      `backing check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (verdict.outcome === 'accept') return;
  if (verdict.outcome === 'defer') throw new BackingDeferredError(verdict.detail);
  throw new RedemptionRefusedError(verdict.detail, voucherId, 0, 0, verdict.reason);
}
