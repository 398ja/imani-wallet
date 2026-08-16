/**
 * VoucherSender
 *
 * Main orchestrator class that coordinates all voucher sending operations.
 * Ties together selection, splitting, recipient resolution, and transmission.
 */

import type { Adapters } from '../adapters';
import type {
  Voucher,
  Recipient,
  MerchantGroup,
  SendParams,
  SendResult,
  PreviewParams,
  PreviewResult,
  SendStage,
  SendEventMap,
  Transaction,
  DmResult,
} from '../types';
import { SendStages } from '../types';
import { SendConfig, type SendConfigOptions } from '../core/SendConfig';
import { TypedEventEmitter } from '../core/EventEmitter';
import { VoucherSendError, ErrorCodes } from '../core/errors';
import { VoucherSelector, type SelectionResult } from '../selection/VoucherSelector';
import { SplitPreviewService } from '../splitting/SplitPreview';
import { SplitExecutor, type SplitExecutionResult } from '../splitting/SplitExecutor';
import { RecipientResolver } from '../recipient/RecipientResolver';
import { DmSender } from '../transmission/DmSender';
import { Nip60Publisher } from '../transmission/Nip60Publisher';

/**
 * VoucherSender configuration
 */
export interface VoucherSenderConfig {
  /** Adapters for API, storage, and Nostr operations */
  adapters: Adapters;

  /** Configuration options */
  config?: SendConfigOptions;
}

/**
 * VoucherSender
 *
 * Main class for sending vouchers. Orchestrates the complete flow:
 * 1. Voucher selection (if not specified)
 * 2. Split preview and execution
 * 3. Recipient resolution
 * 4. DM transmission
 * 5. Optional NIP-60 backup
 * 6. Transaction recording
 */
export class VoucherSender {
  private adapters: Adapters;
  private config: SendConfig;
  private eventEmitter: TypedEventEmitter;
  private selector: VoucherSelector;
  private splitPreview: SplitPreviewService;
  private splitExecutor: SplitExecutor;
  private recipientResolver: RecipientResolver;
  private dmSender: DmSender;
  private nip60Publisher: Nip60Publisher;

  constructor({ adapters, config }: VoucherSenderConfig) {
    this.adapters = adapters;
    this.config = SendConfig.create(config);
    this.eventEmitter = new TypedEventEmitter();

    // Initialize modules
    this.selector = new VoucherSelector({ storage: adapters.storage });
    this.splitPreview = new SplitPreviewService(adapters.api);
    this.splitExecutor = new SplitExecutor(adapters.api);
    this.recipientResolver = new RecipientResolver(adapters.api, adapters.nostr, {
      nip05: { defaultDomain: this.config.defaultNip05Domain },
    });
    this.dmSender = new DmSender(adapters.api, adapters.nostr, {
      infraRelay: this.config.relay.infraRelay,
      chunking: {
        enabled: this.config.chunking.enabled,
        chunkThreshold: this.config.chunking.threshold,
        chunkSize: this.config.chunking.chunkSize,
      },
    });
    this.nip60Publisher = new Nip60Publisher(adapters.nostr, {
      relays: this.config.nip60.relays,
    });
  }

  /**
   * Subscribe to an event
   */
  on<K extends keyof SendEventMap>(
    event: K,
    handler: (data: SendEventMap[K]) => void
  ): () => void {
    return this.eventEmitter.on(event, handler);
  }

  /**
   * Unsubscribe from an event
   */
  off<K extends keyof SendEventMap>(
    event: K,
    handler?: (data: SendEventMap[K]) => void
  ): void {
    this.eventEmitter.off(event, handler);
  }

  /**
   * Send a voucher to a recipient
   *
   * @param params - Send parameters
   * @returns Send result with all details
   */
  async send(params: SendParams): Promise<SendResult> {
    this.eventEmitter.emit('send:start', { params });
    let currentStage: SendStage = SendStages.VALIDATING;

    try {
      // Stage 1: Validate parameters
      this.emitProgress(SendStages.VALIDATING);
      this.validateParams(params);

      // Stage 2: Get or select voucher
      this.emitProgress(SendStages.SELECTING_VOUCHER);
      currentStage = SendStages.SELECTING_VOUCHER;
      const voucher = await this.getOrSelectVoucher(params);
      this.eventEmitter.emit('selection:complete', { voucher });

      // Stage 3: Preview and execute split
      this.emitProgress(SendStages.SPLITTING);
      currentStage = SendStages.SPLITTING;
      const splitResult = await this.executeSplit(voucher, params.amount, params.memo);
      this.eventEmitter.emit('split:complete', { result: splitResult });

      // Stage 4: Resolve recipient
      this.emitProgress(SendStages.RESOLVING_RECIPIENT);
      currentStage = SendStages.RESOLVING_RECIPIENT;
      const recipient = await this.resolveRecipientInternal(params.recipient);
      this.eventEmitter.emit('recipient:found', { recipient });

      // Stage 5: Build payload and send DM
      this.emitProgress(SendStages.BUILDING_PAYLOAD);
      currentStage = SendStages.BUILDING_PAYLOAD;

      this.emitProgress(SendStages.SENDING_DM);
      currentStage = SendStages.SENDING_DM;
      const dmResult = await this.sendDm(splitResult, recipient, params);
      this.eventEmitter.emit('dm:sent', dmResult);

      // Stage 6: Optional NIP-60 publishing
      if (this.config.nip60.enabled) {
        this.emitProgress(SendStages.PUBLISHING_NIP60);
        currentStage = SendStages.PUBLISHING_NIP60;
        await this.publishNip60(splitResult.sendToken, recipient.pubkeyHex);
      }

      // Stage 7: Record transaction
      this.emitProgress(SendStages.RECORDING_TRANSACTION);
      currentStage = SendStages.RECORDING_TRANSACTION;
      const transaction = await this.recordTransaction(
        splitResult,
        recipient,
        params.memo
      );

      // Complete
      this.emitProgress(SendStages.COMPLETE);
      const result: SendResult = {
        success: true,
        sentVoucher: this.buildSentVoucher(voucher, splitResult),
        keepVoucher: splitResult.keepToken
          ? this.buildKeepVoucher(voucher, splitResult)
          : undefined,
        recipient,
        dmResult,
        transaction,
        splitResult,
      };

      this.eventEmitter.emit('send:complete', { result });
      return result;
    } catch (error) {
      this.eventEmitter.emit('send:error', { error: error as Error, stage: currentStage });
      throw error;
    }
  }

