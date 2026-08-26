import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SseManager } from '../src/sse/SseManager';
import type { SubscriptionHandlers, Logger } from '../src/types';

/**
 * Mock EventSource for testing
 */
class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  readyState: number = 0; // CONNECTING
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners: Map<string, ((event: MessageEvent) => void)[]> = new Map();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const listeners = this.listeners.get(type);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  close(): void {
    this.readyState = 2; // CLOSED
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.(new Event('open'));
  }

  simulateError(): void {
    this.onerror?.(new Event('error'));
  }

  simulateEvent(type: string, data: unknown): void {
    const listeners = this.listeners.get(type) || [];
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    listeners.forEach((listener) => listener(event));
  }

  static reset(): void {
    MockEventSource.instances = [];
  }
}

// Create a mock logger
function createMockLogger(): Logger {
  return vi.fn();
}

// Default config for tests
function createTestConfig(
  overrides?: Partial<Parameters<(typeof SseManager)['prototype']['subscribe']>[0]>
) {
  return {
    baseUrl: 'https://test.example.com',
    timeoutMs: 300000,
    reconnectAttempts: 3,
    reconnectDelayMs: 100, // Short for tests
    maxReconnectDelayMs: 400,
    reconnectMultiplier: 2,
    eventSourceFactory: (url: string) => new MockEventSource(url) as unknown as EventSource,
    logger: createMockLogger(),
    ...overrides,
  };
}

