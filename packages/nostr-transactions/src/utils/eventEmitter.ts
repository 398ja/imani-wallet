/**
 * Typed event emitter for transaction events
 */

import type {
  TransactionEventType,
  TransactionEventPayloads,
  EventHandler,
  Unsubscribe,
} from '../types';

/**
 * Typed event emitter
 */
export class TypedEventEmitter {
  private listeners: Map<TransactionEventType, Set<EventHandler<unknown>>> = new Map();

  /**
   * Subscribe to an event
   */
  on<T extends TransactionEventType>(
    event: T,
    handler: EventHandler<TransactionEventPayloads[T]>
  ): Unsubscribe {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler as EventHandler<unknown>);

    // Return unsubscribe function
    return () => {
      this.off(event, handler);
    };
  }

  /**
   * Subscribe to an event (one-time)
   */
  once<T extends TransactionEventType>(
    event: T,
    handler: EventHandler<TransactionEventPayloads[T]>
  ): Unsubscribe {
    const wrapper: EventHandler<TransactionEventPayloads[T]> = (payload) => {
      this.off(event, wrapper);
      handler(payload);
    };
    return this.on(event, wrapper);
  }

  /**
   * Unsubscribe from an event
   */
  off<T extends TransactionEventType>(
    event: T,
    handler: EventHandler<TransactionEventPayloads[T]>
  ): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.delete(handler as EventHandler<unknown>);
    }
  }

  /**
   * Emit an event
   */
  emit<T extends TransactionEventType>(
    event: T,
    payload: TransactionEventPayloads[T]
  ): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(payload);
        } catch (error) {
          console.error(`Error in event handler for ${event}:`, error);
        }
      }
    }
  }

  /**
   * Remove all listeners for an event
   */
  removeAllListeners(event?: TransactionEventType): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  /**
   * Get listener count for an event
   */
  listenerCount(event: TransactionEventType): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

/**
 * Create a typed event emitter
 */
export function createEventEmitter(): TypedEventEmitter {
  return new TypedEventEmitter();
}
