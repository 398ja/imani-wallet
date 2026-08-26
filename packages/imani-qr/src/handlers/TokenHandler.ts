import { CASHU_A_PREFIX, CASHU_B_PREFIX, CASHU_URI_PREFIX } from '../detector/patterns';
import type { QrHandler } from '../types/handlers';

export interface TokenData {
  token: string;
  variant: 'cashuA' | 'cashuB';
}

export class TokenHandler implements QrHandler<TokenData> {
  validate(text: string): boolean {
    if (!text) return false;
    const normalized = this.normalize(text);
    return (
      normalized.toLowerCase().startsWith(CASHU_A_PREFIX) ||
      normalized.toLowerCase().startsWith(CASHU_B_PREFIX)
    );
  }

  async parse(text: string): Promise<TokenData> {
    const normalized = this.normalize(text);
    const lower = normalized.toLowerCase();
    const variant = lower.startsWith(CASHU_A_PREFIX) ? 'cashuA' : 'cashuB';
    return { token: normalized, variant };
  }

  getParams(parsed: TokenData): Record<string, unknown> {
    return { token: parsed.token };
  }

  private normalize(text: string): string {
    const trimmed = text?.trim() ?? '';
    return trimmed.toLowerCase().startsWith(CASHU_URI_PREFIX)
      ? trimmed.slice(CASHU_URI_PREFIX.length)
      : trimmed;
  }
}
