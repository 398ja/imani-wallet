/**
 * DmSender
 *
 * Sends voucher tokens via encrypted Nostr DMs.
 */

import type { ApiAdapter, NostrAdapter, DmSendOptions } from '../adapters';
import type { Recipient, DmResult, Voucher, ChunkProgress } from '../types';
import { VoucherSendError, ErrorCodes } from '../core/errors';
import { TokenChunker, type TokenChunkerConfig, type ChunkReference } from './TokenChunker';
import { PayloadBuilder, MissingFaceUnitError } from './PayloadBuilder';
import { RelayDiscovery, type RelayDiscoveryConfig } from '../recipient/RelayDiscovery';

/**
 * DmSender configuration
 */
export interface DmSenderConfig {
  /** Infrastructure relay URL */
  infraRelay?: string;

  /** Token chunking configuration */
  chunking?: TokenChunkerConfig & {
    /** Enable auto-chunking (default: true) */
    enabled?: boolean;
  };

  /** Relay discovery configuration */
  relay?: RelayDiscoveryConfig;
}

/**
 * Send options for DM transmission
 */
export interface SendOptions {
  /** Transaction memo */
  memo?: string;

  /** Face value (for display) */
  faceValue?: number;

  /** Face unit */
  faceUnit?: string;

  /** Face decimals */
  faceDecimals?: number;

  /** Token amount in sats */
  tokenAmount?: number;

  /** Backing strategy */
  backingStrategy?: string;

  /** Issuer ID */
  issuerId?: string;

  /** Additional relay URLs */
  relayUrls?: string[];

  /** Sender pubkey (for chunk author field) */
  senderPubkey?: string;

  /** Chunk progress callback */
  onChunkProgress?: (progress: ChunkProgress) => void;
}

/**
 * Send result with details
 */
export interface SendResult {
  /** DM result from API */
  dmResult: DmResult;

  /** Whether token was chunked */
  wasChunked: boolean;

  /** Chunk reference if chunked */
  chunkReference?: ChunkReference;

  /** Relays used for sending */
  relaysUsed: string[];
}

/**
 * DmSender
 *
 * Handles sending tokens via Nostr DMs with automatic chunking.
 */
export class DmSender {
  private apiAdapter: ApiAdapter;
  private nostrAdapter?: NostrAdapter;
  private chunker: TokenChunker;
  private payloadBuilder: PayloadBuilder;
  private relayDiscovery: RelayDiscovery;
  private chunkingEnabled: boolean;

  constructor(
    apiAdapter: ApiAdapter,
    nostrAdapter?: NostrAdapter,
    config: DmSenderConfig = {}
  ) {
    this.apiAdapter = apiAdapter;
    this.nostrAdapter = nostrAdapter;
    this.chunker = new TokenChunker(nostrAdapter, config.chunking);
    this.payloadBuilder = new PayloadBuilder();
    this.relayDiscovery = new RelayDiscovery(nostrAdapter, {
      ...config.relay,
      infraRelay: config.infraRelay,
    });
    this.chunkingEnabled = config.chunking?.enabled ?? true;
  }

  /**
   * Send a token to a recipient via DM
   *
   * @param token - Cashu token to send
   * @param recipient - Resolved recipient
   * @param options - Send options
   * @returns Send result
   */
  async send(
    token: string,
    recipient: Recipient,
    options: SendOptions = {}
  ): Promise<SendResult> {
    // Build relay list
    const relays = await this.buildRelayList(recipient, options.relayUrls);

    // Check if chunking is needed
    if (this.chunkingEnabled && this.chunker.needsChunking(token)) {
      return this.sendChunked(token, recipient, relays, options);
    }

    // Standard direct send
    return this.sendDirect(token, recipient, relays, options);
  }

  /**
   * Send a voucher (convenience method).
   *
   * Delegates to PayloadBuilder.buildFromVoucher first so that a missing or
   * UNKNOWN face_unit raises a typed MissingFaceUnitError *before* any DM is
   * dispatched (feature 007-fix-voucher-currency, S-INV-1).
   */
  async sendVoucher(
    voucher: Voucher,
    recipient: Recipient,
    options: Omit<SendOptions, 'faceValue' | 'faceUnit' | 'tokenAmount' | 'backingStrategy' | 'issuerId'> = {}
  ): Promise<SendResult> {
    if (!voucher.token) {
      throw new VoucherSendError(
        'Voucher has no token',
        ErrorCodes.VALIDATION_ERROR,
        { voucherId: voucher.voucher_id }
      );
    }

    const payload = this.payloadBuilder.buildFromVoucher(voucher, {
      memo: options.memo || voucher.memo || undefined,
      relayUrls: options.relayUrls,
    });

    return this.send(voucher.token, recipient, {
      ...options,
      faceValue: payload.faceValue,
      faceUnit: payload.faceUnit,
      faceDecimals: payload.faceDecimals,
      tokenAmount: payload.tokenAmount,
      backingStrategy: payload.backingStrategy,
      issuerId: payload.issuerId || undefined,
      memo: payload.memo || undefined,
    });
  }

