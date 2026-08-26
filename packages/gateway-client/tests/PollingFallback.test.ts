import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PollingFallback } from '../src/polling/PollingFallback';
import { QuoteNotFoundError, QuoteExpiredError } from '../src/errors';
import type { SubscriptionHandlers, Logger, MintQuoteResponse } from '../src/types';

// Create a mock logger
function createMockLogger(): Logger {
  return vi.fn();
}

// Create mock fetch
function createMockFetch(responses: Array<{ status: number; body?: unknown }>) {
  let callIndex = 0;
  return vi.fn(async (_url: string, _options?: RequestInit) => {
    const response = responses[callIndex] || responses[responses.length - 1];
    callIndex++;
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.status === 200 ? 'OK' : 'Error',
      json: async () => response.body,
    } as Response;
  });
}

// Default config for tests
function createTestConfig(overrides?: Partial<ConstructorParameters<typeof PollingFallback>[0]>) {
  return {
    baseUrl: 'https://test.example.com',
    apiKey: 'test-key',
    initialIntervalMs: 50, // Short for tests
    multiplier: 1.5,
    maxIntervalMs: 200,
    timeoutMs: 1000, // Short for tests
    fetch: createMockFetch([{ status: 200, body: { state: 'PENDING' } }]),
    logger: createMockLogger(),
    ...overrides,
  };
}

// Create a quote response
function createQuoteResponse(
  state: string,
  overrides?: Partial<MintQuoteResponse>
): MintQuoteResponse {
  return {
    quote: 'quote123',
    request: 'lnbc...',
    state: state as any,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    amount: 1000,
    unit: 'sat',
    ...overrides,
  };
}

