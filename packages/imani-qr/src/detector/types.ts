export enum QrType {
  PAYMENT_REQUEST = 'payment_request',
  NPUB = 'npub',
  NIP05 = 'nip05',
  CASHU_TOKEN = 'cashu_token',
  /**
   * Spec 028 — a NUT-16 BC-UR fragment (`ur:bytes/...`) belonging to an
   * animated Cashu V4 token transport. Routed through `Nut16ScanProcessor`
   * which accumulates frames and emits the reconstructed cashuB token on
   * the standard scan event.
   */
  UR_FRAGMENT = 'ur_fragment',
  UNKNOWN = 'unknown'
}

export type QrTypeValue = QrType | (string & {});

export interface DetectionResult<TType = QrTypeValue> {
  type: TType;
  raw: string;
  normalized: string;
  metadata?: Record<string, unknown>;
}