  /**
   * Check if a token needs chunking
   */
  needsChunking(token: string): boolean {
    return this.chunkingEnabled && this.chunker.needsChunking(token);
  }

  /**
   * Get estimated chunk count for a token
   */
  getChunkCount(token: string): number {
    return this.chunker.getChunkCount(token);
  }

  /**
   * Send directly via API (no chunking)
   */
  private async sendDirect(
    token: string,
    recipient: Recipient,
    relays: string[],
    options: SendOptions
  ): Promise<SendResult> {
    try {
      const dmOptions: DmSendOptions = {
        memo: options.memo,
        faceValue: options.faceValue,
        faceUnit: options.faceUnit,
        faceDecimals: options.faceDecimals,
        tokenAmount: options.tokenAmount,
        backingStrategy: options.backingStrategy as DmSendOptions['backingStrategy'],
        issuerId: options.issuerId,
        relayUrls: relays,
        senderPubkey: options.senderPubkey,
      };

      const dmResult = await this.apiAdapter.sendTokenDm(
        token,
        recipient.pubkeyHex,
        dmOptions
      );

      return {
        dmResult,
        wasChunked: false,
        relaysUsed: relays,
      };
    } catch (error) {
      if (error instanceof MissingFaceUnitError) throw error;
      throw VoucherSendError.dmSendFailed(
        (error as Error).message,
        error as Error
      );
    }
  }

  /**
   * Send chunked token
   */
  private async sendChunked(
    token: string,
    recipient: Recipient,
    relays: string[],
    options: SendOptions
  ): Promise<SendResult> {
    if (!this.nostrAdapter?.publishChunkEvent) {
      // Fall back to direct send if chunking not supported
      console.warn('[DmSender] Chunking not supported, falling back to direct send');
      return this.sendDirect(token, recipient, relays, options);
    }

    try {
      // Publish chunks to relays
      const chunkReference = await this.chunker.publishChunked(
        token,
        recipient.pubkeyHex,
        relays,
        {
          senderPubkey: options.senderPubkey,
          onProgress: options.onChunkProgress,
        }
      );

      // Build reference payload for DM
      const referencePayload = this.payloadBuilder.buildChunkReference({
        eventId: chunkReference.eventId,
        author: chunkReference.author,
        relays: chunkReference.relays,
        chunkCount: chunkReference.chunkCount,
        memo: options.memo,
        faceValue: options.faceValue,
        faceUnit: options.faceUnit,
      });

      // Send reference DM (small, won't need chunking)
      const serializedReference = this.payloadBuilder.serializeChunkReference(referencePayload);

      const dmOptions: DmSendOptions = {
        memo: `[Chunked token: ${chunkReference.chunkCount} parts]`,
        faceValue: options.faceValue,
        faceUnit: options.faceUnit,
        faceDecimals: options.faceDecimals,
        tokenAmount: options.tokenAmount,
        backingStrategy: options.backingStrategy as DmSendOptions['backingStrategy'],
        issuerId: options.issuerId,
        relayUrls: relays,
        senderPubkey: options.senderPubkey,
      };

      const dmResult = await this.apiAdapter.sendTokenDm(
        serializedReference,
        recipient.pubkeyHex,
        dmOptions
      );

      return {
        dmResult,
        wasChunked: true,
        chunkReference,
        relaysUsed: relays,
      };
    } catch (error) {
      if (error instanceof MissingFaceUnitError) throw error;
      throw VoucherSendError.dmSendFailed(
        `Chunked send failed: ${(error as Error).message}`,
        error as Error
      );
    }
  }

  /**
   * Build relay list for sending
   */
  private async buildRelayList(
    recipient: Recipient,
    customRelays?: string[]
  ): Promise<string[]> {
    return this.relayDiscovery.buildRelayList(recipient.pubkeyHex, customRelays);
  }

  /**
   * Set infrastructure relay
   */
  setInfraRelay(relay: string): void {
    this.relayDiscovery.setInfraRelay(relay);
  }
}

/**
 * Create a DM sender instance
 */
export function createDmSender(
  apiAdapter: ApiAdapter,
  nostrAdapter?: NostrAdapter,
  config?: DmSenderConfig
): DmSender {
  return new DmSender(apiAdapter, nostrAdapter, config);
}
