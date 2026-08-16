import { describe, expect, it } from 'vitest';

import { QrTypeDetector } from '../../src/detector/QrTypeDetector';
import { QrType } from '../../src/detector/types';
import { UR_FRAGMENT_PATTERN } from '../../src/nut16/types';

describe('UR_FRAGMENT_PATTERN', () => {
  it.each([
    'ur:bytes/1-5/aaaaaaaa',
    'ur:bytes/3-7/abcdef',
    'ur:bytes/12-12/xxxxxxxx',
    'UR:BYTES/1-1/yyyyyyy',
    'Ur:Bytes/1-9/zzzz',
    'ur:bytes/singlepartwords',
  ])('matches UR fragment: %s', (input) => {
    expect(UR_FRAGMENT_PATTERN.test(input)).toBe(true);
  });

  it.each([
    'cashuBo2F0gaJhaUgArvSFnZG9JmFwgaNhYRhAYXNYI',
    'nostr:npub1abc',
    'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq2',
    '',
    'http://example.com/ur:bytes/1-5/abc',
    'ur:custom/1-5/abc',
  ])('rejects non-UR-bytes string: %s', (input) => {
    expect(UR_FRAGMENT_PATTERN.test(input)).toBe(false);
  });
});

describe('QrTypeDetector with UR_FRAGMENT registered', () => {
  it('returns QrType.UR_FRAGMENT for a UR fragment string', () => {
    const detector = new QrTypeDetector();
    const result = detector.detect('ur:bytes/2-7/some-bytewords');
    expect(result.type).toBe(QrType.UR_FRAGMENT);
  });

  it('returns QrType.CASHU_TOKEN for a cashuB string (no regression)', () => {
    const detector = new QrTypeDetector();
    const result = detector.detect('cashuBo2F0gaJhaUgArvSFnZG9JmFwgaNhYRhAYXNY');
    expect(result.type).toBe(QrType.CASHU_TOKEN);
  });

  it('returns QrType.NPUB for an npub string (no regression)', () => {
    const detector = new QrTypeDetector();
    const validNpub = 'npub1' + 'q'.repeat(58);
    const result = detector.detect(validNpub);
    expect(result.type).toBe(QrType.NPUB);
  });

  it('returns QrType.NIP05 for a NIP-05 string (no regression)', () => {
    const detector = new QrTypeDetector();
    const result = detector.detect('alice@example.com');
    expect(result.type).toBe(QrType.NIP05);
  });

  it('returns QrType.PAYMENT_REQUEST for a vreqa string (no regression)', () => {
    const detector = new QrTypeDetector();
    const result = detector.detect('vreqaSomeRequestPayload');
    expect(result.type).toBe(QrType.PAYMENT_REQUEST);
  });

  it('returns QrType.UNKNOWN for an unrelated string (no regression)', () => {
    const detector = new QrTypeDetector();
    const result = detector.detect('hello world');
    expect(result.type).toBe(QrType.UNKNOWN);
  });
});
