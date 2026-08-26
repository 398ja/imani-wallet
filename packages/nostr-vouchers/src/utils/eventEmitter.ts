/**
 * Typed event emitter for VoucherService
 */

import type { VoucherEventType, VoucherEventPayloads, EventHandler, Unsubscribe } from '../types';

/**
 * A type-safe event emitter
 */
export class TypedEventEmitter {
  private handlers: Map<VoucherEventType, Set<EventHandler<VoucherEventType>>> = new Map();
  private maxListeners: number = 10;

  /**
   * Set maximum number of listeners per event (to catch memory leaks)
   */
  setMaxListeners(n: number): this {
    this.maxListeners = n;
    return this;
  }

  /**
   * Get maximum number of listeners
   */
  getMaxListeners(): number {
    return this.maxListeners;
  }

  /**
   * Subscribe to an event
   */
  on<T extends VoucherEventType>(event: T, handler: EventHandler<T>): Unsubscribe {
    let eventHandlers = this.handlers.get(event);

    if (!eventHandlers) {
      eventHandlers = new Set();
      this.handlers.set(event, eventHandlers);
    }

    // Warn if too many listeners
    if (eventHandlers.size >= this.maxListeners) {
      console.warn(
        `Warning: Event "${event}" has ${eventHandlers.size} listeners. ` +
          `Possible memory leak. Use setMaxListeners() to increase limit.`
      );
    }

    eventHandlers.add(handler as EventHandler<VoucherEventType>);

    // Return unsubscribe function
    return () => {
      this.off(event, handler);
    };
  }

  /**
   * Subscribe to an event (once only)
   */
  once<T extends VoucherEventType>(event: T, handler: EventHandler<T>): Unsubscribe {
    const onceHandler: EventHandler<T> = (payload) => {
      this.off(event, onceHandler);
      handler(payload);
    };

    return this.on(event, onceHandler);
  }

  /**
   * Unsubscribe from an event
   */
  off<T extends VoucherEventType>(event: T, handler: EventHandler<T>): void {
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      eventHandlers.delete(handler as EventHandler<VoucherEventType>);
      if (eventHandlers.size === 0) {
        this.handlers.delete(event);
      }
    }
  }

  /**
   * Emit an event
   */
  emit<T extends VoucherEventType>(event: T, payload: VoucherEventPayloads[T]): void {
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      for (const handler of eventHandlers) {
        try {
          const result = (handler as EventHandler<T>)(payload);
          // Handle async handlers (fire and forget)
          if (result instanceof Promise) {
            result.catch((error) => {
              console.error(`Error in async event handler for "${event}":`, error);
            });
          }
        } catch (error) {
          console.error(`Error in event handler for "${event}":`, error);
        }
      }
    }
  }

  /**
   * Emit an event and wait for all handlers to complete
   */
  async emitAsync<T extends VoucherEventType>(
    event: T,
    payload: VoucherEventPayloads[T]
  ): Promise<void> {
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      const promises: Promise<void>[] = [];
      for (const handler of eventHandlers) {
        try {
          const result = (handler as EventHandler<T>)(payload);
          if (result instanceof Promise) {
            promises.push(result);
          }
        } catch (error) {
          console.error(`Error in event handler for "${event}":`, error);
        }
      }
      await Promise.all(promises);
    }
  }

  /**
   * Get number of listeners for an event
   */
  listenerCount(event: VoucherEventType): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  /**
   * Get all event names with listeners
   */
  eventNames(): VoucherEventType[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Remove all listeners for an event, or all events if no event specified
   */
  removeAllListeners(event?: VoucherEventType): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }
}

/**
 * Create a new event emitter instance
 */
export function createEventEmitter(): TypedEventEmitter {
  return new TypedEventEmitter();
}
