# @imani/nostr-vouchers

A TypeScript package for managing vouchers in the Imani wallet ecosystem. Provides storage, querying, grouping, and filtering capabilities with support for shared databases.

## Features

- **VoucherStore** - CRUD operations for vouchers with event emission
- **VoucherQuery** - Fluent query builder for filtering and sorting
- **VoucherGrouper** - Group vouchers by issuer, currency, or backing strategy
- **Shared Database** - Use a single IndexedDB database across multiple packages
- **Event System** - Subscribe to voucher lifecycle events
- **Expiry Tracking** - Automatic expiry checking and notifications
- **Memory Adapter** - In-memory storage for testing and Node.js

## Installation

```bash
npm install @imani/nostr-vouchers
```

## Quick Start

```typescript
import { VoucherStore, VoucherQuery, VoucherGrouper } from '@imani/nostr-vouchers';

// Create and initialize store
const store = new VoucherStore();
await store.init();

// Add a voucher
const voucher = await store.add({
  token: 'cashuAbc...',
  faceValue: 100,
  faceUnit: 'USD',
  tokenAmount: 10000,
  backingStrategy: 'FULL',
  issuerId: 'merchant-pubkey',
  mintUrl: 'https://mint.example.com',
});

// Query vouchers
const activeVouchers = await new VoucherQuery(store)
  .active()
  .currency('USD')
  .newest()
  .limit(10)
  .get();

// Group by issuer
const byIssuer = await new VoucherGrouper(store)
  .byIssuer()
  .activeOnly()
  .sortByValue()
  .execute();
```

## API Reference

### VoucherStore

Main store class for managing vouchers.

```typescript
const store = new VoucherStore({
  storage: 'indexeddb', // or 'memory'
  dbName: 'my-vouchers',
  checkExpiryOnInit: true,
  expiryCheckInterval: 60000, // 1 minute
  expiryWarningDays: [7, 3, 1],
});

await store.init();

// CRUD operations
const voucher = await store.add(input);
const vouchers = await store.addBatch(inputs);
const found = await store.get(id);
const updated = await store.update(id, changes);
const deleted = await store.delete(id);

// Query operations
const result = await store.query({ status: 'active', limit: 10 });
const all = await store.getAll();
const count = await store.count();

// Specialized queries
const active = await store.getActive();
const expiring = await store.getExpiringSoon(7);
const byMerchant = await store.getByMerchant(issuerId);
const byCurrency = await store.getByCurrency('USD');

// Statistics
const stats = await store.getStats();

// Sync operations
const unsynced = await store.getUnsynced();
await store.markSynced(ids, eventIds);
const syncStatus = await store.getSyncStatus();

// Close when done
await store.close();
```

### VoucherQuery

Fluent query builder for complex queries.

```typescript
const query = new VoucherQuery(store);

// Status filters
query.active().spent().expired();
query.status(VoucherStatus.ACTIVE);
query.includeExpired(true);

// Entity filters
query.issuer('merchant-pubkey');
query.currency('USD');
query.backingStrategy(BackingStrategy.FULL);

// Value filters
query.minValue(100).maxValue(1000);
query.valueRange(100, 1000);
query.minTokens(10000);

// Date filters
query.expiringWithin(7);
query.createdAfter(new Date('2024-01-01'));
query.createdBetween(from, to);

// Text search
query.search('coffee');

// Sorting
query.newest().oldest();
query.highestValue().lowestValue();
query.expiringFirst();
query.sortBy('faceValue', 'desc');

// Pagination
query.limit(20).offset(40);
query.page(3, 20);

// Execution
const result = await query.execute();
const vouchers = await query.get();
const first = await query.first();
const count = await query.count();
const exists = await query.exists();
```

### VoucherGrouper

Group and aggregate vouchers.

```typescript
const grouper = new VoucherGrouper(store);

// Group by field
grouper.byIssuer();
grouper.byCurrency();
grouper.byBackingStrategy();
grouper.by('issuerId', 'faceUnit');

// Pre-filters
grouper.activeOnly();
grouper.fromIssuer(issuerId);
grouper.withCurrency('USD');
grouper.expiringWithin(7);

// Aggregations
grouper.withAllAggregations();
grouper.includeVouchers();

// Sorting
grouper.sortByValue();
grouper.sortByCount();
grouper.sortByName();
grouper.sortByExpiry();

// Limits
grouper.limit(10);
grouper.top(5);

// Execution
const result = await grouper.execute();
const groups = await grouper.get();

// Convenience functions
const byIssuer = await groupByIssuer(store);
const byCurrency = await groupByCurrency(store);
const topIssuers = await getTopIssuers(store, 5);
```

