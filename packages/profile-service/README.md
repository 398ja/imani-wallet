# @imani/profile-service

A TypeScript library for Nostr profile management with search, lookup, NIP-05 resolution, follow management, and caching.

## Features

- **Profile Search** - Search profiles by query, location, merchant status, and currencies
- **Profile Lookup** - Fetch individual profiles or batches by pubkey
- **NIP-05 Resolution** - Resolve NIP-05 identifiers to pubkeys
- **Follow Management** - Follow/unfollow pubkeys with labels and sync to Nostr relays
- **Caching** - Memory and IndexedDB cache stores with TTL and LRU eviction
- **Events** - Event-driven architecture for tracking actions
- **Adapters** - Pluggable adapters for Nostr relays and APIs

## Installation

```bash
npm install @imani/profile-service
```

## Quick Start

### Browser Usage

```typescript
import { createBrowserService } from '@imani/profile-service';
import { SimplePool } from 'nostr-tools';

const pool = new SimplePool();

const profileService = createBrowserService({
  relays: ['wss://relay.damus.io', 'wss://nos.lol'],
  pool,
  onEvent: (event) => console.log('Event:', event.type),
});

// Search for profiles
const results = await profileService.search({ query: 'bitcoin' });
console.log('Found:', results.profiles.length, 'profiles');

// Get a profile
const profile = await profileService.getProfile('pubkey...');

// Follow a user
await profileService.follow('pubkey...');
```

### Node.js Usage

```typescript
import { createNodeService } from '@imani/profile-service';
import { SimplePool } from 'nostr-tools';

const pool = new SimplePool();

const profileService = createNodeService({
  relays: ['wss://relay.damus.io'],
  pool,
});

// Get a profile
const profile = await profileService.getProfile('pubkey...');
```

### Custom Configuration

```typescript
import {
  ProfileService,
  NostrLookupAdapter,
  NostrDirectoryAdapter,
  LocalFollowAdapter,
  MemoryCacheStore,
} from '@imani/profile-service';
import { SimplePool } from 'nostr-tools';

const pool = new SimplePool();
const relays = ['wss://relay.damus.io'];

const service = new ProfileService({
  lookupAdapter: new NostrLookupAdapter({ relays, pool }),
  directoryAdapter: new NostrDirectoryAdapter({ relays, pool }),
  followAdapter: new LocalFollowAdapter(),
  cache: new MemoryCacheStore({ defaultTtlMs: 5 * 60 * 1000 }),
  onEvent: (event) => console.log(event),
  defaultSearchLimit: 20,
});
```

## API Reference

### ProfileService

The main orchestration class combining all profile operations.

#### Search Operations

```typescript
// Search for profiles
const result = await service.search({
  query: 'bitcoin',
  merchantOnly: true,
  currencies: ['USD', 'BTC'],
  limit: 20,
});

// Get search suggestions
const suggestions = await service.suggest('bit');

// Iterate through all results with pagination
for await (const profiles of service.searchAll({ query: 'nostr' })) {
  console.log('Batch:', profiles.length);
}
```

#### Lookup Operations

```typescript
// Get profile by pubkey
const profile = await service.getProfile('pubkey...');

// Get profile by NIP-05 or pubkey
const profile = await service.lookupByIdentifier('user@example.com');

// Get multiple profiles
const profiles = await service.getProfiles(['pubkey1', 'pubkey2']);

// Get merchant profile (kind-30078)
const merchant = await service.getMerchantProfile('pubkey...');

// Get full profile with merchant data
const full = await service.getFullProfile('pubkey...');
```

#### Follow Operations

```typescript
// Follow a pubkey
await service.follow('pubkey...', { labels: ['friend'] });

// Unfollow
await service.unfollow('pubkey...');

// Toggle follow status
const isNowFollowing = await service.toggleFollow('pubkey...');

// Check if following
const isFollowing = await service.isFollowing('pubkey...');

// List follows
const follows = await service.listFollows();

// Get follows with profiles
const followed = await service.getFollowedProfiles();

// Get profiles with follow status
const withStatus = await service.getProfilesWithFollowStatus(['pubkey1', 'pubkey2']);
```

#### Event Subscription

