# Nostr Integration for Voucher Storage

This document describes the Nostr-based voucher storage implementation in the Imani Voucher module.

## Overview

Vouchers are stored on Nostr relays using **NIP-33 Parameterized Replaceable Events**. This provides:

- **Decentralized storage**: No single point of failure
- **Multi-device sync**: Access vouchers from any device
- **Censorship resistance**: Distributed relay network
- **Event replacement**: Status updates replace previous events

## Architecture

### Platform-Specific Implementations

The `NostrVoucherClient` uses Kotlin Multiplatform's `expect/actual` pattern:

**JVM (`NostrVoucherClient.jvm.kt`)**:
- **Current (Phase 2)**: Supports both in-memory (testing) and real relay modes
- Uses cashu-client's `wallet-core-nostr` module for real relay connections
- Uses coroutines for async relay operations
- Full relay health monitoring and event verification available

**Relay Mode Selection** (JVM):
- `NOSTR_USE_REAL_RELAYS=true`: Connect to real relays (including localhost)
- `NOSTR_USE_REAL_RELAYS=false`: Force in-memory mode (unit tests)
- Not set: Auto-detect (in-memory for localhost, real for public relays)

**JS (`NostrVoucherClient.js.kt`)**:
- **Current**: Native WebSocket-based Nostr client using browser WebSocket API
- Uses `WebSocketRelay` class for relay communication
- Supports all major browsers with WebSocket support

### Event Format (NIP-33)

Vouchers are stored as kind `30078` events:

```json
{
  "kind": 30078,
  "pubkey": "<issuer_public_key_hex>",
  "created_at": <unix_timestamp>,
  "content": "<JSON_encoded_StoredVoucher>",
  "tags": [
    ["d", "<voucher_id>"],           // NIP-33 identifier
    ["status", "ISSUED|DELIVERED|REDEEMED|REVOKED|EXPIRED"],
    ["unit", "sat"],
    ["amount", "<face_value>"]
  ],
  "sig": "<event_signature>"
}
```

## Configuration

### Default Relays

Configured in `NostrConfig.kt`:

```kotlin
val DEFAULT_RELAYS = listOf(
    "wss://relay.398ja.xyz"
)
```

### Custom Relays

Users can specify custom relays when creating a client:

```kotlin
val client = createNostrVoucherClient(
    relayUrls = listOf("wss://my-relay.com")
)
```

## Usage

### Publishing a Voucher

```kotlin
val client = createNostrVoucherClient(NostrConfig.DEFAULT_RELAYS)

val voucher = StoredVoucher(
    voucherId = "voucher_123",
    issuerId = "issuer_456",
    // ... other fields
)

client.publishVoucher(voucher).onSuccess {
    println("Voucher published to Nostr")
}
```

### Querying Vouchers

```kotlin
// Query by ID
client.queryVoucher("voucher_123").onSuccess { voucher ->
    if (voucher != null) {
        println("Found voucher: ${voucher.memo}")
    }
}

// Query by status
client.queryVouchersByStatus(VoucherStatus.ISSUED).onSuccess { vouchers ->
    println("Found ${vouchers.size} issued vouchers")
}

// Query by issuer
client.queryVouchersByIssuer(issuerPubkey).onSuccess { vouchers ->
    println("Issuer has ${vouchers.size} vouchers")
}
```

### Updating Status

```kotlin
// Update voucher status (publishes replacement event)
client.updateVoucherStatus("voucher_123", VoucherStatus.REDEEMED)
    .onSuccess {
        println("Voucher status updated")
    }
```

## JS Platform: Library Compatibility Issues

### Why Not nostr-tools?

We attempted to use `nostr-tools` (v2.1.0+) but encountered fundamental incompatibilities:

1. **ESM/CommonJS Conflict**: nostr-tools exports as ESM, but Kotlin/JS `@JsModule` requires `@JsNonModule` for UMD compatibility
2. **Named Export Issue**: `SimplePool` is exported as a named export, not a constructor accessible via `@JsModule`
3. **Webpack Configuration**: Even with ESM-preferring webpack config (`mainFields: ['browser', 'module', 'main']`), the library doesn't work with Kotlin/JS interop

