/**
 * Spec 039 — Reliable Voucher QR Transfers
 *
 * Types for the pending-QR-share reconciliation flow. Mirrors
 * `specs/039-reliable-qr-transfers/data-model.md` and
 * `specs/039-reliable-qr-transfers/contracts/{pending-qr-share,reconcile-trigger}.md`.
 *
 * Token + proof + secret fields are intentionally absent — see
 * data-model.md MUST-NOT-CONTAIN list (FR-012 + Constitution Principles I + VI).
 */

export type PendingQrShareStatus =
  | 'pending'
  | 'sent'
  | 'closed-by-self-spend'
  | 'expired-without-claim';

export interface PendingQrShare {
  share_id: string;
  voucher_id: string;
  token_id: string;
  amount: number | null;
  unit: string | null;
  issuer_id: string | null;
  created_at: string;
  updated_at: string;
  status: PendingQrShareStatus;
  last_reconciled_at?: string;
}

export interface ReconcileVoucherRow {
  voucher_id: string;
  token_id: string;
  amount: number;
  unit: string;
  issuer_id?: string;
  expires_at?: string | null;
  memo?: string;
  proofs: ReadonlyArray<ProofRef>;
}

export interface ProofRef {
  secret: string;
  C: string;
  id?: string;
  amount?: number;
}

export type ProofState = 'SPENT' | 'UNSPENT' | 'PENDING';

export type ProofStateMap = Record<string, ProofState>;

export interface ReconcileTransactionRow {
  id: string;
  direction: 'in' | 'out';
  type: string;
  amount: number;
  unit: string;
  tokenId: string;
  memo?: string;
  created_at?: string;
  source_voucher_id?: string;
}

export interface AddTransactionResult {
  commitPromise: Promise<ReconcileTransactionRow>;
}

export interface ReconcileQrSharesDeps {
  getActivePendingShares(): Promise<PendingQrShare[]>;
  getVoucherByTokenId(tokenId: string): Promise<ReconcileVoucherRow | null>;
  checkProofStates(proofs: ReadonlyArray<ProofRef>): Promise<ProofStateMap>;
  addTransaction(row: ReconcileTransactionRow): AddTransactionResult;
  markSent(shareId: string): Promise<void>;
  closeWithReason(
    shareId: string,
    reason: 'closed-by-self-spend' | 'expired-without-claim'
  ): Promise<void>;
  hasExistingSentRow?(tokenId: string): Promise<boolean>;
  now?(): number;
  logger?: {
    info?(...args: unknown[]): void;
    warn?(...args: unknown[]): void;
  };
}

export interface ReconcileQrSharesSummary {
  scanned: number;
  sent: number;
  closedBySelfSpend: number;
  expiredWithoutClaim: number;
  deferred: number;
  failed: number;
}
