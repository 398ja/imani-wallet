# Java to Kotlin Domain Model Migration

> Documentation of intentional differences between cashu-client Java models and imani-wallet Kotlin models

## Overview

This document explains the hybrid approach taken when converting Java domain models from `cashu-client` to Kotlin for `imani-wallet`. The strategy balances **code reuse** (matching Java semantics) with **Kotlin Multiplatform requirements** (platform-independent types).

## Migration Strategy: Hybrid Approach

✅ **Keep from Java**: Core domain logic, field names, validation rules
✅ **Adapt for KMP**: Replace Java/JVM-specific types with KMP-compatible alternatives
✅ **Improve**: Use Kotlin idioms (data classes, enums, null safety)

---

## Identity Module

### Identity.kt

| Aspect | Java (cashu-client) | Kotlin (imani-wallet) | Rationale |
|--------|---------------------|----------------------|-----------|
| **privateKey field** | `PrivateKey` (domain wrapper) | `String` (hex-encoded) | ✅ ADDED - was missing in initial version |
| **publicKey type** | `PublicKey` (domain wrapper) | `String` (hex-encoded) | KMP-friendly, no byte array serialization issues |
| **lastUsedAt mutability** | Mutable (`markAsUsed()` updates in-place) | Immutable (use `withUpdatedUsage()`) | Kotlin data class immutability pattern |
| **nostrIdentity** | `nostr.id.Identity` (nostr-java) | Not present | Removed: nostr-java is JVM-only, crypto delegated to platform-specific implementations |
| **Label validation** | 1-100 chars, trimmed | 1-100 chars, trimmed | ✅ MATCHED |
| **isActive() logic** | 90 days, fallback to createdAt | 90 days, fallback to createdAt | ✅ MATCHED |

**Key Methods**:
- Java: `sign(BaseEvent)`, `markAsUsed()`, `withLabel()`, `isActive()`, `isDormant()`
- Kotlin: `toNpub()`, `withUpdatedUsage()`, `withLabel()`, `isActive()`, `isDormant()`

**Differences**:
- ❌ **Removed**: `sign()` method (will be platform-specific, e.g., Web Crypto API for JS, JVM crypto for Android)
- ✅ **Added**: `toNpub()` for Nostr public key encoding

---

### PublicKey.kt

| Aspect | Java | Kotlin | Rationale |
|--------|------|--------|-----------|
| **Key size** | 32 bytes (x-coordinate only) | 32 bytes (x-coordinate only) | ✅ MATCHED - Nostr standard |
| **Validation** | Length check only | Length check only | ✅ MATCHED |
| **nostr-java integration** | `fromNostrJava()`, `toNostrJava()` | Not present | Removed for KMP compatibility |

**Note**: Initial Kotlin version incorrectly used 33 bytes (compressed secp256k1). Fixed to match Java's 32-byte Nostr standard.

---

### PrivateKey.kt

| Aspect | Java | Kotlin | Rationale |
|--------|------|--------|-----------|
| **Key size** | 32 bytes | 32 bytes | ✅ MATCHED |
| **Security method** | `clear()` | `clear()` | ✅ MATCHED - fills bytes with zeros |
| **toString()** | Redacts key, shows hash | Redacts key, shows hash | ✅ MATCHED |
| **bytes visibility** | `private final` | `private val` | ✅ MATCHED |

---

## Voucher Module

### StoredVoucher.kt

| Aspect | Java | Kotlin | Rationale |
|--------|------|--------|-----------|
| **status type** | `String` | `VoucherStatus` enum | ✅ IMPROVED - type safety |
| **Core fields** | All matched | All matched | ✅ MATCHED |
| **Extra fields** | None | `token`, `deliveryMetadata`, `redemptionMetadata` | ✅ FORWARD-LOOKING - supports roadmap spec |

**Status Enum** (Kotlin improvement):
```kotlin
enum class VoucherStatus {
    ISSUED, DELIVERED, REDEEMED, REVOKED, EXPIRED
}
```