### Events

Subscribe to voucher lifecycle events.

```typescript
// Voucher events
store.on('voucher:added', ({ voucher, source }) => {});
store.on('voucher:updated', ({ voucher, previous, changes }) => {});
store.on('voucher:deleted', ({ voucherId, voucher }) => {});
store.on('voucher:batch-added', ({ vouchers, count }) => {});

// Lifecycle events
store.on('voucher:spent', ({ voucher, spentAt }) => {});
store.on('voucher:expired', ({ voucher, expiredAt }) => {});
store.on('voucher:expiring', ({ voucher, daysLeft, expiresAt }) => {});

// Store events
store.on('store:opened', ({ dbName, isShared }) => {});
store.on('store:closed', ({ dbName }) => {});

// Unsubscribe
const unsubscribe = store.on('voucher:added', handler);
unsubscribe();
// or
store.off('voucher:added', handler);
```

## Shared Database Mode

Use a single IndexedDB database across multiple packages.

```typescript
import { createSharedDatabase, VoucherStore } from '@imani/nostr-vouchers';

// Create shared database
const db = await createSharedDatabase({
  dbName: 'imani-wallet',
  version: 1,
});

// Pass to VoucherStore
const voucherStore = new VoucherStore({ database: db });
await voucherStore.init();

// Other packages can use the same database
// const autoRedemption = new AutoRedemptionService({ database: db });
```

### Database Utilities

```typescript
import {
  createSharedDatabase,
  openSharedDatabase,
  sharedDatabaseExists,
  deleteSharedDatabase,
  getSharedDatabaseInfo,
} from '@imani/nostr-vouchers';

// Check if database exists
const exists = await sharedDatabaseExists('imani-wallet');

// Open existing database
const db = await openSharedDatabase('imani-wallet');

// Get database info
const info = await getSharedDatabaseInfo('imani-wallet');
// { name: 'imani-wallet', version: 1, stores: ['vouchers', 'sync_metadata'] }

// Delete database
await deleteSharedDatabase('imani-wallet');
```

## Voucher Types

```typescript
interface Voucher {
  // Identity
  id: string;
  eventId?: string;
  token: string;

  // Face Value
  faceValue: number;
  faceUnit: string;
  faceDecimals: number;

  // Token Backing
  tokenAmount: number;
  tokenUnit: string;
  issuanceRatio: number;
  backingStrategy: BackingStrategy;

  // Status
  status: VoucherStatus;
  expiresAt?: string;
  createdAt: string;
  updatedAt?: string;

  // Merchant
  issuerId?: string;
  issuerName?: string;
  mintUrl?: string;

  // Reception
  memo?: string;
  receivedVia?: ReceptionMethod;
  senderPubkey?: string;

  // Sync
  synced: boolean;
  syncedAt?: number;
}

enum VoucherStatus {
  ACTIVE = 'active',
  SPENT = 'spent',
  EXPIRED = 'expired',
}

enum BackingStrategy {
  LEGACY = 'LEGACY',
  MINIMAL = 'MINIMAL',
  FULL = 'FULL',
}
```

## Integration with Auto-Redemption

Convert vouchers from the auto-redemption package:

```typescript
import { fromAutoRedemptionVoucher } from '@imani/nostr-vouchers';

// Convert auto-redemption voucher format
const voucher = fromAutoRedemptionVoucher({
  voucher_id: 'id-123',
  token: 'cashuAbc...',
  face_value: 100,
  face_unit: 'USD',
  face_decimals: 2,
  token_amount: 10000,
  token_unit: 'sat',
  backing_strategy: 'FULL',
  status: 'active',
  mint_url: 'https://mint.example.com',
  created_at: '2024-01-01T00:00:00Z',
});
```

## Testing

Use the memory adapter for testing:

```typescript
import { VoucherStore, MemoryAdapter } from '@imani/nostr-vouchers';

const store = new VoucherStore({
  storage: 'memory',
  expiryCheckInterval: 0,
});
await store.init();

// Run tests...

await store.close();
```

## License

MIT
