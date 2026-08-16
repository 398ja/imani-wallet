/**
 * Orchestrator Module
 *
 * Main VoucherSender class that ties all modules together.
 */

export {
  VoucherSender,
  createVoucherSender,
  type VoucherSenderConfig,
} from './VoucherSender';

// Spec 012-multi-voucher-send orchestrator.
export {
  BundleSender,
  createBundleSender,
  defaultBundleIdGenerator,
  type BundleSenderConfig,
  type BundleSendAdapters,
  type BundleSendApiAdapter,
  type BundleSendVoucherAdapter,
  type BundleSendJournalAdapter,
  type BundleSendTransactionAdapter,
  type BundleSendIdAdapter,
  type BundleSendClockAdapter,
  type BundleLogger,
  type BundleCandidateSelection,
  type AtomicSendInitiateParams,
  type AtomicSendInitialResult,
  type AtomicSendTerminalResult,
} from './BundleSender';