### Why Not nostrify?

We also evaluated `@nostrify/nostrify` as an alternative:

1. **JSR Dependencies**: nostrify depends on Deno's JSR packages (`@jsr/std__encoding`)
2. **npm Unavailability**: JSR packages are not available on npm registry
3. **Registry Error**: `yarn install` fails with "https://registry.yarnpkg.com/@jsr%2fstd__encoding: Not found"

### Solution: Native WebSocket Client (Phase 3)

Since existing libraries don't work with Kotlin/JS, we'll implement a native WebSocket-based Nostr client using the browser's built-in WebSocket API. See [Phase 3: JS WebSocket Client](#phase-3-js-websocket-client-implementation) below.

## Phase 2 Limitations

Current limitations (to be addressed in Phase 3):

1. **Simplified Event Signing**: Events reuse voucher signatures instead of proper Nostr event signing
2. **No Signature Verification**: Received events are not cryptographically verified
3. **JVM In-Memory**: JVM implementation doesn't connect to actual relays
4. **No Retry Logic**: Failed relay operations are not retried
5. **No Health Monitoring**: No relay health checks or automatic failover

## Phase 3: JVM Integration with cashu-client

The JVM platform can leverage `wallet-core-nostr` from cashu-client for full Nostr relay functionality.

**Current Status**: Dependency added, in-memory implementation for testing. Real relay integration planned.

### Dependency (Already Added)

```kotlin
// imani-voucher/build.gradle.kts
implementation("xyz.tcheeric:wallet-core-nostr:1.2.0") {
    exclude(group = "org.springframework")
    exclude(group = "org.springframework.boot")
}
```

### Available Components from wallet-core-nostr

| Class | Purpose |
|-------|---------|
| `NostrGatewayService` | Main service for publishing/querying events |
| `NostrRelayClient` | Low-level relay connection |
| `NostrFilterBuilder` | Build NIP-01 filters |
| `NostrEventVerifier` | Signature verification |
| `RelayHealthMonitor` | Monitor relay health metrics |
| `RelaySelectionPolicy` | Choose optimal relays |
| `InMemoryRelayClientFactory` | In-memory relay for testing |

### Integration Plan

To enable real relay connectivity, update `NostrVoucherClient.jvm.kt`:

```kotlin
// Phase 3: Replace in-memory with real relay
import xyz.tcheeric.wallet.core.nostr.NostrGatewayService
import xyz.tcheeric.wallet.core.nostr.filter.NostrFilterBuilder

actual class NostrVoucherClient(relayUrls: List<String>) {
    private val gateway = NostrGatewayService.createDefault()

    init {
        gateway.start()
    }

    actual suspend fun publishVoucher(voucher: StoredVoucher): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val event = NostrEvent.unsigned(
                    voucher.issuerPublicKey,
                    30078, // NIP-33 kind
                    Json.encodeToString(voucher),
                    Instant.now(),
                    listOf(listOf("d", voucher.voucherId), ...)
                )
                gateway.publish(event)
            }
        }

    actual suspend fun queryVoucher(voucherId: String): Result<StoredVoucher?> =
        withContext(Dispatchers.IO) {
            runCatching {
                val filter = NostrFilterBuilder.newBuilder()
                    .kinds(30078)
                    .tag("d", voucherId)
                    .limit(1)
                    .build()
                gateway.queryEvents(filter, Duration.ofSeconds(5))
                    .firstOrNull()?.let { Json.decodeFromString(it.content) }
            }
        }
}
```

### Features Available via cashu-client

1. **Relay Health Monitoring**: `RelayHealthMonitor` tracks latency, success rates
2. **Smart Relay Selection**: `RelaySelectionPolicy` picks optimal relays
3. **Event Verification**: `NostrEventVerifier` validates Schnorr signatures
4. **Retry Logic**: Built-in retry with exponential backoff
5. **Connection Pooling**: Efficient WebSocket connection reuse

---

## Phase 3: JS WebSocket Client Implementation

