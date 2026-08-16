# @imani/nostr-transactions Examples

This directory contains example applications demonstrating how to use the `@imani/nostr-transactions` library.

## Browser Example

Interactive web application showing transaction management with IndexedDB storage.

### Features Demonstrated
- Transaction recording
- Fluent query builder
- Statistics dashboard
- Filtering and search
- Export to JSON

### Running

1. Build the library first:
   ```bash
   cd ../..
   npm run build
   ```

2. Serve the example:
   ```bash
   npx serve examples/browser
   # Or use any static file server
   ```

3. Open http://localhost:3000 in your browser

## Node.js Example

Command-line example showing the library with the memory adapter.

### Features Demonstrated
- Memory adapter usage
- Batch transaction recording
- Fluent query builder
- Statistics calculation
- Pagination
- Export to JSON/CSV

### Running

1. Build the library first:
   ```bash
   cd ../..
   npm run build
   ```

2. Run the example:
   ```bash
   cd examples/node
   npm install
   npm start
   ```

## Usage Patterns

### Basic Store Setup

```typescript
import { TransactionStore, TransactionType, TransactionDirection } from '@imani/nostr-transactions';

// Browser (IndexedDB)
const browserStore = new TransactionStore({
  storage: 'indexeddb',
  dbName: 'my-wallet-transactions',
});

// Node.js (Memory)
const nodeStore = new TransactionStore({
  storage: 'memory',
});

await store.init();
```

### Recording Transactions

```typescript
// Single transaction
await store.record({
  type: TransactionType.RECEIVED,
  direction: TransactionDirection.IN,
  tokenAmount: 1000,
  faceValue: 5000,
  faceUnit: 'USD',
  faceDecimals: 2,
  counterpartyName: 'Alice',
  memo: 'Payment',
});

// Batch
await store.recordBatch([
  { type: TransactionType.RECEIVED, ... },
  { type: TransactionType.SENT, ... },
]);
```

### Querying with Fluent API

```typescript
// Simple queries
const received = await store.find().received().get();
const sent = await store.find().sent().get();

// Complex queries
const results = await store.find()
  .received()
  .counterparty('alice-pubkey')
  .thisMonth()
  .minAmount(1000)
  .newest()
  .limit(20)
  .execute();

// Get first match
const first = await store.find().received().largest().first();

// Count
const count = await store.find().thisWeek().count();

// Check existence
const hasRecent = await store.find().today().exists();

// Get statistics
const stats = await store.find().thisMonth().stats();
```

### Relay Sync

```typescript
import { RelaySync, createRelaySync } from '@imani/nostr-transactions';

const sync = createRelaySync(store, {
  pubkey: 'your-pubkey-hex',
  signer: window.nostr, // NIP-07 signer
  relayUrls: ['wss://relay.damus.io'],
  walletDTag: 'my-wallet',
  encryption: true,
});

await sync.init();

// Push local changes
await sync.push();

// Pull remote changes
await sync.pull();

// Full sync
await sync.full();

// Get status
const status = sync.getStatus();
console.log(`Pending: ${status.pendingCount}`);
```

### Event Handling

```typescript
// Transaction events
store.on('transaction:added', ({ transaction }) => {
  console.log('New:', transaction.id);
});

// Sync events
sync.on('sync:progress', ({ percentage }) => {
  console.log(`Syncing: ${percentage}%`);
});

sync.on('sync:completed', ({ pushed, pulled }) => {
  console.log(`Done: ${pushed} pushed, ${pulled} pulled`);
});
```

### Error Handling

```typescript
import { ValidationError, StorageError, isRetryableError } from '@imani/nostr-transactions';

try {
  await store.record(input);
} catch (error) {
  if (error instanceof ValidationError) {
    console.error('Invalid input:', error.field);
  } else if (isRetryableError(error)) {
    // Retry operation
  }
}
```
