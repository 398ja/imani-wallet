import { describe, expect, it, beforeEach } from 'vitest';
import {
  QrType,
  QrTypeDetector,
  detect,
  isCashuToken,
  isNip05,
  isNpub,
  isPaymentRequest
} from '../src/detector';

describe('QrTypeDetector', () => {
  let detector: QrTypeDetector;

  beforeEach(() => {
    detector = new QrTypeDetector();
  });

  it('detects payment requests with vreqA prefix', () => {
    const direct = detector.detect('vreqA123');
    expect(direct.type).toBe(QrType.PAYMENT_REQUEST);
    expect(direct.normalized).toBe('vreqA123');

    const uri = detector.detect('cashu:vreqA456');
    expect(uri.type).toBe(QrType.PAYMENT_REQUEST);
    expect(uri.normalized).toBe('vreqA456');
  });

  it('detects cashu tokens with or without cashu: prefix', () => {
    const tokenA = detector.detect('cashuAey...');
    expect(tokenA.type).toBe(QrType.CASHU_TOKEN);
    expect(tokenA.normalized).toBe('cashuAey...');

    const tokenB = detector.detect('cashu:cashuBxyz');
    expect(tokenB.type).toBe(QrType.CASHU_TOKEN);
    expect(tokenB.normalized).toBe('cashuBxyz');
  });

  it('detects npub keys and strips nostr: prefix', () => {
    const npub = `npub1${'a'.repeat(58)}`;
    const direct = detector.detect(npub);
    expect(direct.type).toBe(QrType.NPUB);
    expect(direct.normalized).toBe(npub);

    const prefixed = detector.detect(`nostr:${npub}`);
    expect(prefixed.type).toBe(QrType.NPUB);
    expect(prefixed.normalized).toBe(npub);
  });

  it('detects NIP-05 identifiers', () => {
    const nip05 = detector.detect('user@example.com');
    expect(nip05.type).toBe(QrType.NIP05);
    expect(nip05.normalized).toBe('user@example.com');
  });

  it('returns unknown for unsupported content', () => {
    const unknown = detector.detect('hello world');
    expect(unknown.type).toBe(QrType.UNKNOWN);
    expect(unknown.normalized).toBe('hello world');
  });

  it('supports registering custom patterns', () => {
    const lnurlType = 'lnurl';
    detector.registerPattern(lnurlType, /^lnurl[a-z0-9]+$/i);

    const result = detector.detect('lnurl12345');
    expect(result.type).toBe(lnurlType);
    expect(result.normalized).toBe('lnurl12345');
  });

  it('exposes helper validators', () => {
    expect(isPaymentRequest('cashu:vreqA123')).toBe(true);
    expect(isCashuToken('cashu:cashuB...')).toBe(true);
    expect(isNpub(`npub1${'b'.repeat(58)}`)).toBe(true);
    expect(isNip05('name@domain.tld')).toBe(true);
  });

  it('provides a default detector helper', () => {
    const result = detect('cashuAexample');
    expect(result.type).toBe(QrType.CASHU_TOKEN);
  });

  it('strips supported URI prefixes', () => {
    expect(detector.stripPrefix('cashu:npub1abc')).toBe('npub1abc');
    expect(detector.stripPrefix('nostr:npub1abc')).toBe('npub1abc');
    expect(detector.stripPrefix('   nostr:npub1abc   ')).toBe('npub1abc');
  });
});