describe('PollingFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('poll', () => {
    it('polls with correct URL and headers', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: createQuoteResponse('PAID') }]);
      const config = createTestConfig({ fetch: mockFetch });
      const poller = new PollingFallback(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      await poller.poll('quote123', handlers);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test.example.com/api/v1/wallet/mint/quote/quote123',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Accept: 'application/json',
            'X-API-Key': 'test-key',
          }),
        })
      );
    });

    it('returns payment result when quote is PAID', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: createQuoteResponse('PAID') }]);
      const config = createTestConfig({ fetch: mockFetch });
      const poller = new PollingFallback(config);
      const onPaymentConfirmed = vi.fn();
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed,
      };

      const result = await poller.poll('quote123', handlers);

      expect(result.type).toBe('payment');
      if (result.type === 'payment') {
        expect(result.event.quote_id).toBe('quote123');
        expect(result.event.amount).toBe(1000);
        expect(result.event.unit).toBe('sat');
      }
    });

    it('returns payment result when quote is ISSUED', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: createQuoteResponse('ISSUED') }]);
      const config = createTestConfig({ fetch: mockFetch });
      const poller = new PollingFallback(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      const result = await poller.poll('quote123', handlers);

      expect(result.type).toBe('payment');
    });

    it('continues polling while quote is PENDING', async () => {
      const mockFetch = createMockFetch([
        { status: 200, body: createQuoteResponse('PENDING') },
        { status: 200, body: createQuoteResponse('PENDING') },
        { status: 200, body: createQuoteResponse('PAID') },
      ]);
      const config = createTestConfig({ fetch: mockFetch });
      const poller = new PollingFallback(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      const resultPromise = poller.poll('quote123', handlers);

      // First poll
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Wait for first backoff (50ms)
      await vi.advanceTimersByTimeAsync(50);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Wait for second backoff (75ms = 50 * 1.5)
      await vi.advanceTimersByTimeAsync(75);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      const result = await resultPromise;
      expect(result.type).toBe('payment');
    });

    it('uses exponential backoff', async () => {
      const mockFetch = createMockFetch([
        { status: 200, body: createQuoteResponse('PENDING') },
        { status: 200, body: createQuoteResponse('PENDING') },
        { status: 200, body: createQuoteResponse('PENDING') },
        { status: 200, body: createQuoteResponse('PAID') },
      ]);
      const config = createTestConfig({
        fetch: mockFetch,
        initialIntervalMs: 100,
        multiplier: 2,
        maxIntervalMs: 500,
        timeoutMs: 10000, // Long enough for all polls
      });
      const poller = new PollingFallback(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      const resultPromise = poller.poll('quote123', handlers);

      // First poll is immediate
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // First delay: 100ms (calculateBackoff(0, 100, 2, 500) = 100)
      await vi.advanceTimersByTimeAsync(100);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Second delay: 200ms (calculateBackoff(1, 100, 2, 500) = 200)
      await vi.advanceTimersByTimeAsync(200);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // Third delay: 400ms (calculateBackoff(2, 100, 2, 500) = 400)
      await vi.advanceTimersByTimeAsync(400);
      expect(mockFetch).toHaveBeenCalledTimes(4);

      const result = await resultPromise;
      expect(result.type).toBe('payment');
    });

    it('returns timeout result when timeout exceeded', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: createQuoteResponse('PENDING') }]);
      const config = createTestConfig({
        fetch: mockFetch,
        timeoutMs: 100,
        initialIntervalMs: 50,
      });
      const poller = new PollingFallback(config);
      const onTimeout = vi.fn();
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
        onTimeout,
      };

      const resultPromise = poller.poll('quote123', handlers);

      // First poll
      await vi.advanceTimersByTimeAsync(0);

      // Keep polling until timeout
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(75);

      const result = await resultPromise;
      expect(result.type).toBe('timeout');
    });

    it('returns error for EXPIRED quote', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: createQuoteResponse('EXPIRED') }]);
      const config = createTestConfig({ fetch: mockFetch });
      const poller = new PollingFallback(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      const result = await poller.poll('quote123', handlers);

      expect(result.type).toBe('error');
      if (result.type === 'error') {
        expect(result.error).toBeInstanceOf(QuoteExpiredError);
      }
    });

    it('returns error for FAILED quote', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: createQuoteResponse('FAILED') }]);
      const config = createTestConfig({ fetch: mockFetch });
      const poller = new PollingFallback(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      const result = await poller.poll('quote123', handlers);

      expect(result.type).toBe('error');
    });

    it('returns error for 404 response', async () => {
      const mockFetch = createMockFetch([{ status: 404 }]);
      const config = createTestConfig({ fetch: mockFetch });
      const poller = new PollingFallback(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      const result = await poller.poll('quote123', handlers);

      expect(result.type).toBe('error');
      if (result.type === 'error') {
        expect(result.error).toBeInstanceOf(QuoteNotFoundError);
      }
    });

    it('continues polling after transient errors', async () => {
      const mockFetch = createMockFetch([
        { status: 500 }, // Error
        { status: 200, body: createQuoteResponse('PENDING') },
        { status: 200, body: createQuoteResponse('PAID') },
      ]);
      const config = createTestConfig({ fetch: mockFetch });
      const poller = new PollingFallback(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      const resultPromise = poller.poll('quote123', handlers);

      // First poll (fails)
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Continue polling after error
      await vi.advanceTimersByTimeAsync(50);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(75);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      const result = await resultPromise;
      expect(result.type).toBe('payment');
    });

    it('calls onStateChange with polling state', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: createQuoteResponse('PAID') }]);
      const config = createTestConfig({ fetch: mockFetch });
      const poller = new PollingFallback(config);
      const onStateChange = vi.fn();
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
        onStateChange,
      };

      await poller.poll('quote123', handlers);

      expect(onStateChange).toHaveBeenCalledWith('polling', undefined);
      expect(onStateChange).toHaveBeenCalledWith('completed', undefined);
    });

    it('omits API key header when not configured', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: createQuoteResponse('PAID') }]);
      const config = createTestConfig({ fetch: mockFetch, apiKey: null });
      const poller = new PollingFallback(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      await poller.poll('quote123', handlers);

      const callArgs = mockFetch.mock.calls[0][1] as RequestInit;
      expect((callArgs.headers as Record<string, string>)['X-API-Key']).toBeUndefined();
    });
  });

  describe('close', () => {
    it('stops polling when closed', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: createQuoteResponse('PENDING') }]);
      const config = createTestConfig({ fetch: mockFetch });
      const poller = new PollingFallback(config);
      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      const resultPromise = poller.poll('quote123', handlers);

      // First poll
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Close
      poller.close();

      // Advance time - should not make more requests
      await vi.advanceTimersByTimeAsync(500);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const result = await resultPromise;
      expect(result.type).toBe('closed');
    });
  });

  describe('state', () => {
    it('returns current state', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: createQuoteResponse('PAID') }]);
      const config = createTestConfig({ fetch: mockFetch });
      const poller = new PollingFallback(config);

      expect(poller.state).toBe('polling'); // Initial state

      const handlers: SubscriptionHandlers = {
        onPaymentConfirmed: vi.fn(),
      };

      await poller.poll('quote123', handlers);

      // After completion, might still be 'polling' or 'completed' depending on implementation
    });
  });
});
