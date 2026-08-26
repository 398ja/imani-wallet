import { describe, it, expect, vi } from 'vitest';
import { SimpleEventEmitter, createEventHelpers } from '../../src/utils/eventEmitter.js';
import type { ProfileEvent } from '../../src/types/events.js';

describe('SimpleEventEmitter', () => {
  describe('on', () => {
    it('should register listener', () => {
      const emitter = new SimpleEventEmitter();
      const listener = vi.fn();

      emitter.on(listener);

      expect(emitter.listenerCount).toBe(1);
    });

    it('should return unsubscribe function', () => {
      const emitter = new SimpleEventEmitter();
      const listener = vi.fn();

      const unsubscribe = emitter.on(listener);
      expect(emitter.listenerCount).toBe(1);

      unsubscribe();
      expect(emitter.listenerCount).toBe(0);
    });

    it('should allow multiple listeners', () => {
      const emitter = new SimpleEventEmitter();

      emitter.on(vi.fn());
      emitter.on(vi.fn());
      emitter.on(vi.fn());

      expect(emitter.listenerCount).toBe(3);
    });
  });

  describe('emit', () => {
    it('should call all listeners with event', () => {
      const emitter = new SimpleEventEmitter();
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      emitter.on(listener1);
      emitter.on(listener2);

      const event: ProfileEvent = {
        type: 'followAdded',
        pubkey: 'abc123',
        timestamp: Date.now(),
      };

      emitter.emit(event);

      expect(listener1).toHaveBeenCalledWith(event);
      expect(listener2).toHaveBeenCalledWith(event);
    });

    it('should not throw if no listeners', () => {
      const emitter = new SimpleEventEmitter();
      const event: ProfileEvent = {
        type: 'followRemoved',
        pubkey: 'abc123',
        timestamp: Date.now(),
      };

      expect(() => emitter.emit(event)).not.toThrow();
    });

    it('should continue calling other listeners if one throws', () => {
      const emitter = new SimpleEventEmitter();
      const errorListener = vi.fn(() => {
        throw new Error('Test error');
      });
      const normalListener = vi.fn();

      emitter.on(errorListener);
      emitter.on(normalListener);

      const event: ProfileEvent = {
        type: 'followAdded',
        pubkey: 'abc123',
        timestamp: Date.now(),
      };

      // Should not throw
      expect(() => emitter.emit(event)).not.toThrow();

      // Both should have been called
      expect(errorListener).toHaveBeenCalled();
      expect(normalListener).toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('should remove all listeners', () => {
      const emitter = new SimpleEventEmitter();

      emitter.on(vi.fn());
      emitter.on(vi.fn());

      emitter.clear();

      expect(emitter.listenerCount).toBe(0);
    });
  });
});

describe('createEventHelpers', () => {
  it('should emit followAdded event', () => {
    const emitter = new SimpleEventEmitter();
    const listener = vi.fn();
    emitter.on(listener);

    const helpers = createEventHelpers(emitter);
    helpers.emitFollowAdded('pubkey123', ['merchant']);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'followAdded',
        pubkey: 'pubkey123',
        labels: ['merchant'],
      })
    );
  });

  it('should emit followRemoved event', () => {
    const emitter = new SimpleEventEmitter();
    const listener = vi.fn();
    emitter.on(listener);

    const helpers = createEventHelpers(emitter);
    helpers.emitFollowRemoved('pubkey123');

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'followRemoved',
        pubkey: 'pubkey123',
      })
    );
  });

  it('should emit followSyncError event', () => {
    const emitter = new SimpleEventEmitter();
    const listener = vi.fn();
    emitter.on(listener);

    const helpers = createEventHelpers(emitter);
    helpers.emitFollowSyncError('Network failed', true);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'followSyncError',
        error: 'Network failed',
        retryable: true,
      })
    );
  });

  it('should emit cacheHit event', () => {
    const emitter = new SimpleEventEmitter();
    const listener = vi.fn();
    emitter.on(listener);

    const helpers = createEventHelpers(emitter);
    helpers.emitCacheHit('profile:abc', 'memory');

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'cacheHit',
        key: 'profile:abc',
        cacheType: 'memory',
      })
    );
  });

  it('should emit cacheMiss event', () => {
    const emitter = new SimpleEventEmitter();
    const listener = vi.fn();
    emitter.on(listener);

    const helpers = createEventHelpers(emitter);
    helpers.emitCacheMiss('profile:xyz');

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'cacheMiss',
        key: 'profile:xyz',
      })
    );
  });

  it('should include timestamp in all events', () => {
    const emitter = new SimpleEventEmitter();
    const listener = vi.fn();
    emitter.on(listener);

    const before = Date.now();
    const helpers = createEventHelpers(emitter);
    helpers.emitFollowAdded('pubkey');
    const after = Date.now();

    const event = listener.mock.calls[0][0] as ProfileEvent;
    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(event.timestamp).toBeLessThanOrEqual(after);
  });
});
