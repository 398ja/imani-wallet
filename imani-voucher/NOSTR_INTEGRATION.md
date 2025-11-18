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
- Phase 2: Simplified in-memory implementation
- Phase 3: Will integrate with cashu-client's `NostrGatewayService`
- Uses coroutines for async relay operations

**JS (`NostrVoucherClient.js.kt`)**:
- Uses `nostr-tools` NPM library (v2.1.0+)
- WebSocket-based relay connectivity
- Supports all major browsers

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
    "wss://relay.damus.io",
    "wss://relay.snort.social",
    "wss://nos.lol",
    "wss://relay.nostr.band"
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

## NPM Dependencies (JS Platform)

Add to `package.json`:

```json
{
  "dependencies": {
    "nostr-tools": "^2.1.0"
  }
}
```

Install with:
```bash
npm install
```

## Phase 2 Limitations

Current limitations (to be addressed in Phase 3):

1. **Simplified Event Signing**: Events reuse voucher signatures instead of proper Nostr event signing
2. **No Signature Verification**: Received events are not cryptographically verified
3. **JVM In-Memory**: JVM implementation doesn't connect to actual relays
4. **No Retry Logic**: Failed relay operations are not retried
5. **No Health Monitoring**: No relay health checks or automatic failover

## Phase 3 Enhancements

Planned improvements:

1. **Proper Event Signing**: Use NIP-01 event ID computation and Schnorr signatures
2. **Signature Verification**: Verify all received events before parsing
3. **JVM Integration**: Integrate with cashu-client's `NostrGatewayService`
4. **Relay Health**: Monitor relay health and auto-evict slow/failing relays
5. **Circuit Breakers**: Prevent cascading failures with circuit breaker pattern
6. **Background Sync**: Automatic synchronization with retry logic
7. **Multi-Relay Publishing**: Publish to multiple relays with redundancy
8. **Event History**: Track event replacements for audit trail

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

**Version**: 1.0.0 (Phase 2)
**Last Updated**: 2025-11-18
**Status**: ✅ Implemented
