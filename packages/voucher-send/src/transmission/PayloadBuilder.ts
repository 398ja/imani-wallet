/**
 * PayloadBuilder
 *
 * Builds DM payloads for voucher transmission.
 */

import type { Voucher, BackingStrategy } from '../types';

/**
 * Thrown by buildFromVoucher when the sender's voucher has no usable
 * face_unit. S-INV-1 of the rumor contract — feature 007-fix-voucher-currency.
 * Callers must propagate the error up to the UI rather than emitting a
 * partial payload.
 */
export class MissingFaceUnitError extends Error {
  readonly code = 'MISSING_FACE_UNIT' as const;
  constructor(voucherId: string, actual: unknown) {
    super(
      `Refusing to build DM payload — voucher ${voucherId} has no known ` +
        `face_unit (got ${JSON.stringify(actual)}). Inbound-only "UNKNOWN" ` +
        `sentinel is not permitted on outbound sends.`
    );
    this.name = 'MissingFaceUnitError';
  }
}

const INBOUND_ONLY_UNKNOWN = 'UNKNOWN';

function assertSendableFaceUnit(voucher: Voucher): string {
  const raw = voucher.face_unit;
  if (typeof raw !== 'string') {
    throw new MissingFaceUnitError(voucher.voucher_id, raw);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new MissingFaceUnitError(voucher.voucher_id, raw);
  }
  const upper = trimmed.toUpperCase();
  if (upper === INBOUND_ONLY_UNKNOWN) {
    throw new MissingFaceUnitError(voucher.voucher_id, raw);
  }
  return upper;
}

/**
 * DM payload structure
 */
export interface DmPayload {
  /** Transaction memo */
  memo?: string | null;

  /** Face value in minor units */
  faceValue: number;

  /** Face unit (currency code) */
  faceUnit: string;

  /** Face decimals */
  faceDecimals?: number;

  /** Token amount in sats */
  tokenAmount: number;

  /** Backing strategy */
  backingStrategy: BackingStrategy;

  /** Issuer ID (merchant pubkey) */
  issuerId?: string | null;

  /** Relay URLs for recipient to use */
  relayUrls?: string[];
}

/**
 * Chunk reference payload for chunked tokens
 */
export interface ChunkReferencePayload {
  /** Payload type identifier */
  type: 'cashu:chunk';

  /** Event ID of first chunk */
  eventId: string;

  /** Author pubkey (sender) */
  author?: string;

  /** Relay hints for fetching chunks */
  relays: string[];

  /** Number of chunks */
  chunkCount: number;

  /** Display metadata */
  memo?: string;
  faceValue?: number;
  faceUnit?: string;
}

/**
 * PayloadBuilder configuration
 */
export interface PayloadBuilderConfig {
  /** Default backing strategy */
  defaultBackingStrategy?: BackingStrategy;

  /** Default face decimals */
  defaultFaceDecimals?: number;
}

/**
 * PayloadBuilder
 *
 * Builds structured payloads for DM transmission.
 */
export class PayloadBuilder {
  private defaultBackingStrategy: BackingStrategy;
  private defaultFaceDecimals: number;

  constructor(config: PayloadBuilderConfig = {}) {
    this.defaultBackingStrategy = config.defaultBackingStrategy || 'LEGACY';
    this.defaultFaceDecimals = config.defaultFaceDecimals || 2;
  }

  /**
   * Build a DM payload from a voucher.
   *
   * Throws `MissingFaceUnitError` if the voucher's face_unit is absent,
   * empty, or the inbound-only `"UNKNOWN"` sentinel. The caller must surface
   * the error to the UI — no DM is dispatched on failure.
   */
  buildFromVoucher(
    voucher: Voucher,
    options: {
      memo?: string;
      relayUrls?: string[];
      issuerId?: string;
    } = {}
  ): DmPayload {
    const faceUnit = assertSendableFaceUnit(voucher);
    return {
      memo: options.memo || voucher.memo || null,
      faceValue: voucher.face_value || 0,
      faceUnit,
      faceDecimals: voucher.face_decimals ?? this.defaultFaceDecimals,
      tokenAmount: voucher.token_amount || 0,
      backingStrategy: voucher.backing_strategy || this.defaultBackingStrategy,
      issuerId: options.issuerId || voucher.issuer_id || null,
      relayUrls: options.relayUrls,
    };
  }

  /**
   * Build a DM payload from raw values
   */
  build(options: {
    memo?: string;
    faceValue: number;
    faceUnit: string;
    faceDecimals?: number;
    tokenAmount: number;
    backingStrategy?: BackingStrategy;
    issuerId?: string;
    relayUrls?: string[];
  }): DmPayload {
    return {
      memo: options.memo || null,
      faceValue: options.faceValue,
      faceUnit: options.faceUnit,
      faceDecimals: options.faceDecimals ?? this.defaultFaceDecimals,
      tokenAmount: options.tokenAmount,
      backingStrategy: options.backingStrategy || this.defaultBackingStrategy,
      issuerId: options.issuerId || null,
      relayUrls: options.relayUrls,
    };
  }

  /**
   * Build a chunk reference payload
   */
  buildChunkReference(options: {
    eventId: string;
    author?: string;
    relays: string[];
    chunkCount: number;
    memo?: string;
    faceValue?: number;
    faceUnit?: string;
  }): ChunkReferencePayload {
    return {
      type: 'cashu:chunk',
      eventId: options.eventId,
      author: options.author,
      relays: options.relays,
      chunkCount: options.chunkCount,
      memo: options.memo,
      faceValue: options.faceValue,
      faceUnit: options.faceUnit,
    };
  }

  /**
   * Serialize a chunk reference to JSON string
   */
  serializeChunkReference(reference: ChunkReferencePayload): string {
    return JSON.stringify(reference);
  }

  /**
   * Check if a payload is a chunk reference
   */
  isChunkReference(payload: string): boolean {
    try {
      const parsed = JSON.parse(payload);
      return parsed.type === 'cashu:chunk' && typeof parsed.eventId === 'string';
    } catch {
      return false;
    }
  }

  /**
   * Parse a chunk reference from JSON string
   */
  parseChunkReference(payload: string): ChunkReferencePayload | null {
    try {
      const parsed = JSON.parse(payload);
      if (parsed.type === 'cashu:chunk' && typeof parsed.eventId === 'string') {
        return parsed as ChunkReferencePayload;
      }
      return null;
    } catch {
      return null;
    }
  }
}

/**
 * Create a payload builder instance
 */
export function createPayloadBuilder(config?: PayloadBuilderConfig): PayloadBuilder {
  return new PayloadBuilder(config);
}
