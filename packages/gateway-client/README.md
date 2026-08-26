# @imani/gateway-client

Typed REST + SSE client for Imani gateway wallet/mint operations with automatic payment notification support.

## Features

- **SSE subscription** for real-time payment confirmations
- **Automatic polling fallback** when SSE is unavailable
- **Exponential backoff** for reconnection and polling
- **TypeScript types** matching backend DTOs
- **Promise-based API** with callback support

## Installation

```bash
npm install @imani/gateway-client
```

## Quick Start

```typescript
import { GatewayClient } from '@imani/gateway-client';

const client = new GatewayClient({
  baseUrl: 'https://account.imani.casa',
  apiKey: 'your-api-key', // optional
});

// Create a mint quote
const quote = await client.createMintQuote(1000, 'sat');
console.log('Pay this invoice:', quote.request);

// Wait for payment (SSE with polling fallback)
try {
  const payment = await client.waitForPayment(quote.quote, {
    onStateChange: (state) => console.log('Status:', state),
  });
  console.log('Payment confirmed!', payment);
} catch (error) {
  if (error instanceof ConnectionTimeoutError) {
    console.log('Payment timed out');
  }
}
```

## API Reference

### GatewayClient

#### Constructor

```typescript
const client = new GatewayClient({
  baseUrl: string;           // Required: Gateway API URL
  apiKey?: string;           // API key for authenticated endpoints
  apiSecret?: string;        // API secret if required
  sse?: SseConfig;           // SSE configuration
  polling?: PollingConfig;   // Polling configuration
  debug?: boolean;           // Enable debug logging
  logger?: Logger;           // Custom logger
});
```

#### Methods

##### `createMintQuote(amount: number, unit?: string): Promise<MintQuoteResponse>`

Create a new mint quote.

##### `getMintQuote(quoteId: string): Promise<MintQuoteResponse>`

Get the status of a mint quote.

##### `isQuotePaid(quoteId: string): Promise<boolean>`

Check if a quote is already paid.

##### `subscribeToQuoteStatus(quoteId, handlers, options?): SubscriptionHandle`

Subscribe to payment status with full control over the subscription lifecycle.

```typescript
const handle = client.subscribeToQuoteStatus(quoteId, {
  onPaymentConfirmed: (event) => {
    console.log('Paid!', event.amount, event.unit);
  },
  onConnected: () => console.log('Connected to SSE'),
  onStateChange: (state) => console.log('State:', state),
  onError: (error) => console.error('Error:', error),
  onTimeout: () => console.log('Timed out'),
});

// Later: close the subscription
handle.close();
```

##### `waitForPayment(quoteId, options?): Promise<PaymentConfirmedEvent>`

Convenience wrapper that returns a Promise.

```typescript
const payment = await client.waitForPayment(quoteId, {
  timeoutMs: 300000,
  onStateChange: (state) => updateUI(state),
});
```

### Configuration

#### SseConfig

```typescript
interface SseConfig {
  timeoutMs?: number;          // SSE timeout (default: 300000, max: 600000)
  reconnectAttempts?: number;  // Retries before polling fallback (default: 3)
  reconnectDelayMs?: number;   // Initial reconnect delay (default: 1000)
  maxReconnectDelayMs?: number; // Max reconnect delay (default: 4000)
  reconnectMultiplier?: number; // Backoff multiplier (default: 2)
}
```

#### PollingConfig

```typescript
interface PollingConfig {
  initialIntervalMs?: number;  // Initial poll interval (default: 100)
  multiplier?: number;         // Backoff multiplier (default: 1.5)
  maxIntervalMs?: number;      // Max poll interval (default: 1000)
  timeoutMs?: number;          // Total polling timeout (default: 60000)
}
```

### Subscription States

| State | Description |
|-------|-------------|
| `connecting` | Initial SSE connection attempt |
| `connected` | SSE connected, waiting for payment |
| `reconnecting` | Reconnecting after SSE error |
| `polling` | Fell back to polling |
| `completed` | Payment confirmed |
| `timeout` | Timed out waiting for payment |
| `error` | Unrecoverable error |
| `closed` | Manually closed |

### Error Classes

