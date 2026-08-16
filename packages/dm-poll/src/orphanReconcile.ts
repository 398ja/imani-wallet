/**
 * Spec 038 FR-015 + FR-021 — boot orphan reconciliation pass.
 *
 * On wallet boot (BEFORE DmPollService.start() and BEFORE the catch-up
 * loop), walk `wallet_vouchers` once and:
 *
 *   1. **Orphan voucher → write missing transaction row.**
 *      Any voucher with `swap_completed_at != null` MUST have a matching
 *      transaction row in `wallet_transactions` keyed by the same
 *      `token_id` (spec-017). If absent — historical / pre-spec-038
 *      partial-write — call `recordLocalVoucherTransaction(voucher)` to
 *      reconcile.
 *
 *   2. **Legacy-receive backfill** (FR-021).
 *      Any voucher with `swap_completed_at` set BUT no `source_transport`
 *      gets `source_transport='manual'` written back (the safest default
 *      for historic vouchers — most predate the unified pipeline that
 *      tags `sse` / `catchup`).
 *
 * **Scope clarification**: FR-015 is a HISTORICAL backstop for pre-spec-038
 * orphans, NOT a runtime safety net for the atomic-write-throws case.
 * `atomicallyWrite` is all-or-nothing (FR-014); a throw rolls the IDB
 * transaction back, leaving BOTH rows absent — that recovery is via
 * watermark-non-advancement (the catch-up loop re-fetches on next
 * trigger). The reconcile pass here covers ONLY:
 *
 *   - Pre-spec-038 vouchers (legitimate orphans from before atomicallyWrite shipped).
 *   - Hypothetical write-path regressions that bypass atomicallyWrite
 *     (defense-in-depth — should be zero in well-functioning systems).
 *
 * The function is **idempotent** — running it twice on the same state is
 * a no-op (existing tx rows are detected by token_id and skipped; the
 * backfill writes the same `'manual'` value).
 *
 * **Per-identity scope**: the walletStorage / recorder callbacks are
 * already user-scoped by the bridge (each identity has its own IDB DB
 * name via spec-006). This function operates on whatever DB the
 * walletStorage callback resolves to — it does NOT cross identity
 * boundaries.
 */

/**
 * Local minimum shape — duck-typed to match `@imani/wallet-storage`'s
 * `ReconcileVoucherRow` / `ReconcileTransactionRow` exports without a hard package
 * dependency (the two packages don't share a workspace link; cross-
 * package import would require either a npm install or a tsconfig
 * paths entry). The bridge supplies the real rows; only these fields
 * are read by the reconcile logic.
 */
export interface ReconcileVoucherRow {
  token_id: string;
  voucher_id?: string;
  amount?: number;
  face_value?: number;
  face_unit?: string;
  bundle_id?: string;
  swap_completed_at?: string;
  source_transport?: string;
  [extra: string]: unknown;
}

export interface ReconcileTransactionRow {
  id: string;
  type: string;
  direction: 'in' | 'out';
  timestamp: number;
  voucher_id?: string;
  amount?: number;
  [extra: string]: unknown;
}

/**
 * Minimal callback surface — keeps the package free of any direct IDB
 * or LocalTransactionStore knowledge.
 */
export interface OrphanReconcileDeps {
  /** Returns every voucher in this identity's `wallet_vouchers` store. */
  getAllVouchers(): Promise<ReconcileVoucherRow[]>;
  /** Returns the transaction row keyed by `token_id`, or null if absent. */
  getTransactionByTokenId(tokenId: string): Promise<ReconcileTransactionRow | null>;
  /** Persist a transaction row (FR-015 reconcile step 1). */
  addTransaction(row: ReconcileTransactionRow): Promise<unknown>;
  /** Persist the modified voucher row (FR-021 backfill step 2). */
  saveVoucher(row: ReconcileVoucherRow): Promise<unknown>;
  /**
   * Build a ReconcileTransactionRow shape for a voucher. Owned by the bridge
   * because the wallet's tx taxonomy (cashback, bundle-receive,
   * receive, send) is application-level, not package-level. The
   * bridge supplies the right shape for the voucher it sees.
   *
   * Return `null` to skip a voucher (the bridge couldn't synthesize
   * a tx — e.g. missing fields).
   */
  buildTransactionForVoucher(voucher: ReconcileVoucherRow): ReconcileTransactionRow | null;
  /** Optional logger. */
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
  };
}