Since third-party Nostr libraries (nostr-tools, nostrify) have compatibility issues with Kotlin/JS, Phase 3 will implement a native WebSocket-based Nostr client for the browser.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    NostrVoucherClient.js.kt                  │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐  │
│  │  WebSocketRelay │  │  WebSocketRelay │  │ WebSocket.. │  │
│  │  (relay1.com)   │  │  (relay2.com)   │  │ (relay3..)  │  │
│  └────────┬────────┘  └────────┬────────┘  └──────┬──────┘  │
│           │                    │                   │         │
│           └────────────────────┼───────────────────┘         │
│                                ▼                             │
│                    ┌───────────────────┐                    │
│                    │    RelayPool      │                    │
│                    │  - connect()      │                    │
│                    │  - publish()      │                    │
│                    │  - subscribe()    │                    │
│                    │  - healthCheck()  │                    │
│                    └───────────────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

### Core Components

#### 1. WebSocketRelay

Single relay connection manager using browser WebSocket API:

```kotlin
// imani-voucher/jsMain/kotlin/cash/imani/voucher/nostr/WebSocketRelay.kt
class WebSocketRelay(private val url: String) {
    private var ws: WebSocket? = null
    private val subscriptions = mutableMapOf<String, (NostrEvent) -> Unit>()

    suspend fun connect(): Result<Unit>
    suspend fun publish(event: SignedNostrEvent): Result<Unit>
    fun subscribe(filter: NostrFilter, onEvent: (NostrEvent) -> Unit): String
    fun unsubscribe(subscriptionId: String)
    fun close()
}
```

#### 2. RelayPool

Multi-relay connection pool with health monitoring:

```kotlin
// imani-voucher/jsMain/kotlin/cash/imani/voucher/nostr/RelayPool.kt
class RelayPool(private val relayUrls: List<String>) {
    private val relays = mutableMapOf<String, WebSocketRelay>()

    suspend fun connectAll(): Result<Unit>
    suspend fun publishToAll(event: SignedNostrEvent): Result<Int> // Returns success count
    suspend fun queryFirst(filter: NostrFilter, timeout: Duration): NostrEvent?
    suspend fun queryAll(filter: NostrFilter, timeout: Duration): List<NostrEvent>
    fun close()
}
```

#### 3. NostrEventBuilder

NIP-01 compliant event construction and signing:

```kotlin
// imani-voucher/jsMain/kotlin/cash/imani/voucher/nostr/NostrEventBuilder.kt
class NostrEventBuilder(private val cryptoAdapter: CryptoAdapter) {

    fun createVoucherEvent(voucher: StoredVoucher, privateKey: String): SignedNostrEvent {
        val event = NostrEvent(
            kind = 30078,  // NIP-33 Parameterized Replaceable
            pubkey = derivePublicKey(privateKey),
            created_at = Clock.System.now().epochSeconds,
            content = Json.encodeToString(voucher),
            tags = listOf(
                listOf("d", voucher.voucherId),
                listOf("status", voucher.status.name),
                listOf("unit", voucher.unit),
                listOf("amount", voucher.faceValue.toString())
            )
        )

        val eventId = computeEventId(event)  // SHA-256 of serialized event
        val signature = cryptoAdapter.schnorrSign(privateKey, eventId)

        return SignedNostrEvent(event, eventId.toHex(), signature.toHex())
    }

    private fun computeEventId(event: NostrEvent): ByteArray {
        // NIP-01: SHA-256 of [0, pubkey, created_at, kind, tags, content]
        val serialized = Json.encodeToString(listOf(
            0,
            event.pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content
        ))
        return sha256(serialized.encodeToByteArray())
    }
}
```

### Nostr Protocol Messages

#### Client → Relay

```text
EVENT - Publish event
["EVENT", { "id": "...", "pubkey": "...", "sig": "...", ... }]

REQ - Subscribe to events
["REQ", "subscription_id", { "kinds": [30078], "#d": ["voucher_123"] }]

CLOSE - Unsubscribe
["CLOSE", "subscription_id"]
```

#### Relay → Client

```text
EVENT - Received event
["EVENT", "subscription_id", { "id": "...", "content": "...", ... }]

OK - Event accepted/rejected
["OK", "event_id_hex", true, ""]

EOSE - End of stored events
["EOSE", "subscription_id"]

NOTICE - Relay message
["NOTICE", "message text"]
```

