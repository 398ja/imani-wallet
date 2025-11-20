# cashu-client Integration Master Plan

> **Document Type**: Reference & How-To (Diátaxis)
> **Purpose**: Comprehensive roadmap for integrating cashu-client into imani-wallet for both identity and voucher functionality
> **Status**: ✅ Identity 77% Complete | 📋 Voucher Ready to Start
> **Last Updated**: 2025-11-20

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [Integration Strategy](#integration-strategy)
4. [Phase 1: Identity Integration (77% Complete)](#phase-1-identity-integration-77-complete)
5. [Phase 2: Voucher Integration (Ready to Start)](#phase-2-voucher-integration-ready-to-start)
6. [Complete Task Tracking](#complete-task-tracking)
7. [Timeline & Dependencies](#timeline--dependencies)
8. [Success Metrics](#success-metrics)
9. [Related Documentation](#related-documentation)

---

## Executive Summary

### Mission

Reuse **100% of cashu-client's production-tested code** on Android/JVM while maintaining Kotlin Multiplatform architecture for web compatibility.

### Scope

**Two Integration Phases**:

1. ✅ **Identity Module** (Phase 1) - 77% Complete
   - Cryptography (secp256k1, Schnorr, SHA-256)
   - BIP39 mnemonic generation
   - Identity management (create, import, sign)
   - Android Keystore integration
   - **Code Reuse**: ≥95% on Android, ~70% on web

2. 📋 **Voucher Module** (Phase 2) - Ready to Start
   - Voucher issuance (P2PK-locked)
   - Redemption and verification
   - Nostr backup/restore (NIP-17 + NIP-44)
   - Proof selection and token encoding
   - **Code Reuse**: ≥95% on Android, ~70% on web

### Approach: Adapter Pattern

**Proven Strategy** (from Identity Integration):

```
┌─────────────────────────────────────────────────────────────┐
│                 imani-{module} (KMP)                         │
├─────────────────────────────────────────────────────────────┤
│  commonMain/                                                 │
│    └── {Feature}Adapter.kt (interface)                      │
│                                                              │
│  jvmMain/ (Android)              jsMain/ (Web)              │
│    └── Jvm{Feature}Adapter       └── Web{Feature}Adapter    │
│        └─→ Wraps                     └─→ Reuses existing    │
│           cashu-client                  KMP use cases       │
└─────────────────────────────────────────────────────────────┘
```

**Why This Works**:
- ✅ **Self-sovereign**: Keys stay on device (no backend)
- ✅ **Proven**: Identity integration already 77% complete
- ✅ **Fast**: 2 weeks per phase
- ✅ **Flexible**: Platform-specific optimizations
- ✅ **Testable**: Easy to mock adapters

**Rejected Alternatives**:
- ❌ **Ktor BFF**: Violates self-custody, requires backend ($5-50/mo hosting)
- ❌ **Port to KMP**: 3-month effort, high maintenance burden

---

## Architecture Overview

### High-Level Structure

```
imani-wallet/
├── imani-identity/                      # Phase 1 (77% complete)
│   ├── commonMain/
│   │   ├── crypto/
│   │   │   ├── CryptoAdapter.kt         # ✅ Interface
│   │   │   └── Bip39Adapter.kt          # ✅ Interface
│   │   ├── domain/Identity.kt           # ✅ Domain model
│   │   ├── repository/IdentityRepository.kt
│   │   └── usecases/
│   ├── jvmMain/
│   │   ├── crypto/
│   │   │   ├── JvmCryptoAdapter.kt      # ✅ Wraps BouncyCastle
│   │   │   └── JvmBip39Adapter.kt       # ✅ BIP39 impl
│   │   └── repository/JvmIdentityRepository.kt
│   └── jsMain/
│       ├── crypto/WebCryptoAdapter.kt   # ✅ Web Crypto API
│       └── repository/WebIdentityRepository.kt
│
├── imani-voucher/                        # Phase 2 (TODO)
│   ├── commonMain/
│   │   ├── adapter/VoucherAdapter.kt    # 📋 TODO: Interface
│   │   ├── domain/StoredVoucher.kt      # ✅ Already exists
│   │   ├── repository/VoucherRepository.kt
│   │   └── usecases/
│   │       ├── IssueVoucherUseCase.kt   # 🔄 Refactor to use adapter
│   │       └── RedeemVoucherUseCase.kt  # 🔄 Refactor to use adapter
│   ├── jvmMain/
│   │   └── adapter/JvmVoucherAdapter.kt # 📋 TODO: Wrap cashu-client
│   └── jsMain/
│       └── adapter/WebVoucherAdapter.kt # 📋 TODO: Reuse existing
│
└── imani-android/
    ├── repository/AndroidIdentityRepository.kt  # ✅ Done
    └── di/AndroidModule.kt                      # ✅ DI configured
```

### Platform Coverage

| Component | Android (JVM) | Web (JS) | iOS (Native) |
|-----------|--------------|----------|--------------|
| **Identity** | ✅ 95% reuse (cashu-client) | ✅ 70% reuse (Web Crypto) | 📋 Future (Keychain) |
| **Voucher** | 📋 95% reuse (cashu-client) | 📋 70% reuse (existing) | 📋 Future |
| **Storage** | ✅ SQLDelight + Keystore | ✅ IndexedDB | 📋 Future |
| **Crypto** | ✅ BouncyCastle | ✅ Web Crypto API | 📋 Future |

---

## Integration Strategy

### Design Principles

1. **KMP Boundaries**
   - `commonMain`: Platform-agnostic interfaces and domain models
   - `jvmMain`: Android/JVM implementations wrapping cashu-client
   - `jsMain`: Web implementations using Web APIs

2. **Adapter Pattern**
   - Define interface in `commonMain`
   - Implement platform-specific adapters
   - Inject via Koin DI

3. **Dependency Management**
   - cashu-client added only to `jvmMain` dependencies
   - No JVM types in `commonMain` interfaces
   - Platform-specific libraries isolated

4. **Testing Strategy**
   - Mock adapters for unit tests
   - Platform-specific integration tests
   - E2E tests verify full flows

### Code Reuse Metrics

| Metric | Android (JVM) | Web (JS) |
|--------|--------------|----------|
| **Identity Crypto** | 95% (BouncyCastle via cashu-client) | 70% (Web Crypto API) |
| **Identity Repository** | 90% (SQLDelight + Keystore) | 75% (IndexedDB) |
| **Voucher Logic** | 95% (VoucherService from cashu-client) | 70% (Existing use cases) |
| **Domain Models** | 100% (shared commonMain) | 100% (shared commonMain) |

---

## Phase 1: Identity Integration (77% Complete)

### Overview

**Goal**: Reuse cashu-client cryptography for identity management on Android/JVM.

**Status**: 10/13 tasks complete (77%)

**What's Done**:
- ✅ CryptoAdapter and Bip39Adapter interfaces
- ✅ JvmCryptoAdapter wrapping BouncyCastle
- ✅ AndroidIdentityRepository with Keystore encryption
- ✅ DI configuration with proper Context injection
- ✅ Mnemonic storage in encrypted SharedPreferences
- ✅ 54 unit tests passing

**What's Left**:
- 🔄 E2E test fixes (9/45 passing, checkbox interaction issue)
- 📋 Additional unit tests for JvmCryptoAdapter
- 📋 Integration tests for CreateIdentityUseCase

### Identity Tasks

| ID | Task | Size | Status | Commit | Dependencies |
|----|------|------|--------|--------|--------------|
| **1.1** | Define CryptoAdapter Interface | S (1d) | ✅ DONE | Phase 0 | None |
| **1.2** | Implement JvmCryptoAdapter | M (2d) | ✅ DONE | Phase 1 | 1.1 |
| **1.3** | Define Bip39Adapter Interface | S (1d) | ✅ DONE | Phase 0 | None |
| **1.4** | Implement JvmBip39Adapter | M (2d) | ✅ DONE | Phase 1 | 1.3 |
| **2.1** | Implement AndroidIdentityRepository.createIdentity() | M (2d) | ✅ DONE | 2cf888d | 1.2, 1.4 |
| **2.2** | Add Context Injection to Repository | S (1d) | ✅ DONE | 2cf888d | 2.1 |
| **2.3** | Update DI Configuration | S (1d) | ✅ DONE | 2cf888d | 2.2 |
| **2.4** | Implement Mnemonic Storage | M (2d) | ✅ DONE | 2cf888d | 2.1 |
| **3.1** | Fix E2E Test Fixtures | M (2d) | ✅ DONE | 2cf888d | 2.1 |
| **3.2** | Fix UI Padding for FAB Visibility | S (1d) | ✅ DONE | 2cf888d | 3.1 |
| **3.3** | Make Mnemonic Checkbox Clickable | M (2d) | 🔄 IN PROGRESS | Partial | 3.2 |
| **3.4** | Add Unit Tests for JvmCryptoAdapter | M (2d) | 📋 TODO | - | 1.2 |
| **3.5** | Add Integration Tests for CreateIdentityUseCase | M (2d) | 📋 TODO | - | 2.1 |

**Total Completed**: 10/13 tasks (77%)
**Estimated Remaining**: 6 days

---

## Phase 2: Voucher Integration (Ready to Start)

### Overview

**Goal**: Reuse cashu-client VoucherService for voucher operations on Android/JVM.

**Status**: 0/12 tasks complete (0%)

**Architecture Decision**: ✅ Option A (Adapter Pattern) - Approved 2025-11-20

**What We'll Build**:
- 📋 VoucherAdapter interface (commonMain)
- 📋 JvmVoucherAdapter wrapping cashu-client VoucherService
- 📋 WebVoucherAdapter reusing existing use cases
- 📋 Refactor existing use cases to thin wrappers
- 📋 Integration with cashu-client dependencies (SendService, TokenCodec, NostrGateway)

### cashu-client VoucherService Features

From `cashu-client/wallet-plugin/wallet-core-app/src/main/java/xyz/tcheeric/wallet/core/VoucherService.java`:

| Feature | Description | Code Reuse |
|---------|-------------|------------|
| **Issue Vouchers** | Creates P2PK-locked vouchers with proof selection | 100% cashu-client |
| **Redeem Vouchers** | Verifies and claims vouchers | 100% cashu-client |
| **Revoke Vouchers** | Publishes revocation to Nostr ledger | 100% cashu-client |
| **Verify Vouchers** | Ed25519 signature verification (NUT-11) | 100% cashu-client |
| **Backup to Nostr** | NIP-17 + NIP-44 encrypted backups | 100% cashu-client |
| **Restore from Nostr** | Recovers vouchers from relays | 100% cashu-client |
| **Refresh Status** | Queries Nostr ledger for current status | 100% cashu-client |
| **List/Query** | Full voucher management | 100% cashu-client |

### Voucher Tasks

#### Sub-Phase 2.1: Abstraction Layer (2 days)

| ID | Task | Size | Status | Dependencies |
|----|------|------|--------|--------------|
| **2.1.1** | Define VoucherAdapter Interface (commonMain) | M (1d) | 📋 TODO | None |
| **2.1.2** | Update StoredVoucher Domain Model | S (1d) | 📋 TODO | 2.1.1 |

**Deliverables**:
- `imani-voucher/src/commonMain/kotlin/cash/imani/voucher/adapter/VoucherAdapter.kt`
- Methods: `issueVoucher()`, `redeemVoucher()`, `revokeVoucher()`, `verifyVoucher()`, `listVouchers()`, `backupToNostr()`, `restoreFromNostr()`
- Updated `StoredVoucher` with `@SerialName` annotations matching cashu-client

---

#### Sub-Phase 2.2: Android Implementation (3 days)

| ID | Task | Size | Status | Dependencies |
|----|------|------|--------|--------------|
| **2.2.1** | Add cashu-client Dependency (jvmMain) | S (1d) | 📋 TODO | None |
| **2.2.2** | Implement JvmVoucherAdapter | M (2d) | 📋 TODO | 2.1.1, 2.2.1 |
| **2.2.3** | Update Android DI for VoucherService | S (1d) | 📋 TODO | 2.2.2 |

**Deliverables**:
- `settings.gradle.kts` with cashu-client `includeBuild()` or Maven local
- `imani-voucher/src/jvmMain/kotlin/cash/imani/voucher/adapter/JvmVoucherAdapter.kt`
- Wraps `VoucherServiceImpl`, `SendService`, `TokenCodec`
- DI configuration in `AndroidModule.kt`

**Key Implementation**:
```kotlin
class JvmVoucherAdapter(
    private val voucherService: VoucherService // from cashu-client
) : VoucherAdapter {
    override suspend fun issueVoucher(request: IssueVoucherRequest) =
        withContext(Dispatchers.IO) {
            runCatching {
                val javaResult = voucherService.issueAndBackup(request.toJava())
                javaResult.toKotlin()
            }
        }
}
```

---

#### Sub-Phase 2.3: Web Implementation (2 days)

| ID | Task | Size | Status | Dependencies |
|----|------|------|--------|--------------|
| **2.3.1** | Implement WebVoucherAdapter | M (2d) | 📋 TODO | 2.1.1 |
| **2.3.2** | Update Web DI for VoucherAdapter | S (1d) | 📋 TODO | 2.3.1 |

**Deliverables**:
- `imani-voucher/src/jsMain/kotlin/cash/imani/voucher/adapter/WebVoucherAdapter.kt`
- Reuses existing `IssueVoucherUseCase`, `RedeemVoucherUseCase`
- Web DI in `WebModule.kt`

**Key Implementation**:
```kotlin
class WebVoucherAdapter(
    private val issueVoucherUseCase: IssueVoucherUseCase,
    private val redeemVoucherUseCase: RedeemVoucherUseCase
) : VoucherAdapter {
    override suspend fun issueVoucher(request: IssueVoucherRequest) =
        issueVoucherUseCase(request) // Delegate to existing
}
```

---

#### Sub-Phase 2.4: Migration & Cleanup (2 days)

| ID | Task | Size | Status | Dependencies |
|----|------|------|--------|--------------|
| **2.4.1** | Refactor IssueVoucherUseCase to Use Adapter | M (1d) | 📋 TODO | 2.2.2, 2.3.1 |
| **2.4.2** | Refactor RedeemVoucherUseCase to Use Adapter | M (1d) | 📋 TODO | 2.2.2, 2.3.1 |
| **2.4.3** | Remove Duplicate Voucher Logic | M (1d) | 📋 TODO | 2.4.1, 2.4.2 |

**Deliverables**:
- Simplified use cases (thin wrappers around VoucherAdapter)
- Removed direct MintApiClient usage
- Removed duplicate proof selection logic
- Removed duplicate token encoding logic

**Before**:
```kotlin
class IssueVoucherUseCase(
    private val voucherRepository: VoucherRepository,
    private val proofRepository: ProofRepository,
    private val mintApiClient: MintApiClient,
    // ... 7+ dependencies
) {
    // 200+ lines of logic
}
```

**After**:
```kotlin
class IssueVoucherUseCase(
    private val voucherAdapter: VoucherAdapter // Single dependency
) {
    suspend operator fun invoke(request: IssueVoucherRequest) =
        voucherAdapter.issueVoucher(request) // Delegate to adapter
}
```

---

#### Sub-Phase 2.5: Testing (2 days)

| ID | Task | Size | Status | Dependencies |
|----|------|------|--------|--------------|
| **2.5.1** | Unit Tests for JvmVoucherAdapter | M (1d) | 📋 TODO | 2.2.2 |
| **2.5.2** | Unit Tests for WebVoucherAdapter | M (1d) | 📋 TODO | 2.3.1 |
| **2.5.3** | Integration Tests (Full Voucher Flow) | M (2d) | 📋 TODO | 2.4.3 |

**Deliverables**:
- `JvmVoucherAdapterTest.kt` - Verifies delegation to cashu-client
- `WebVoucherAdapterTest.kt` - Verifies delegation to use cases
- `VoucherIntegrationTest.kt` - Issue → redeem flow

**Total Tasks**: 12
**Estimated Effort**: 11 days (~2 weeks)

---

## Complete Task Tracking

### Summary

| Phase | Total Tasks | Complete | In Progress | TODO | % Complete |
|-------|------------|----------|-------------|------|------------|
| **Phase 1: Identity** | 13 | 10 | 1 | 2 | 77% |
| **Phase 2: Voucher** | 12 | 0 | 0 | 12 | 0% |
| **TOTAL** | 25 | 10 | 1 | 14 | 40% |

### All Tasks (Chronological)

| # | Phase | Task | Size | Status | Commit | Notes |
|---|-------|------|------|--------|--------|-------|
| 1 | 1 | Define CryptoAdapter Interface | S | ✅ DONE | Phase 0 | KMP interface |
| 2 | 1 | Implement JvmCryptoAdapter | M | ✅ DONE | Phase 1 | BouncyCastle wrapper |
| 3 | 1 | Define Bip39Adapter Interface | S | ✅ DONE | Phase 0 | KMP interface |
| 4 | 1 | Implement JvmBip39Adapter | M | ✅ DONE | Phase 1 | BIP39 impl |
| 5 | 1 | Implement AndroidIdentityRepository.createIdentity() | M | ✅ DONE | 2cf888d | Full impl with crypto |
| 6 | 1 | Add Context Injection to Repository | S | ✅ DONE | 2cf888d | Koin DI |
| 7 | 1 | Update DI Configuration | S | ✅ DONE | 2cf888d | AndroidModule |
| 8 | 1 | Implement Mnemonic Storage | M | ✅ DONE | 2cf888d | Encrypted prefs |
| 9 | 1 | Fix E2E Test Fixtures | M | ✅ DONE | 2cf888d | Button selectors |
| 10 | 1 | Fix UI Padding for FAB Visibility | S | ✅ DONE | 2cf888d | Box wrapper |
| 11 | 1 | Make Mnemonic Checkbox Clickable | M | 🔄 IN PROGRESS | Partial | 36/45 tests timeout |
| 12 | 1 | Add Unit Tests for JvmCryptoAdapter | M | 📋 TODO | - | Schnorr, key gen |
| 13 | 1 | Add Integration Tests for CreateIdentityUseCase | M | 📋 TODO | - | E2E identity creation |
| 14 | 2 | Define VoucherAdapter Interface | M | 📋 TODO | - | KMP interface |
| 15 | 2 | Update StoredVoucher Domain Model | S | 📋 TODO | - | @SerialName annotations |
| 16 | 2 | Add cashu-client Dependency (jvmMain) | S | 📋 TODO | - | includeBuild() |
| 17 | 2 | Implement JvmVoucherAdapter | M | 📋 TODO | - | Wrap VoucherService |
| 18 | 2 | Update Android DI for VoucherService | S | 📋 TODO | - | AndroidModule |
| 19 | 2 | Implement WebVoucherAdapter | M | 📋 TODO | - | Reuse use cases |
| 20 | 2 | Update Web DI for VoucherAdapter | S | 📋 TODO | - | WebModule |
| 21 | 2 | Refactor IssueVoucherUseCase to Use Adapter | M | 📋 TODO | - | Thin wrapper |
| 22 | 2 | Refactor RedeemVoucherUseCase to Use Adapter | M | 📋 TODO | - | Thin wrapper |
| 23 | 2 | Remove Duplicate Voucher Logic | M | 📋 TODO | - | Cleanup |
| 24 | 2 | Unit Tests for JvmVoucherAdapter | M | 📋 TODO | - | Mock cashu-client |
| 25 | 2 | Integration Tests (Full Voucher Flow) | M | 📋 TODO | - | Issue → redeem |

---

## Timeline & Dependencies

### Gantt Chart (Simplified)

```
Week 1-2:  ████████ Phase 1: Identity (DONE - 77%)
Week 2:    ██ Phase 1: Identity Testing (IN PROGRESS)
Week 3-4:  ████████ Phase 2: Voucher Integration
Week 5:    ████ Phase 2: Testing & Cleanup
```

### Critical Path

```
Phase 1 (Identity) - 77% Complete
  ├── 1.1-1.4: Adapters ✅ DONE
  ├── 2.1-2.4: Repository ✅ DONE
  ├── 3.1-3.2: UI Fixes ✅ DONE
  └── 3.3-3.5: Testing 🔄 IN PROGRESS (blocking voucher start)

Phase 2 (Voucher) - Ready to Start (after 3.3 completes)
  ├── 2.1: Abstraction Layer (2 days)
  │   ├── 2.1.1: VoucherAdapter interface
  │   └── 2.1.2: Update StoredVoucher
  │
  ├── 2.2: Android Implementation (3 days)
  │   ├── 2.2.1: Add cashu-client dependency
  │   ├── 2.2.2: JvmVoucherAdapter ← depends on 2.1.1
  │   └── 2.2.3: DI configuration ← depends on 2.2.2
  │
  ├── 2.3: Web Implementation (2 days) ← parallel to 2.2
  │   ├── 2.3.1: WebVoucherAdapter
  │   └── 2.3.2: DI configuration
  │
  ├── 2.4: Migration (2 days) ← depends on 2.2.3, 2.3.2
  │   ├── 2.4.1: Refactor IssueVoucherUseCase
  │   ├── 2.4.2: Refactor RedeemVoucherUseCase
  │   └── 2.4.3: Remove duplicates
  │
  └── 2.5: Testing (2 days) ← depends on 2.4.3
      ├── 2.5.1: JvmVoucherAdapter tests
      ├── 2.5.2: WebVoucherAdapter tests
      └── 2.5.3: Integration tests
```

### Estimated Timeline

| Phase | Duration | Start | End | Dependencies |
|-------|----------|-------|-----|--------------|
| **Phase 1: Identity** | 13 days | Week 1 | Week 2 | ✅ 77% complete |
| Phase 1 Testing (remaining) | 3 days | Now | Week 2 | Task 3.3-3.5 |
| **Phase 2: Voucher** | 11 days | Week 3 | Week 4 | Phase 1 complete |
| Phase 2.1: Abstraction | 2 days | Week 3 | Week 3 | None |
| Phase 2.2: Android | 3 days | Week 3 | Week 3 | 2.1 complete |
| Phase 2.3: Web | 2 days | Week 3 | Week 3 | 2.1 complete (parallel to 2.2) |
| Phase 2.4: Migration | 2 days | Week 4 | Week 4 | 2.2, 2.3 complete |
| Phase 2.5: Testing | 2 days | Week 4 | Week 5 | 2.4 complete |

**Total Project Duration**: 5 weeks (~24 days actual work)
**Current Progress**: Week 2 (77% of Phase 1 complete)
**Remaining**: 3 weeks (~17 days)

---

## Success Metrics

### Code Reuse Metrics

| Component | Target | Current | Status |
|-----------|--------|---------|--------|
| **Identity (Android)** | ≥95% | ~95% | ✅ ON TRACK |
| **Identity (Web)** | ≥70% | ~70% | ✅ ON TRACK |
| **Voucher (Android)** | ≥95% | TBD | 📋 TODO |
| **Voucher (Web)** | ≥70% | TBD | 📋 TODO |

### Test Coverage

| Module | Target | Current | Status |
|--------|--------|---------|--------|
| **imani-identity** | ≥80% | ~75% (54 tests) | ✅ ON TRACK |
| **imani-voucher** | ≥80% | TBD | 📋 TODO |
| **imani-android** | ≥70% | 20% (9/45 E2E) | 🔄 IN PROGRESS |

### Performance Metrics

| Metric | Target | Status |
|--------|--------|--------|
| **Identity creation** | <2s | ✅ ACHIEVED (~500ms) |
| **Voucher issuance** | <2s | 📋 TODO |
| **Voucher redemption** | <1.5s | 📋 TODO |

### Quality Metrics

| Metric | Target | Status |
|--------|--------|--------|
| **No JVM types in commonMain** | 100% | ✅ ACHIEVED |
| **NUT-compliant keys** | 100% (32 bytes) | ✅ ACHIEVED |
| **Self-custody** | 100% (keys on device) | ✅ ACHIEVED |
| **Offline support** | 100% | ✅ ACHIEVED |

---

## Related Documentation

### Primary Guides

- **[Integrate cashu-client Vouchers](../docs/how-to/integrate-cashu-client-vouchers.md)** - Detailed voucher integration guide (Phase 2)
- **[Reuse cashu-client on Android](../docs/how-to/reuse-cashu-client-on-android.md)** - Identity integration reference (Phase 1)

### Architecture & Design

- **[Voucher Integration Architectures](../docs/explanation/voucher-integration-architectures.md)** - Option A (Adapter) vs BFF vs KMP port
- **[Nostr Voucher Storage Design](nostr-voucher-storage-design.md)** - Nostr-first storage architecture
- **[Java to Kotlin Migration](JAVA_TO_KOTLIN_MIGRATION.md)** - Domain model migration notes

### Roadmaps

- **[Kotlin Voucher Client Roadmap](kotlin-voucher-client-roadmap.md)** - Main project roadmap
- **[Android Port Roadmap](android-port-roadmap.md)** - Android-specific tasks

### Reference

- **[Security Audit](SECURITY_AUDIT.md)** - Security considerations
- **[Error Handling Guide](ERROR_HANDLING_GUIDE.md)** - Error handling patterns
- **[Performance Optimization](PERFORMANCE_OPTIMIZATION.md)** - Performance best practices

---

## Change Log

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2025-11-20 | Initial master plan combining identity (77% complete) and voucher integration (ready to start) |

---

## Appendix: Quick Reference

### Phase 1 (Identity) - At a Glance

**Status**: ✅ 77% Complete (10/13 tasks)
**Key Files**:
- `imani-identity/src/commonMain/kotlin/cash/imani/identity/crypto/CryptoAdapter.kt`
- `imani-identity/src/jvmMain/kotlin/cash/imani/identity/crypto/JvmCryptoAdapter.kt`
- `imani-android/src/androidMain/kotlin/cash/imani/android/repository/AndroidIdentityRepository.kt`

**Remaining Work**: E2E test fixes (3 days)

### Phase 2 (Voucher) - At a Glance

**Status**: 📋 Ready to Start (0/12 tasks)
**Key Files to Create**:
- `imani-voucher/src/commonMain/kotlin/cash/imani/voucher/adapter/VoucherAdapter.kt`
- `imani-voucher/src/jvmMain/kotlin/cash/imani/voucher/adapter/JvmVoucherAdapter.kt`
- `imani-voucher/src/jsMain/kotlin/cash/imani/voucher/adapter/WebVoucherAdapter.kt`

**Estimated Effort**: 11 days (~2 weeks)

### Commands

```bash
# Run all tests
./gradlew test

# Run identity tests
./gradlew :imani-identity:test

# Run Android E2E tests
./gradlew :imani-android:connectedDebugAndroidTest

# Build web app
./gradlew :imani-web:jsBrowserDevelopmentRun

# Publish cashu-client locally (for Phase 2.2.1)
cd ~/IdeaProjects/cashu-client
./gradlew publishToMavenLocal
```
