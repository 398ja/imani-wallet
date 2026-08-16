/**
 * TypedEventEmitter
 *
 * A type-safe event emitter for the voucher-send library.
 */

import type { SendEventMap } from '../types';

/**
 * Event handler function type
 */
type EventHandler<T> = (data: T) => void;

/**
 * Unsubscribe function type
 */
type Unsubscribe = () => void;

/**
 * TypedEventEmitter
 *
 * Provides type-safe event emission and subscription.
 */
export class TypedEventEmitter {
  private handlers: Map<string, Set<EventHandler<unknown>>> = new Map();

  /**
   * Subscribe to an event
   *
   * @param event - Event name
   * @param handler - Event handler function
   * @returns Unsubscribe function
   */
  on<K extends keyof SendEventMap>(
    event: K,
    handler: EventHandler<SendEventMap[K]>
  ): Unsubscribe {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }

    const handlers = this.handlers.get(event)!;
    handlers.add(handler as EventHandler<unknown>);

    return () => {
      handlers.delete(handler as EventHandler<unknown>);
      if (handlers.size === 0) {
        this.handlers.delete(event);
      }
    };
  }

  /**
   * Subscribe to an event (once)
   *
   * @param event - Event name
   * @param handler - Event handler function
   * @returns Unsubscribe function
   */
  once<K extends keyof SendEventMap>(
    event: K,
    handler: EventHandler<SendEventMap[K]>
  ): Unsubscribe {
    const unsubscribe = this.on(event, (data) => {
      unsubscribe();
      handler(data);
    });
    return unsubscribe;
  }

  /**
   * Unsubscribe from an event
   *
   * @param event - Event name
   * @param handler - Event handler function (optional, removes all if not provided)
   */
  off<K extends keyof SendEventMap>(
    event: K,
    handler?: EventHandler<SendEventMap[K]>
  ): void {
    if (!handler) {
      this.handlers.delete(event);
      return;
    }

    const handlers = this.handlers.get(event);
    if (handlers) {
      handlers.delete(handler as EventHandler<unknown>);
      if (handlers.size === 0) {
        this.handlers.delete(event);
      }
    }
  }

  /**
   * Emit an event
   *
   * @param event - Event name
   * @param data - Event data
   */
  emit<K extends keyof SendEventMap>(event: K, data: SendEventMap[K]): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(data);
        } catch (error) {
          console.error(`[EventEmitter] Error in handler for "${event}":`, error);
        }
      });
    }
  }

  /**
   * Remove all event handlers
   */
  removeAllListeners(): void {
    this.handlers.clear();
  }

  /**
   * Get listener count for an event
   */
  listenerCount(event: keyof SendEventMap): number {
    return this.handlers.get(event)?.size || 0;
  }

  /**
   * Get all event names with listeners
   */
  eventNames(): (keyof SendEventMap)[] {
    return Array.from(this.handlers.keys()) as (keyof SendEventMap)[];
  }
}

/**
 * Create a new event emitter instance
 */
export function createEventEmitter(): TypedEventEmitter {
  return new TypedEventEmitter();
}
