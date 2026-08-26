import { createDecoder } from './decoder';
import type { Nut16Decoder, Nut16ScanEvent } from './types';

export type Nut16ScanProcessorResult =
  | { kind: 'fragment'; events: Nut16ScanEvent[] }
  | { kind: 'reconstructed'; cashuBToken: string; events: Nut16ScanEvent[] };

export class Nut16ScanProcessor {
  private decoder: Nut16Decoder = createDecoder();

  process(fragment: string): Nut16ScanProcessorResult {
    const events: Nut16ScanEvent[] = [];
    const status = this.decoder.receive(fragment);

    switch (status.kind) {
      case 'progress':
        events.push({ kind: 'fragment-accepted', progress: status.progress });
        return { kind: 'fragment', events };
      case 'complete': {
        events.push({
          kind: 'fragment-accepted',
          progress: this.decoder.progress(),
        });
        const token = this.decoder.result();
        events.push({ kind: 'reconstruction-complete', cashuBToken: token });
        this.decoder.reset();
        return { kind: 'reconstructed', cashuBToken: token, events };
      }
      case 'ignored':
        events.push({ kind: 'fragment-ignored', reason: status.reason });
        return { kind: 'fragment', events };
      case 'error':
        events.push({
          kind: 'reconstruction-error',
          code: status.code,
          message: status.message,
        });
        return { kind: 'fragment', events };
    }
  }

  reset(): Nut16ScanEvent[] {
    this.decoder.reset();
    return [{ kind: 'decoder-reset' }];
  }
}
