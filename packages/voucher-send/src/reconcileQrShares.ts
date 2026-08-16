/**
 * Spec 039 — Reliable Voucher QR Transfers
 *
 * Walks active pending QR-share records, queries the mint for proof-state,
 * and transitions each share to its terminal outcome (or leaves it pending
 * for the next tick).
 *
 * Pure function. All dependencies are callbacks — no `window`,
 * no `localStorage`, no `fetch`. The wallet bridge
 * (`shared/qrShareReconcileIntegration.js`) wraps it with the real wallet
 * APIs and triggers it via the boot / visibilitychange / online hooks.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Cashu protocol references (Constitution Principle II pinning):
 *
 *   NUT-07 (token state check, optional) — used here to query whether the
 *     pending share's proofs have been spent by the recipient. Pinned at
 *     `https://github.com/cashubtc/nuts/blob/main/07.md` at commit
 *     `8d0fa00` (2026-05-30 main). The constitution will gain NUT-07 to
 *     its optional-NUT list as a follow-up (see specs/039 T056a + plan.md
 *     "Constitution carry-forward").
 *
 *   NUT-16 (animated QR via fountain codes) — relevant because the
 *     pending-share record lifecycle starts when the sender opens an
 *     animated QR. Pinned at
 *     `https://github.com/cashubtc/nuts/blob/main/16.md` at commit
 *     `8d0fa00` (2026-05-30 main).
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Contract: `specs/039-reliable-qr-transfers/contracts/reconcile-trigger.md`.
 */

import type {
  PendingQrShare,
  ReconcileQrSharesDeps,
  ReconcileQrSharesSummary,
  ReconcileTransactionRow,
  ProofState,
  ProofStateMap,
} from './types/qr-share';

const LOG_PREFIX = '[qr-share-reconcile]';

function defaultNow(): number {
  return Date.now();
}

function allSpent(map: ProofStateMap): boolean {
  const values = Object.values(map);
  return values.length > 0 && values.every((s) => s === 'SPENT');
}

function anyUnspent(map: ProofStateMap): boolean {
  return Object.values(map).some((s: ProofState) => s === 'UNSPENT');
}

function pastExpiry(expiresAt: string | null | undefined, now: number): boolean {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) return false;
  return ts < now;
}

function buildTxRow(share: PendingQrShare, voucher: {
  voucher_id: string;
  token_id: string;
  amount: number;
  unit: string;
  memo?: string;
}, now: number): ReconcileTransactionRow {
  return {
    id: `sent:${share.token_id}`,
    direction: 'out',
    type: 'sent',
    amount: voucher.amount,
    unit: voucher.unit,
    tokenId: share.token_id,
    source_voucher_id: voucher.voucher_id,
    memo: voucher.memo ?? 'QR share claimed',
    created_at: new Date(now).toISOString(),
  };
}

export async function reconcileQrShares(
  deps: ReconcileQrSharesDeps
): Promise<ReconcileQrSharesSummary> {
  const now = (deps.now ?? defaultNow)();
  const log = deps.logger ?? console;

  const summary: ReconcileQrSharesSummary = {
    scanned: 0,
    sent: 0,
    closedBySelfSpend: 0,
    expiredWithoutClaim: 0,
    deferred: 0,
    failed: 0,
  };

  let active: PendingQrShare[];
  try {
    active = await deps.getActivePendingShares();
  } catch (e) {
    log.warn?.(LOG_PREFIX, 'getActivePendingShares failed', e);
    return summary;
  }

  summary.scanned = active.length;
  if (active.length === 0) return summary;

  for (const share of active) {
    try {
      const voucher = await deps.getVoucherByTokenId(share.token_id);
      if (!voucher) {
        log.warn?.(LOG_PREFIX, 'orphan share — voucher missing', {
          share_id: share.share_id,
          token_id: share.token_id,
        });
        summary.failed += 1;
        continue;
      }

      const proofStates = await deps.checkProofStates(voucher.proofs);

      if (allSpent(proofStates)) {
        const existsAlready = deps.hasExistingSentRow
          ? await deps.hasExistingSentRow(share.token_id)
          : false;
        if (existsAlready) {
          await deps.closeWithReason(share.share_id, 'closed-by-self-spend');
          summary.closedBySelfSpend += 1;
          log.info?.(LOG_PREFIX, 'closed-by-self-spend', {
            share_id: share.share_id,
            token_id: share.token_id,
          });
          continue;
        }
        const row = buildTxRow(share, voucher, now);
        const { commitPromise } = deps.addTransaction(row);
        await commitPromise;
        await deps.markSent(share.share_id);
        summary.sent += 1;
        log.info?.(LOG_PREFIX, 'sent', {
          share_id: share.share_id,
          token_id: share.token_id,
          amount: row.amount,
          unit: row.unit,
        });
        continue;
      }

      if (anyUnspent(proofStates) && pastExpiry(voucher.expires_at, now)) {
        await deps.closeWithReason(share.share_id, 'expired-without-claim');
        summary.expiredWithoutClaim += 1;
        log.info?.(LOG_PREFIX, 'expired-without-claim', {
          share_id: share.share_id,
          token_id: share.token_id,
        });
        continue;
      }

      summary.deferred += 1;
    } catch (e) {
      summary.failed += 1;
      log.warn?.(LOG_PREFIX, 'per-share failure', {
        share_id: share.share_id,
        token_id: share.token_id,
        error: (e as Error)?.message ?? String(e),
      });
    }
  }

  log.info?.(LOG_PREFIX, 'reconcile-complete', summary);
  return summary;
}