Java uses strings: `"issued"`, `"delivered"`, etc.

---

### WalletState.kt

| Aspect | Java | Kotlin | Rationale |
|--------|------|--------|-----------|
| **Complexity** | Full-featured (schema, history, deterministic wallet) | Simplified (vouchers, proofs, timestamp) | ✅ PHASE 0 SCOPE - will expand in later phases |
| **tokens field** | `List<WalletToken>` | `List<Proof>` | Different: Kotlin uses NUT-00 spec directly |
| **Missing fields** | - | `schema`, `history`, `encryptedMnemonic`, etc. | To be added in Phase 1 (Step 1.4) |

**Rationale**: Simplified for initial implementation per roadmap. Full features will be added incrementally.

---

### Proof.kt

| Aspect | Java | Kotlin | Rationale |
|--------|------|--------|-----------|
| **Domain model** | ❌ Doesn't exist (uses `ProofRecord` for DB) | ✅ Exists (NUT-00 compliant) | Kotlin follows protocol spec, Java is DB-centric |
| **Fields** | DB fields (id, mintUrl, unit, etc.) | Protocol fields (amount, secret, C, id) | Different purposes: storage vs. wire format |

**Kotlin follows NUT-00**:
```kotlin
data class Proof(
    val amount: Int,
    val secret: String,
    val C: String,
    val id: String // keyset ID
)
```

**Java uses ProofRecord** (database storage):
```java
record ProofRecord(
    long id, // DB primary key
    String mintUrl,
    String unit,
    int amount,
    String cHex,
    byte[] secret,
    String keysetId
)
```

---

## Summary of Differences

### ✅ Matched Java Behavior
- Identity: label validation (1-100 chars)
- Identity: isActive() logic (90 days)
- PublicKey/PrivateKey: 32-byte key size
- PrivateKey: clear() security method
- StoredVoucher: core fields and methods

### ✅ Intentional Improvements
- **Type safety**: VoucherStatus enum vs String
- **Immutability**: Kotlin data class copy() vs Java mutable fields
- **KMP compatibility**: Removed nostr-java dependencies
- **Forward-looking**: Added token, metadata fields to StoredVoucher

### ⚠️ Simplified for Phase 0
- **WalletState**: Basic fields only, will expand in Phase 1
- **Proof**: Protocol model vs. DB model (both needed, different purposes)

### ❌ Removed (Platform-Specific)
- **nostr-java integration**: Will use platform-specific crypto (Web Crypto API, Android Keystore, etc.)
- **Signing operations**: Delegated to platform-specific implementations

---

## Next Steps (Phase 1)

1. **Expand WalletState** (Step 1.4):
   - Add schema, history, deterministic wallet fields
   - Match Java WalletState complexity

2. **Add ProofRecord** (Storage layer):
   - Create DB-centric model for persistence
   - Keep Proof for wire protocol
   - Map between them in repository layer

3. **Platform-specific crypto** (Week 4):
   - Implement signing for each platform
   - Web: Web Crypto API
   - Android: Android Keystore + BouncyCastle
   - iOS: Security framework
   - JVM: BouncyCastle

---

## Code Reuse Percentage

| Module | Target | Actual | Notes |
|--------|--------|--------|-------|
| **identity-domain** | 95% | ~85% | Reduced due to nostr-java removal |
| **wallet-core-base** | 90% | ~70% | Simplified for Phase 0 |

**Overall: ~75% reuse** with intentional adaptations for KMP and modern Kotlin idioms.

---

## References

- Java source: `/home/eric/IdeaProjects/cashu-client/identity-plugin/identity-domain/`
- Kotlin source: `/home/eric/IdeaProjects/imani-wallet/imani-identity/src/commonMain/kotlin/cash/imani/identity/domain/`
- Roadmap: `project/kotlin-voucher-client-roadmap.md`
- Tech spec: `project/explanation/kotlin-client-spec-detailed.md`
