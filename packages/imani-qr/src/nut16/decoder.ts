import {
  bytesToString,
  createAccumulator,
  type UrAccumulator,
} from './ur-codec';
import {
  UR_FRAGMENT_PATTERN,
  type Nut16Decoder,
  type Nut16DecoderProgress,
  type Nut16DecoderStatus,
} from './types';

class Nut16DecoderImpl implements Nut16Decoder {
  private accumulator: UrAccumulator = createAccumulator();
  private accepted = 0;
  private cachedResult: string | null = null;

  receive(fragment: string): Nut16DecoderStatus {
    const trimmed = fragment.trim();
    if (!UR_FRAGMENT_PATTERN.test(trimmed)) {
      return { kind: 'ignored', reason: 'NOT_A_UR_FRAGMENT' };
    }

    if (this.cachedResult !== null) {
      return { kind: 'ignored', reason: 'DIFFERENT_SEQUENCE' };
    }

    let accepted = false;
    try {
      accepted = this.accumulator.receivePart(trimmed);
    } catch (err) {
      return {
        kind: 'error',
        code: 'INVALID_UR_FRAGMENT',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    if (this.accumulator.isError()) {
      const message = this.accumulator.resultError();
      this.accumulator = createAccumulator();
      this.accepted = 0;
      return {
        kind: 'error',
        code: 'CRC_MISMATCH',
        message: message || 'fountain decoder reported error',
      };
    }

    if (accepted) {
      this.accepted += 1;
    }

    if (this.accumulator.isComplete()) {
      try {
        const bytes = this.accumulator.resultBytes();
        this.cachedResult = bytesToString(bytes);
      } catch (err) {
        return {
          kind: 'error',
          code: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      return { kind: 'complete' };
    }

    return { kind: 'progress', progress: this.progress() };
  }

  isComplete(): boolean {
    return this.cachedResult !== null;
  }

  result(): string {
    if (this.cachedResult === null) {
      throw new Error('Nut16Decoder.result() called before isComplete()');
    }
    return this.cachedResult;
  }

  progress(): Nut16DecoderProgress {
    const expected = this.accumulator.expectedPartCount();
    const estimatedCompletion = this.cachedResult !== null
      ? 1
      : this.accumulator.estimatedPercentComplete();
    return {
      receivedCount: this.accepted,
      estimatedTotal: expected,
      estimatedCompletion,
    };
  }

  reset(): void {
    this.accumulator = createAccumulator();
    this.accepted = 0;
    this.cachedResult = null;
  }
}

export function createDecoder(): Nut16Decoder {
  return new Nut16DecoderImpl();
}
