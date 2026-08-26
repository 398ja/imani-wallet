/**
 * Typed Event Emitter
 *
 * A type-safe event emitter implementation.
 */

/**
 * Event listener function type
 */
export type EventListener<T> = (event: T) => void;

/**
 * Unsubscribe function
 */
export type Unsubscribe = () => void;

/**
 * Generic typed event emitter
 */
export class TypedEventEmitter<TEventMap extends Record<string, unknown>> {
  private listeners: Map<keyof TEventMap, Set<EventListener<unknown>>> = new Map();
  private onceListeners: Map<keyof TEventMap, Set<EventListener<unknown>>> = new Map();

  /**
   * Subscribe to an event
   */
  on<K extends keyof TEventMap>(
    event: K,
    listener: EventListener<TEventMap[K]>
  ): Unsubscribe {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as EventListener<unknown>);

    return () => this.off(event, listener);
  }

  /**
   * Subscribe to an event (once)
   */
  once<K extends keyof TEventMap>(
    event: K,
    listener: EventListener<TEventMap[K]>
  ): Unsubscribe {
    if (!this.onceListeners.has(event)) {
      this.onceListeners.set(event, new Set());
    }
    this.onceListeners.get(event)!.add(listener as EventListener<unknown>);

    return () => {
      const set = this.onceListeners.get(event);
      if (set) {
        set.delete(listener as EventListener<unknown>);
      }
    };
  }

  /**
   * Unsubscribe from an event
   */
  off<K extends keyof TEventMap>(
    event: K,
    listener: EventListener<TEventMap[K]>
  ): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener as EventListener<unknown>);
    }

    const onceSet = this.onceListeners.get(event);
    if (onceSet) {
      onceSet.delete(listener as EventListener<unknown>);
    }
  }

  /**
   * Emit an event
   */
  emit<K extends keyof TEventMap>(event: K, data: TEventMap[K]): void {
    // Regular listeners
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(data);
        } catch (error) {
          console.error(`Error in event listener for ${String(event)}:`, error);
        }
      }
    }

    // Once listeners
    const onceListeners = this.onceListeners.get(event);
    if (onceListeners) {
      const listenersToCall = [...onceListeners];
      onceListeners.clear();
      for (const listener of listenersToCall) {
        try {
          listener(data);
        } catch (error) {
          console.error(`Error in once listener for ${String(event)}:`, error);
        }
      }
    }
  }

  /**
   * Remove all listeners for an event (or all events if no event specified)
   */
  removeAllListeners<K extends keyof TEventMap>(event?: K): void {
    if (event) {
      this.listeners.delete(event);
      this.onceListeners.delete(event);
    } else {
      this.listeners.clear();
      this.onceListeners.clear();
    }
  }

  /**
   * Get listener count for an event
   */
  listenerCount<K extends keyof TEventMap>(event: K): number {
    const regular = this.listeners.get(event)?.size ?? 0;
    const once = this.onceListeners.get(event)?.size ?? 0;
    return regular + once;
  }

  /**
   * Get all event names that have listeners
   */
  eventNames(): Array<keyof TEventMap> {
    const names = new Set<keyof TEventMap>();
    for (const key of this.listeners.keys()) {
      if (this.listeners.get(key)?.size) {
        names.add(key);
      }
    }
    for (const key of this.onceListeners.keys()) {
      if (this.onceListeners.get(key)?.size) {
        names.add(key);
      }
    }
    return [...names];
  }
}
