import { NPUB_PREFIX, NIP05_PATTERN, NOSTR_URI_PREFIX } from '../detector/patterns';
import type { QrHandler } from '../types/handlers';

export interface IdentityData {
  identifier: string;
  kind: 'npub' | 'nip05';
}

export class IdentityHandler implements QrHandler<IdentityData> {
  validate(text: string): boolean {
    if (!text) return false;
    const normalized = this.normalize(text);
    return normalized.toLowerCase().startsWith(NPUB_PREFIX) || NIP05_PATTERN.test(normalized);
  }

  async parse(text: string): Promise<IdentityData> {
    const normalized = this.normalize(text);
    const isNpub = normalized.toLowerCase().startsWith(NPUB_PREFIX);
    return {
      identifier: normalized,
      kind: isNpub ? 'npub' : 'nip05'
    };
  }

  getParams(parsed: IdentityData): Record<string, unknown> {
    return { identifier: parsed.identifier };
  }

  private normalize(text: string): string {
    const trimmed = text?.trim() ?? '';
    return trimmed.toLowerCase().startsWith(NOSTR_URI_PREFIX)
      ? trimmed.slice(NOSTR_URI_PREFIX.length)
      : trimmed;
  }
}
