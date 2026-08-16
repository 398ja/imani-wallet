/**
 * ImaniApiAdapter
 *
 * Adapts the Imani GatewayAPI to the ApiAdapter interface.
 * Wraps existing api.js functions for use with VoucherSender.
 */

import type { ApiAdapter, DmSendOptions } from '../../adapters';
import type { SplitPreview, SplitResult, NostrProfile, DmResult } from '../../types';

/**
 * Imani GatewayAPI interface (from shared/api.js)
 */
export interface GatewayAPI {
  splitPreview(token: string, sendFaceValue: number): Promise<ImaniSplitPreviewResponse>;
  splitExecute(
    token: string,
    sendFaceValue: number,
    memo?: string | null,
    allowSwap?: boolean
  ): Promise<ImaniSplitExecuteResponse>;
  sendTokenDm(
    token: string,
    recipientPubkey: string,
    options?: ImaniDmOptions
  ): Promise<ImaniDmResponse>;
  getProfile(pubkey: string, skipCache?: boolean): Promise<ImaniProfile | null>;
  resolveNip05?(nip05: string): Promise<ImaniNip05Response>;
  infraRelay?: string;
  nip60Relays?: string[];
}

/**
 * Imani API response types
 */
interface ImaniSplitPreviewResponse {
  requested_face_value?: number;
  actual_face_value?: number;
  actual_send_face_value?: number;
  rounding_applied?: boolean;
  rounding_delta?: number;
  rounding_mode?: string;
  keep_face_value?: number;
  send_token_amount?: number;
  keep_token_amount?: number;
  swap_required?: boolean;
  swap_reason?: string;
  min_split_face_value?: number;
  min_denomination?: number;
  send?: {
    face_value?: number;
    token_amount?: number;
  };
  keep?: {
    face_value?: number;
    token_amount?: number;
  };
}

interface ImaniSplitExecuteResponse {
  send_token?: string;
  sent_token?: string;
  keep_token?: string;
  send_face_value?: number;
  keep_face_value?: number;
  send_token_amount?: number;
  keep_token_amount?: number;
  rounding_applied?: boolean;
  rounding_mode?: string;
  face_unit?: string;
  face_decimals?: number;
  issuer_id?: string;
  backing_strategy?: string;
  error?: string;
  message?: string;
}

interface ImaniDmOptions {
  memo?: string | null;
  faceValue?: number;
  faceUnit?: string;
  tokenAmount?: number;
  backingStrategy?: string;
  issuerId?: string;
  relayUrls?: string[];
}

interface ImaniDmResponse {
  event_id?: string;
  success?: boolean;
  relays_published?: string[];
}

interface ImaniProfile {
  pubkey?: string;
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  nip05?: string;
  lud16?: string;
  banner?: string;
  website?: string;
}

interface ImaniNip05Response {
  pubkey?: string;
  relays?: string[];
  error?: string;
}

/**
 * ImaniApiAdapter configuration
 */
export interface ImaniApiAdapterConfig {
  /** The GatewayAPI instance (window.api in browser) */
  api: GatewayAPI;
}

/**
 * ImaniApiAdapter
 *
 * Adapts the Imani GatewayAPI to the voucher-send ApiAdapter interface.
 */
export class ImaniApiAdapter implements ApiAdapter {
  private api: GatewayAPI;

  constructor(config: ImaniApiAdapterConfig) {
    this.api = config.api;
  }

  /**
   * Preview a split operation
   */
  async splitPreview(token: string, amount: number): Promise<SplitPreview> {
    const response = await this.api.splitPreview(token, amount);

    // Map Imani response to SplitPreview
    const requestedAmount = response.requested_face_value ?? amount;
    const actualAmount = response.send?.face_value ??
      response.actual_face_value ??
      response.actual_send_face_value ??
      requestedAmount;

    return {
      canSplit: !response.swap_required,
      actualAmount,
      roundingApplied: response.rounding_applied ?? actualAmount !== requestedAmount,
      swapRequired: response.swap_required ?? false,
      minSplitAmount: response.min_split_face_value ?? response.min_denomination,
    };
  }

  /**
   * Execute a split operation
   */
  async splitExecute(token: string, amount: number, memo?: string): Promise<SplitResult> {
    const response = await this.api.splitExecute(
      token,
      amount,
      memo ?? null,
      false // allowSwap
    );

    // Check for errors
    if (response.error || response.message) {
      throw new Error(response.error || response.message || 'Split failed');
    }

    const sendToken = response.send_token || response.sent_token;
    if (!sendToken) {
      throw new Error('Split failed: no send token returned');
    }

    return {
      sendToken,
      keepToken: response.keep_token || '',
      sendFaceValue: response.send_face_value ?? amount,
      keepFaceValue: response.keep_face_value ?? 0,
      sendTokenAmount: response.send_token_amount ?? 0,
      keepTokenAmount: response.keep_token_amount ?? 0,
      roundingApplied: response.rounding_applied ?? false,
      issuerId: response.issuer_id,
      faceUnit: response.face_unit,
      faceDecimals: response.face_decimals,
      backingStrategy: response.backing_strategy as 'MINIMAL' | 'FULL' | 'LEGACY' | undefined,
    };
  }

  /**
   * Send a token via DM
   */
  async sendTokenDm(
    token: string,
    recipientPubkey: string,
    options?: DmSendOptions
  ): Promise<DmResult> {
    const imaniOptions: ImaniDmOptions = {};

    if (options?.memo) {
      imaniOptions.memo = options.memo;
    }
    if (options?.faceValue != null) {
      imaniOptions.faceValue = options.faceValue;
    }
    if (options?.faceUnit) {
      imaniOptions.faceUnit = options.faceUnit;
    }
    if (options?.tokenAmount != null) {
      imaniOptions.tokenAmount = options.tokenAmount;
    }
    if (options?.backingStrategy) {
      imaniOptions.backingStrategy = options.backingStrategy;
    }
    if (options?.issuerId) {
      imaniOptions.issuerId = options.issuerId;
    }
    if (options?.relayUrls && options.relayUrls.length > 0) {
      imaniOptions.relayUrls = options.relayUrls;
    }

    const response = await this.api.sendTokenDm(token, recipientPubkey, imaniOptions);

    return {
      eventId: response.event_id ?? '',
      recipientPubkey,
      sentAt: new Date().toISOString(),
      relaysUsed: response.relays_published ?? [],
    };
  }

  /**
   * Get a Nostr profile
   */
  async getProfile(pubkey: string): Promise<NostrProfile | null> {
    try {
      const profile = await this.api.getProfile(pubkey);
      if (!profile) return null;

      return {
        name: profile.name || profile.display_name,
        about: profile.about,
        picture: profile.picture,
        nip05: profile.nip05,
        lud16: profile.lud16,
        banner: profile.banner,
        website: profile.website,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get the infrastructure relay URL
   */
  getInfraRelay(): string | undefined {
    return this.api.infraRelay;
  }

  /**
   * Get NIP-60 relays
   */
  getNip60Relays(): string[] {
    return this.api.nip60Relays ?? [];
  }
}

/**
 * Create an ImaniApiAdapter from a GatewayAPI instance
 */
export function createImaniApiAdapter(api: GatewayAPI): ImaniApiAdapter {
  return new ImaniApiAdapter({ api });
}
