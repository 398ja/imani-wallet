export interface Nut16EncodeOptions {
  maxFragmentLength?: number;
  frameIntervalMs?: number;
  forceAnimated?: boolean;
}

export interface Nut16FrameIterator {
  next(): { value: string; done: false };
  reset(): void;
}

export type Nut16EncodeResult =
  | {
      mode: 'static';
      staticContent: string;
      frameIntervalMs: number;
    }
  | {
      mode: 'animated';
      frames: Nut16FrameIterator;
      frameIntervalMs: number;
      estimatedFrameCount: number;
    };

export type Nut16EncodeErrorCode = 'NOT_CASHU_V4' | 'EMPTY_INPUT';

export class Nut16EncodeError extends Error {
  readonly code: Nut16EncodeErrorCode;
  constructor(code: Nut16EncodeErrorCode, message: string) {
    super(message);
    this.name = 'Nut16EncodeError';
    this.code = code;
  }
}

export interface Nut16DecoderProgress {
  receivedCount: number;
  estimatedTotal: number;
  estimatedCompletion: number;
}

export type Nut16DecoderErrorCode =
  | 'INVALID_UR_FRAGMENT'
  | 'CRC_MISMATCH'
  | 'INTERNAL';

export type Nut16DecoderStatus =
  | { kind: 'progress'; progress: Nut16DecoderProgress }
  | { kind: 'complete' }
  | { kind: 'ignored'; reason: 'NOT_A_UR_FRAGMENT' | 'DIFFERENT_SEQUENCE' }
  | { kind: 'error'; code: Nut16DecoderErrorCode; message: string };

export interface Nut16Decoder {
  receive(fragment: string): Nut16DecoderStatus;
  isComplete(): boolean;
  result(): string;
  progress(): Nut16DecoderProgress;
  reset(): void;
}

export type Nut16ScanEvent =
  | { kind: 'fragment-accepted'; progress: Nut16DecoderProgress }
  | { kind: 'fragment-ignored'; reason: 'NOT_A_UR_FRAGMENT' | 'DIFFERENT_SEQUENCE' }
  | { kind: 'reconstruction-complete'; cashuBToken: string }
  | { kind: 'reconstruction-error'; code: Nut16DecoderErrorCode; message: string }
  | { kind: 'decoder-reset' };

export const NUT16_QR_TYPE_VALUE = 'UR_FRAGMENT' as const;
// Permissive prefix match — matches both single-part (`ur:bytes/<words>`) and
// multi-part (`ur:bytes/<n>-<m>/<words>`) URs. Structural validation happens in
// the decoder via BC-UR's `URDecoder.receivePart`.
export const UR_FRAGMENT_PATTERN: RegExp = /^ur:bytes\//i;

export const DEFAULT_MAX_FRAGMENT_LENGTH = 100;
export const DEFAULT_FRAME_INTERVAL_MS = 200;
// Static QR routing threshold. NUT-16 specifies "≤ 2 proofs" as the rule of
// thumb. Spec 035 US3 T024 lowers this from 400 → 240 because a 400-byte
// static QR (V14, ~73×73 modules at ECC L) is dense enough that the
// low-end Android baseline cameras (Tecno / Itel-class) used in the
// launch market struggle to capture it cleanly. 240 B at ECC L lands in
// the V10–V11 range (~57×57), which decode-tests show is reliable on
// the same hardware. A 2-proof DLEQ+P2PK token sits roughly at 350-400 B,
// so most such tokens now route through the animated NUT-16 path.
// Spec 035 R1 (research.md): further on-device measurement may ratchet
// this down toward 200 B if needed; the current value is a defensible
// upper bound of the 200-240 B target band agreed on at planning time.
export const STATIC_BYTE_GUARD = 240;