### Implementation Plan

| Task | Description | Effort |
|------|-------------|--------|
| 3.1 | WebSocketRelay: Basic connect/disconnect | 1 day |
| 3.2 | WebSocketRelay: Publish and receive events | 1 day |
| 3.3 | WebSocketRelay: Subscription management | 1 day |
| 3.4 | RelayPool: Multi-relay connection | 1 day |
| 3.5 | RelayPool: Health monitoring and failover | 1 day |
| 3.6 | NostrEventBuilder: NIP-01 event ID and signing | 1 day |
| 3.7 | NostrEventBuilder: Signature verification | 0.5 day |
| 3.8 | Integration: Replace stub with WebSocket client | 0.5 day |
| 3.9 | Testing: Unit and integration tests | 2 days |

**Total Effort**: ~10 days

### Browser WebSocket API Usage

```kotlin
// External declaration for browser WebSocket
external class WebSocket(url: String) {
    var onopen: ((Event) -> Unit)?
    var onmessage: ((MessageEvent) -> Unit)?
    var onerror: ((Event) -> Unit)?
    var onclose: ((CloseEvent) -> Unit)?
    val readyState: Short
    fun send(data: String)
    fun close(code: Short = definedExternally, reason: String = definedExternally)

    companion object {
        val CONNECTING: Short
        val OPEN: Short
        val CLOSING: Short
        val CLOSED: Short
    }
}
```

### Error Handling

```kotlin
sealed class NostrError : Exception() {
    data class ConnectionFailed(val relay: String, override val cause: Throwable?) : NostrError()
    data class PublishRejected(val eventId: String, val reason: String) : NostrError()
    data class Timeout(val operation: String, val duration: Duration) : NostrError()
    data class InvalidSignature(val eventId: String) : NostrError()
    object AllRelaysFailed : NostrError()
}
```

### Phase 3 Enhancements Summary

1. **Native WebSocket**: No external library dependencies
2. **Proper Event Signing**: NIP-01 compliant event ID and Schnorr signatures
3. **Signature Verification**: Verify all received events
4. **JVM Integration**: Integrate with cashu-client's `NostrGatewayService`
5. **Relay Health**: Monitor relay health and auto-evict slow/failing relays
6. **Circuit Breakers**: Prevent cascading failures
7. **Background Sync**: Automatic synchronization with retry logic
8. **Multi-Relay Publishing**: Publish to multiple relays with redundancy
9. **Event History**: Track event replacements for audit trail

## Testing

### Unit Tests

```kotlin
// Test publishing
@Test
fun `publishVoucher creates NIP-33 event`() = runTest {
    val client = createNostrVoucherClient(NostrConfig.TEST_RELAYS)
    val voucher = createTestVoucher()

    val result = client.publishVoucher(voucher)
    assertTrue(result.isSuccess)
}

// Test querying
@Test
fun `queryVoucher retrieves published voucher`() = runTest {
    val client = createNostrVoucherClient(NostrConfig.TEST_RELAYS)
    val voucher = createTestVoucher()

    client.publishVoucher(voucher)
    val retrieved = client.queryVoucher(voucher.voucherId).getOrThrow()

    assertEquals(voucher.voucherId, retrieved?.voucherId)
}
```

### Integration Tests

See `Task 2.7` in the roadmap for end-to-end Nostr integration tests.

## References

- [NIP-01: Basic Protocol Flow](https://github.com/nostr-protocol/nips/blob/master/01.md)
- [NIP-33: Parameterized Replaceable Events](https://github.com/nostr-protocol/nips/blob/master/33.md)
- [nostr-tools Documentation](https://github.com/nbd-wtf/nostr-tools)
- [Nostr Voucher Storage Design](../project/nostr-voucher-storage-design.md)

## Support

For issues or questions:
- GitHub Issues: https://github.com/imani-cash/imani-wallet/issues
- Documentation: https://docs.imani.cash

---

**Version**: 1.1.0 (Phase 2 + Phase 3 Planning)
**Last Updated**: 2025-11-21
**Status**: ✅ Phase 2 Stub Implemented | 📋 Phase 3 WebSocket Client Planned