describe('SseManager', () => {
  beforeEach(() => {
    MockEventSource.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isAvailable', () => {
    it('returns true when EventSource exists', () => {
      // In test environment, EventSource may not exist
      const originalEventSource = globalThis.EventSource;
      (globalThis as any).EventSource = MockEventSource;

      expect(SseManager.isAvailable()).toBe(true);

      (globalThis as any).EventSource = originalEventSource;
    });
  });

  describe('subscribe', () => {
    it('creates EventSource with correct URL', async () => {
      const config = createTestConfig();
      const manager = new SseManager(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      // Start subscription (don't await, it will block)
      const resultPromise = manager.subscribe('quote123', handlers);

      // Wait for EventSource to be created
      await vi.advanceTimersByTimeAsync(0);

      expect(MockEventSource.instances).toHaveLength(1);
      expect(MockEventSource.instances[0].url).toBe(
        'https://test.example.com/api/v1/wallet/mint/quote/quote123/subscribe?timeout=300'
      );

      // Close to cleanup
      manager.close();
    });

    it('clamps timeout to server max (600s)', async () => {
      const config = createTestConfig({ timeoutMs: 1000000 }); // Way over max
      const manager = new SseManager(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      manager.subscribe('quote123', handlers);
      await vi.advanceTimersByTimeAsync(0);

      expect(MockEventSource.instances[0].url).toContain('timeout=600');

      manager.close();
    });

    it('calls onConnected when connected event received', async () => {
      const config = createTestConfig();
      const manager = new SseManager(config);
      const onConnected = vi.fn();
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
        onConnected,
      };

      manager.subscribe('quote123', handlers);
      await vi.advanceTimersByTimeAsync(0);

      const es = MockEventSource.instances[0];
      es.simulateOpen();
      es.simulateEvent('connected', { status: 'subscribed', quote_id: 'quote123' });

      expect(onConnected).toHaveBeenCalledWith({
        status: 'subscribed',
        quote_id: 'quote123',
      });

      manager.close();
    });

    it('resolves with payment event on payment_confirmed', async () => {
      const config = createTestConfig();
      const manager = new SseManager(config);
      const onPaymentConfirmed = vi.fn();
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed,
      };

      const resultPromise = manager.subscribe('quote123', handlers);
      await vi.advanceTimersByTimeAsync(0);

      const es = MockEventSource.instances[0];
      es.simulateOpen();
      es.simulateEvent('payment_confirmed', {
        quote_id: 'quote123',
        payment_method: 'bolt11',
        amount: 1000,
        unit: 'sat',
        preimage: 'abc123',
        paid_at: '2024-01-15T12:00:00Z',
      });

      const result = await resultPromise;

      expect(result.type).toBe('payment');
      if (result.type === 'payment') {
        expect(result.event.quote_id).toBe('quote123');
        expect(result.event.amount).toBe(1000);
      }
    });

    it('closes EventSource after payment_confirmed', async () => {
      const config = createTestConfig();
      const manager = new SseManager(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      const resultPromise = manager.subscribe('quote123', handlers);
      await vi.advanceTimersByTimeAsync(0);

      const es = MockEventSource.instances[0];
      es.simulateOpen();
      es.simulateEvent('payment_confirmed', {
        quote_id: 'quote123',
        payment_method: 'bolt11',
        amount: 1000,
        unit: 'sat',
        paid_at: '2024-01-15T12:00:00Z',
      });

      await resultPromise;

      expect(es.readyState).toBe(2); // CLOSED
    });

    it('calls onStateChange with state transitions', async () => {
      const config = createTestConfig();
      const manager = new SseManager(config);
      const onStateChange = vi.fn();
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
        onStateChange,
      };

      const resultPromise = manager.subscribe('quote123', handlers);
      await vi.advanceTimersByTimeAsync(0);

      // Should have called with 'connecting'
      expect(onStateChange).toHaveBeenCalledWith('connecting', undefined);

      const es = MockEventSource.instances[0];
      es.simulateOpen();
      es.simulateEvent('connected', { status: 'subscribed', quote_id: 'quote123' });

      // Should have called with 'connected'
      expect(onStateChange).toHaveBeenCalledWith('connected', undefined);

      es.simulateEvent('payment_confirmed', {
        quote_id: 'quote123',
        payment_method: 'bolt11',
        amount: 1000,
        unit: 'sat',
        paid_at: '2024-01-15T12:00:00Z',
      });

      await resultPromise;

      // Should have called with 'completed'
      expect(onStateChange).toHaveBeenCalledWith('completed', undefined);
    });

    it('calls onDiagnostics when diagnostics event received', async () => {
      const config = createTestConfig();
      const manager = new SseManager(config);
      const onDiagnostics = vi.fn();
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
        onDiagnostics,
      };

      manager.subscribe('quote123', handlers);
      await vi.advanceTimersByTimeAsync(0);

      const es = MockEventSource.instances[0];
      es.simulateOpen();
      es.simulateEvent('diagnostics', {
        quote_id: 'quote123',
        subscribers: 2,
        reconnects: 0,
        last_error: null,
        last_broadcast_at: null,
      });

      expect(onDiagnostics).toHaveBeenCalledWith({
        quote_id: 'quote123',
        subscribers: 2,
        reconnects: 0,
        last_error: null,
        last_broadcast_at: null,
      });

      manager.close();
    });
  });

  describe('reconnection', () => {
    it('attempts reconnect on error', async () => {
      const config = createTestConfig();
      const manager = new SseManager(config);
      const onStateChange = vi.fn();
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
        onStateChange,
      };

      manager.subscribe('quote123', handlers);
      await vi.advanceTimersByTimeAsync(0);

      const es1 = MockEventSource.instances[0];
      es1.simulateOpen();
      es1.simulateError();

      // Should be reconnecting
      expect(onStateChange).toHaveBeenCalledWith('reconnecting', expect.stringContaining('1/3'));

      // Advance past reconnect delay
      await vi.advanceTimersByTimeAsync(100);

      // Should have created a new EventSource
      expect(MockEventSource.instances).toHaveLength(2);

      manager.close();
    });

    it('falls back to polling after max reconnect attempts', async () => {
      const config = createTestConfig({ reconnectAttempts: 2 });
      const manager = new SseManager(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      const resultPromise = manager.subscribe('quote123', handlers);
      await vi.advanceTimersByTimeAsync(0);

      // First connection fails
      MockEventSource.instances[0].simulateError();
      await vi.advanceTimersByTimeAsync(100);

      // Second connection fails
      MockEventSource.instances[1].simulateError();
      await vi.advanceTimersByTimeAsync(200);

      // Third connection fails (max reached)
      MockEventSource.instances[2].simulateError();

      const result = await resultPromise;

      expect(result.type).toBe('fallback');
      if (result.type === 'fallback') {
        expect(result.reason).toContain('2');
      }
    });

    it('uses exponential backoff for reconnect delays', async () => {
      const config = createTestConfig({
        reconnectDelayMs: 100,
        reconnectMultiplier: 2,
        maxReconnectDelayMs: 400,
      });
      const manager = new SseManager(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      manager.subscribe('quote123', handlers);
      await vi.advanceTimersByTimeAsync(0);

      // First error
      MockEventSource.instances[0].simulateError();

      // First delay should be 100ms
      await vi.advanceTimersByTimeAsync(99);
      expect(MockEventSource.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockEventSource.instances).toHaveLength(2);

      // Second error
      MockEventSource.instances[1].simulateError();

      // Second delay should be 200ms
      await vi.advanceTimersByTimeAsync(199);
      expect(MockEventSource.instances).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockEventSource.instances).toHaveLength(3);

      manager.close();
    });
  });

  describe('close', () => {
    it('closes EventSource immediately', async () => {
      const config = createTestConfig();
      const manager = new SseManager(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      manager.subscribe('quote123', handlers);
      await vi.advanceTimersByTimeAsync(0);

      const es = MockEventSource.instances[0];
      expect(es.readyState).not.toBe(2);

      manager.close();

      expect(es.readyState).toBe(2); // CLOSED
    });

    it('returns closed result when closed during reconnect', async () => {
      const config = createTestConfig();
      const manager = new SseManager(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      const resultPromise = manager.subscribe('quote123', handlers);
      await vi.advanceTimersByTimeAsync(0);

      // Trigger an error to start reconnect
      MockEventSource.instances[0].simulateError();

      // Close during reconnect delay
      manager.close();

      // Advance past reconnect delay
      await vi.advanceTimersByTimeAsync(1000);

      const result = await resultPromise;
      expect(result.type).toBe('closed');
    });

    it('stops reconnection attempts when closed', async () => {
      const config = createTestConfig();
      const manager = new SseManager(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      const resultPromise = manager.subscribe('quote123', handlers);
      await vi.advanceTimersByTimeAsync(0);

      MockEventSource.instances[0].simulateError();

      // Close before reconnect timer fires
      manager.close();

      await vi.advanceTimersByTimeAsync(1000);

      // Should not have created more EventSources
      expect(MockEventSource.instances).toHaveLength(1);

      const result = await resultPromise;
      expect(result.type).toBe('closed');
    });
  });

  describe('fallback when EventSource unavailable', () => {
    it('returns fallback result when no EventSource and no factory', async () => {
      const originalEventSource = globalThis.EventSource;
      delete (globalThis as any).EventSource;

      const config = {
        baseUrl: 'https://test.example.com',
        timeoutMs: 300000,
        reconnectAttempts: 3,
        reconnectDelayMs: 100,
        maxReconnectDelayMs: 400,
        reconnectMultiplier: 2,
        eventSourceFactory: null,
        logger: createMockLogger(),
      };
      const manager = new SseManager(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      const result = await manager.subscribe('quote123', handlers);

      expect(result.type).toBe('fallback');
      if (result.type === 'fallback') {
        expect(result.reason).toContain('EventSource not available');
      }

      (globalThis as any).EventSource = originalEventSource;
    });
  });
});