  /**
   * Preview a send without executing
   *
   * @param params - Preview parameters
   * @returns Preview result with split details
   */
  async preview(params: PreviewParams): Promise<PreviewResult> {
    // Resolve voucher
    const voucher = await this.resolveVoucher(params.voucher);

    if (!voucher.token) {
      throw new VoucherSendError(
        'Voucher has no token',
        ErrorCodes.VALIDATION_ERROR,
        { voucherId: voucher.voucher_id }
      );
    }

    // Get split preview
    const preview = await this.splitPreview.preview(voucher.token, params.amount);

    return {
      ...preview,
      voucher,
      merchant: voucher.issuer_id
        ? {
            id: voucher.issuer_id,
            name: voucher.merchant_metadata?.merchant_name || voucher.issuer_id,
          }
        : undefined,
    };
  }

  /**
   * Resolve a recipient identifier
   *
   * @param identifier - npub, NIP-05, or hex pubkey
   * @returns Resolved recipient
   */
  async resolveRecipient(identifier: string): Promise<Recipient> {
    this.eventEmitter.emit('recipient:resolve', { identifier });

    try {
      const recipient = await this.recipientResolver.resolve(identifier);
      return recipient;
    } catch (error) {
      this.eventEmitter.emit('recipient:notfound', {
        identifier,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Get voucher groups by merchant
   */
  async getVoucherGroups(): Promise<MerchantGroup[]> {
    return this.selector.getMerchantGroups();
  }

  /**
   * Select a voucher for a given amount
   *
   * @param merchantId - Merchant ID to select from
   * @param amount - Amount needed (face value)
   * @returns Selection result
   */
  async selectVoucher(merchantId: string, amount: number): Promise<SelectionResult> {
    this.eventEmitter.emit('selection:start', { merchantId, amount });
    return this.selector.selectByMerchant(merchantId, amount);
  }

  /**
   * Check if a token needs chunking
   */
  needsChunking(token: string): boolean {
    return this.dmSender.needsChunking(token);
  }

  /**
   * Get chunk count estimate for a token
   */
  getChunkCount(token: string): number {
    return this.dmSender.getChunkCount(token);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private validateParams(params: SendParams): void {
    if (!params.amount || params.amount <= 0) {
      throw new VoucherSendError(
        'Amount must be greater than 0',
        ErrorCodes.VALIDATION_ERROR,
        { amount: params.amount }
      );
    }

    if (!params.recipient && !params.paymentRequest) {
      throw new VoucherSendError(
        'Recipient is required',
        ErrorCodes.VALIDATION_ERROR
      );
    }

    if (!params.voucher && !params.merchantId && !params.paymentRequest) {
      throw new VoucherSendError(
        'Either voucher, merchantId, or paymentRequest is required',
        ErrorCodes.VALIDATION_ERROR
      );
    }
  }

  private async getOrSelectVoucher(params: SendParams): Promise<Voucher> {
    // If voucher is directly provided
    if (params.voucher) {
      return this.resolveVoucher(params.voucher);
    }

    // If merchantId is provided, select from merchant's vouchers
    if (params.merchantId) {
      const selection = await this.selector.selectByMerchant(
        params.merchantId,
        params.amount
      );
      return selection.voucher;
    }

    // TODO: Handle payment request
    throw new VoucherSendError(
      'Could not determine voucher to send',
      ErrorCodes.VOUCHER_NOT_FOUND
    );
  }

  private async resolveVoucher(
    voucherOrId: string | Voucher
  ): Promise<Voucher> {
    if (typeof voucherOrId !== 'string') {
      return voucherOrId;
    }

    const voucher = await this.adapters.storage.getVoucher(voucherOrId);
    if (!voucher) {
      throw VoucherSendError.voucherNotFound(voucherOrId);
    }

    return voucher;
  }

  private async resolveRecipientInternal(recipient: string | Recipient): Promise<Recipient> {
    if (typeof recipient !== 'string') {
      return recipient;
    }

    return this.resolveRecipient(recipient);
  }

  private async executeSplit(
    voucher: Voucher,
    amount: number,
    memo?: string
  ): Promise<SplitExecutionResult> {
    if (!voucher.token) {
      throw new VoucherSendError(
        'Voucher has no token',
        ErrorCodes.VALIDATION_ERROR,
        { voucherId: voucher.voucher_id }
      );
    }

    // Preview first
    const preview = await this.splitPreview.preview(voucher.token, amount);
    this.eventEmitter.emit('split:preview', preview);

    // Execute split
    this.eventEmitter.emit('split:start', { token: voucher.token, amount });
    const executionResult = await this.splitExecutor.execute(voucher, amount, { memo });

    // Return the SplitResult part (SplitExecutionResult extends SplitResult)
    return executionResult;
  }

  private async sendDm(
    splitResult: SplitExecutionResult,
    recipient: Recipient,
    params: SendParams
  ): Promise<DmResult> {
    this.eventEmitter.emit('dm:sending', {
      recipient,
      relayCount: this.config.getDefaultRelays().length,
    });

    const sendResult = await this.dmSender.send(
      splitResult.sendToken,
      recipient,
      {
        memo: params.memo,
        faceValue: splitResult.sendFaceValue,
        faceUnit: splitResult.faceUnit,
        faceDecimals: splitResult.faceDecimals,
        tokenAmount: splitResult.sendTokenAmount,
        backingStrategy: splitResult.backingStrategy,
        issuerId: splitResult.issuerId,
        onChunkProgress: (progress) => {
          this.eventEmitter.emit('chunk:progress', progress);
        },
      }
    );

    return {
      eventId: sendResult.dmResult.eventId || '',
      recipientPubkey: recipient.pubkeyHex,
      sentAt: new Date().toISOString(),
      relaysUsed: sendResult.relaysUsed,
      chunked: sendResult.wasChunked,
      chunkCount: sendResult.chunkReference?.chunkCount,
    };
  }

  private async publishNip60(
    token: string,
    recipientPubkey: string
  ): Promise<void> {
    if (!this.nip60Publisher.isAvailable()) {
      this.config.log('NIP-60 not available, skipping');
      return;
    }

    const result = await this.nip60Publisher.publishFromToken(token, recipientPubkey);
    this.eventEmitter.emit('nip60:published', { success: result.success });

    if (result.success) {
      this.eventEmitter.emit('nip60:publishing', { proofCount: result.proofCount || 0 });
    }
  }

  private async recordTransaction(
    splitResult: SplitExecutionResult,
    recipient: Recipient,
    memo?: string
  ): Promise<Transaction> {
    const transaction: Transaction = {
      id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      type: 'voucher_sent',
      direction: 'out',
      faceValue: splitResult.sendFaceValue,
      faceUnit: splitResult.faceUnit,
      faceDecimals: splitResult.faceDecimals,
      tokenAmount: splitResult.sendTokenAmount,
      issuerId: splitResult.issuerId,
      counterparty: recipient.pubkeyHex,
      counterpartyName: recipient.displayName || recipient.nip05 || recipient.npub,
      memo,
      timestamp: new Date().toISOString(),
    };

    await this.adapters.storage.addTransaction(transaction);
    return transaction;
  }

  private buildSentVoucher(original: Voucher, splitResult: SplitExecutionResult): Voucher {
    return {
      voucher_id: `sent-${Date.now()}`,
      token: splitResult.sendToken,
      face_value: splitResult.sendFaceValue,
      face_unit: splitResult.faceUnit,
      face_decimals: splitResult.faceDecimals,
      token_amount: splitResult.sendTokenAmount,
      backing_strategy: splitResult.backingStrategy,
      issuer_id: splitResult.issuerId,
      merchant_metadata: original.merchant_metadata,
      status: 'spent',
    };
  }

  private buildKeepVoucher(original: Voucher, splitResult: SplitExecutionResult): Voucher {
    return {
      voucher_id: original.voucher_id,
      token: splitResult.keepToken,
      face_value: splitResult.keepFaceValue,
      face_unit: splitResult.faceUnit,
      face_decimals: splitResult.faceDecimals,
      token_amount: splitResult.keepTokenAmount,
      backing_strategy: splitResult.backingStrategy,
      issuer_id: splitResult.issuerId,
      merchant_metadata: original.merchant_metadata,
      status: 'active',
    };
  }

  private emitProgress(stage: SendStage, details?: Record<string, unknown>): void {
    this.eventEmitter.emit('send:progress', { stage, details });
  }
}

/**
 * Create a VoucherSender instance
 *
 * @param config - Sender configuration
 * @returns VoucherSender instance
 */
export function createVoucherSender(config: VoucherSenderConfig): VoucherSender {
  return new VoucherSender(config);
}
