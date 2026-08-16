import {
  CASHU_URI_PREFIX,
  DEFAULT_PATTERNS,
  NOSTR_URI_PREFIX,
  TYPE_DESCRIPTIONS,
  extractEmbeddedCashuToken
} from './patterns';
import { QrType, type DetectionResult, type QrTypeValue } from './types';

type PatternMap = Partial<Record<QrTypeValue, RegExp>>;

export class QrTypeDetector {
  private patterns: Map<QrTypeValue, RegExp>;
  private descriptions: Map<QrTypeValue, string>;

  constructor(customPatterns: PatternMap = {}) {
    this.patterns = new Map<QrTypeValue, RegExp>([
      ...(Object.entries(DEFAULT_PATTERNS) as [QrTypeValue, RegExp][]),
      ...(Object.entries(customPatterns) as [QrTypeValue, RegExp][])
    ]);

    this.descriptions = new Map<QrTypeValue, string>(
      Object.entries(TYPE_DESCRIPTIONS) as [QrTypeValue, string][]
    );
  }

  detect(text: string): DetectionResult<QrTypeValue> {
    if (typeof text !== 'string') {
      return { type: QrType.UNKNOWN, raw: String(text ?? ''), normalized: '' };
    }

    const raw = text.trim();
    if (!raw) {
      return { type: QrType.UNKNOWN, raw: '', normalized: '' };
    }

    const normalized = this.stripPrefix(raw);
    const type = this.getType(normalized);

    // Spec 035 US1 FR-003 — Cashu-token-in-URL extraction.
    // When the standard pattern match returns UNKNOWN (typical for a
    // scanned URL), try extracting a single embedded cashu token from the
    // URL's query / fragment. If exactly one is found, treat the scan as a
    // CASHU_TOKEN with `normalized` set to the extracted inner token, so
    // downstream routing never carries the long outer URL (HTTP 414).
    if (type === QrType.UNKNOWN) {
      const embedded = extractEmbeddedCashuToken(raw);
      if (embedded) {
        return { type: QrType.CASHU_TOKEN, raw, normalized: embedded };
      }
    }

    return { type, raw, normalized };
  }

  getType(text: string): QrTypeValue {
    if (typeof text !== 'string') {
      return QrType.UNKNOWN;
    }

    const normalized = this.stripPrefix(text);

    for (const [type, pattern] of this.patterns.entries()) {
      if (pattern.test(normalized)) {
        return type;
      }
    }

    return QrType.UNKNOWN;
  }

  validate(text: string, type: QrTypeValue): boolean {
    const pattern = this.patterns.get(type);
    if (!pattern || typeof text !== 'string') {
      return false;
    }

    const normalized = this.stripPrefix(text);
    return pattern.test(normalized);
  }

  getDescription(type: QrTypeValue): string {
    return this.descriptions.get(type) ?? TYPE_DESCRIPTIONS[QrType.UNKNOWN];
  }

  stripPrefix(text: string): string {
    if (typeof text !== 'string') {
      return '';
    }

    const trimmed = text.trim();
    const prefixPattern = new RegExp(`^(${CASHU_URI_PREFIX}|${NOSTR_URI_PREFIX})`, 'i');
    return trimmed.replace(prefixPattern, '');
  }

  registerPattern(type: QrTypeValue, pattern: RegExp): void {
    this.patterns.set(type, pattern);
  }
}
