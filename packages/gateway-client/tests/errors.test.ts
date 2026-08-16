import { describe, it, expect } from 'vitest';
import {
  GatewayClientError,
  QuoteNotFoundError,
  QuoteExpiredError,
  ConnectionTimeoutError,
  SseConnectionError,
  PollingError,
  ApiError,
  ConfigurationError,
} from '../src/errors';

describe('GatewayClientError', () => {
  it('creates error with message and code', () => {
    const error = new GatewayClientError('Test error', 'TEST_CODE', 'quote123');
    expect(error.message).toBe('Test error');
    expect(error.code).toBe('TEST_CODE');
    expect(error.quoteId).toBe('quote123');
    expect(error.name).toBe('GatewayClientError');
    expect(error).toBeInstanceOf(Error);
  });

  it('supports cause error', () => {
    const cause = new Error('Original error');
    const error = new GatewayClientError('Wrapped error', 'WRAPPED', undefined, cause);
    expect(error.cause).toBe(cause);
  });
});

describe('QuoteNotFoundError', () => {
  it('creates error with quote ID', () => {
    const error = new QuoteNotFoundError('quote123');
    expect(error.message).toBe('Quote not found: quote123');
    expect(error.code).toBe('QUOTE_NOT_FOUND');
    expect(error.quoteId).toBe('quote123');
    expect(error.name).toBe('QuoteNotFoundError');
    expect(error).toBeInstanceOf(GatewayClientError);
  });
});

describe('QuoteExpiredError', () => {
  it('creates error with quote ID', () => {
    const error = new QuoteExpiredError('quote123');
    expect(error.message).toBe('Quote expired: quote123');
    expect(error.code).toBe('QUOTE_EXPIRED');
    expect(error.quoteId).toBe('quote123');
    expect(error.name).toBe('QuoteExpiredError');
    expect(error).toBeInstanceOf(GatewayClientError);
  });
});

describe('ConnectionTimeoutError', () => {
  it('creates error with quote ID and timeout', () => {
    const error = new ConnectionTimeoutError('quote123', 60000);
    expect(error.message).toContain('60000ms');
    expect(error.message).toContain('quote123');
    expect(error.code).toBe('CONNECTION_TIMEOUT');
    expect(error.quoteId).toBe('quote123');
    expect(error.name).toBe('ConnectionTimeoutError');
    expect(error).toBeInstanceOf(GatewayClientError);
  });
});

describe('SseConnectionError', () => {
  it('creates error with quote ID and message', () => {
    const cause = new Error('Network error');
    const error = new SseConnectionError('quote123', 'Connection lost', cause);
    expect(error.message).toContain('quote123');
    expect(error.message).toContain('Connection lost');
    expect(error.code).toBe('SSE_CONNECTION_ERROR');
    expect(error.cause).toBe(cause);
    expect(error.name).toBe('SseConnectionError');
  });
});

describe('PollingError', () => {
  it('creates error with quote ID and message', () => {
    const error = new PollingError('quote123', 'Request failed');
    expect(error.message).toContain('quote123');
    expect(error.message).toContain('Request failed');
    expect(error.code).toBe('POLLING_ERROR');
    expect(error.name).toBe('PollingError');
  });
});

describe('ApiError', () => {
  it('creates error with status code and response', () => {
    const response = { error: 'Not found' };
    const error = new ApiError('Quote not found', 404, response, 'quote123');
    expect(error.message).toBe('Quote not found');
    expect(error.code).toBe('API_ERROR_404');
    expect(error.statusCode).toBe(404);
    expect(error.response).toBe(response);
    expect(error.quoteId).toBe('quote123');
    expect(error.name).toBe('ApiError');
  });
});

describe('ConfigurationError', () => {
  it('creates error with message', () => {
    const error = new ConfigurationError('baseUrl is required');
    expect(error.message).toBe('baseUrl is required');
    expect(error.code).toBe('CONFIGURATION_ERROR');
    expect(error.name).toBe('ConfigurationError');
  });
});
