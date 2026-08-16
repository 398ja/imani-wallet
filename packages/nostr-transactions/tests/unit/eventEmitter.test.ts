/**
 * Tests for TypedEventEmitter
 */

import { describe, it, expect, vi } from 'vitest';
import { TypedEventEmitter, createEventEmitter } from '../../src';

describe('TypedEventEmitter', () => {
  describe('on()', () => {
    it('should subscribe to events', () => {
      const emitter = createEventEmitter();
      const handler = vi.fn();

      emitter.on('transaction:added', handler);
      emitter.emit('transaction:added', { transaction: {} as any });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should call handler with payload', () => {
      const emitter = createEventEmitter();
      const handler = vi.fn();
      const transaction = { id: 'tx-123' };

      emitter.on('transaction:added', handler);
      emitter.emit('transaction:added', { transaction } as any);

      expect(handler).toHaveBeenCalledWith({ transaction });
    });

    it('should allow multiple handlers', () => {
      const emitter = createEventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('transaction:added', handler1);
      emitter.on('transaction:added', handler2);
      emitter.emit('transaction:added', { transaction: {} as any });

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('should return unsubscribe function', () => {
      const emitter = createEventEmitter();
      const handler = vi.fn();

      const unsubscribe = emitter.on('transaction:added', handler);
      unsubscribe();
      emitter.emit('transaction:added', { transaction: {} as any });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('once()', () => {
    it('should only call handler once', () => {
      const emitter = createEventEmitter();
      const handler = vi.fn();

      emitter.once('transaction:added', handler);
      emitter.emit('transaction:added', { transaction: {} as any });
      emitter.emit('transaction:added', { transaction: {} as any });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should return unsubscribe function', () => {
      const emitter = createEventEmitter();
      const handler = vi.fn();

      const unsubscribe = emitter.once('transaction:added', handler);
      unsubscribe();
      emitter.emit('transaction:added', { transaction: {} as any });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('off()', () => {
    it('should unsubscribe handler', () => {
      const emitter = createEventEmitter();
      const handler = vi.fn();

      emitter.on('transaction:added', handler);
      emitter.off('transaction:added', handler);
      emitter.emit('transaction:added', { transaction: {} as any });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should not affect other handlers', () => {
      const emitter = createEventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('transaction:added', handler1);
      emitter.on('transaction:added', handler2);
      emitter.off('transaction:added', handler1);
      emitter.emit('transaction:added', { transaction: {} as any });

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });
  });

  describe('emit()', () => {
    it('should not throw for event with no handlers', () => {
      const emitter = createEventEmitter();

      expect(() => {
        emitter.emit('transaction:added', { transaction: {} as any });
      }).not.toThrow();
    });

    it('should catch handler errors', () => {
      const emitter = createEventEmitter();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const errorHandler = vi.fn(() => {
        throw new Error('Handler error');
      });
      const goodHandler = vi.fn();

      emitter.on('transaction:added', errorHandler);
      emitter.on('transaction:added', goodHandler);
      emitter.emit('transaction:added', { transaction: {} as any });

      // Error handler threw but good handler still called
      expect(goodHandler).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('removeAllListeners()', () => {
    it('should remove all listeners for specific event', () => {
      const emitter = createEventEmitter();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('transaction:added', handler1);
      emitter.on('transaction:added', handler2);
      emitter.removeAllListeners('transaction:added');
      emitter.emit('transaction:added', { transaction: {} as any });

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });

    it('should not affect other events', () => {
      const emitter = createEventEmitter();
      const addedHandler = vi.fn();
      const deletedHandler = vi.fn();

      emitter.on('transaction:added', addedHandler);
      emitter.on('transaction:deleted', deletedHandler);
      emitter.removeAllListeners('transaction:added');

      emitter.emit('transaction:added', { transaction: {} as any });
      emitter.emit('transaction:deleted', { id: 'tx-123' });

      expect(addedHandler).not.toHaveBeenCalled();
      expect(deletedHandler).toHaveBeenCalled();
    });

    it('should remove all listeners when no event specified', () => {
      const emitter = createEventEmitter();
      const addedHandler = vi.fn();
      const deletedHandler = vi.fn();

      emitter.on('transaction:added', addedHandler);
      emitter.on('transaction:deleted', deletedHandler);
      emitter.removeAllListeners();

      emitter.emit('transaction:added', { transaction: {} as any });
      emitter.emit('transaction:deleted', { id: 'tx-123' });

      expect(addedHandler).not.toHaveBeenCalled();
      expect(deletedHandler).not.toHaveBeenCalled();
    });
  });

  describe('listenerCount()', () => {
    it('should return 0 for event with no listeners', () => {
      const emitter = createEventEmitter();
      expect(emitter.listenerCount('transaction:added')).toBe(0);
    });

    it('should return correct count', () => {
      const emitter = createEventEmitter();
      emitter.on('transaction:added', () => {});
      emitter.on('transaction:added', () => {});
      emitter.on('transaction:added', () => {});

      expect(emitter.listenerCount('transaction:added')).toBe(3);
    });

    it('should decrease after unsubscribe', () => {
      const emitter = createEventEmitter();
      const handler = () => {};

      emitter.on('transaction:added', handler);
      expect(emitter.listenerCount('transaction:added')).toBe(1);

      emitter.off('transaction:added', handler);
      expect(emitter.listenerCount('transaction:added')).toBe(0);
    });
  });

  describe('event types', () => {
    it('should handle sync events', () => {
      const emitter = createEventEmitter();
      const handler = vi.fn();

      emitter.on('sync:started', handler);
      emitter.emit('sync:started', { direction: 'push', timestamp: Date.now() });

      expect(handler).toHaveBeenCalled();
    });

    it('should handle store events', () => {
      const emitter = createEventEmitter();
      const handler = vi.fn();

      emitter.on('store:opened', handler);
      emitter.emit('store:opened', { dbName: 'test', version: 1 });

      expect(handler).toHaveBeenCalled();
    });
  });
});
