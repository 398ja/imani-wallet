# Nostr Voucher Storage Design for Imani Wallet

**Date**: 2025-11-18
**Status**: Design Phase
**Author**: Claude Code

## Executive Summary

This document outlines the design for implementing Nostr-based voucher storage in Imani Wallet based on analysis of cashu-client's proven architecture. The design uses a hybrid approach with Nostr as the source of truth and IndexedDB as a local cache for offline access.

---

## 1. cashu-client Architecture Analysis

### 1.1 Core Components

#### NostrGatewayService (927 lines)
The main service coordinating all Nostr relay operations:

**Key Capabilities:**
- **Connection Management**
  - Multi-relay connectivity with circuit breaker pattern (Resilience4j)
  - Health monitoring and automatic relay eviction
  - Relay re-evaluation and recovery
  - NIP-42 AUTH support (optional per relay)

- **Publishing Events**
  ```java
  void publish(NostrEvent event)
  void publish(NostrEvent event, Collection<String> relayUrls)
  ```
  - Publishes to configured relays
  - Circuit breaker fault tolerance
  - Per-relay health tracking

- **Querying Events**
  ```java
  List<NostrEvent> queryEvents(NostrServerSideFilter filter, Duration timeout)
  ```
  - Synchronous query with timeout
  - Deduplicates events from multiple relays
  - Thread-safe with ConcurrentHashMap

- **Subscribing to Events**
  ```java
  AutoCloseable subscribe(String name, NostrServerSideFilter serverFilter, Consumer<NostrEvent> consumer)
  ```
  - Real-time event subscriptions
  - Automatic signature verification
  - Filter-based event selection

- **Relay Selection**
  - Segregated read/write relay pools
  - Pluggable selection policies (RANDOM, STICKY, etc.)
  - Health-based relay selection

- **Security**
  - Signature verification on all received events
  - IdentityKey and WalletSigningKey integration
  - Per-relay authentication (NIP-42)

- **Health & Telemetry**
  - RelayHealthMonitor: tracks connection success rate, operation latency
  - RelayReEvaluator: manages evicted relays and retry logic
  - RelayTelemetryCollector: aggregated stats (opt-in)
  - Persists health state across restarts

#### NostrEventAdapter (247 lines)
Converts between wallet's NostrEvent and nostr-java's GenericEvent:

**Conversion Mapping:**
| Wallet Format | nostr-java Format |
|--------------|------------------|
| `id` (String) | `id` (String) |
| `pubkey` (hex String) | `pubKey` (PublicKey object) |
| `kind` (int) | `kind` (int) |
| `content` (String) | `content` (String) |
| `createdAt` (Instant) | `createdAt` (Long epoch seconds) |
| `tags` (List&lt;List&lt;String&gt;&gt;) | `tags` (List&lt;BaseTag&gt;) |
| `sig` (hex String) | `signature` (Signature object) |

**Key Methods:**
- `toNostrJavaEvent(NostrEvent walletEvent)` - Wallet → nostr-java
- `toWalletEvent(GenericEvent nostrEvent)` - nostr-java → Wallet

#### VoucherLedgerAdapter (251 lines)
Bridges wallet services to cashu-voucher library's VoucherLedgerPort:

**Architecture Flow:**
```
VoucherServiceImpl (cashu-client)
    ↓
VoucherLedgerAdapter
    ├─> VoucherConverter: StoredVoucher ↔ SignedVoucher
    ├─> WalletNostrClientAdapter: NostrGatewayService → NostrClientAdapter
    └─> NostrVoucherLedgerRepository (cashu-voucher library)
```

**Key Methods:**
- `publishVoucher(StoredVoucher voucher, VoucherStatus status)` - Publish to Nostr ledger
- `queryStatus(String voucherId)` - Query current status
- `updateStatus(String voucherId, VoucherStatus newStatus)` - Update status (NIP-33 replacement)
- `queryVoucher(String voucherId)` - Retrieve full voucher
- `exists(String voucherId)` - Check if voucher exists

#### VoucherConverter (126 lines)
Converts between wallet's StoredVoucher and cashu-voucher's SignedVoucher:

**Data Model Differences:**
| StoredVoucher (Wallet) | SignedVoucher (cashu-voucher) |
|----------------------|------------------------------|
| Hex-encoded signature | Byte array signature |
| Tracks status and timestamp | Focus on cryptographic verification |
| Includes `issuedAt`, `status` | Uses VoucherSecret domain model |

### 1.2 Nostr Event Schema

#### Current Implementation (NIP-33 Replaceable Events)

**Event Kind**: `30078` (NIP-33 Parameterized Replaceable Event)

**Event Structure:**
```json
{
  "kind": 30078,
  "pubkey": "<issuer_pubkey_hex>",
  "created_at": <unix_timestamp>,
  "content": "<JSON_encoded_voucher_data>",
  "tags": [
    ["d", "<voucher_id>"],           // NIP-33 identifier
    ["status", "ISSUED|DELIVERED|REDEEMED|REVOKED|EXPIRED"],
    ["mint", "<mint_url>"],
    ["unit", "<sat|msat|usd|etc>"],
    ["amount", "<face_value>"],
    ["expiry", "<expires_at_timestamp>"] // optional
  ],
  "sig": "<event_signature>"
}
```

**Key Properties:**
- **Replaceable**: Status updates replace previous events (same voucher ID)
- **Queryable**: Filter by `d` tag (voucher ID), status, mint, etc.
- **Verifiable**: Event signatures ensure authenticity
- **Decentralized**: No single point of failure

#### Proposed Event Kinds (Future Enhancement)

From cashu-client docs, proposed specialized event kinds:

| Event Kind | Name | Description | Published By |
|------------|------|-------------|--------------|
| 38400 | Issue | Voucher creation | Issuer |
| 38401 | Redeem | Voucher redemption | Redeemer |
| 38402 | Revoke | Voucher cancellation | Issuer |

**Decision**: Start with NIP-33 (kind 30078) for simplicity, migrate to specialized kinds in Phase 3.

---

## 2. Imani Wallet Integration Strategy

### 2.1 Kotlin Multiplatform Challenges

**Problem**: NostrGatewayService is Java (JVM-only), but Imani Wallet targets both JVM and JS.

**Solution**: Expect/Actual pattern with platform-specific implementations:

```kotlin
// commonMain
expect class NostrVoucherClient {
    suspend fun publishVoucher(voucher: StoredVoucher): Result<Unit>
    suspend fun queryVoucher(voucherId: String): Result<StoredVoucher?>
    suspend fun queryVouchersByStatus(status: VoucherStatus): Result<List<StoredVoucher>>
    suspend fun updateVoucherStatus(voucherId: String, status: VoucherStatus): Result<Unit>
}

expect fun createNostrVoucherClient(): NostrVoucherClient
```

### 2.2 JVM Implementation

**Strategy**: Directly use cashu-client's NostrGatewayService:

```kotlin
// jvmMain
actual class NostrVoucherClient(
    private val gateway: NostrGatewayService
) {
    actual suspend fun publishVoucher(voucher: StoredVoucher): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val event = createVoucherEvent(voucher)
                gateway.publish(event)
            }
        }

    actual suspend fun queryVoucher(voucherId: String): Result<StoredVoucher?> =
        withContext(Dispatchers.IO) {
            runCatching {
                val filter = NostrFilterBuilder()
                    .kind(30078)
                    .tag("d", voucherId)
                    .build()

                val events = gateway.queryEvents(filter, Duration.ofSeconds(3))
                events.firstOrNull()?.let { parseVoucherEvent(it) }
            }
        }
}
```

### 2.3 JS Implementation

**Strategy**: Implement custom Nostr client using WebSockets:

**Options:**
1. **nostr-tools** (TypeScript library) - Recommended
2. **Custom WebSocket implementation** - More control, more work

**Recommended: nostr-tools integration**

```kotlin
// jsMain
actual class NostrVoucherClient {
    private val relayPool: dynamic // nostr-tools SimplePool

    actual suspend fun publishVoucher(voucher: StoredVoucher): Result<Unit> =
        suspendCoroutine { continuation ->
            val event = createVoucherEvent(voucher)
            relayPool.publish(relayUrls.toTypedArray(), event)
                .then {
                    continuation.resume(Result.success(Unit))
                }
                .catch { error ->
                    continuation.resume(Result.failure(Exception(error.toString())))
                }
        }
}
```

