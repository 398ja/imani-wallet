/**
 * Type Exports
 *
 * Re-exports all types from the types module.
 */

// Spec 039 — QR-share reconciliation types
export type {
  PendingQrShareStatus,
  PendingQrShare,
  ReconcileVoucherRow,
  ProofRef,
  ProofState,
  ProofStateMap,
  ReconcileTransactionRow,
  AddTransactionResult,
  ReconcileQrSharesDeps,
  ReconcileQrSharesSummary,
} from './qr-share';

// Voucher types
export type {
  BackingStrategy,
  VoucherStatus,
  RoundingMode,
  MerchantMetadata,
  Voucher,
  MerchantGroup,
  VoucherSelection,
} from './voucher';

// Recipient types
export type {
  Recipient,
  Nip05Result,
  NostrProfile,
  RecipientInput,
} from './recipient';

// Transaction types
export type {
  TransactionType,
  TransactionDirection,
  Transaction,
  TransactionInput,
} from './transaction';

// Split types
export type {
  SplitPreview,
  SplitResult,
  SplitRequest,
} from './split';

// Payment request types
export type {
  TransportType,
  PaymentTransport,
  PaymentRequest,
  PaymentRequestValidation,
  PaymentRequestMatch,
} from './payment-request';

// Event types
export {
  SendStages,
} from './events';

export type {
  SendStage,
  DmResult,
  ChunkProgress,
  SendEventMap,
  SendParams,
  SendResult,
  PreviewParams,
  PreviewResult,
} from './events';

// Multi-voucher send bundle types (spec 012)
export type {
  BundlePartPlan,
  BundlePlan,
  BundleSubSendRecord,
  BundleSendJournalEntry,
  BundleSendParams,
  BundleSendCallbacks,
  BundleSendPlanSummary,
  BundlePartProgress,
  BundlePartialOutcome,
  BundleCompleteResult,
  BundleSendErrorCode,
} from './bundle';

export { BundleSendError } from './bundle';
