import { QrType, type QrTypeValue } from '../detector/types';

export interface ScanMetadata {
  [key: string]: unknown;
}

export class ScanResult<TType = QrTypeValue> {
  raw: string;
  normalized: string;
  type: TType;
  timestamp: Date;
  metadata: ScanMetadata;

  constructor(
    raw: string,
    normalized?: string,
    type: TType = QrType.UNKNOWN as TType,
    metadata: ScanMetadata = {},
    timestamp: Date = new Date()
  ) {
    this.raw = raw;
    this.normalized = normalized ?? raw;
    this.type = type;
    this.metadata = metadata;
    this.timestamp = timestamp;
  }

  isValid(): boolean {
    return Boolean(this.raw);
  }

  toJSON(): Record<string, unknown> {
    return {
      raw: this.raw,
      normalized: this.normalized,
      type: this.type,
      metadata: this.metadata,
      timestamp: this.timestamp.toISOString()
    };
  }
}
