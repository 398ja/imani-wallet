/**
 * Core Module Tests
 *
 * Tests for SendConfig, EventEmitter, and errors.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SendConfig,
  TypedEventEmitter,
  createEventEmitter,
  VoucherSendError,
  ErrorCodes,
} from '../src/core';

describe('SendConfig', () => {
  describe('constructor', () => {
    it('should create config with defaults', () => {
      const config = new SendConfig();

      expect(config.chunking.enabled).toBe(true);
      expect(config.chunking.threshold).toBe(40_000);
      expect(config.chunking.chunkSize).toBe(30_000);
      expect(config.relay.maxRelays).toBe(5);
      expect(config.nip60.enabled).toBe(false);
      expect(config.defaultNip05Domain).toBe('imani.casa');
      expect(config.timeout).toBe(30_000);
      expect(config.debug).toBe(false);
    });

    it('should merge custom options with defaults', () => {
      const config = new SendConfig({
        chunking: { threshold: 50_000 },
        relay: { infraRelay: 'wss://relay.test.com' },
        debug: true,
      });

      expect(config.chunking.threshold).toBe(50_000);
      expect(config.chunking.enabled).toBe(true); // default preserved
      expect(config.relay.infraRelay).toBe('wss://relay.test.com');
      expect(config.debug).toBe(true);
    });
  });

  describe('static create', () => {
    it('should create config instance', () => {
      const config = SendConfig.create({ debug: true });
      expect(config).toBeInstanceOf(SendConfig);
      expect(config.debug).toBe(true);
    });
  });

  describe('getInfraRelay', () => {
    it('should return infra relay if configured', () => {
      const config = new SendConfig({
        relay: { infraRelay: 'wss://infra.test.com' },
      });
      expect(config.getInfraRelay()).toBe('wss://infra.test.com');
    });

    it('should return undefined if not configured', () => {
      const config = new SendConfig();
      expect(config.getInfraRelay()).toBeUndefined();
    });
  });

  describe('getDefaultRelays', () => {
    it('should include infra relay first', () => {
      const config = new SendConfig({
        relay: {
          infraRelay: 'wss://infra.test.com',
          defaultRelays: ['wss://relay1.com', 'wss://relay2.com'],
        },
      });

      const relays = config.getDefaultRelays();

      expect(relays[0]).toBe('wss://infra.test.com');
      expect(relays).toContain('wss://relay1.com');
      expect(relays).toContain('wss://relay2.com');
    });

    it('should return empty array if no relays configured', () => {
      const config = new SendConfig();
      expect(config.getDefaultRelays()).toEqual([]);
    });
  });

  describe('shouldChunk', () => {
    it('should return true for large sizes', () => {
      const config = new SendConfig();
      // 40KB * 1.4 = 56KB > 40KB threshold
      expect(config.shouldChunk(40_000)).toBe(true);
    });

    it('should return false for small sizes', () => {
      const config = new SendConfig();
      // 20KB * 1.4 = 28KB < 40KB threshold
      expect(config.shouldChunk(20_000)).toBe(false);
    });

    it('should return false if chunking disabled', () => {
      const config = new SendConfig({ chunking: { enabled: false } });
      expect(config.shouldChunk(100_000)).toBe(false);
    });
  });

  describe('log', () => {
    it('should log when debug enabled', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const config = new SendConfig({ debug: true });

      config.log('Test message', { data: 123 });

      expect(consoleSpy).toHaveBeenCalledWith('[VoucherSend]', 'Test message', { data: 123 });
      consoleSpy.mockRestore();
    });

    it('should not log when debug disabled', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const config = new SendConfig({ debug: false });

      config.log('Test message');

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});

describe('TypedEventEmitter', () => {
  describe('on/emit', () => {
    it('should emit events to subscribers', () => {
      const emitter = new TypedEventEmitter();
      const handler = vi.fn();

      emitter.on('send:start', handler);
      emitter.emit('send:start', { params: { amount: 100, recipient: 'test' } });

      expect(handler).toHaveBeenCalledWith({ params: { amount: 100, recipient: 'test' } });
    });

    it('should support multiple handlers', () => {
      const emitter = new TypedEventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('send:complete', handler1);
      emitter.on('send:complete', handler2);
      emitter.emit('send:complete', { result: {} } as any);

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('should return unsubscribe function', () => {
      const emitter = new TypedEventEmitter();
      const handler = vi.fn();

      const unsubscribe = emitter.on('send:start', handler);
      unsubscribe();
      emitter.emit('send:start', { params: { amount: 100, recipient: 'test' } });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('once', () => {
    it('should only fire once', () => {
      const emitter = new TypedEventEmitter();
      const handler = vi.fn();

      emitter.once('dm:sent', handler);
      emitter.emit('dm:sent', { eventId: '1', recipientPubkey: 'abc', sentAt: '', relaysUsed: [] });
      emitter.emit('dm:sent', { eventId: '2', recipientPubkey: 'abc', sentAt: '', relaysUsed: [] });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ eventId: '1' }));
    });
  });

  describe('off', () => {
    it('should remove specific handler', () => {
      const emitter = new TypedEventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('send:error', handler1);
      emitter.on('send:error', handler2);
      emitter.off('send:error', handler1);
      emitter.emit('send:error', { error: new Error('test'), stage: 'validating' });

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('should remove all handlers if no handler specified', () => {
      const emitter = new TypedEventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('send:error', handler1);
      emitter.on('send:error', handler2);
      emitter.off('send:error');
      emitter.emit('send:error', { error: new Error('test'), stage: 'validating' });

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });
  });

  describe('removeAllListeners', () => {
    it('should remove all event handlers', () => {
      const emitter = new TypedEventEmitter();
      emitter.on('send:start', vi.fn());
      emitter.on('send:complete', vi.fn());

      emitter.removeAllListeners();

      expect(emitter.listenerCount('send:start')).toBe(0);
      expect(emitter.listenerCount('send:complete')).toBe(0);
    });
  });

  describe('listenerCount', () => {
    it('should return number of listeners', () => {
      const emitter = new TypedEventEmitter();

      expect(emitter.listenerCount('send:start')).toBe(0);

      emitter.on('send:start', vi.fn());
      emitter.on('send:start', vi.fn());

      expect(emitter.listenerCount('send:start')).toBe(2);
    });
  });

  describe('eventNames', () => {
    it('should return array of event names', () => {
      const emitter = new TypedEventEmitter();
      emitter.on('send:start', vi.fn());
      emitter.on('send:complete', vi.fn());

      const names = emitter.eventNames();

      expect(names).toContain('send:start');
      expect(names).toContain('send:complete');
    });
  });

  describe('error handling', () => {
    it('should catch and log handler errors', () => {
      const emitter = new TypedEventEmitter();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const goodHandler = vi.fn();

      emitter.on('send:start', () => {
        throw new Error('Handler error');
      });
      emitter.on('send:start', goodHandler);

      emitter.emit('send:start', { params: { amount: 100, recipient: 'test' } });

      expect(errorSpy).toHaveBeenCalled();
      expect(goodHandler).toHaveBeenCalled(); // Other handlers still run
      errorSpy.mockRestore();
    });
  });
});

describe('createEventEmitter', () => {
  it('should create new emitter instance', () => {
    const emitter = createEventEmitter();
    expect(emitter).toBeInstanceOf(TypedEventEmitter);
  });
});

describe('VoucherSendError', () => {
  describe('constructor', () => {
    it('should create error with code and details', () => {
      const error = new VoucherSendError(
        'Test error',
        ErrorCodes.INSUFFICIENT_BALANCE,
        { required: 100, available: 50 }
      );

      expect(error.message).toBe('Test error');
      expect(error.code).toBe(ErrorCodes.INSUFFICIENT_BALANCE);
      expect(error.details.required).toBe(100);
      expect(error.details.available).toBe(50);
      expect(error.name).toBe('VoucherSendError');
    });
  });

  describe('static factory methods', () => {
    it('insufficientBalance should create proper error', () => {
      const error = VoucherSendError.insufficientBalance(100, 50, 'EUR');

      expect(error.code).toBe(ErrorCodes.INSUFFICIENT_BALANCE);
      expect(error.message).toContain('100 EUR');
      expect(error.message).toContain('50 EUR');
    });

    it('voucherNotFound should create proper error', () => {
      const error = VoucherSendError.voucherNotFound('voucher-123');

      expect(error.code).toBe(ErrorCodes.VOUCHER_NOT_FOUND);
      expect(error.details.voucherId).toBe('voucher-123');
    });

    it('merchantNotFound should create proper error', () => {
      const error = VoucherSendError.merchantNotFound('merchant-abc');

      expect(error.code).toBe(ErrorCodes.MERCHANT_NOT_FOUND);
      expect(error.details.merchantId).toBe('merchant-abc');
    });

    it('noVoucherWithBalance should create proper error', () => {
      const error = VoucherSendError.noVoucherWithBalance(100, 50, 'EUR');

      expect(error.code).toBe(ErrorCodes.NO_VOUCHER_WITH_BALANCE);
      expect(error.message).toContain('100 EUR');
      expect(error.message).toContain('50 EUR');
    });

    it('swapRequired should create proper error', () => {
      const error = VoucherSendError.swapRequired(10, 50);

      expect(error.code).toBe(ErrorCodes.SWAP_REQUIRED);
      expect(error.message).toContain('10');
      expect(error.message).toContain('50');
    });

    it('recipientNotFound should create proper error', () => {
      const error = VoucherSendError.recipientNotFound('alice@example.com');

      expect(error.code).toBe(ErrorCodes.RECIPIENT_NOT_FOUND);
      expect(error.details.recipient).toBe('alice@example.com');
    });

    it('nip05Failed should create proper error', () => {
      const error = VoucherSendError.nip05Failed('alice@example.com', 'DNS error');

      expect(error.code).toBe(ErrorCodes.NIP05_RESOLUTION_FAILED);
      expect(error.message).toContain('DNS error');
    });

    it('dmSendFailed should create proper error', () => {
      const cause = new Error('Network error');
      const error = VoucherSendError.dmSendFailed('Connection refused', cause);

      expect(error.code).toBe(ErrorCodes.DM_SEND_FAILED);
      expect(error.details.cause).toBe(cause);
    });

    it('paymentRequestExpired should create proper error', () => {
      const error = VoucherSendError.paymentRequestExpired();

      expect(error.code).toBe(ErrorCodes.PAYMENT_REQUEST_EXPIRED);
    });

    it('paymentRequestInvalid should create proper error', () => {
      const error = VoucherSendError.paymentRequestInvalid('Invalid format');

      expect(error.code).toBe(ErrorCodes.PAYMENT_REQUEST_INVALID);
      expect(error.message).toContain('Invalid format');
    });

    it('timeout should create proper error', () => {
      const error = VoucherSendError.timeout('split');

      expect(error.code).toBe(ErrorCodes.TIMEOUT);
      expect(error.details.stage).toBe('split');
    });
  });

  describe('toJSON', () => {
    it('should serialize error to plain object', () => {
      const error = VoucherSendError.insufficientBalance(100, 50, 'EUR');
      const json = error.toJSON();

      expect(json.name).toBe('VoucherSendError');
      expect(json.code).toBe(ErrorCodes.INSUFFICIENT_BALANCE);
      expect(json.message).toBeDefined();
      expect(json.details).toBeDefined();
    });
  });
});