**External Declaration** (for nostr-tools):
```kotlin
@JsModule("nostr-tools")
@JsNonModule
external object NostrTools {
    class SimplePool {
        fun publish(relays: Array<String>, event: dynamic): Promise<Unit>
        fun querySync(relays: Array<String>, filter: dynamic): Array<dynamic>
        fun subscribeMany(
            relays: Array<String>,
            filters: Array<dynamic>,
            callbacks: dynamic
        ): dynamic
    }
}
```

### 2.4 Hybrid Storage Architecture

**Design**: Nostr as source of truth + IndexedDB cache for offline access

```
┌─────────────────────────────────────────┐
│      NostrVoucherRepository             │
│  (Implements VoucherRepository)         │
├─────────────────────────────────────────┤
│                                         │
│  ┌─────────────┐    ┌──────────────┐  │
│  │   Nostr     │◄──►│  IndexedDB   │  │
│  │  (Remote)   │    │   (Cache)    │  │
│  └─────────────┘    └──────────────┘  │
│       ▲                    ▲           │
│       │                    │           │
│  ┌────┴────────────────────┴───────┐  │
│  │  NostrVoucherClient (expect)    │  │
│  │  - JVM: NostrGatewayService     │  │
│  │  - JS: nostr-tools WebSocket    │  │
│  └─────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

**Operations Flow:**

1. **Save Voucher**:
   - Publish to Nostr relays
   - On success: Save to IndexedDB cache
   - On failure: Queue for retry

2. **Load Vouchers**:
   - Return cached data immediately (fast)
   - Background sync from Nostr
   - Merge and update cache

3. **Update Status**:
   - Publish replacement event (NIP-33)
   - Update IndexedDB on confirmation
   - Handle conflicts (first-write-wins)

4. **Offline Mode**:
   - Use IndexedDB cache
   - Queue operations for sync
   - Retry when connection restored

### 2.5 IndexedDB Schema

**JS Platform Only** (JVM uses in-memory or file-based storage):

```typescript
// IndexedDB Schema
const voucherStore = {
  name: "vouchers",
  keyPath: "voucherId",
  indexes: [
    { name: "status", keyPath: "status" },
    { name: "issuerId", keyPath: "issuerId" },
    { name: "mint", keyPath: "mint" },
    { name: "issuedAt", keyPath: "issuedAt" },
    { name: "syncStatus", keyPath: "_syncStatus" }
  ]
}

// Voucher Object Structure
interface CachedVoucher {
  // StoredVoucher fields
  voucherId: string
  issuerId: string
  mint: string
  unit: string
  faceValue: number
  expiresAt?: number
  memo?: string
  issuerSignature: string
  issuerPublicKey: string
  issuedAt: string // ISO-8601
  status: string
  token?: string

