# @imani/dm-poll

NIP-17 DM polling and auto-redemption service for Cashu tokens.

## Overview

This package provides a service for receiving Cashu tokens via Nostr NIP-17 encrypted DMs with automatic redemption support. It follows a **nostrdb-first architecture** where all reads go through the backend API - the package never connects directly to relays.

## Features

- **nostrdb SSE subscription** (primary) - Real-time events via backend Server-Sent Events
- **nostrdb query** (initial fetch) - One-time query for recent DMs on startup
- **Legacy API polling** (fallback) - For backward compatibility
- **NO direct WebSocket** - Package never connects to relays directly
- Automatic token redemption
- Event-driven architecture (EventEmitter pattern)
- Duplicate detection with persistence
- Client-side gift wrap unwrapping (decryption happens locally)

## Installation

```bash
npm install @imani/dm-poll
```

## Usage

### Basic Usage (Node.js/ESM)

```typescript
import { createDmPollService } from '@imani/dm-poll';

const service = createDmPollService({
  recipientPubkey: 'your-hex-pubkey',
  recipientPrivkey: 'your-hex-privkey',
  subscriptionMode: 'auto',
  nostrdbAdapter: myNostrdbAdapter,
  cryptoAdapter: myCryptoAdapter,
});

// Listen to events
service.on('redemption:success', (voucher) => {
  console.log('Received voucher:', voucher.voucher_id);
});

service.on('redemption:error', (error) => {
  console.error('Redemption failed:', error.message);
});

// Start listening
service.start();

// Stop when done
service.stop();
```

### Browser Usage (IIFE)

```html
<script src="dm-poll.min.js"></script>
<script>
  const service = ImaniDmPoll.createDmPollService({
    recipientPubkey: pubkey,
    recipientPrivkey: privkey,
    subscriptionMode: 'nostrdb-sse',
    nostrdbAdapter: {
      subscribeEvents: (filter, onEvent, onError) => {
        return nostrApi.subscribeEvents(filter, onEvent, onError);
      },
      queryEvents: (filter) => nostrApi.queryEvents(filter),
      getProfile: (pk) => api.getProfile(pk),
      isAvailable: () => true,
    },
    cryptoAdapter: {
      unwrapNip17Dm: (event, privkey) => NostrUtils.unwrapNip17Dm(event, privkey),
      parseTokenTransferMessage: (content) => NostrUtils.parseTokenTransferMessage(content),
      extractToken: (content) => content.match(/cashu[AB][A-Za-z0-9_-]+/)?.[0] || null,
    },
  });

  service.start();
</script>
```

### With Integration Bridge (Imani Apps)

```html
<script src="../lib/dm-poll.min.js"></script>
<script src="../shared/dmPollIntegration.js"></script>
<script>
  // Initialize with existing app globals
  await DmPollIntegration.init({
    recipientPubkey: identity.publicKey,
    recipientPrivkey: identity.privateKey,
    nip60Wallet: wallet,
  });

  // Start listening
  DmPollIntegration.start();

  // Listen to events
  DmPollIntegration.on('redemption:success', (voucher) => {
    updateBalance();
  });
</script>
```

## Configuration

```typescript
interface DmPollConfig {
  // Recipient identity (required)
  recipientPubkey: string;
  recipientPrivkey: string;

  // Subscription mode
  subscriptionMode: 'nostrdb-sse' | 'nostrdb-polling' | 'legacy-api' | 'auto';

  // Polling configuration
  pollIntervalMs?: number;           // Default: 30000

  // Initial fetch
  fetchRecentOnStart?: boolean;      // Default: true
  recentDmsSince?: number;           // Default: 86400 (24 hours)

  // Retry configuration
  maxRetries?: number;               // Default: 3
  retryDelayMs?: number;             // Default: 2000

  // Deduplication
  maxProcessedEvents?: number;       // Default: 100

  // Feature flags
  enableAutoRedemption?: boolean;    // Default: true
  enableUiNotifications?: boolean;   // Default: true

  // Adapters (dependency injection)
  nostrdbAdapter: NostrdbAdapter;    // REQUIRED
  cryptoAdapter: CryptoAdapter;      // REQUIRED
  storageAdapter?: StorageAdapter;
  redemptionAdapter?: RedemptionAdapter;
  uiAdapter?: UiAdapter;
  nip60Wallet?: Nip60WalletAdapter;
}
```

## Adapters

### NostrdbAdapter (Required)

Interface for reading events via the backend API:

```typescript
interface NostrdbAdapter {
  subscribeEvents(
    filter: EventFilter,
    onEvent: (event: GiftWrapEvent) => void,
    onError: (error: Error) => void
  ): SubscriptionHandle;

  queryEvents(filter: EventFilter): Promise<GiftWrapEvent[]>;
  getProfile(pubkey: string): Promise<Profile | null>;
  isAvailable(): boolean;
}
```

### CryptoAdapter (Required)

Interface for client-side cryptographic operations:

```typescript
interface CryptoAdapter {
  unwrapNip17Dm(event: GiftWrapEvent, recipientPrivkey: string): Promise<UnwrappedDm | null>;
  parseTokenTransferMessage(content: string): TokenMetadata | null;
  extractToken(content: string): string | null;
}
```

### StorageAdapter (Optional)

Interface for persistence:

```typescript
interface StorageAdapter {
  saveVoucher(voucher: Voucher): Promise<void>;
  hasTokenBeenReceived(fingerprint: string): Promise<boolean>;
  markTokenAsReceived(fingerprint: string): Promise<void>;
  getProcessedEventIds(): Promise<string[]>;
  saveProcessedEventIds(ids: string[]): Promise<void>;
}
```

## Events

| Event | Data | Description |
|-------|------|-------------|
| `token:received` | `{ eventId, token }` | Token extracted from DM |
| `redemption:success` | `Voucher` | Token successfully redeemed |
| `redemption:error` | `{ message, token, eventId }` | Redemption failed |
| `started` | - | Service started |
| `stopped` | - | Service stopped |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        @imani/dm-poll                            │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │ NostrdbSSE   │    │ GiftWrap     │    │ Token        │       │
│  │ Subscription │───►│ Processor    │───►│ Redeemer     │       │
│  └──────┬───────┘    └──────────────┘    └──────────────┘       │
│         │                                                        │
│         │  All reads through nostrdb                             │
│         ▼                                                        │
│  ┌──────────────┐                                                │
│  │ NostrdbAdptr │                                                │
│  │ (REQUIRED)   │                                                │
│  └──────┬───────┘                                                │
└─────────┼────────────────────────────────────────────────────────┘
          │
          ▼
   nostrdb Backend API
          │
          ▼
   Nostr Relays (managed by backend)
```

## Default Adapters

The package includes default adapters for browser environments:

- `BrowserStorageAdapter` - localStorage-based storage
- `NoopUiAdapter` - Silent UI adapter (no notifications)
- `ConsoleUiAdapter` - Console logging adapter
- `DefaultCryptoAdapter` - Basic token parsing (NIP-17 unwrapping must be provided)

## Testing

```bash
npm run test        # Run tests in watch mode
npm run test:run    # Run tests once
npm run test:coverage  # Run with coverage
```

## Build

```bash
npm run build       # Build ESM, CJS, and IIFE bundles
npm run dev         # Watch mode
npm run typecheck   # TypeScript check
```

## License

MIT
