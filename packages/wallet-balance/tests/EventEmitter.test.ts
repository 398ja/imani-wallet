/**
 * TypedEventEmitter Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { TypedEventEmitter } from '../src/utils/EventEmitter';

// Define a test event map
type TestEvents = {
  ping: { value: number };
  pong: { message: string };
  empty: undefined;
};

function createEmitter(): TypedEventEmitter<TestEvents> {
  return new TypedEventEmitter<TestEvents>();
}

describe('TypedEventEmitter', () => {
  describe('on / emit', () => {
    it('should call listener when event is emitted', () => {
      const emitter = createEmitter();
      const listener = vi.fn();

      emitter.on('ping', listener);
      emitter.emit('ping', { value: 42 });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith({ value: 42 });
    });

    it('should support multiple listeners on the same event', () => {
      const emitter = createEmitter();
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      emitter.on('ping', listener1);
      emitter.on('ping', listener2);
      emitter.emit('ping', { value: 1 });

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it('should not call listener for different events', () => {
      const emitter = createEmitter();
      const pingListener = vi.fn();
      const pongListener = vi.fn();

      emitter.on('ping', pingListener);
      emitter.on('pong', pongListener);
      emitter.emit('ping', { value: 1 });

      expect(pingListener).toHaveBeenCalledOnce();
      expect(pongListener).not.toHaveBeenCalled();
    });

    it('should call listener on every emit', () => {
      const emitter = createEmitter();
      const listener = vi.fn();

      emitter.on('ping', listener);
      emitter.emit('ping', { value: 1 });
      emitter.emit('ping', { value: 2 });
      emitter.emit('ping', { value: 3 });

      expect(listener).toHaveBeenCalledTimes(3);
      expect(listener).toHaveBeenNthCalledWith(1, { value: 1 });
      expect(listener).toHaveBeenNthCalledWith(3, { value: 3 });
    });

    it('should not throw when emitting with no listeners', () => {
      const emitter = createEmitter();
      expect(() => emitter.emit('ping', { value: 1 })).not.toThrow();
    });
  });

  describe('on return value (unsubscribe)', () => {
    it('should return an unsubscribe function', () => {
      const emitter = createEmitter();
      const listener = vi.fn();

      const unsub = emitter.on('ping', listener);
      unsub();

      emitter.emit('ping', { value: 1 });
      expect(listener).not.toHaveBeenCalled();
    });

    it('should only unsubscribe the specific listener', () => {
      const emitter = createEmitter();
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      const unsub1 = emitter.on('ping', listener1);
      emitter.on('ping', listener2);
      unsub1();

      emitter.emit('ping', { value: 1 });
      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalledOnce();
    });
  });

  describe('once', () => {
    it('should call listener only once', () => {
      const emitter = createEmitter();
      const listener = vi.fn();

      emitter.once('ping', listener);
      emitter.emit('ping', { value: 1 });
      emitter.emit('ping', { value: 2 });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith({ value: 1 });
    });

    it('should return an unsubscribe function that works before emit', () => {
      const emitter = createEmitter();
      const listener = vi.fn();

      const unsub = emitter.once('ping', listener);
      unsub();

      emitter.emit('ping', { value: 1 });
      expect(listener).not.toHaveBeenCalled();
    });

    it('should work alongside regular listeners', () => {
      const emitter = createEmitter();
      const onceListener = vi.fn();
      const regularListener = vi.fn();

      emitter.once('ping', onceListener);
      emitter.on('ping', regularListener);

      emitter.emit('ping', { value: 1 });
      emitter.emit('ping', { value: 2 });

      expect(onceListener).toHaveBeenCalledOnce();
      expect(regularListener).toHaveBeenCalledTimes(2);
    });
  });

  describe('off', () => {
    it('should remove a regular listener', () => {
      const emitter = createEmitter();
      const listener = vi.fn();

      emitter.on('ping', listener);
      emitter.off('ping', listener);
      emitter.emit('ping', { value: 1 });

      expect(listener).not.toHaveBeenCalled();
    });

    it('should remove a once listener', () => {
      const emitter = createEmitter();
      const listener = vi.fn();

      emitter.once('ping', listener);
      emitter.off('ping', listener);
      emitter.emit('ping', { value: 1 });

      expect(listener).not.toHaveBeenCalled();
    });

    it('should not throw when removing non-existent listener', () => {
      const emitter = createEmitter();
      const listener = vi.fn();
      expect(() => emitter.off('ping', listener)).not.toThrow();
    });
  });

  describe('removeAllListeners', () => {
    it('should remove all listeners for a specific event', () => {
      const emitter = createEmitter();
      const pingListener = vi.fn();
      const pongListener = vi.fn();

      emitter.on('ping', pingListener);
      emitter.on('pong', pongListener);
      emitter.removeAllListeners('ping');

      emitter.emit('ping', { value: 1 });
      emitter.emit('pong', { message: 'hi' });

      expect(pingListener).not.toHaveBeenCalled();
      expect(pongListener).toHaveBeenCalledOnce();
    });

    it('should remove all listeners for all events when no arg', () => {
      const emitter = createEmitter();
      const pingListener = vi.fn();
      const pongListener = vi.fn();

      emitter.on('ping', pingListener);
      emitter.on('pong', pongListener);
      emitter.removeAllListeners();

      emitter.emit('ping', { value: 1 });
      emitter.emit('pong', { message: 'hi' });

      expect(pingListener).not.toHaveBeenCalled();
      expect(pongListener).not.toHaveBeenCalled();
    });

    it('should remove once listeners too', () => {
      const emitter = createEmitter();
      const listener = vi.fn();

      emitter.once('ping', listener);
      emitter.removeAllListeners('ping');
      emitter.emit('ping', { value: 1 });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('listenerCount', () => {
    it('should return 0 for no listeners', () => {
      const emitter = createEmitter();
      expect(emitter.listenerCount('ping')).toBe(0);
    });

    it('should count regular listeners', () => {
      const emitter = createEmitter();
      emitter.on('ping', () => {});
      emitter.on('ping', () => {});
      expect(emitter.listenerCount('ping')).toBe(2);
    });

    it('should count once listeners', () => {
      const emitter = createEmitter();
      emitter.once('ping', () => {});
      expect(emitter.listenerCount('ping')).toBe(1);
    });

    it('should count both regular and once listeners', () => {
      const emitter = createEmitter();
      emitter.on('ping', () => {});
      emitter.once('ping', () => {});
      expect(emitter.listenerCount('ping')).toBe(2);
    });

    it('should decrease after unsubscribe', () => {
      const emitter = createEmitter();
      const unsub = emitter.on('ping', () => {});
      expect(emitter.listenerCount('ping')).toBe(1);
      unsub();
      expect(emitter.listenerCount('ping')).toBe(0);
    });
  });

  describe('eventNames', () => {
    it('should return empty array when no listeners', () => {
      const emitter = createEmitter();
      expect(emitter.eventNames()).toEqual([]);
    });

    it('should return event names with active listeners', () => {
      const emitter = createEmitter();
      emitter.on('ping', () => {});
      emitter.on('pong', () => {});

      const names = emitter.eventNames();
      expect(names).toContain('ping');
      expect(names).toContain('pong');
      expect(names).toHaveLength(2);
    });

    it('should include once listeners', () => {
      const emitter = createEmitter();
      emitter.once('ping', () => {});

      expect(emitter.eventNames()).toContain('ping');
    });

    it('should exclude events after all listeners removed', () => {
      const emitter = createEmitter();
      const unsub = emitter.on('ping', () => {});
      unsub();

      expect(emitter.eventNames()).not.toContain('ping');
    });
  });

  describe('error isolation', () => {
    it('should not halt other listeners when one throws', () => {
      const emitter = createEmitter();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const listener1 = vi.fn(() => { throw new Error('boom'); });
      const listener2 = vi.fn();

      emitter.on('ping', listener1);
      emitter.on('ping', listener2);
      emitter.emit('ping', { value: 1 });

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });

    it('should not halt other once listeners when one throws', () => {
      const emitter = createEmitter();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const listener1 = vi.fn(() => { throw new Error('boom'); });
      const listener2 = vi.fn();

      emitter.once('ping', listener1);
      emitter.once('ping', listener2);
      emitter.emit('ping', { value: 1 });

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();

      errorSpy.mockRestore();
    });
  });
});
