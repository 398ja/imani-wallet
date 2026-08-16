import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GatewayClient, createGatewayClient } from '../src/client/GatewayClient';
import { ConfigurationError, QuoteNotFoundError, ApiError } from '../src/errors';
import type { Logger, MintQuoteResponse } from '../src/types';

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

// Create a quote response
function createQuoteResponse(overrides?: Partial<MintQuoteResponse>): MintQuoteResponse {
  return {
    quote: 'quote123',
    request: 'lnbc1000n1...',
    state: 'PENDING',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    amount: 1000,
    unit: 'sat',
    ...overrides,
  };
}

describe('GatewayClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('throws ConfigurationError if baseUrl is missing', () => {
      expect(() => new GatewayClient({ baseUrl: '' })).toThrow(ConfigurationError);
      expect(() => new GatewayClient({} as any)).toThrow(ConfigurationError);
    });

    it('strips trailing slash from baseUrl', () => {
      const mockFetch = createMockFetch([{ status: 404 }]);
      const client = new GatewayClient({
        baseUrl: 'https://example.com/',
        fetch: mockFetch,
        logger: createMockLogger(),
      });

      // Try to get a quote (will 404, but we can verify the URL)
      client.getMintQuote('test').catch(() => {});

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/api/v1/wallet/mint/quote/test',
        expect.any(Object)
      );
    });
  });

  describe('createMintQuote', () => {
    it('creates a mint quote with correct request', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: createQuoteResponse() }]);
      const client = new GatewayClient({
        baseUrl: 'https://example.com',
        apiKey: 'test-key',
        fetch: mockFetch,
        logger: createMockLogger(),
      });

      const quote = await client.createMintQuote(1000, 'sat');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/api/v1/wallet/mint/quote',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-API-Key': 'test-key',
          }),
          body: JSON.stringify({ amount: 1000, unit: 'sat' }),
        })
      );
      expect(quote.quote).toBe('quote123');
      expect(quote.amount).toBe(1000);
    });

    it('throws ApiError on non-200 response', async () => {
      const mockFetch = createMockFetch([{ status: 500, body: { error: 'Internal error' } }]);
      const client = new GatewayClient({
        baseUrl: 'https://example.com',
        fetch: mockFetch,
        logger: createMockLogger(),
      });

      await expect(client.createMintQuote(1000)).rejects.toThrow(ApiError);
    });
  });

  describe('getMintQuote', () => {
    it('gets a mint quote by ID', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: createQuoteResponse() }]);
      const client = new GatewayClient({
        baseUrl: 'https://example.com',
        fetch: mockFetch,
        logger: createMockLogger(),
      });

      const quote = await client.getMintQuote('quote123');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/api/v1/wallet/mint/quote/quote123',
        expect.objectContaining({
          method: 'GET',
        })
      );
      expect(quote.quote).toBe('quote123');
    });

    it('throws QuoteNotFoundError on 404', async () => {
      const mockFetch = createMockFetch([{ status: 404 }]);
      const client = new GatewayClient({
        baseUrl: 'https://example.com',
        fetch: mockFetch,
        logger: createMockLogger(),
      });

      await expect(client.getMintQuote('nonexistent')).rejects.toThrow(QuoteNotFoundError);
    });
  });

  describe('isQuotePaid', () => {
    it('returns true if quote state is PAID', async () => {
      const mockFetch = createMockFetch([
        { status: 200, body: createQuoteResponse({ state: 'PAID' }) },
      ]);
      const client = new GatewayClient({
        baseUrl: 'https://example.com',
        fetch: mockFetch,
        logger: createMockLogger(),
      });

      const isPaid = await client.isQuotePaid('quote123');
      expect(isPaid).toBe(true);
    });

    it('returns true if quote state is ISSUED', async () => {
      const mockFetch = createMockFetch([
        { status: 200, body: createQuoteResponse({ state: 'ISSUED' }) },
      ]);
      const client = new GatewayClient({
        baseUrl: 'https://example.com',
        fetch: mockFetch,
        logger: createMockLogger(),
      });

      const isPaid = await client.isQuotePaid('quote123');
      expect(isPaid).toBe(true);
    });

    it('returns false if quote state is PENDING', async () => {
      const mockFetch = createMockFetch([
        { status: 200, body: createQuoteResponse({ state: 'PENDING' }) },
      ]);
      const client = new GatewayClient({
        baseUrl: 'https://example.com',
        fetch: mockFetch,
        logger: createMockLogger(),
      });

      const isPaid = await client.isQuotePaid('quote123');
      expect(isPaid).toBe(false);
    });

    it('returns false if quote is not found', async () => {
      const mockFetch = createMockFetch([{ status: 404 }]);
      const client = new GatewayClient({
        baseUrl: 'https://example.com',
        fetch: mockFetch,
        logger: createMockLogger(),
      });

      const isPaid = await client.isQuotePaid('nonexistent');
      expect(isPaid).toBe(false);
    });
  });

  describe('subscribeToQuoteStatus', () => {
    it('immediately resolves if quote is already paid', async () => {
      const mockFetch = createMockFetch([
        // First call: isQuotePaid
        { status: 200, body: createQuoteResponse({ state: 'PAID', amount: 1000 }) },
        // Second call: getMintQuote for details
        { status: 200, body: createQuoteResponse({ state: 'PAID', amount: 1000 }) },
      ]);
      const client = new GatewayClient({
        baseUrl: 'https://example.com',
        fetch: mockFetch,
        logger: createMockLogger(),
      });

      const onPaymentConfirmed = vi.fn();
      const onStateChange = vi.fn();

      const handle = client.subscribeToQuoteStatus(
        'quote123',
        { onPaymentConfirmed, onStateChange },
        { pollingOnly: true }
      );

      // Wait for the async check
      await vi.advanceTimersByTimeAsync(0);

      expect(onPaymentConfirmed).toHaveBeenCalled();
      expect(onStateChange).toHaveBeenCalledWith('completed');
      expect(handle.state).toBe('completed');
    });

    it('returns a subscription handle with state and close', async () => {
      const mockFetch = createMockFetch([
        // isQuotePaid check returns PENDING
        { status: 200, body: createQuoteResponse({ state: 'PENDING' }) },
        // Polling returns PENDING (will continue polling)
        { status: 200, body: createQuoteResponse({ state: 'PENDING' }) },
      ]);
      const client = new GatewayClient({
        baseUrl: 'https://example.com',
        fetch: mockFetch,
        logger: createMockLogger(),
      });

      const handle = client.subscribeToQuoteStatus(
        'quote123',
        { onPaymentConfirmed: vi.fn() },
        { pollingOnly: true }
      );

      expect(handle.quoteId).toBe('quote123');
      expect(handle.state).toBe('connecting');

      // Close the subscription
      handle.close();
      expect(handle.state).toBe('closed');
    });
  });

  describe('createGatewayClient', () => {
    it('creates a GatewayClient instance', () => {
      const client = createGatewayClient({
        baseUrl: 'https://example.com',
        logger: createMockLogger(),
      });

      expect(client).toBeInstanceOf(GatewayClient);
    });
  });

  describe('configuration', () => {
    it('uses default polling config when not specified', async () => {
      const mockFetch = createMockFetch([
        { status: 200, body: createQuoteResponse({ state: 'PENDING' }) },
        { status: 200, body: createQuoteResponse({ state: 'PENDING' }) },
        { status: 200, body: createQuoteResponse({ state: 'PAID', amount: 1000 }) },
      ]);
      const client = new GatewayClient({
        baseUrl: 'https://example.com',
        fetch: mockFetch,
        logger: createMockLogger(),
      });

      const onPaymentConfirmed = vi.fn();
      client.subscribeToQuoteStatus('quote123', { onPaymentConfirmed }, { pollingOnly: true });

      // Should use default 100ms initial interval
      await vi.advanceTimersByTimeAsync(0); // isQuotePaid check
      await vi.advanceTimersByTimeAsync(100); // First poll interval
      await vi.advanceTimersByTimeAsync(150); // Second poll interval (100 * 1.5)

      expect(onPaymentConfirmed).toHaveBeenCalled();
    });

    it('includes API key in headers when provided', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: createQuoteResponse() }]);
      const client = new GatewayClient({
        baseUrl: 'https://example.com',
        apiKey: 'secret-key',
        fetch: mockFetch,
        logger: createMockLogger(),
      });

      await client.getMintQuote('quote123');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-API-Key': 'secret-key',
          }),
        })
      );
    });

    it('omits API key header when not provided', async () => {
      const mockFetch = createMockFetch([{ status: 200, body: createQuoteResponse() }]);
      const client = new GatewayClient({
        baseUrl: 'https://example.com',
        fetch: mockFetch,
        logger: createMockLogger(),
      });

      await client.getMintQuote('quote123');

      const callArgs = mockFetch.mock.calls[0][1] as RequestInit;
      expect((callArgs.headers as Record<string, string>)['X-API-Key']).toBeUndefined();
    });
  });
});