/** Summary of one pass. */
export interface OrphanReconcileSummary {
  /** Total vouchers walked. */
  scanned: number;
  /** Vouchers that received a synthesized transaction (FR-015 step 1). */
  fixed: number;
  /** Vouchers backfilled with `source_transport='manual'` (FR-021). */
  backfilled: number;
  /** Vouchers with `swap_completed_at` set (the candidate population). */
  candidates: number;
}

/**
 * Run one reconciliation pass over `wallet_vouchers`. Returns a summary
 * the bridge can log + emit as a single line per boot.
 *
 * Never throws on a per-voucher failure — logs at WARN and moves on.
 * A failure on row N MUST NOT prevent row N+1 from being processed.
 */
export async function reconcileVoucherTxOrphans(
  deps: OrphanReconcileDeps
): Promise<OrphanReconcileSummary> {
  const logger = deps.logger ?? {};
  let scanned = 0;
  let candidates = 0;
  let fixed = 0;
  let backfilled = 0;

  let vouchers: ReconcileVoucherRow[];
  try {
    vouchers = await deps.getAllVouchers();
  } catch (err) {
    logger.warn?.(
      '[dmPoll] reconcile-orphan-load-failed',
      { error: err instanceof Error ? err.message : String(err) }
    );
    return { scanned: 0, fixed: 0, backfilled: 0, candidates: 0 };
  }

  for (const voucher of vouchers) {
    scanned++;
    // The candidate population is vouchers with swap_completed_at set —
    // these are vouchers that DID complete an api.receive at some point.
    // Vouchers without swap_completed_at are either legacy-receive (FR-008,
    // Phase 6 recovery affordance) or fresh from before this spec, both
    // of which are out of scope for THIS reconcile pass (Phase 6 handles
    // them separately via a different code path).
    if (!voucher.swap_completed_at) continue;
    candidates++;

    // FR-015 step 1: ensure a matching transaction row exists.
    try {
      const existing = await deps.getTransactionByTokenId(voucher.token_id);
      if (!existing) {
        const synth = deps.buildTransactionForVoucher(voucher);
        if (synth) {
          await deps.addTransaction(synth);
          fixed++;
          logger.info?.(
            '[dmPoll] reconcile-orphan-tx-fixed',
            { token_id: truncate(voucher.token_id), voucher_id: voucher.voucher_id }
          );
        }
      }
    } catch (err) {
      logger.warn?.(
        '[dmPoll] reconcile-orphan-tx-failed',
        {
          token_id: truncate(voucher.token_id),
          error: err instanceof Error ? err.message : String(err),
        }
      );
    }

    // FR-021 step 2: backfill source_transport='manual' on legacy rows
    // that have swap_completed_at set but no source_transport.
    if (!voucher.source_transport) {
      try {
        await deps.saveVoucher({ ...voucher, source_transport: 'manual' });
        backfilled++;
      } catch (err) {
        logger.warn?.(
          '[dmPoll] reconcile-source-backfill-failed',
          {
            token_id: truncate(voucher.token_id),
            error: err instanceof Error ? err.message : String(err),
          }
        );
      }
    }
  }

  logger.info?.(
    '[dmPoll] reconcile-orphan-vouchers',
    { fixed, scanned, candidates, backfilled }
  );

  return { scanned, fixed, backfilled, candidates };
}

function truncate(hex: string | undefined | null): string {
  if (!hex || hex.length < 8) return String(hex);
  return hex.substring(0, 8) + '...';
}
