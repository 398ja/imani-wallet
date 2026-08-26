import { VREQ_PREFIX, CASHU_URI_PREFIX } from '../detector/patterns';
import type { QrHandler } from '../types/handlers';

export interface PaymentRequestData {
  request: string;
  parsed?: unknown;
  error?: string;
}

export class PaymentRequestHandler implements QrHandler<PaymentRequestData> {
  validate(text: string): boolean {
    if (!text) return false;
    const lower = text.trim().toLowerCase();
    const normalized = lower.startsWith(CASHU_URI_PREFIX)
      ? lower.slice(CASHU_URI_PREFIX.length)
      : lower;
    return normalized.startsWith(VREQ_PREFIX);
  }

  async parse(text: string): Promise<PaymentRequestData> {
    const normalized = this.normalize(text);
    const result: PaymentRequestData = { request: normalized };

    const nut = (globalThis as unknown as { NUT18V?: { parse?: (str: string) => unknown } }).NUT18V;
    if (nut?.parse) {
      try {
        result.parsed = nut.parse(normalized);
      } catch (error) {
        result.error = error instanceof Error ? error.message : 'Failed to parse payment request';
      }
    }

    return result;
  }

  getParams(parsed: PaymentRequestData): Record<string, unknown> {
    return { paymentRequest: parsed.request };
  }

  private normalize(text: string): string {
    if (!text) return '';
    const trimmed = text.trim();
    return trimmed.toLowerCase().startsWith(CASHU_URI_PREFIX)
      ? trimmed.slice(CASHU_URI_PREFIX.length)
      : trimmed;
  }
}
