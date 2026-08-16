# @imani/nostr-transactions

Transaction management library for Nostr with local storage and relay sync.

## Features

- **Local-first storage** - IndexedDB for fast UI, with memory adapter for Node.js/testing
- **Relay sync** - Push/pull transactions to Nostr relays via NIP-60 (kind 7376)
- **Rich filtering** - Filter by type, direction, counterparty, date range, amount, and more
- **Fluent query API** - Chainable query builder for complex queries
- **Type-safe** - Full TypeScript support with comprehensive type definitions
- **Platform-agnostic** - Works in browser, Node.js, and React Native

## Installation

```bash
npm install @imani/nostr-transactions
```

## Quick Start

```typescript
import {
  TransactionStore,
  TransactionType,
  TransactionDirection,
} from '@imani/nostr-transactions';

// Create the store
const store = new TransactionStore({
  storage: 'indexeddb', // or 'memory' for Node.js/testing
  dbName: 'my-transactions',
});

await store.init();

// Record a transaction
const tx = await store.record({
  type: TransactionType.RECEIVED,
  direction: TransactionDirection.IN,
  tokenAmount: 1000,        // Backing amount in sats
  faceValue: 5000,          // Face value in minor units
  faceUnit: 'USD',          // Currency code
  faceDecimals: 2,          // Decimal places
  counterparty: 'npub1...',
  counterpartyName: 'Alice',
  memo: 'Payment for coffee',
});

// Query transactions
const recent = await store.query({ limit: 10 });
const received = await store.query({
  type: TransactionType.RECEIVED,
  sortBy: 'timestamp',
  sortOrder: 'desc',
});
```

## Fluent Query Builder

Build complex queries with a chainable API:

```typescript
// Get received transactions from Alice in the last 7 days
const results = await store.find()
  .received()
  .counterparty('alice-pubkey')
  .lastDays(7)
  .minAmount(1000)
  .newest()
  .limit(20)
  .execute();

// Get statistics for this month
const stats = await store.find()
  .thisMonth()
  .incoming()
  .stats();

console.log(`Total received: ${stats.totalIn} sats`);
console.log(`Transaction count: ${stats.countIn}`);
```

### Query Methods

| Method | Description |
|--------|-------------|
| `.type(type)` | Filter by transaction type(s) |
| `.received()` | Shorthand for type=RECEIVED |
| `.sent()` | Shorthand for type=SENT |
| `.purchased()` | Shorthand for type=PURCHASED |
| `.direction(dir)` | Filter by direction (in/out/internal) |
| `.incoming()` | Shorthand for direction=IN |
| `.outgoing()` | Shorthand for direction=OUT |
| `.counterparty(pubkey)` | Filter by counterparty |
| `.issuer(pubkey)` | Filter by issuer/merchant |
| `.wallet(id)` | Filter by wallet ID |
| `.fromDate(date)` | Filter from date |
| `.toDate(date)` | Filter to date |
| `.between(from, to)` | Filter date range |
| `.today()` | Filter today's transactions |
| `.thisWeek()` | Filter this week |
| `.thisMonth()` | Filter this month |
| `.lastDays(n)` | Filter last N days |
| `.minAmount(n)` | Minimum face value |
| `.maxAmount(n)` | Maximum face value |
| `.unit(code)` | Filter by currency |
| `.search(text)` | Full-text search in memo/names |
| `.synced()` / `.unsynced()` | Filter by sync status |
| `.limit(n)` | Limit results |
| `.offset(n)` / `.skip(n)` | Skip results |
| `.page(n, size)` | Pagination helper |
| `.sortBy(field, order)` | Sort by timestamp/amount |
| `.newest()` / `.oldest()` | Sort shortcuts |
| `.largest()` / `.smallest()` | Amount sort shortcuts |

### Result Methods

| Method | Returns |
|--------|---------|
| `.execute()` | Full query result with pagination |
| `.get()` | Array of transactions |
| `.first()` | First matching transaction or null |
| `.count()` | Count of matching transactions |
| `.exists()` | Boolean if any match |
| `.stats()` | Aggregate statistics |

## Transaction Types

```typescript
enum TransactionType {
  RECEIVED = 'voucher_received',
  SENT = 'voucher_sent',
  PURCHASED = 'voucher_purchased',
  REDEEMED = 'voucher_redeemed',
  SPLIT = 'voucher_split',
  EXPIRED = 'voucher_expired',
}

enum TransactionDirection {
  IN = 'in',
  OUT = 'out',
  INTERNAL = 'internal',
}
```

## Relay Sync

Sync transactions with Nostr relays using NIP-60 (kind 7376):

```typescript
import {
  TransactionStore,
  RelaySync,
  createRelaySync,
} from '@imani/nostr-transactions';

const store = new TransactionStore({ storage: 'indexeddb' });
await store.init();

// Create relay sync with your signer (NIP-07 compatible)
const sync = createRelaySync(store, {
  pubkey: 'your-pubkey-hex',
  signer: window.nostr, // or custom signer
  relayUrls: ['wss://relay.damus.io', 'wss://nos.lol'],
  walletDTag: 'my-wallet',
  encryption: true, // Enable NIP-44 encryption
});

await sync.init();

// Push local transactions to relays
const pushResult = await sync.push();
console.log(`Pushed ${pushResult.pushed} transactions`);

// Pull transactions from relays
const pullResult = await sync.pull();
console.log(`Pulled ${pullResult.pulled} transactions`);

// Full sync (push then pull)
const fullResult = await sync.full();

// Get sync status
const status = sync.getStatus();
console.log(`Pending: ${status.pendingCount}, Synced: ${status.synced}`);

// Listen for sync events
sync.on('sync:progress', ({ processed, total, percentage }) => {
  console.log(`Sync progress: ${percentage}%`);
});

sync.on('sync:completed', ({ pushed, pulled, duration }) => {
  console.log(`Sync completed in ${duration}ms`);
});
```