```typescript
const unsubscribe = service.on((event) => {
  switch (event.type) {
    case 'followAdded':
      console.log('Followed:', event.pubkey);
      break;
    case 'followRemoved':
      console.log('Unfollowed:', event.pubkey);
      break;
    case 'searchExecuted':
      console.log('Search found:', event.resultCount, 'in', event.durationMs, 'ms');
      break;
    case 'profileViewed':
      console.log('Viewed:', event.pubkey);
      break;
    case 'cacheHit':
      console.log('Cache hit:', event.key);
      break;
  }
});

// Later: unsubscribe
unsubscribe();
```

### Adapters

#### NostrLookupAdapter

Fetches profiles from Nostr relays (kind-0 events).

```typescript
import { NostrLookupAdapter } from '@imani/profile-service';

const adapter = new NostrLookupAdapter({
  relays: ['wss://relay.damus.io'],
  pool: new SimplePool(),
  timeoutMs: 5000,
});
```

#### NostrDirectoryAdapter

Searches profiles on Nostr relays.

```typescript
import { NostrDirectoryAdapter } from '@imani/profile-service';

const adapter = new NostrDirectoryAdapter({
  relays: ['wss://relay.damus.io'],
  pool: new SimplePool(),
});
```

#### LocalFollowAdapter

Stores follows in IndexedDB for offline persistence.

```typescript
import { LocalFollowAdapter } from '@imani/profile-service';

const adapter = new LocalFollowAdapter({
  dbName: 'my-app-follows',
});
```

#### NostrFollowAdapter

Syncs follows to Nostr kind-3 contact list events.

```typescript
import { NostrFollowAdapter } from '@imani/profile-service';

const adapter = new NostrFollowAdapter({
  relays: ['wss://relay.damus.io'],
  pool: new SimplePool(),
  signer: mySigner,
  publisher: myPublisher,
});
```

#### ImaniApiAdapter

Combined lookup and directory adapter for the Imani API.

```typescript
import { ImaniApiAdapter } from '@imani/profile-service';

const adapter = new ImaniApiAdapter({
  baseUrl: 'https://api.example.com',
});
```

### Cache Stores

#### MemoryCacheStore

In-memory cache with TTL and LRU eviction.

```typescript
import { MemoryCacheStore } from '@imani/profile-service';

const cache = new MemoryCacheStore({
  defaultTtlMs: 5 * 60 * 1000, // 5 minutes
  maxSize: 1000,
});
```

#### IndexedDBCacheStore

IndexedDB cache for offline persistence.

```typescript
import { IndexedDBCacheStore } from '@imani/profile-service';

const cache = new IndexedDBCacheStore({
  name: 'profile-cache',
  defaultTtlMs: 24 * 60 * 60 * 1000, // 24 hours
  maxSize: 1000,
});
```

### Utilities

#### Validation

```typescript
import { isValidPubkey, isValidNip05, normalizePubkey } from '@imani/profile-service';

isValidPubkey('abc123...');  // true/false
isValidNip05('user@example.com');  // true/false
normalizePubkey('npub1...');  // converts to hex
```

#### Geo Utilities

```typescript
import { haversineDistance, isWithinRadius, boundingBox } from '@imani/profile-service';

// Calculate distance in km
const distance = haversineDistance(lat1, lon1, lat2, lon2);

// Check if within radius
const nearby = isWithinRadius(lat1, lon1, lat2, lon2, radiusKm);

// Get bounding box for a center point
const bbox = boundingBox(lat, lon, radiusKm);
```

## Types

### Profile

```typescript
interface Profile {
  pubkey: string;
  name?: string;
  displayName?: string;
  picture?: string;
  banner?: string;
  about?: string;
  nip05?: string;
  lud16?: string;
  website?: string;
  location?: ProfileLocation;
  currencies?: string[];
  merchantTags?: string[];
  createdAt?: number;
  metadata?: Record<string, unknown>;
}
```

### ProfileFilter

```typescript
interface ProfileFilter {
  query?: string;
  merchantOnly?: boolean;
  currencies?: string[];
  location?: LocationFilter;
  limit?: number;
  cursor?: string;
}

interface LocationFilter {
  lat: number;
  lon: number;
  radiusKm: number;
}
```

### FollowEntry

```typescript
interface FollowEntry {
  pubkey: string;
  labels: string[];
  createdAt: number;
  source: 'local' | 'nostr' | 'import';
}
```

## License

MIT
