/**
 * TypedEventEmitter - Type-safe event emitter for DmPollService
 */

/**
 * Generic type-safe event emitter
 */
export class TypedEventEmitter<T extends Record<string, unknown>> {
  private listeners: Map<keyof T, Set<(data: unknown) => void>> = new Map();

  /**
   * Add an event listener
   *
   * @param event - Event name
   * @param handler - Event handler function
   */
  on<K extends keyof T>(event: K, handler: (data: T[K]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler as (data: unknown) => void);
  }

  /**
   * Add a one-time event listener
   *
   * @param event - Event name
   * @param handler - Event handler function
   */
  once<K extends keyof T>(event: K, handler: (data: T[K]) => void): void {
    const onceHandler = (data: T[K]) => {
      this.off(event, onceHandler);
      handler(data);
    };
    this.on(event, onceHandler);
  }

  /**
   * Remove an event listener
   *
   * @param event - Event name
   * @param handler - Event handler function to remove
   */
  off<K extends keyof T>(event: K, handler: (data: T[K]) => void): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.delete(handler as (data: unknown) => void);
      if (handlers.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  /**
   * Emit an event
   *
   * @param event - Event name
   * @param data - Event data
   */
  protected emit<K extends keyof T>(event: K, data: T[K]): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(data);
        } catch (error) {
          console.error(`[EventEmitter] Error in handler for ${String(event)}:`, error);
        }
      });
    }
  }

  /**
   * Remove all listeners for an event, or all listeners if no event specified
   *
   * @param event - Optional event name
   */
  removeAllListeners<K extends keyof T>(event?: K): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  /**
   * Get the number of listeners for an event
   *
   * @param event - Event name
   * @returns Number of listeners
   */
  listenerCount<K extends keyof T>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
