# How to Integrate cashu-client Voucher Functionality

> **Document Type**: How-To Guide (Diátaxis)
> **Purpose**: Guide for integrating cashu-client's VoucherService into imani-wallet for both Android and web platforms
> **Status**: ✅ **Option A (Adapter Pattern) APPROVED** - Ready for implementation
> **Last Updated**: 2025-11-20
> **Related**: [Reuse cashu-client on Android](reuse-cashu-client-on-android.md), [Kotlin Voucher Client Roadmap](../../project/kotlin-voucher-client-roadmap.md), [Architecture Comparison](../explanation/voucher-integration-architectures.md)

## Table of Contents

1. [Decision Summary](#decision-summary)
2. [Overview](#overview)
3. [Architecture Decision](#architecture-decision)
4. [Phase 1: VoucherAdapter Abstraction Layer](#phase-1-voucheradapter-abstraction-layer)
5. [Phase 2: Android Implementation (Reuse cashu-client)](#phase-2-android-implementation-reuse-cashu-client)
6. [Phase 3: Web Implementation (KMP-Compatible)](#phase-3-web-implementation-kmp-compatible)
7. [Phase 4: Migration from Current Implementation](#phase-4-migration-from-current-implementation)
8. [Testing Strategy](#testing-strategy)
9. [Troubleshooting](#troubleshooting)

---

## Decision Summary

**✅ DECISION: Use Option A - Adapter Pattern**

**Date**: 2025-11-20

**Reasoning**:
1. **Aligns with Imani Principles**: Self-sovereign (keys on device), privacy-first (no backend), offline-capable
2. **Proven Pattern**: Successfully used for identity integration (77% complete, Phase 1-2 done)
3. **Fast Implementation**: 2 weeks vs 3 weeks (BFF) or 3 months (KMP port)
4. **No Deployment Overhead**: Works offline, no server hosting/monitoring required
5. **Good Enough**: 95% code reuse on Android (primary target), 70% on web (acceptable)

**Rejected Alternatives**:
- ❌ **Option B (Ktor BFF)**: Violates self-custody principle, requires backend deployment, adds latency
- ❌ **Option C (Port to KMP)**: 3-month effort, high maintenance burden, premature optimization

**See**: [Architecture Comparison](../explanation/voucher-integration-architectures.md) for detailed analysis

---

## Overview

### Goal

Make **cashu-client the foundation** for voucher functionality across web and Android platforms by:

1. **Reusing 100% of cashu-client voucher code on Android** (JVM)
2. **Creating KMP abstraction layer** for web compatibility
3. **Preserving existing imani-wallet UI and navigation**
4. **Maintaining Nostr-first storage architecture**

### Current State

**cashu-client (Java)**:
- ✅ Complete VoucherService implementation (1318 lines)
- ✅ Issue, redeem, revoke, verify operations
- ✅ Nostr backup/restore (NIP-17 + NIP-44)
- ✅ P2PK-locked vouchers (NUT-11)
- ✅ SendService for proof selection
- ✅ TokenCodec for Cashu token encoding/decoding
- ❌ JVM-only (not KMP-compatible)

**imani-wallet (Kotlin)**:
- ✅ Basic IssueVoucherUseCase (KMP commonMain)
- ✅ RedeemVoucherUseCase (KMP commonMain)
- ✅ Nostr voucher storage (NostrVoucherRepository)
- ✅ IndexedDB cache (web), in-memory cache (JVM)
- ❌ Reimplements logic from cashu-client (~30% code duplication)

### Target State

**After Integration**:
- ✅ Android uses cashu-client VoucherService directly (≥95% code reuse)
- ✅ Web uses VoucherAdapter abstraction layer
- ✅ Shared domain models (StoredVoucher, VoucherStatus)
- ✅ Consistent behavior across platforms
- ✅ Zero code duplication for voucher logic

---

## Architecture Decision

### Pattern: Adapter Pattern (Same as CryptoAdapter)

Following the successful identity integration pattern from [reuse-cashu-client-on-android.md](reuse-cashu-client-on-android.md):

```
┌─────────────────────────────────────────────────────────────────┐
│                    imani-voucher (KMP)                          │
├─────────────────────────────────────────────────────────────────┤
│  commonMain/                                                    │
│    └── cash/imani/voucher/adapter/VoucherAdapter.kt            │
│        - interface VoucherAdapter {                             │
│            suspend fun issueVoucher(request): Result<Voucher>   │
│            suspend fun redeemVoucher(token): Result<Redemption> │
│            suspend fun revokeVoucher(id): Result<Unit>          │
│            suspend fun verifyVoucher(id): Result<Verification>  │
│            suspend fun listVouchers(): Result<List<Voucher>>    │
│          }                                                       │
├─────────────────────────────────────────────────────────────────┤
│  jvmMain/ (Android + JVM Desktop)                               │
│    └── cash/imani/voucher/adapter/JvmVoucherAdapter.kt         │
│        - actual class JvmVoucherAdapter : VoucherAdapter {      │
│            private val voucherService: VoucherService           │
│            // Delegates to cashu-client VoucherServiceImpl      │
│          }                                                       │
├─────────────────────────────────────────────────────────────────┤
│  jsMain/ (Web)                                                  │
│    └── cash/imani/voucher/adapter/WebVoucherAdapter.kt         │
│        - actual class WebVoucherAdapter : VoucherAdapter {      │
│            // Lightweight implementation OR                     │
│            // Reuse existing IssueVoucherUseCase logic          │
│          }                                                       │
└─────────────────────────────────────────────────────────────────┘
```

### Why This Pattern?

✅ **Proven**: Successfully used for CryptoAdapter (Phase 1)
✅ **Platform-specific optimizations**: Android uses full cashu-client, web uses lighter approach
✅ **Type-safe**: Compile-time checks for platform compatibility
✅ **Testable**: Easy to mock for unit tests
✅ **Flexible**: Can swap implementations without changing use cases

---

## Phase 1: VoucherAdapter Abstraction Layer

### Task 1.1: Define Common Interface

**File**: `imani-voucher/src/commonMain/kotlin/cash/imani/voucher/adapter/VoucherAdapter.kt`

```kotlin
package cash.imani.voucher.adapter

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus

/**
 * Platform-abstraction layer for voucher operations.
 *
 * Implementations:
 * - JVM/Android: Delegates to cashu-client VoucherService
 * - Web: Lightweight KMP-compatible implementation
 */
interface VoucherAdapter {

    /**
     * Issues a new voucher.
     *
     * Implementation notes:
     * - JVM: Uses cashu-client VoucherServiceImpl.issueAndBackup()
     * - Web: Uses IssueVoucherUseCase + NostrVoucherRepository
     *
     * @param request Voucher issuance request
     * @return Issued voucher with token
     */
    suspend fun issueVoucher(request: IssueVoucherRequest): Result<IssueVoucherResult>

    /**
     * Redeems a voucher from a Cashu token.
     *
     * @param token Cashu token (cashuA...)
     * @return Redemption result with claimed proofs
     */
    suspend fun redeemVoucher(token: String): Result<RedeemVoucherResult>

    /**
     * Revokes a voucher (issuer workflow).
     *
     * @param voucherId Voucher ID to revoke
     * @param reason Revocation reason
     * @return Revocation result
     */
    suspend fun revokeVoucher(
        voucherId: String,
        reason: String
    ): Result<RevokeVoucherResult>

    /**
     * Verifies a voucher's cryptographic signature.
     *
     * @param voucherId Voucher ID to verify
     * @return Verification result
     */
    suspend fun verifyVoucher(voucherId: String): Result<VerifyVoucherResult>

    /**
     * Lists all vouchers in wallet.
     *
     * @return List of stored vouchers
     */
    suspend fun listVouchers(): Result<List<StoredVoucher>>

    /**
     * Gets a specific voucher by ID.
     *
     * @param voucherId Voucher ID
     * @return Voucher if found
     */
    suspend fun getVoucher(voucherId: String): Result<StoredVoucher?>

    /**
     * Backs up all vouchers to Nostr.
     *
     * @return Number of vouchers backed up
     */
    suspend fun backupToNostr(): Result<Int>

    /**
     * Restores vouchers from Nostr backups.
     *
     * @return Number of vouchers restored
     */
    suspend fun restoreFromNostr(): Result<Int>

    /**
     * Refreshes voucher status from Nostr ledger.
     *
     * @param voucherId Voucher ID to refresh
     * @return Updated voucher
     */
    suspend fun refreshStatus(voucherId: String): Result<StoredVoucher?>
}

/**
 * Request to issue a new voucher.
 *
 * Matches cashu-client VoucherService.IssueVoucherRequest.
 */
data class IssueVoucherRequest(
    val amount: Long,
    val unit: String,
    val mintUrl: String,
    val expiresInDays: Int? = null,
    val memo: String? = null
) {
    init {
        require(amount > 0) { "amount must be positive" }
        require(unit.isNotBlank()) { "unit must not be blank" }
        require(mintUrl.isNotBlank()) { "mintUrl must not be blank" }
        if (expiresInDays != null) {
            require(expiresInDays > 0) { "expiresInDays must be positive" }
        }
    }
}

/**
 * Result of voucher issuance.
 *
 * Matches cashu-client VoucherService.IssueVoucherResult.
 */
data class IssueVoucherResult(
    val voucher: StoredVoucher,
    val token: String,
    val backedUp: Boolean,
    val message: String
)

/**
 * Result of voucher redemption.
 */
data class RedeemVoucherResult(
    val voucherId: String,
    val status: VoucherStatus,
    val message: String,
    val amountReceived: Long
)

/**
 * Result of voucher revocation.
 */
data class RevokeVoucherResult(
    val voucherId: String,
    val previousStatus: VoucherStatus,
    val message: String,
    val ledgerPublished: Boolean
)

/**
 * Result of voucher verification.
 */
data class VerifyVoucherResult(
    val voucherId: String,
    val signatureValid: Boolean,
    val expired: Boolean,
    val status: VoucherStatus,
    val message: String
) {
    fun isValid(): Boolean = signatureValid && !expired && status == VoucherStatus.ISSUED
}
```

**Acceptance Criteria**:
- [ ] Interface compiles in `commonMain`
- [ ] All request/result classes are `data class` (serializable)
- [ ] Matches cashu-client VoucherService API surface
- [ ] No JVM-specific types (no `java.time`, `java.util` except collections)

---

### Task 1.2: Update Domain Models

**File**: `imani-voucher/src/commonMain/kotlin/cash/imani/voucher/domain/StoredVoucher.kt`

**Current** (imani-wallet):
```kotlin
@Serializable
data class StoredVoucher(
    val voucherId: String,
    val issuerId: String,
    val unit: String,
    val faceValue: Long,
    val expiresAt: Long? = null,
    val memo: String? = null,
    val issuerSignature: String,
    val issuerPublicKey: String,
    @Contextual val issuedAt: Instant,
    val status: VoucherStatus,
    val token: String? = null,
    val deliveryMetadata: DeliveryMetadata? = null,
    val redemptionMetadata: RedemptionMetadata? = null
)
```

**Target** (match cashu-client):
```kotlin
@Serializable
data class StoredVoucher(
    @SerialName("voucher_id") val voucherId: String,
    @SerialName("issuer_id") val issuerId: String,
    val unit: String,
    @SerialName("face_value") val faceValue: Long,
    @SerialName("expires_at") val expiresAt: Long? = null,
    val memo: String? = null,
    @SerialName("issuer_signature") val issuerSignature: String,
    @SerialName("issuer_public_key") val issuerPublicKey: String,
    @SerialName("issued_at") @Contextual val issuedAt: Instant,
    val status: VoucherStatus
) {
    /**
     * Checks if voucher has expired based on current time.
     */
    fun isExpired(): Boolean {
        return expiresAt != null && Clock.System.now().epochSeconds > expiresAt
    }

    /**
     * Checks if voucher is active (issued and not expired).
     */
    fun isActive(): Boolean {
        return status == VoucherStatus.ISSUED && !isExpired()
    }
}

@Serializable
enum class VoucherStatus {
    @SerialName("issued") ISSUED,
    @SerialName("delivered") DELIVERED,
    @SerialName("redeemed") REDEEMED,
    @SerialName("revoked") REVOKED,
    @SerialName("expired") EXPIRED
}
```

**Changes**:
- ✅ Added `@SerialName` annotations to match cashu-client JSON keys
- ✅ Removed `token`, `deliveryMetadata`, `redemptionMetadata` (store separately if needed)
- ✅ Added `isExpired()` and `isActive()` helper methods
- ✅ Enum values lowercase to match cashu-client

**Acceptance Criteria**:
- [ ] Serialization round-trip works (JSON → Kotlin → JSON)
- [ ] Compatible with cashu-client JSON format
- [ ] Existing tests still pass

---

## Phase 2: Android Implementation (Reuse cashu-client)

### Task 2.1: Add cashu-client Dependency

**File**: `build.gradle.kts` (root)

**Option A: includeBuild** (Recommended for development):
```kotlin
// settings.gradle.kts
includeBuild("/home/eric/IdeaProjects/cashu-client") {
    dependencySubstitution {
        substitute(module("xyz.tcheeric:wallet-core-app")).using(project(":wallet-plugin:wallet-core-app"))
        substitute(module("xyz.tcheeric:wallet-core-base")).using(project(":wallet-plugin:wallet-core-base"))
    }
}
```

**Option B: Maven Local** (For production):
```bash
# In cashu-client directory
./gradlew publishToMavenLocal

# In imani-wallet/imani-voucher/build.gradle.kts
kotlin {
    sourceSets {
        val jvmMain by getting {
            dependencies {
                implementation("xyz.tcheeric:wallet-core-app:1.0.0-SNAPSHOT")
                implementation("xyz.tcheeric:wallet-core-base:1.0.0-SNAPSHOT")
            }
        }
    }
}
```

**Acceptance Criteria**:
- [ ] `./gradlew :imani-voucher:build` succeeds
- [ ] Can import `xyz.tcheeric.wallet.core.VoucherService`
- [ ] No transitive dependency conflicts

---

### Task 2.2: Implement JvmVoucherAdapter

**File**: `imani-voucher/src/jvmMain/kotlin/cash/imani/voucher/adapter/JvmVoucherAdapter.kt`

```kotlin
package cash.imani.voucher.adapter

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import xyz.tcheeric.wallet.core.VoucherService
import xyz.tcheeric.wallet.core.WalletConfig
import java.time.Instant as JavaInstant

/**
 * JVM implementation of VoucherAdapter using cashu-client VoucherService.
 *
 * This is a thin wrapper that:
 * 1. Translates Kotlin requests to Java requests
 * 2. Delegates to cashu-client VoucherServiceImpl
 * 3. Translates Java results back to Kotlin
 *
 * Code reuse: ≥95% (all voucher logic from cashu-client)
 */
class JvmVoucherAdapter(
    private val voucherService: VoucherService,
    private val config: WalletConfig
) : VoucherAdapter {

    init {
        // Initialize VoucherService with config
        voucherService.init(config)
    }

    override suspend fun issueVoucher(
        request: IssueVoucherRequest
    ): Result<IssueVoucherResult> = withContext(Dispatchers.IO) {
        runCatching {
            // Translate Kotlin request to Java request
            val javaRequest = VoucherService.IssueVoucherRequest(
                request.amount,
                request.unit,
                request.mintUrl,
                request.expiresInDays,
                request.memo
            )

            // Delegate to cashu-client
            val javaResult = voucherService.issueAndBackup(javaRequest)

            // Translate Java result to Kotlin result
            IssueVoucherResult(
                voucher = javaResult.voucher().toKotlin(),
                token = javaResult.token(),
                backedUp = javaResult.backedUp(),
                message = javaResult.message() ?: "Voucher issued successfully"
            )
        }
    }

    override suspend fun redeemVoucher(token: String): Result<RedeemVoucherResult> =
        withContext(Dispatchers.IO) {
            runCatching {
                // TODO: cashu-client doesn't have redeemVoucher(token) yet
                // Will need to add or use alternative approach
                throw UnsupportedOperationException("Redeem by token not yet implemented in cashu-client")
            }
        }

    override suspend fun revokeVoucher(
        voucherId: String,
        reason: String
    ): Result<RevokeVoucherResult> = withContext(Dispatchers.IO) {
        runCatching {
            val javaRequest = VoucherService.RevokeVoucherRequest(voucherId, reason)
            val javaResult = voucherService.revokeVoucher(javaRequest)

            RevokeVoucherResult(
                voucherId = javaResult.voucherId(),
                previousStatus = VoucherStatus.valueOf(javaResult.previousStatus().uppercase()),
                message = javaResult.message(),
                ledgerPublished = javaResult.ledgerPublished()
            )
        }
    }

    override suspend fun verifyVoucher(voucherId: String): Result<VerifyVoucherResult> =
        withContext(Dispatchers.IO) {
            runCatching {
                val javaRequest = VoucherService.VerifyVoucherRequest(voucherId)
                val javaResult = voucherService.verifyVoucher(javaRequest)

                VerifyVoucherResult(
                    voucherId = javaResult.voucherId(),
                    signatureValid = javaResult.signatureValid(),
                    expired = javaResult.expired(),
                    status = VoucherStatus.valueOf(javaResult.status().uppercase()),
                    message = javaResult.message()
                )
            }
        }

    override suspend fun listVouchers(): Result<List<StoredVoucher>> =
        withContext(Dispatchers.IO) {
            runCatching {
                voucherService.listVouchers().map { it.toKotlin() }
            }
        }

    override suspend fun getVoucher(voucherId: String): Result<StoredVoucher?> =
        withContext(Dispatchers.IO) {
            runCatching {
                voucherService.getVoucher(voucherId).map { it.toKotlin() }.orElse(null)
            }
        }

    override suspend fun backupToNostr(): Result<Int> = withContext(Dispatchers.IO) {
        runCatching {
            voucherService.backupToNostr()
            voucherService.listVouchers().size
        }
    }

    override suspend fun restoreFromNostr(): Result<Int> = withContext(Dispatchers.IO) {
        runCatching {
            voucherService.restoreFromNostr()
        }
    }

    override suspend fun refreshStatus(voucherId: String): Result<StoredVoucher?> =
        withContext(Dispatchers.IO) {
            runCatching {
                voucherService.refreshStatus(voucherId).map { it.toKotlin() }.orElse(null)
            }
        }
}

/**
 * Extension: Convert Java StoredVoucher to Kotlin StoredVoucher.
 */
private fun xyz.tcheeric.wallet.core.state.StoredVoucher.toKotlin(): StoredVoucher {
    return StoredVoucher(
        voucherId = this.voucherId(),
        issuerId = this.issuerId(),
        unit = this.unit(),
        faceValue = this.faceValue(),
        expiresAt = this.expiresAt(),
        memo = this.memo(),
        issuerSignature = this.issuerSignature(),
        issuerPublicKey = this.issuerPublicKey(),
        issuedAt = kotlinx.datetime.Instant.fromEpochSeconds(this.issuedAt().epochSecond),
        status = VoucherStatus.valueOf(this.status().uppercase())
    )
}
```

**Acceptance Criteria**:
- [ ] Can issue voucher via cashu-client
- [ ] Can list vouchers
- [ ] Can verify voucher signature
- [ ] Nostr backup/restore works
- [ ] Unit tests pass

---

### Task 2.3: Update Android DI

**File**: `imani-android/src/androidMain/kotlin/cash/imani/android/di/AndroidModule.kt`

```kotlin
// Add cashu-client VoucherService dependencies
single<VoucherService> {
    val walletStorage = get<WalletStorage>()
    val encryptionService = get<EncryptionService>()
    val backupService = get<VoucherBackupService>()
    val identityKeyService = get<IdentityKeyService>()
    val sendService = get<SendService>()
    val tokenCodec = get<TokenCodec>()

    VoucherServiceImpl(
        walletStorage,
        encryptionService,
        backupService,
        identityKeyService,
        sendService,
        tokenCodec
    )
}

single<VoucherAdapter> {
    JvmVoucherAdapter(
        voucherService = get(),
        config = WalletConfig(
            defaultMintUrl = "http://localhost:7777", // Or from config
            defaultUnit = "sat"
        )
    )
}

// Update IssueVoucherUseCase to use VoucherAdapter
single {
    IssueVoucherUseCase(
        voucherAdapter = get()
    )
}
```

**Acceptance Criteria**:
- [ ] DI graph resolves successfully
- [ ] Can inject `VoucherAdapter` in use cases
- [ ] Android app compiles and runs

---

## Phase 3: Web Implementation (KMP-Compatible)

### Task 3.1: Implement WebVoucherAdapter

**File**: `imani-voucher/src/jsMain/kotlin/cash/imani/voucher/adapter/WebVoucherAdapter.kt`

**Option A: Reuse Existing Logic** (Recommended):
```kotlin
package cash.imani.voucher.adapter

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.nostr.NostrVoucherClient
import cash.imani.voucher.repository.ProofRepository
import cash.imani.voucher.usecases.IssueVoucherUseCase
import cash.imani.voucher.usecases.RedeemVoucherUseCase

/**
 * Web implementation of VoucherAdapter.
 *
 * Reuses existing KMP use cases instead of wrapping cashu-client.
 */
class WebVoucherAdapter(
    private val issueVoucherUseCase: IssueVoucherUseCase,
    private val redeemVoucherUseCase: RedeemVoucherUseCase,
    private val nostrClient: NostrVoucherClient,
    private val proofRepository: ProofRepository
) : VoucherAdapter {

    override suspend fun issueVoucher(
        request: IssueVoucherRequest
    ): Result<IssueVoucherResult> {
        // Delegate to existing IssueVoucherUseCase
        return issueVoucherUseCase(
            cash.imani.voucher.usecases.IssueVoucherRequest(
                amount = request.amount,
                unit = request.unit,
                mintUrl = request.mintUrl,
                expiresInDays = request.expiresInDays,
                memo = request.memo
            )
        ).map { result ->
            IssueVoucherResult(
                voucher = result.voucher,
                token = result.token,
                backedUp = result.backedUp,
                message = result.message
            )
        }
    }

    override suspend fun redeemVoucher(token: String): Result<RedeemVoucherResult> {
        return redeemVoucherUseCase(token).map { result ->
            RedeemVoucherResult(
                voucherId = result.voucherId,
                status = result.status,
                message = result.message,
                amountReceived = result.amountReceived
            )
        }
    }

    override suspend fun listVouchers(): Result<List<StoredVoucher>> {
        return nostrClient.queryVouchersByStatus(null) // All vouchers
    }

    override suspend fun backupToNostr(): Result<Int> {
        // Web already backs up on every issue/redeem
        return listVouchers().map { it.size }
    }

    override suspend fun restoreFromNostr(): Result<Int> {
        // Web restores on query
        return listVouchers().map { it.size }
    }

    // Implement other methods...
}
```

**Option B: Port cashu-client Logic** (If Option A insufficient):
- Port VoucherServiceImpl to pure Kotlin (no JVM dependencies)
- Replace `java.time` with `kotlinx.datetime`
- Replace Jackson with `kotlinx.serialization`

**Acceptance Criteria**:
- [ ] Can issue voucher in browser
- [ ] Can redeem voucher in browser
- [ ] IndexedDB cache works
- [ ] Nostr backup/restore works
- [ ] Unit tests pass

---

### Task 3.2: Update Web DI

**File**: `imani-app/src/jsMain/kotlin/cash/imani/app/di/WebModule.kt`

```kotlin
single<VoucherAdapter> {
    WebVoucherAdapter(
        issueVoucherUseCase = get(),
        redeemVoucherUseCase = get(),
        nostrClient = get(),
        proofRepository = get()
    )
}

// Update use cases to use VoucherAdapter if needed
single {
    IssueVoucherUseCase(
        voucherAdapter = get()
    )
}
```

**Acceptance Criteria**:
- [ ] Web DI graph resolves
- [ ] Can inject `VoucherAdapter` in ViewModels
- [ ] Web app compiles and runs

---

## Phase 4: Migration from Current Implementation

### Task 4.1: Update Use Cases to Use VoucherAdapter

**File**: `imani-voucher/src/commonMain/kotlin/cash/imani/voucher/usecases/IssueVoucherUseCase.kt`

**Before**:
```kotlin
class IssueVoucherUseCase(
    private val voucherRepository: VoucherRepository,
    private val proofRepository: ProofRepository,
    private val mintApiClient: MintApiClient,
    // ... many dependencies
) {
    suspend operator fun invoke(request: IssueVoucherRequest): Result<IssueVoucherResult> {
        // 200+ lines of logic
    }
}
```

**After**:
```kotlin
class IssueVoucherUseCase(
    private val voucherAdapter: VoucherAdapter
) {
    suspend operator fun invoke(
        request: IssueVoucherRequest
    ): Result<IssueVoucherResult> {
        // Delegate to VoucherAdapter (platform-specific implementation)
        return voucherAdapter.issueVoucher(request)
    }
}
```

**Acceptance Criteria**:
- [ ] Use cases simplified to ~10 lines (thin wrappers)
- [ ] No direct dependency on repositories/clients
- [ ] Unit tests pass with mocked VoucherAdapter

---

### Task 4.2: Remove Duplicate Logic

**Files to Clean Up**:
- ✅ Keep: `VoucherAdapter` abstraction
- ✅ Keep: Domain models (`StoredVoucher`, `VoucherStatus`)
- ❌ Remove: Direct MintApiClient usage in use cases (now in JvmVoucherAdapter)
- ❌ Remove: Proof selection logic (now in cashu-client SendService)
- ❌ Remove: Token encoding logic (now in cashu-client TokenCodec)

**Acceptance Criteria**:
- [ ] No code duplication between imani-wallet and cashu-client
- [ ] Code reuse ≥95% on Android
- [ ] All tests still pass

---

## Testing Strategy

### Unit Tests

**Test VoucherAdapter Implementations**:

```kotlin
// imani-voucher/src/jvmTest/kotlin/JvmVoucherAdapterTest.kt
class JvmVoucherAdapterTest {
    @Test
    fun `issueVoucher delegates to cashu-client VoucherService`() = runTest {
        val mockService = mockk<VoucherService>()
        val adapter = JvmVoucherAdapter(mockService, mockConfig)

        coEvery { mockService.issueAndBackup(any()) } returns mockJavaResult

        val result = adapter.issueVoucher(mockRequest)

        assertTrue(result.isSuccess)
        verify { mockService.issueAndBackup(any()) }
    }
}

// imani-voucher/src/jsTest/kotlin/WebVoucherAdapterTest.kt
class WebVoucherAdapterTest {
    @Test
    fun `issueVoucher uses IssueVoucherUseCase`() = runTest {
        val mockUseCase = mockk<IssueVoucherUseCase>()
        val adapter = WebVoucherAdapter(mockUseCase, ...)

        coEvery { mockUseCase(any()) } returns Result.success(mockResult)

        val result = adapter.issueVoucher(mockRequest)

        assertTrue(result.isSuccess)
        verify { mockUseCase(any()) }
    }
}
```

### Integration Tests

**Test Full Flow**:

```kotlin
class VoucherIntegrationTest {
    @Test
    fun `issue voucher on Android using cashu-client`() = runTest {
        // Setup real VoucherServiceImpl (or test double)
        val adapter = JvmVoucherAdapter(realVoucherService, config)

        // Issue voucher
        val result = adapter.issueVoucher(testRequest)

        assertTrue(result.isSuccess)
        assertNotNull(result.getOrThrow().token)
        assertEquals(1000L, result.getOrThrow().voucher.faceValue)
    }
}
```

---

## Troubleshooting

### Issue 1: Dependency Conflict (BouncyCastle Version)

**Symptom**: Build fails with "Conflict between versions of org.bouncycastle"

**Solution**:
```kotlin
// imani-voucher/build.gradle.kts
configurations.all {
    resolutionStrategy {
        force("org.bouncycastle:bcprov-jdk18on:1.78")
    }
}
```

---

### Issue 2: JVM vs Kotlin Instant Conversion

**Symptom**: Type mismatch when converting `java.time.Instant` to `kotlinx.datetime.Instant`

**Solution**:
```kotlin
// Use extension function
fun java.time.Instant.toKotlinInstant(): kotlinx.datetime.Instant {
    return kotlinx.datetime.Instant.fromEpochSeconds(this.epochSecond, this.nano.toLong())
}

fun kotlinx.datetime.Instant.toJavaInstant(): java.time.Instant {
    return java.time.Instant.ofEpochSecond(this.epochSeconds, this.nanosecondsOfSecond.toLong())
}
```

---

### Issue 3: Web Adapter Incomplete

**Symptom**: Some VoucherAdapter methods not implemented in WebVoucherAdapter

**Solution**:
1. Check if existing use cases cover the functionality
2. If not, port minimal logic from cashu-client
3. File GitHub issue for missing features

---

## Summary

| Phase | Android Approach | Web Approach | Code Reuse |
|-------|-----------------|--------------|------------|
| **Phase 1** | Define VoucherAdapter interface | Same | 100% shared interface |
| **Phase 2** | Wrap cashu-client VoucherService | N/A | ≥95% from cashu-client |
| **Phase 3** | N/A | Reuse existing use cases OR port logic | ~70% from existing KMP code |
| **Phase 4** | Simplify use cases to thin wrappers | Same | 100% shared use cases |

**Final Architecture**:
- ✅ Android: 100% cashu-client voucher logic (zero duplication)
- ✅ Web: Reuses existing KMP implementation or minimal porting
- ✅ Shared: VoucherAdapter abstraction, domain models, use cases
- ✅ Testing: Platform-specific tests + shared integration tests

**Next Steps**:
1. Start with Phase 1 (VoucherAdapter interface) - **2 days**
2. Implement Phase 2 (Android wrapper) - **3 days**
3. Implement Phase 3 (Web adapter) - **2 days**
4. Migrate use cases (Phase 4) - **2 days**
5. Integration testing - **2 days**

**Total Estimated Effort**: 11 days (~2 weeks)