  // Cache metadata
  _syncStatus: "synced" | "pending" | "conflict"
  _lastSyncAt: string // ISO-8601
  _nostrEventId?: string
}
```

---

## 3. Implementation Phases

### Phase 1: NostrVoucherClient (expect/actual)

**Tasks:**
1. Define expect interface in commonMain
2. Implement JVM actual using NostrGatewayService
3. Implement JS actual using nostr-tools
4. Add relay configuration
5. Unit tests for both platforms

**Deliverables:**
- `NostrVoucherClient.kt` (commonMain)
- `NostrVoucherClient.jvm.kt` (jvmMain)
- `NostrVoucherClient.js.kt` (jsMain)
- NostrTools external declarations

### Phase 2: NostrVoucherRepository with IndexedDB Cache

**Tasks:**
1. Create NostrVoucherRepository implementing VoucherRepository
2. Add IndexedDB cache layer (JS platform)
3. Implement sync strategy (background sync)
4. Add conflict resolution (first-write-wins)
5. Implement offline queue
6. Integration tests

**Deliverables:**
- `NostrVoucherRepository.kt` (commonMain)
- `IndexedDBVoucherCache.js.kt` (jsMain)
- Background sync worker
- Retry queue mechanism

### Phase 3: Advanced Features

**Tasks:**
1. Multi-relay publishing (redundancy)
2. Relay health monitoring
3. Event history tracking
4. Double-spend detection
5. Migration to specialized event kinds (38400-38402)
6. Subscription-based real-time updates

**Deliverables:**
- Relay health UI
- Event history viewer
- Double-spend alerts
- Real-time voucher updates

---

## 4. Nostr Configuration

### 4.1 Relay Selection

**Default Relays** (for testing):
```kotlin
val defaultRelays = listOf(
    "wss://relay.damus.io",
    "wss://relay.snort.social",
    "wss://nos.lol",
    "wss://relay.nostr.band"
)
```

**Production Considerations:**
- Use paid relays for reliability
- Segregate read/write relays for performance
- NIP-42 AUTH for private relays
- Geographic distribution for latency

### 4.2 Event Filters

**Query All Vouchers by Issuer:**
```json
{
  "kinds": [30078],
  "authors": ["<issuer_pubkey>"],
  "#d": [] // All d tags (voucher IDs)
}
```

**Query Specific Voucher:**
```json
{
  "kinds": [30078],
  "#d": ["<voucher_id>"]
}
```

**Query by Status:**
```json
{
  "kinds": [30078],
  "authors": ["<issuer_pubkey>"],
  "#status": ["ISSUED"]
}
```

---

## 5. Security Considerations

### 5.1 Event Signature Verification

**Always verify** event signatures before trusting data:
```kotlin
fun verifyVoucherEvent(event: NostrEvent): Boolean {
    return NostrEventVerifier.verify(event, event.sig).isValid()
}
```

### 5.2 Voucher Signature Verification

**Separate from event signature** - verifies issuer authority:
```kotlin
fun verifyVoucherSignature(voucher: StoredVoucher): Boolean {
    val message = buildVoucherMessage(voucher)
    return cryptoAdapter.verifySchnorr(
        message = message.toByteArray(),
        signature = voucher.issuerSignature.hexToBytes(),
        publicKey = voucher.issuerPublicKey.hexToBytes()
    )
}
```

### 5.3 Privacy Considerations

**Current Approach** (NIP-33):
- Voucher data is **public** on Nostr
- Anyone can query voucher status
- Suitable for public vouchers (gift cards, tickets)

**Future Enhancement** (NIP-04 Encrypted DMs):
- Encrypt voucher content for privacy
- Only issuer and recipient can read
- Requires key exchange

---

## 6. Migration Path

### 6.1 From In-Memory to Nostr

**Current State**: InMemoryVoucherRepository (Phase 2)

**Migration Steps:**
1. Keep in-memory repository for Phase 2 testing
2. Implement NostrVoucherRepository in parallel
3. Add feature flag to switch between implementations
4. Migrate existing vouchers to Nostr
5. Deprecate in-memory implementation

### 6.2 Data Migration

**Challenge**: Existing vouchers in local storage need Nostr events

**Solution**:
```kotlin
suspend fun migrateToNostr(localVouchers: List<StoredVoucher>) {
    localVouchers.forEach { voucher ->
        // Publish to Nostr
        nostrClient.publishVoucher(voucher).onSuccess {
            // Mark as migrated
            localRepository.markAsMigrated(voucher.voucherId)
        }
    }
}
```

---

## 7. Testing Strategy

### 7.1 Unit Tests

**NostrVoucherClient Tests:**
- Publish voucher event
- Query voucher by ID
- Query vouchers by status
- Update voucher status (NIP-33 replacement)
- Handle relay failures
- Signature verification

### 7.2 Integration Tests

**NostrVoucherRepository Tests:**
- Save and retrieve voucher
- Cache synchronization
- Offline queue
- Conflict resolution
- Multi-relay publishing

### 7.3 E2E Tests

**Full Flow Tests:**
1. Issue voucher → Publish to Nostr → Query from different client
2. Update status → Verify replacement event
3. Offline mode → Queue operations → Sync when online
4. Multi-device sync → Same identity on two devices

---

## 8. Performance Considerations

### 8.1 Query Optimization

**Challenge**: Querying all vouchers can be slow

**Solutions:**
1. **Local Cache First**: Always return cached data immediately
2. **Background Sync**: Update cache in background
3. **Pagination**: Limit query results with `limit` and `until` filters
4. **Incremental Sync**: Only query events after last sync timestamp

### 8.2 Relay Selection

**Best Practices:**
- Use 2-3 reliable relays (not 10+)
- Prefer relays with low latency
- Monitor relay health and auto-evict slow relays
- Use circuit breakers to prevent cascading failures

### 8.3 IndexedDB Performance

**Optimizations:**
- Index frequently queried fields (status, issuerId)
- Batch writes for bulk operations
- Use transactions for consistency
- Implement LRU cache eviction for old vouchers

---

## 9. Open Questions

### 9.1 Voucher Discovery

**Question**: How do recipients discover vouchers sent to them?

**Options:**
1. **P2PK Tag**: Add `["p", "<recipient_pubkey>"]` tag
2. **Separate Delivery Event**: Publish kind 14 (DM) with voucher token
3. **Out-of-Band**: Share token via QR code / link (current Phase 2 approach)

**Decision**: Phase 2 uses out-of-band sharing, Phase 3 adds Nostr discovery

### 9.2 Double-Spend Prevention

**Question**: How to prevent voucher double-spending via Nostr?

**cashu-client Approach**:
- First-redemption-wins rule
- Query ledger before accepting redemption
- Detect rapid status changes (issued → redeemed multiple times)

**Imani Wallet Approach**: Adopt same strategy + mint-side proof state checking

### 9.3 Relay Costs

**Question**: Should we use paid relays for production?

**Considerations:**
- Free relays may drop events or have downtime
- Paid relays offer SLAs and persistence guarantees
- Cost: ~$5-20/month per relay

**Recommendation**: Start with free relays, upgrade to paid for production

---

## 10. References

### 10.1 Nostr NIPs

- **NIP-01**: Basic protocol flow description
- **NIP-33**: Parameterized Replaceable Events (kind 30000-39999)
- **NIP-42**: Authentication of clients to relays
- **NIP-04**: Encrypted Direct Messages (future privacy)

### 10.2 cashu-client Documentation

- [Voucher Implementation Tasks](docs/testing/voucher-implementation-tasks.md)
- [Task 4: Voucher Status Refresh Plan](docs/testing/task-4-voucher-status-refresh-plan.md)

### 10.3 External Libraries

- **nostr-tools** (JS): https://github.com/nbd-wtf/nostr-tools
- **nostr-java** (JVM): https://github.com/tcheeric/nostr-java
- **Resilience4j**: Circuit breaker library

---

## 11. Next Steps

1. **Review this design** with the user
2. **Implement Phase 1**: NostrVoucherClient (expect/actual)
3. **Test on both platforms**: JVM and JS
4. **Implement Phase 2**: NostrVoucherRepository with IndexedDB cache
5. **Replace InMemoryVoucherRepository**: Use NostrVoucherRepository in app

---

## Appendix A: Event Example

### Published Voucher Event (NIP-33)

```json
{
  "id": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "pubkey": "02a1633cafe06f69d3b1b5d7c8d6e3e5f4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0",
  "kind": 30078,
  "created_at": 1700000000,
  "content": "{\"voucherId\":\"voucher_abc123\",\"issuerId\":\"issuer_xyz\",\"mint\":\"https://testnut.cashu.space\",\"unit\":\"sat\",\"faceValue\":1000,\"memo\":\"Test voucher\",\"issuerSignature\":\"304402...\",\"issuerPublicKey\":\"02a163...\"}",
  "tags": [
    ["d", "voucher_abc123"],
    ["status", "ISSUED"],
    ["mint", "https://testnut.cashu.space"],
    ["unit", "sat"],
    ["amount", "1000"]
  ],
  "sig": "30440220..."
}
```

### Query Filter

```json
{
  "kinds": [30078],
  "authors": ["02a1633cafe06f69d3b1b5d7c8d6e3e5f4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0"],
  "#d": ["voucher_abc123"]
}
```

---

**End of Document**