- `GatewayClientError` - Base error class
- `QuoteNotFoundError` - Quote does not exist (404)
- `QuoteExpiredError` - Quote has expired
- `ConnectionTimeoutError` - Timeout waiting for payment
- `SseConnectionError` - SSE connection failure
- `PollingError` - Polling request failure
- `ApiError` - General API error
- `ConfigurationError` - Invalid configuration

## Browser Compatibility

| Browser | Support |
|---------|---------|
| Chrome 6+ | Native EventSource |
| Firefox 6+ | Native EventSource |
| Safari 5+ | Native EventSource |
| Edge 79+ | Native EventSource |
| IE 11 | Polling fallback only |

### Mobile Considerations

SSE may disconnect when the app goes to background. Handle visibility changes:

```typescript
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && pendingQuote) {
    // Reconnect subscription
    handle.close();
    handle = client.subscribeToQuoteStatus(pendingQuote, handlers);
  }
});
```

## Advanced Usage

### Custom EventSource Factory

For environments requiring authentication headers on SSE:

```typescript
import { fetchEventSource } from '@microsoft/fetch-event-source';

const client = new GatewayClient({
  baseUrl: 'https://account.imani.casa',
  eventSourceFactory: (url, options) => {
    // Use a polyfill that supports headers
    return new FetchEventSource(url, options);
  },
});
```

### Polling Only Mode

Skip SSE entirely:

```typescript
const payment = await client.waitForPayment(quoteId, {
  pollingOnly: true,
});
```

### Custom Logger

```typescript
const client = new GatewayClient({
  baseUrl: 'https://account.imani.casa',
  debug: true,
  logger: (level, message, data) => {
    myLoggingService.log({ level, message, ...data });
  },
});
```

## Migration Guide

### From `api.subscribeToQuoteStatus()`

**Before** (using `shared/api.js`):
```javascript
const eventSource = api.subscribeToQuoteStatus(quoteId, {
  onPaid: (data) => {
    // Handle payment
    mintTokens(quoteId);
  },
  onConnected: () => console.log('Connected'),
  onError: (err) => console.error('Error:', err)
});

// Manual cleanup
eventSource.close();
```

**After** (using `@imani/gateway-client`):
```javascript
import { GatewayClientIntegration } from './gatewayClientIntegration.js';

// Initialize once
GatewayClientIntegration.init({ debug: true });

// Use Promise-based API
try {
  const payment = await GatewayClientIntegration.waitForQuotePayment(quoteId, {
    onStateChange: (state) => {
      switch (state) {
        case 'connecting': showStatus('Connecting...'); break;
        case 'connected': showStatus('Waiting for payment...'); break;
        case 'reconnecting': showStatus('Reconnecting...'); break;
        case 'polling': showStatus('Checking payment...'); break;
      }
    }
  });

  // Payment confirmed, proceed to mint
  await mintTokens(quoteId);

} catch (error) {
  if (error.name === 'ConnectionTimeoutError') {
    showError('Payment timed out');
  } else {
    showError(error.message);
  }
}
```

### Key Differences

| Feature | Old (`api.js`) | New (`@imani/gateway-client`) |
|---------|----------------|-------------------------------|
| SSE reconnect | Manual | Automatic with exponential backoff |
| Polling fallback | None | Automatic when SSE fails |
| State feedback | Basic | Detailed state machine |
| Error types | Generic | Typed errors (QuoteNotFoundError, etc.) |
| Promise support | Callback only | Both callback and Promise |
| TypeScript | No types | Full type definitions |

## Troubleshooting

### SSE Connection Issues

1. **Check nginx config**: Ensure `X-Accel-Buffering: no` is set for SSE endpoints
2. **Check CORS**: SSE endpoint should allow your origin
3. **Check timeout**: Default SSE timeout is 5 minutes (300s), max is 10 minutes (600s)

### Polling Fallback

If you see `onStateChange('polling')` frequently:
- Check network connectivity
- Check if SSE endpoint is returning correct `Content-Type: text/event-stream`
- Enable debug mode to see detailed logs: `{ debug: true }`

### Debug Mode

Enable debug logging to see detailed connection information:

```javascript
const client = new GatewayClient({
  baseUrl: 'https://account.imani.casa',
  debug: true, // Logs all SSE events and state changes
});
```

## License

MIT