## Statistics

Get aggregate statistics for transactions:

```typescript
const stats = await store.getStats({
  fromTimestamp: startOfMonth,
  walletId: 'my-wallet',
});

console.log({
  totalIn: stats.totalIn,       // Total received (sats)
  totalOut: stats.totalOut,     // Total sent (sats)
  countIn: stats.countIn,       // Number of received
  countOut: stats.countOut,     // Number of sent
  netFlow: stats.netFlow,       // totalIn - totalOut
  byType: stats.byType,         // Breakdown by type
  byUnit: stats.byUnit,         // Breakdown by currency
});
```

## Export

Export transactions to JSON or CSV:

```typescript
import { exportToJSON, exportToCSV } from '@imani/nostr-transactions';

const transactions = await store.find().thisMonth().get();

// Export to JSON
const json = exportToJSON(transactions);

// Export to CSV
const csv = exportToCSV(transactions);

// Download as file
const blob = new Blob([csv], { type: 'text/csv' });
const url = URL.createObjectURL(blob);
```

## Formatting Utilities

```typescript
import {
  formatCurrency,
  formatTimestamp,
  formatRelativeTime,
  formatPubkey,
  getTransactionTypeLabel,
} from '@imani/nostr-transactions';

// Format currency
formatCurrency(5000, 'USD', 2);  // "$50.00"
formatCurrency(1000, 'SAT', 0);  // "1,000 sats"

// Format timestamps
formatTimestamp(1704067200);           // "Jan 1, 2024, 12:00 AM"
formatRelativeTime(1704067200);        // "2 months ago"

// Format pubkey
formatPubkey('abcd1234567890...');     // "abcd1234...7890"

// Get type label
getTransactionTypeLabel('voucher_received');  // "Received"
```

## Error Handling

```typescript
import {
  TransactionError,
  StorageError,
  NotFoundError,
  ValidationError,
  SyncError,
  isTransactionError,
  isRetryableError,
} from '@imani/nostr-transactions';

try {
  await store.record(invalidInput);
} catch (error) {
  if (error instanceof ValidationError) {
    console.error('Invalid input:', error.message, error.field);
  } else if (error instanceof StorageError) {
    console.error('Storage failed:', error.message);
    if (isRetryableError(error)) {
      // Retry the operation
    }
  }
}
```

## Storage Adapters

### IndexedDB (Browser)

```typescript
import { IndexedDBAdapter } from '@imani/nostr-transactions';

const adapter = new IndexedDBAdapter({
  dbName: 'my-transactions',
  version: 1,
});
```

### Memory (Node.js/Testing)

```typescript
import { MemoryAdapter } from '@imani/nostr-transactions';

const adapter = new MemoryAdapter({
  initialData: [], // Optional seed data
});
```

### Custom Adapter

Implement the `StorageAdapter` interface:

```typescript
import type { StorageAdapter } from '@imani/nostr-transactions';

class MyCustomAdapter implements StorageAdapter {
  // Implement required methods...
}
```

## Events

Listen for transaction and sync events:

```typescript
import { TypedEventEmitter } from '@imani/nostr-transactions';

// Transaction events
store.on('transaction:added', ({ transaction }) => {
  console.log('New transaction:', transaction.id);
});

store.on('transaction:updated', ({ transaction, changes }) => {
  console.log('Updated:', transaction.id);
});

// Sync events
sync.on('sync:started', ({ direction }) => {
  showSpinner();
});

sync.on('sync:completed', ({ pushed, pulled }) => {
  hideSpinner();
  refreshUI();
});

sync.on('sync:error', ({ error }) => {
  showError(error.message);
});
```

## API Reference

### TransactionStore

| Method | Description |
|--------|-------------|
| `init()` | Initialize the store |
| `close()` | Close the store |
| `record(input)` | Record a new transaction |
| `recordBatch(inputs)` | Record multiple transactions |
| `get(id)` | Get transaction by ID |
| `getByEventId(eventId)` | Get by Nostr event ID |
| `update(id, update)` | Update a transaction |
| `delete(id)` | Delete a transaction |
| `query(filter)` | Query with filter |
| `find()` | Create query builder |
| `getAll()` | Get all transactions |
| `getRecent(limit)` | Get recent transactions |
| `getByType(type, limit)` | Get by type |
| `getByCounterparty(pubkey, limit)` | Get by counterparty |
| `count(filter)` | Count transactions |
| `exists(id)` | Check if exists |
| `clear()` | Clear all transactions |
| `getStats(filter)` | Get statistics |
| `getUnsynced()` | Get unsynced transactions |
| `markSynced(ids, eventIds)` | Mark as synced |

### RelaySync

| Method | Description |
|--------|-------------|
| `init()` | Connect to relays |
| `close()` | Disconnect |
| `push()` | Push to relays |
| `pull()` | Pull from relays |
| `full()` | Full sync |
| `getStatus()` | Get sync status |
| `on(event, handler)` | Subscribe to events |
| `setWalletDTag(tag)` | Update wallet tag |

## License

MIT
