/**
 * Core Module
 *
 * Exports core functionality.
 */

export {
  SendConfig,
  type SendConfigOptions,
  type ChunkingConfig,
  type RelayConfig,
  type Nip60Config,
} from './SendConfig';

export {
  TypedEventEmitter,
  createEventEmitter,
} from './EventEmitter';

export {
  VoucherSendError,
  ErrorCodes,
  type ErrorCode,
  type ErrorDetails,
} from './errors';
