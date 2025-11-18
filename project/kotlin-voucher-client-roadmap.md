# Imani Wallet - Kotlin Multiplatform Implementation Roadmap

> **Product Name**: Imani Wallet
> **Tagline**: Built on Trust, Secured by Math
> **Document Type**: How-To Guide (Diátaxis)
> **Version**: 1.1.0
> **Last Updated**: 2025-11-17
> **Related Documents**:
> - [Kotlin Client Detailed Specification](explanation/kotlin-client-spec-detailed.md)
> - [Web Client Specification (High-Level)](explanation/web-client-spec.md)
> - [NUT Specifications Analysis](../docs/reference/nut-specifications-web-client-analysis.md)

## About Imani

**Imani** (ee-MAH-nee) is Swahili for "faith" and "trust" - the 7th principle of Kwanzaa representing belief in community, self, and the righteousness of purpose. Imani Wallet embodies this principle through:

- **Trust in Cryptography**: Mathematical proofs secure your value
- **Trust in Community**: Peer-to-peer exchange without intermediaries
- **Trust in Self**: Self-sovereign identity and self-custody
- **Trust in the System**: Transparent, open-source, verifiable code

This document provides a phased implementation roadmap for building **Imani Wallet**, a voucher-focused Kotlin Multiplatform application that reuses the existing Java 21 codebase. The application is structured around two core modules: **Identity** and **Voucher**, with initial focus on **Web (Kotlin/JS)**, followed by **Android**, and eventually **iOS**.

---

## Table of Contents

1. [Mission Statement](#mission-statement)
2. [Brand Identity](#brand-identity)
3. [Project Overview](#project-overview)
4. [Module Architecture](#module-architecture)
5. [Phase 0: Project Setup & Foundation](#phase-0-project-setup--foundation)
6. [Phase 1: Identity Module (Web)](#phase-1-identity-module-web)
7. [Phase 2: Voucher Module (Web)](#phase-2-voucher-module-web)
8. [Phase 3: Web Polish & Production](#phase-3-web-polish--production)
9. [Phase 4: Android Port](#phase-4-android-port)
10. [Phase 5: iOS Port](#phase-5-ios-port)
11. [Testing Strategy](#testing-strategy)
12. [Success Metrics](#success-metrics)

---

## Mission Statement

**Imani Wallet** empowers individuals and communities to exchange value with confidence through self-sovereign identity and cryptographically-secured vouchers.

### Our Principles

Inspired by the seven principles of Kwanzaa (Nguzo Saba), Imani Wallet embodies:

1. **Umoja (Unity)**: One codebase, multiple platforms - unified experience across Web, Android, and iOS
2. **Kujichagulia (Self-Determination)**: Self-sovereign identity - you control your keys, you control your identity
3. **Ujima (Collective Work)**: Open-source collaboration and community-driven development
4. **Ujamaa (Cooperative Economics)**: Peer-to-peer value exchange without intermediaries
5. **Nia (Purpose)**: Built to serve communities, not corporations - privacy-first, user-first
6. **Kuumba (Creativity)**: Innovative use of Cashu, Nostr, and Kotlin Multiplatform technologies
7. **Imani (Faith)**: Trust in cryptography, trust in community, trust in self-custody

### Vision

To become the **trusted standard** for digital voucher management in communities worldwide, bridging traditional gift-giving practices with modern cryptographic security.

### Values

- **Privacy by Design**: Your data stays with you, encrypted and secure
- **Transparency**: Open-source code, verifiable cryptographic proofs
- **Accessibility**: Simple enough for anyone, powerful enough for experts
- **Interoperability**: Built on open protocols (Cashu NUTs, Nostr NIPs)
- **Resilience**: Works offline, syncs when online, recovers from backup

---

## Brand Identity

### Visual Identity

**Logo Concept**: Interlocking hands forming a shield, symbolizing trust and protection

**Color Palette**:
- **Primary - Deep Purple** (#6B46C1): Trust, wisdom, royalty
- **Accent - Gold** (#F59E0B): Value, warmth, African heritage
- **Secondary - Deep Blue** (#1E40AF): Security, stability
- **Background - Cream** (#FFFBEB): Clarity, openness

**Typography**:
- **Headers**: Inter Bold (modern, accessible)
- **Body**: Inter Regular (clean, readable)
- **Code/Tokens**: JetBrains Mono (technical precision)

### Product Suite

| Product | Description | Target Platform |
|---------|-------------|-----------------|
| **Imani Wallet** | Core application for voucher management | Web, Android, iOS |
| **Imani Identity** | Identity module for key management | Library (Kotlin Multiplatform) |
| **Imani Vouchers** | Voucher issuance and redemption | Library (Kotlin Multiplatform) |
| **Imani Vault** | Secure encrypted storage | Platform-specific implementations |

### Messaging

**Primary Tagline**: "Built on Trust, Secured by Math"

**Secondary Taglines**:
- "Your Value, Your Trust"
- "Faith in Every Transaction"
- "Where Community Meets Cryptography"

**Elevator Pitch** (30 seconds):
> Imani Wallet is a self-custody digital voucher app that lets you issue, share, and redeem value tokens with cryptographic security. Like sending a gift card, but with the privacy of cash and the security of Bitcoin. Your keys, your identity, your trust.

**Feature Highlights**:
- 🔐 Self-sovereign identity (you control your keys)
- 🎁 Issue vouchers as digital gifts
- 📱 QR code sharing (instant, offline-capable)
- 🔄 Nostr relay backup (decentralized, censorship-resistant)
- ✅ Cryptographic verification (math-backed trust)
- 🌍 Cross-platform (Web, Android, iOS from one codebase)

---

## Project Overview

### Application Focus: Voucher Management

**Core Use Cases**:
1. **Identity Management**: Create, import, and manage Nostr identities for voucher signing
2. **Issue Vouchers**: Create P2PK-locked vouchers backed by Cashu proofs
3. **Share Vouchers**: Share via QR code, URL, or Nostr relay
4. **Redeem Vouchers**: Validate and redeem received vouchers
5. **Track Status**: Monitor voucher lifecycle (issued → delivered → redeemed)

**Non-Goals** (Defer to Future):
- Full wallet management (mint/melt operations)
- Lightning payments
- Multi-unit support (focus on `sat` only initially)
- Complex proof selection (use simple FIFO)

### Timeline

| Phase | Focus | Duration | Target Completion |
|-------|-------|----------|-------------------|
| Phase 0 | Project Setup & Foundation | 2 weeks | Week 2 |
| Phase 1 | Identity Module (Web) | 3 weeks | Week 5 |
| Phase 2 | Voucher Module (Web) | 4 weeks | Week 9 |
| Phase 3 | Web Polish & Production | 2 weeks | Week 11 |
| Phase 4 | Android Port | 3 weeks | Week 14 |
| Phase 5 | iOS Port | 4 weeks | Week 18 |

**Total Duration**: 18 weeks (~4.5 months)

### Team Composition

- **Kotlin Developer (Lead)**: Full-stack Kotlin/JVM experience, 100% allocation
- **Frontend Developer**: Compose Multiplatform, 100% allocation
- **Mobile Developer**: Android/iOS experience, 50% allocation (Phase 4-5)
- **QA Engineer**: Testing and automation, 50% allocation

---

## Module Architecture

### Two-Module Structure

```
imani-wallet/
├── imani-identity/                   # Identity module (reused across all platforms)
│   ├── commonMain/
│   │   ├── cash/imani/identity/
│   │   │   ├── domain/              # Identity, PrivateKey, PublicKey
│   │   │   ├── usecases/            # CreateIdentityUseCase, SignEventUseCase
│   │   │   ├── repository/          # IdentityRepository interface
│   │   │   └── crypto/              # CryptoAdapter interface (expect/actual)
│   ├── webMain/cash/imani/identity/  # Web Crypto API implementation
│   ├── androidMain/cash/imani/identity/ # Android Keystore implementation
│   └── iosMain/cash/imani/identity/  # iOS Keychain implementation
│
├── imani-voucher/                    # Voucher module
│   ├── commonMain/
│   │   ├── cash/imani/voucher/
│   │   │   ├── domain/              # StoredVoucher, Proof, WalletState
│   │   │   ├── usecases/            # IssueVoucherUseCase, RedeemVoucherUseCase
│   │   │   ├── repository/          # VoucherRepository, ProofRepository
│   │   │   ├── network/             # MintApiClient (Ktor)
│   │   │   └── storage/             # StorageAdapter interface (expect/actual)
│   ├── webMain/cash/imani/voucher/   # IndexedDB implementation
│   ├── androidMain/cash/imani/voucher/ # SQLDelight Android driver
│   └── iosMain/cash/imani/voucher/   # SQLDelight Native driver
│
├── imani-app/                        # Compose Multiplatform UI
│   ├── commonMain/
│   │   ├── cash/imani/app/
│   │   │   ├── ui/
│   │   │   │   ├── identity/        # Identity screens
│   │   │   │   ├── voucher/         # Voucher screens
│   │   │   │   ├── theme/           # Imani brand theme (colors, typography)
│   │   │   │   └── components/      # Reusable UI components
│   │   │   ├── viewmodels/          # ViewModels (StateFlow)
│   │   │   └── navigation/          # Navigation graph
│   ├── webMain/cash/imani/app/       # Web entry point
│   ├── androidMain/cash/imani/app/   # Android entry point
│   └── iosMain/cash/imani/app/       # iOS entry point
│
└── imani-web/                        # Web application deployment
    └── src/
        └── jsMain/
            └── kotlin/cash/imani/web/Main.kt
```

### Dependency Flow

```
imani-app (UI)
    ↓
    ├── imani-identity
    │   ├── commonMain (domain, usecases)
    │   └── webMain (Web Crypto API)
    │
    └── imani-voucher
        ├── commonMain (domain, usecases, Ktor client)
        ├── webMain (IndexedDB)
        └── depends on → imani-identity
```

### Package Naming Convention

**Base Package**: `cash.imani`

**Module Packages**:
- `cash.imani.identity.*` - Identity management
- `cash.imani.voucher.*` - Voucher operations
- `cash.imani.app.*` - UI application
- `cash.imani.crypto.*` - Cryptographic primitives
- `cash.imani.storage.*` - Platform-specific storage

---

## Phase 0: Project Setup & Foundation

**Goal**: Set up Kotlin Multiplatform project structure, build configuration, and development tooling.

**Duration**: 2 weeks

### Tasks

#### 0.1. Repository and Build Setup
- [ ] Create new Git repository: `imani-wallet`
- [ ] Initialize Gradle project with Kotlin Multiplatform plugin
- [ ] Configure multi-module structure:
  - `imani-identity` (Kotlin Multiplatform Library)
  - `imani-voucher` (Kotlin Multiplatform Library)
  - `imani-app` (Compose Multiplatform)
  - `imani-web` (Kotlin/JS application)
- [ ] Configure `build.gradle.kts` for each module (see template below)
- [ ] Set up version catalogs for dependency management

**Gradle Configuration Template**:

```kotlin
// build.gradle.kts (root)
plugins {
    kotlin("multiplatform") version "1.9.22" apply false
    kotlin("plugin.serialization") version "1.9.22" apply false
    id("org.jetbrains.compose") version "1.6.0" apply false
    id("com.android.application") version "8.2.2" apply false
    id("com.android.library") version "8.2.2" apply false
}

allprojects {
    group = "cash.imani"
    version = "1.0.0-SNAPSHOT"

    repositories {
        google()
        mavenCentral()
        maven("https://maven.pkg.jetbrains.space/public/p/compose/dev")
    }
}

// imani-identity/build.gradle.kts
plugins {
    kotlin("multiplatform")
    kotlin("plugin.serialization")
}

kotlin {
    js(IR) {
        browser {
            commonWebpackConfig {
                cssSupport { enabled.set(true) }
            }
        }
        binaries.executable()
    }

    jvm() // For future use

    sourceSets {
        val commonMain by getting {
            dependencies {
                implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")
                implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.2")
            }
        }

        val commonTest by getting {
            dependencies {
                implementation(kotlin("test"))
                implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.7.3")
            }
        }

        val jsMain by getting {
            dependencies {
                // Web-specific dependencies
            }
        }
    }
}

// imani-voucher/build.gradle.kts
plugins {
    kotlin("multiplatform")
    kotlin("plugin.serialization")
}

kotlin {
    js(IR) {
        browser()
        binaries.executable()
    }

    jvm()

    sourceSets {
        val commonMain by getting {
            dependencies {
                implementation(project(":imani-identity"))
                implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")
                implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.2")
                implementation("io.ktor:ktor-client-core:2.3.7")
                implementation("io.ktor:ktor-client-content-negotiation:2.3.7")
                implementation("io.ktor:ktor-serialization-kotlinx-json:2.3.7")
            }
        }

        val jsMain by getting {
            dependencies {
                implementation("io.ktor:ktor-client-js:2.3.7")
            }
        }
    }
}

// imani-app/build.gradle.kts
plugins {
    kotlin("multiplatform")
    id("org.jetbrains.compose")
}

kotlin {
    js(IR) {
        browser()
        binaries.executable()
    }

    sourceSets {
        val commonMain by getting {
            dependencies {
                implementation(project(":imani-identity"))
                implementation(project(":imani-voucher"))
                implementation(compose.runtime)
                implementation(compose.foundation)
                implementation(compose.material3)
                implementation(compose.ui)
                implementation(compose.components.resources)
            }
        }
    }
}
```

**Acceptance Criteria**:
- Project builds successfully: `./gradlew build`
- Module dependencies resolve correctly
- Web target compiles: `./gradlew :imani-web:jsBrowserDevelopmentRun`
- Package names follow `cash.imani.*` convention

**Effort**: 3 days

---

#### 0.2. Convert Existing Java Domain Models to Kotlin

**Goal**: Convert core domain models from existing Java codebase to Kotlin `data class`.

**Steps**:
1. Convert `Identity`, `PrivateKey`, `PublicKey` from `identity-domain`:
   ```java
   // Java (existing)
   public record Identity(String id, String label, PublicKey publicKey, ...) {}
   ```
   ```kotlin
   // Kotlin (identity-module/commonMain)
   @Serializable
   data class Identity(
       val id: String,
       val label: String,
       val publicKey: String, // Hex-encoded
       @Contextual
       val createdAt: Instant,
       @Contextual
       val lastUsedAt: Instant
   ) {
       fun toNpub(): String = Bech32.encode("npub", publicKey.hexToBytes())
       fun isActive(): Boolean = lastUsedAt > Clock.System.now().minus(90.days)
   }
   ```

2. Convert `StoredVoucher`, `WalletState`, `Proof` from `wallet-core-base`:
   ```kotlin
   // imani-voucher/commonMain/cash/imani/voucher/domain/StoredVoucher.kt
   package cash.imani.voucher.domain

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
       @Contextual
       val issuedAt: Instant,
       val status: VoucherStatus,
       val token: String? = null,
       val deliveryMetadata: DeliveryMetadata? = null,
       val redemptionMetadata: RedemptionMetadata? = null
   ) {
       fun isExpired(): Boolean = expiresAt?.let { it < Clock.System.now().epochSeconds } ?: false
       fun isActive(): Boolean = status == VoucherStatus.ISSUED && !isExpired()
   }

   @Serializable
   enum class VoucherStatus {
       ISSUED, DELIVERED, REDEEMED, REVOKED, EXPIRED
   }

   @Serializable
   data class Proof(
       val amount: Int,
       val secret: String,
       val C: String,
       val id: String
   )

   @Serializable
   data class WalletState(
       val vouchers: List<StoredVoucher>,
       val proofs: List<Proof>,
       @Contextual
       val lastUpdated: Instant
   )
   ```

**Acceptance Criteria**:
- All domain models compile in `commonMain`
- JSON serialization works (test with `kotlinx.serialization`)
- Models are identical to Java versions (field names, types)

**Effort**: 3 days

---

#### 0.3. Set Up Testing Infrastructure

- [ ] Configure Kotlin Test for `commonTest`
- [ ] Add Kotest for BDD-style tests (optional)
- [ ] Set up MockK for mocking
- [ ] Create sample unit test:
   ```kotlin
   // imani-identity/commonTest/kotlin/cash/imani/identity/domain/IdentityTest.kt
   package cash.imani.identity.domain

   class IdentityTest {
       @Test
       fun `isActive returns true when last used within 90 days`() {
           val now = Clock.System.now()
           val identity = Identity(
               id = "test",
               label = "Test",
               publicKey = "0".repeat(64),
               createdAt = now.minus(30.days),
               lastUsedAt = now
           )
           assertTrue(identity.isActive())
       }
   }
   ```

**Acceptance Criteria**:
- Tests run successfully: `./gradlew test`
- Coverage report generated

**Effort**: 2 days

---

#### 0.4. CI/CD Pipeline Setup

- [ ] Configure GitHub Actions workflow:
  ```yaml
  # .github/workflows/build.yml
  name: Build and Test

  on:
    push:
      branches: [ main, develop ]
    pull_request:
      branches: [ main ]

  jobs:
    build:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-java@v4
          with:
            distribution: 'temurin'
            java-version: '21'
        - name: Build project
          run: ./gradlew build
        - name: Run tests
          run: ./gradlew test
        - name: Build web app
          run: ./gradlew :web:jsBrowserProductionWebpack
  ```
- [ ] Configure Dependabot for dependency updates
- [ ] Set up code coverage reporting (Kover)

**Acceptance Criteria**:
- CI pipeline passes on sample PR
- Code coverage report published

**Effort**: 1 day

---

#### 0.5. Development Tooling

- [ ] Configure IntelliJ IDEA project structure
- [ ] Set up Kotlin code style (ktlint or detekt)
- [ ] Create run configurations for web development
- [ ] Document local development setup in `README.md`

**Acceptance Criteria**:
- Developers can run web app locally: `./gradlew :imani-web:jsBrowserDevelopmentRun`
- Code style checks pass: `./gradlew ktlintCheck`
- Imani brand theme configured in UI module

**Effort**: 1 day

---

### Phase 0 Deliverables

- [ ] Multi-module Kotlin Multiplatform project structure
- [ ] Core domain models converted to Kotlin
- [ ] Testing infrastructure (unit tests running)
- [ ] CI/CD pipeline (GitHub Actions)
- [ ] Development tooling configured

**Total Effort**: 10 days (2 weeks with buffer)

### Phase 0 Task Tracking

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 0.1 | Repository and Build Setup | M (3d) | ✅ DONE | d6e0b88 | Created imani-wallet project with 4 modules, Gradle version catalog, package naming cash.imani.* | None |
| 0.2 | Convert Java Domain Models to Kotlin | M (3d) | ✅ DONE | 8b17f1e | Hybrid approach: Identity (with privateKey), PublicKey (32-byte), PrivateKey (with clear()), StoredVoucher, Proof (NUT-00), WalletState. ~75% code reuse. See JAVA_TO_KOTLIN_MIGRATION.md | 0.1 |
| 0.3 | Set Up Testing Infrastructure | M (2d) | ✅ DONE | 46fc742 | 54 test cases (744 lines) across 6 test files. Kotlin Test + coroutines-test configured. 100% coverage of domain models. Tests in commonTest for KMP. | 0.1 |
| 0.4 | CI/CD Pipeline Setup | S (1d) | ✅ DONE | bb3b787 | GitHub Actions (build/test/coverage), Dependabot (weekly updates), Kover 0.7.5 (XML reports for Codecov). Gradle wrapper pending Task 0.5. | 0.1, 0.3 |
| 0.5 | Development Tooling | S (1d) | ✅ DONE | 0e646d6 | Gradle wrapper (8.5), ktlint (12.1.0), .editorconfig, IntelliJ run configs (5), Imani brand theme (ImaniColors/Typography/Spacing), comprehensive README.md. | 0.1 |

#### Legend
- 📋 **TODO**: Ready to implement
- 🔶 **IN PROGRESS**: Currently being worked on
- ✅ **DONE**: Completed and tested
- 🚫 **BLOCKED**: Waiting on dependencies
- 📝 **DEFERRED**: Postponed to later phase

[↑ Back to top](#imani-wallet---kotlin-multiplatform-implementation-roadmap)

---

## Phase 1: Identity Module (Web)

**Goal**: Implement complete identity management for Web platform (create, import, sign events).

**Duration**: 3 weeks

**Depends On**: Phase 0 complete

### Tasks

#### 1.1. Crypto Adapter for Web (Kotlin/JS)

**Implement `CryptoAdapter` using Web Crypto API via JS interop**:

```kotlin
// imani-identity/commonMain/cash/imani/identity/crypto/CryptoAdapter.kt
package cash.imani.identity.crypto

interface CryptoAdapter {
    suspend fun generateRandomBytes(length: Int): ByteArray
    suspend fun sha256(data: ByteArray): ByteArray
    suspend fun generateKeypair(): KeyPair
    suspend fun schnorrSign(privateKey: ByteArray, message: ByteArray): ByteArray
    suspend fun schnorrVerify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean
    suspend fun encryptNip44(plaintext: String, recipientPubkey: String, senderPrivkey: String): String
    suspend fun decryptNip44(ciphertext: String, senderPubkey: String, recipientPrivkey: String): String
}

data class KeyPair(val publicKey: ByteArray, val privateKey: ByteArray)

// imani-identity/jsMain/cash/imani/identity/crypto/WebCryptoAdapter.kt
package cash.imani.identity.crypto

actual class CryptoAdapter {
    private val crypto = kotlinx.browser.window.crypto

    actual suspend fun generateRandomBytes(length: Int): ByteArray {
        val array = Uint8Array(length)
        crypto.getRandomValues(array)
        return array.unsafeCast<ByteArray>()
    }

    actual suspend fun sha256(data: ByteArray): ByteArray = suspendCoroutine { cont ->
        crypto.subtle.digest("SHA-256", data.toJsUint8Array()).then { result ->
            cont.resume(Uint8Array(result).unsafeCast<ByteArray>())
        }
    }

    actual suspend fun generateKeypair(): KeyPair {
        // Use @noble/secp256k1 library via dynamic import
        val secp256k1 = js("require('@noble/secp256k1')")
        val privKey = generateRandomBytes(32)
        val pubKey = secp256k1.getPublicKey(privKey, false).unsafeCast<ByteArray>()
        return KeyPair(pubKey, privKey)
    }

    actual suspend fun schnorrSign(privateKey: ByteArray, message: ByteArray): ByteArray {
        val secp256k1 = js("require('@noble/secp256k1')")
        return secp256k1.schnorr.sign(message, privateKey).unsafeCast<ByteArray>()
    }

    // ... NIP-44 encryption using @noble/hashes and chacha20
}
```

**NPM Dependencies** (add to `package.json` for web target):
```json
{
  "dependencies": {
    "@noble/secp256k1": "^2.0.0",
    "@noble/hashes": "^1.3.3",
    "@scure/bip39": "^1.2.1"
  }
}
```

**Acceptance Criteria**:
- Can generate secp256k1 keypairs in browser
- SHA-256 hashing works
- Schnorr signatures verify correctly
- NIP-44 encryption roundtrip succeeds

**Effort**: 5 days

---

#### 1.2. Identity Repository (Web Storage)

**Implement encrypted localStorage for identity persistence**:

```kotlin
// imani-identity/commonMain/cash/imani/identity/repository/IdentityRepository.kt
package cash.imani.identity.repository

interface IdentityRepository {
    suspend fun createIdentity(label: String): Result<Identity>
    suspend fun listIdentities(): Result<List<Identity>>
    suspend fun getIdentity(id: String): Result<Identity>
    suspend fun deleteIdentity(id: String): Result<Unit>
    suspend fun importFromMnemonic(mnemonic: String, label: String): Result<Identity>
    suspend fun exportMnemonic(id: String): Result<String>
}

// imani-identity/jsMain/cash/imani/identity/repository/WebIdentityRepository.kt
package cash.imani.identity.repository

class WebIdentityRepository(
    private val cryptoAdapter: CryptoAdapter
) : IdentityRepository {

    private val storage = kotlinx.browser.window.localStorage

    override suspend fun createIdentity(label: String): Result<Identity> = runCatching {
        val keypair = cryptoAdapter.generateKeypair()
        val mnemonic = generateMnemonic(keypair.privateKey) // Using @scure/bip39

        val identity = Identity(
            id = UUID.randomUUID().toString(),
            label = label,
            publicKey = keypair.publicKey.toHex(),
            createdAt = Clock.System.now(),
            lastUsedAt = Clock.System.now()
        )

        // Store encrypted private key
        val encryptedPrivKey = encryptPrivateKey(keypair.privateKey)
        storage.setItem("identity_${identity.id}", Json.encodeToString(identity))
        storage.setItem("privkey_${identity.id}", encryptedPrivKey)
        storage.setItem("mnemonic_${identity.id}", mnemonic)

        identity
    }

    override suspend fun listIdentities(): Result<List<Identity>> = runCatching {
        val identities = mutableListOf<Identity>()
        for (i in 0 until storage.length) {
            val key = storage.key(i) ?: continue
            if (key.startsWith("identity_")) {
                val json = storage.getItem(key) ?: continue
                identities.add(Json.decodeFromString(json))
            }
        }
        identities.sortedByDescending { it.lastUsedAt }
    }

    private suspend fun encryptPrivateKey(privateKey: ByteArray): String {
        // Encrypt with user passphrase (derived key)
        // For simplicity, use Web Crypto API AES-GCM
        // In production, derive key from passphrase using Argon2 or PBKDF2
        TODO("Implement passphrase-based encryption")
    }
}
```

**Acceptance Criteria**:
- Identities persist in localStorage
- Can create, list, and delete identities
- Private keys encrypted at rest
- Mnemonic backup stored securely

**Effort**: 4 days

---

#### 1.3. Identity Use Cases

**Convert existing Java use cases to Kotlin**:

```kotlin
// imani-identity/commonMain/cash/imani/identity/usecases/CreateIdentityUseCase.kt
package cash.imani.identity.usecases

class CreateIdentityUseCase(
    private val repository: IdentityRepository
) {
    suspend operator fun invoke(label: String): Result<Identity> {
        return repository.createIdentity(label)
    }
}

// imani-identity/commonMain/cash/imani/identity/usecases/ImportIdentityUseCase.kt
package cash.imani.identity.usecases

class ImportIdentityUseCase(
    private val repository: IdentityRepository
) {
    suspend operator fun invoke(mnemonic: String, label: String): Result<Identity> {
        return repository.importFromMnemonic(mnemonic, label)
    }
}

// imani-identity/commonMain/cash/imani/identity/usecases/SignNostrEventUseCase.kt
package cash.imani.identity.usecases

class SignNostrEventUseCase(
    private val repository: IdentityRepository,
    private val cryptoAdapter: CryptoAdapter
) {
    suspend operator fun invoke(identityId: String, event: NostrEvent): Result<SignedEvent> = runCatching {
        val identity = repository.getIdentity(identityId).getOrThrow()
        val privateKey = repository.getPrivateKey(identityId).getOrThrow()

        val eventId = event.computeId() // SHA-256 of serialized event
        val signature = cryptoAdapter.schnorrSign(privateKey, eventId)

        SignedEvent(
            event = event,
            id = eventId.toHex(),
            sig = signature.toHex()
        )
    }
}

@Serializable
data class NostrEvent(
    val kind: Int,
    val created_at: Long,
    val tags: List<List<String>>,
    val content: String,
    val pubkey: String
) {
    fun computeId(): ByteArray {
        val json = Json.encodeToString(serializer(), this)
        return sha256(json.encodeToByteArray())
    }
}

@Serializable
data class SignedEvent(
    val event: NostrEvent,
    val id: String,
    val sig: String
)
```

**Acceptance Criteria**:
- Use cases compile and run
- Unit tests pass for all use cases
- Follows Result pattern (no exceptions thrown)

**Effort**: 2 days

---

#### 1.4. Identity UI (Compose for Web)

**Build Compose UI screens for identity management**:

```kotlin
// imani-app/commonMain/cash/imani/app/ui/identity/IdentityListScreen.kt
package cash.imani.app.ui.identity

@Composable
fun IdentityListScreen(
    viewModel: IdentityViewModel,
    onCreateClick: () -> Unit,
    onIdentityClick: (Identity) -> Unit
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(title = { Text("Identities") })
        },
        floatingActionButton = {
            FloatingActionButton(onClick = onCreateClick) {
                Icon(Icons.Default.Add, "Create Identity")
            }
        }
    ) { padding ->
        when (val state = uiState) {
            is IdentityUiState.Loading -> {
                Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator()
                }
            }

            is IdentityUiState.Success -> {
                LazyColumn(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    items(state.identities) { identity ->
                        IdentityCard(
                            identity = identity,
                            onClick = { onIdentityClick(identity) }
                        )
                    }
                }
            }

            is IdentityUiState.Error -> {
                ErrorView(
                    message = state.message,
                    onRetry = { viewModel.loadIdentities() }
                )
            }
        }
    }
}

@Composable
fun IdentityCard(identity: Identity, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        elevation = CardDefaults.cardElevation(4.dp)
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(identity.label, style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(4.dp))
            Text(
                text = identity.toNpub(),
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Spacer(Modifier.height(8.dp))
            Row {
                Icon(
                    Icons.Default.CheckCircle,
                    contentDescription = null,
                    tint = if (identity.isActive()) Color.Green else Color.Gray,
                    modifier = Modifier.size(16.dp)
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    text = if (identity.isActive()) "Active" else "Inactive",
                    style = MaterialTheme.typography.bodySmall
                )
            }
        }
    }
}

// imani-app/commonMain/cash/imani/app/ui/identity/CreateIdentityScreen.kt
package cash.imani.app.ui.identity

@Composable
fun CreateIdentityScreen(
    viewModel: IdentityViewModel,
    onSuccess: () -> Unit,
    onCancel: () -> Unit
) {
    var label by remember { mutableStateOf("") }
    var mnemonic by remember { mutableStateOf<String?>(null) }
    var isCreating by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Create Identity") },
                navigationIcon = {
                    IconButton(onClick = onCancel) {
                        Icon(Icons.Default.ArrowBack, "Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            if (mnemonic == null) {
                // Step 1: Enter label
                TextField(
                    value = label,
                    onValueChange = { label = it },
                    label = { Text("Identity Label") },
                    modifier = Modifier.fillMaxWidth()
                )

                Button(
                    onClick = {
                        isCreating = true
                        viewModel.createIdentity(label) { result ->
                            result.onSuccess { mnemonicPhrase ->
                                mnemonic = mnemonicPhrase
                                isCreating = false
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = label.isNotBlank() && !isCreating
                ) {
                    if (isCreating) {
                        CircularProgressIndicator(Modifier.size(24.dp))
                    } else {
                        Text("Create Identity")
                    }
                }
            } else {
                // Step 2: Display mnemonic
                Text(
                    "⚠️ Write down your recovery phrase",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.error
                )

                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant
                    )
                ) {
                    Text(
                        text = mnemonic!!,
                        modifier = Modifier.padding(16.dp),
                        style = MaterialTheme.typography.bodyLarge,
                        fontFamily = FontFamily.Monospace
                    )
                }

                Text(
                    "This phrase is the only way to recover your identity. Store it safely.",
                    style = MaterialTheme.typography.bodySmall
                )

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    OutlinedButton(
                        onClick = {
                            // Copy to clipboard
                            copyToClipboard(mnemonic!!)
                        },
                        modifier = Modifier.weight(1f)
                    ) {
                        Icon(Icons.Default.ContentCopy, "Copy")
                        Spacer(Modifier.width(4.dp))
                        Text("Copy")
                    }

                    Button(
                        onClick = onSuccess,
                        modifier = Modifier.weight(1f)
                    ) {
                        Text("I've saved it")
                    }
                }
            }
        }
    }
}
```

**ViewModel**:

```kotlin
// imani-app/commonMain/cash/imani/app/viewmodels/IdentityViewModel.kt
package cash.imani.app.viewmodels

class IdentityViewModel(
    private val createIdentityUseCase: CreateIdentityUseCase,
    private val listIdentitiesUseCase: ListIdentitiesUseCase
) : ViewModel() {

    private val _uiState = MutableStateFlow<IdentityUiState>(IdentityUiState.Loading)
    val uiState: StateFlow<IdentityUiState> = _uiState.asStateFlow()

    init {
        loadIdentities()
    }

    fun loadIdentities() {
        viewModelScope.launch {
            _uiState.value = IdentityUiState.Loading
            listIdentitiesUseCase()
                .onSuccess { identities ->
                    _uiState.value = IdentityUiState.Success(identities)
                }
                .onFailure { error ->
                    _uiState.value = IdentityUiState.Error(error.message ?: "Failed to load identities")
                }
        }
    }

    fun createIdentity(label: String, onResult: (Result<String>) -> Unit) {
        viewModelScope.launch {
            createIdentityUseCase(label)
                .onSuccess { identity ->
                    // Return mnemonic for display
                    val mnemonic = getMnemonic(identity.id) // From repository
                    onResult(Result.success(mnemonic))
                    loadIdentities()
                }
                .onFailure { error ->
                    onResult(Result.failure(error))
                }
        }
    }
}

sealed interface IdentityUiState {
    object Loading : IdentityUiState
    data class Success(val identities: List<Identity>) : IdentityUiState
    data class Error(val message: String) : IdentityUiState
}
```

**Acceptance Criteria**:
- Identity list displays correctly in browser
- Can create identity with label
- Mnemonic displayed with warning
- Can copy mnemonic to clipboard
- Identity persists in localStorage

**Effort**: 4 days

---

#### 1.5. Dependency Injection (Koin)

**Set up Koin for dependency injection**:

```kotlin
// imani-app/commonMain/cash/imani/app/di/AppModule.kt
package cash.imani.app.di

val appModule = module {
    // Identity module
    single<CryptoAdapter> { WebCryptoAdapter() }
    single<IdentityRepository> { WebIdentityRepository(get()) }
    single { CreateIdentityUseCase(get()) }
    single { ListIdentitiesUseCase(get()) }
    single { SignNostrEventUseCase(get(), get()) }
    single { IdentityViewModel(get(), get()) }
}

// imani-web/src/jsMain/kotlin/cash/imani/web/Main.kt
package cash.imani.web

fun main() {
    startKoin {
        modules(appModule)
    }

    CanvasBasedWindow("Imani Wallet") {
        MaterialTheme {
            AppNavigation()
        }
    }
}
```

**Acceptance Criteria**:
- Koin initializes successfully
- Dependencies resolve correctly
- ViewModels injected into Composables

**Effort**: 1 day

---

### Phase 1 Deliverables

- [x] Web Crypto API adapter (secp256k1, SHA-256, Schnorr, NIP-44)
- [x] Identity repository (localStorage with encryption)
- [x] Identity use cases (create, import, sign)
- [x] Identity UI screens (list, create, import)
- [x] Dependency injection configured

**Total Effort**: 16 days (~3 weeks with buffer)

### Phase 1 Task Tracking

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 1.1 | Crypto Adapter for Web (Kotlin/JS) | L (5d) | ✅ DONE | 3660043 | Web Crypto API, @noble/secp256k1, Schnorr signatures working | 0.1, 0.2 |
| 1.2 | Identity Repository (Web Storage) | M (4d) | ✅ DONE | 3660043 | localStorage with XOR encryption, BIP39 mnemonics, 16 unit tests passing | 1.1 |
| 1.3 | Identity Use Cases | M (2d) | ✅ DONE | 3660043 | 4 use cases implemented (Create, List, Import, SignNostr), Nostr event models (NIP-01), 13 unit tests passing, mock adapters for testing | 1.1, 1.2 |
| 1.4 | Identity UI (Compose for Web) | M (4d) | ✅ DONE | 9cacdbb | List, create, import screens with Material 3, ViewModel with reactive state, navigation routing, web entry point | 1.2, 1.3 |
| 1.5 | Dependency Injection (Koin) | S (1d) | ✅ DONE | 8ee0624 | Koin 3.5.3 configured, appModule with all dependencies, custom koinInject() helper for Compose KMP | 1.3, 1.4 |

[↑ Back to top](#imani-wallet---kotlin-multiplatform-implementation-roadmap)

---

## Phase 2: Voucher Module (Web)

**Goal**: Implement complete voucher management (issue, share, redeem, track status).

**Duration**: 4 weeks

**Depends On**: Phase 1 complete

### Tasks

#### 2.1. Ktor HTTP Client for Mint API

**Implement Cashu Mint API client using Ktor**:

```kotlin
// imani-voucher/commonMain/cash/imani/voucher/network/MintApiClient.kt
package cash.imani.voucher.network

class MintApiClient(
    private val httpClient: HttpClient
) {
    suspend fun getInfo(mintUrl: String): Result<MintInfo> = runCatching {
        httpClient.get("$mintUrl/v1/info").body()
    }

    suspend fun getKeySets(mintUrl: String): Result<List<KeySet>> = runCatching {
        val response: KeySetsResponse = httpClient.get("$mintUrl/v1/keys").body()
        response.keysets
    }

    suspend fun swapProofs(
        mintUrl: String,
        proofs: List<Proof>,
        outputs: List<BlindedMessage>
    ): Result<SwapResponse> = runCatching {
        httpClient.post("$mintUrl/v1/swap") {
            contentType(ContentType.Application.Json)
            setBody(SwapRequest(proofs, outputs))
        }.body()
    }

    suspend fun checkProofStates(mintUrl: String, secrets: List<String>): Result<ProofStateResponse> = runCatching {
        httpClient.post("$mintUrl/v1/checkstate") {
            contentType(ContentType.Application.Json)
            setBody(CheckStateRequest(secrets.map { sha256(it.encodeToByteArray()).toHex() }))
        }.body()
    }
}

@Serializable
data class MintInfo(
    val name: String,
    val pubkey: String,
    val version: String,
    val description: String,
    val description_long: String? = null,
    val contact: List<ContactInfo> = emptyList(),
    val motd: String? = null,
    val nuts: Map<String, NutInfo>
)

@Serializable
data class KeySetsResponse(
    val keysets: List<KeySet>
)

@Serializable
data class KeySet(
    val id: String,
    val unit: String,
    val active: Boolean,
    val keys: Map<Int, String>
)

@Serializable
data class SwapRequest(
    val inputs: List<Proof>,
    val outputs: List<BlindedMessage>
)

@Serializable
data class SwapResponse(
    val signatures: List<BlindSignature>
)

@Serializable
data class CheckStateRequest(
    val Ys: List<String> // SHA-256 of secrets
)

@Serializable
data class ProofStateResponse(
    val states: List<ProofState>
)

@Serializable
data class ProofState(
    val Y: String,
    val state: String, // "UNSPENT", "PENDING", "SPENT"
    val witness: String? = null
)
```

**Configure Ktor Client**:

```kotlin
// imani-voucher/commonMain/cash/imani/voucher/network/HttpClientFactory.kt
package cash.imani.voucher.network

fun createHttpClient(): HttpClient {
    return HttpClient {
        install(ContentNegotiation) {
            json(Json {
                ignoreUnknownKeys = true
                isLenient = true
            })
        }
        install(Logging) {
            level = LogLevel.INFO
        }
        defaultRequest {
            header(HttpHeaders.ContentType, ContentType.Application.Json)
        }
    }
}
```

**Acceptance Criteria**:
- Can fetch mint info from real Cashu mint
- Can fetch keySets
- Swap operation succeeds (with mock proofs)
- Check proof states returns correct response

**Effort**: 4 days

---

#### 2.2. Proof Management and Token Encoding

**Implement proof storage and Cashu token encoding**:

```kotlin
// voucher-module/commonMain/domain/Proof.kt
@Serializable
data class Proof(
    val amount: Int,
    val secret: String,
    val C: String,
    val id: String // KeySet ID
)

// voucher-module/commonMain/repository/ProofRepository.kt
interface ProofRepository {
    suspend fun saveProofs(proofs: List<Proof>, mintUrl: String): Result<Unit>
    suspend fun getProofs(mintUrl: String, unit: String): Result<List<Proof>>
    suspend fun selectProofs(amount: Long, mintUrl: String, unit: String): Result<List<Proof>>
    suspend fun deleteProofs(secrets: List<String>): Result<Unit>
}

// voucher-module/jsMain/repository/IndexedDBProofRepository.kt
class IndexedDBProofRepository : ProofRepository {
    private val dbName = "cashu_proofs"

    override suspend fun saveProofs(proofs: List<Proof>, mintUrl: String): Result<Unit> = runCatching {
        val db = openDatabase()
        val tx = db.transaction(arrayOf("proofs"), "readwrite")
        val store = tx.objectStore("proofs")

        proofs.forEach { proof ->
            val record = js("""({
                secret: proof.secret,
                amount: proof.amount,
                C: proof.C,
                id: proof.id,
                mintUrl: mintUrl,
                createdAt: Date.now()
            })""")
            store.add(record)
        }

        tx.oncomplete = { db.close() }
    }

    override suspend fun selectProofs(amount: Long, mintUrl: String, unit: String): Result<List<Proof>> = runCatching {
        val allProofs = getProofs(mintUrl, unit).getOrThrow()

        // Simple FIFO selection
        var remaining = amount
        val selected = mutableListOf<Proof>()

        for (proof in allProofs.sortedBy { it.amount }) {
            if (remaining <= 0) break
            selected.add(proof)
            remaining -= proof.amount
        }

        if (remaining > 0) {
            throw InsufficientBalanceException("Need $remaining more sats")
        }

        selected
    }
}

// voucher-module/commonMain/encoding/TokenEncoder.kt
object TokenEncoder {
    fun encodeV4(proofs: List<Proof>, mintUrl: String, unit: String, memo: String? = null): String {
        val token = TokenV4(
            mint = mintUrl,
            unit = unit,
            proofs = proofs.map { TokenProof(it.amount, it.secret, it.C, it.id) },
            memo = memo
        )

        val cbor = Cbor.encodeToByteArray(TokenV4.serializer(), token)
        return Bech32.encode("cashuA", cbor)
    }

    fun decodeV4(token: String): TokenV4 {
        val (hrp, data) = Bech32.decode(token)
        require(hrp == "cashuA") { "Invalid token prefix: $hrp" }

        return Cbor.decodeFromByteArray(TokenV4.serializer(), data)
    }
}

@Serializable
data class TokenV4(
    val mint: String,
    val unit: String,
    val proofs: List<TokenProof>,
    val memo: String? = null
)

@Serializable
data class TokenProof(
    val amount: Int,
    @SerialName("s") val secret: String,
    @SerialName("C") val C: String,
    @SerialName("id") val id: String
)
```

**Acceptance Criteria**:
- Proofs stored in IndexedDB
- Proof selection algorithm works (FIFO)
- Token encoding/decoding works (V4 CBOR + bech32)
- Encoded tokens match Cashu spec (NUT-00)

**Effort**: 5 days

---

#### 2.3. Voucher Use Cases

**Implement voucher issuance and redemption logic**:

```kotlin
// voucher-module/commonMain/usecases/IssueVoucherUseCase.kt
class IssueVoucherUseCase(
    private val voucherRepository: VoucherRepository,
    private val proofRepository: ProofRepository,
    private val mintApiClient: MintApiClient,
    private val cryptoAdapter: CryptoAdapter,
    private val identityRepository: IdentityRepository
) {
    suspend operator fun invoke(request: IssueVoucherRequest): Result<IssueVoucherResult> = runCatching {
        // 1. Select proofs
        val proofs = proofRepository.selectProofs(request.amount, request.mintUrl, request.unit).getOrThrow()

        // 2. Create P2PK secret if recipient specified
        val secret = if (request.lockToPubkey != null) {
            createP2PKSecret(request.lockToPubkey)
        } else {
            generateRandomSecret()
        }

        // 3. Swap proofs to create voucher tokens
        val voucherProofs = swapProofs(proofs, secret, request.mintUrl).getOrThrow()

        // 4. Create voucher payload
        val voucher = StoredVoucher(
            voucherId = UUID.randomUUID().toString(),
            issuerId = identityRepository.getActiveIdentity().id,
            unit = request.unit,
            faceValue = request.amount,
            expiresAt = request.expiresInDays?.let {
                Clock.System.now().plus(it.days).epochSeconds
            },
            memo = request.memo,
            issuerSignature = "", // Will be set after signing
            issuerPublicKey = identityRepository.getActiveIdentity().publicKey,
            issuedAt = Clock.System.now(),
            status = VoucherStatus.ISSUED
        )

        // 5. Sign voucher
        val signedVoucher = signVoucher(voucher)

        // 6. Store voucher
        voucherRepository.saveVoucher(signedVoucher)

        // 7. Encode token
        val token = TokenEncoder.encodeV4(voucherProofs, request.mintUrl, request.unit, request.memo)

        IssueVoucherResult(
            voucher = signedVoucher,
            token = token,
            backedUp = false,
            message = "Voucher issued successfully"
        )
    }

    private suspend fun createP2PKSecret(pubkey: String): String {
        // NUT-11 P2PK secret format
        // secret = ["P2PK", { "data": "<pubkey>", "nonce": "<random>", "tags": [["sigflag", "SIG_ALL"]] }]
        val nonce = cryptoAdapter.generateRandomBytes(32).toHex()
        return Json.encodeToString(listOf(
            "P2PK",
            mapOf(
                "data" to pubkey,
                "nonce" to nonce,
                "tags" to listOf(listOf("sigflag", "SIG_ALL"))
            )
        ))
    }

    private suspend fun signVoucher(voucher: StoredVoucher): StoredVoucher {
        // Sign message: voucherId || issuerId || unit || faceValue || expiresAt || memo
        val message = buildString {
            append(voucher.voucherId)
            append(voucher.issuerId)
            append(voucher.unit)
            append(voucher.faceValue)
            append(voucher.expiresAt ?: "")
            append(voucher.memo ?: "")
        }

        val identity = identityRepository.getActiveIdentity()
        val privateKey = identityRepository.getPrivateKey(identity.id).getOrThrow()
        val signature = cryptoAdapter.schnorrSign(privateKey, message.encodeToByteArray())

        return voucher.copy(issuerSignature = signature.toHex())
    }
}

data class IssueVoucherRequest(
    val amount: Long,
    val unit: String,
    val mintUrl: String,
    val expiresInDays: Int? = null,
    val memo: String? = null,
    val lockToPubkey: String? = null
)

data class IssueVoucherResult(
    val voucher: StoredVoucher,
    val token: String,
    val backedUp: Boolean,
    val message: String
)

// voucher-module/commonMain/usecases/RedeemVoucherUseCase.kt
class RedeemVoucherUseCase(
    private val voucherRepository: VoucherRepository,
    private val proofRepository: ProofRepository,
    private val mintApiClient: MintApiClient,
    private val cryptoAdapter: CryptoAdapter
) {
    suspend operator fun invoke(token: String): Result<RedeemVoucherResult> = runCatching {
        // 1. Decode token
        val tokenData = TokenEncoder.decodeV4(token)

        // 2. Check proof states
        val states = mintApiClient.checkProofStates(
            tokenData.mint,
            tokenData.proofs.map { it.secret }
        ).getOrThrow()

        val unspentProofs = states.states.filter { it.state == "UNSPENT" }
        if (unspentProofs.isEmpty()) {
            throw VoucherRedemptionException.alreadyRedeemed("unknown")
        }

        // 3. Import proofs to wallet
        val proofs = tokenData.proofs.map { Proof(it.amount, it.secret, it.C, it.id) }
        proofRepository.saveProofs(proofs, tokenData.mint).getOrThrow()

        // 4. Create redemption record
        val amountReceived = proofs.sumOf { it.amount.toLong() }

        RedeemVoucherResult(
            voucherId = "redeemed-${UUID.randomUUID()}",
            status = VoucherStatus.REDEEMED,
            message = "Redeemed $amountReceived ${tokenData.unit}",
            proofsReceived = proofs,
            amountReceived = amountReceived
        )
    }
}

data class RedeemVoucherResult(
    val voucherId: String,
    val status: VoucherStatus,
    val message: String,
    val proofsReceived: List<Proof>,
    val amountReceived: Long
)
```

**Acceptance Criteria**:
- Can issue voucher with selected proofs
- P2PK secret format matches NUT-11
- Voucher signature valid (Schnorr)
- Can redeem voucher token
- Proofs imported to wallet after redemption

**Effort**: 6 days

---

#### 2.4. Voucher UI Screens

**Build voucher management screens**:

```kotlin
// composeApp/commonMain/ui/voucher/VoucherListScreen.kt
@Composable
fun VoucherListScreen(
    viewModel: VoucherViewModel,
    onIssueClick: () -> Unit,
    onRedeemClick: () -> Unit,
    onVoucherClick: (StoredVoucher) -> Unit
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(title = { Text("Vouchers") })
        },
        floatingActionButton = {
            Column {
                FloatingActionButton(
                    onClick = onIssueClick,
                    modifier = Modifier.padding(bottom = 8.dp)
                ) {
                    Icon(Icons.Default.Add, "Issue Voucher")
                }
                FloatingActionButton(onClick = onRedeemClick) {
                    Icon(Icons.Default.Download, "Redeem Voucher")
                }
            }
        }
    ) { padding ->
        when (val state = uiState) {
            is VoucherUiState.Success -> {
                LazyColumn(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    // Group by status
                    val grouped = state.vouchers.groupBy { it.status }

                    grouped.forEach { (status, vouchers) ->
                        item {
                            Text(
                                text = status.name,
                                style = MaterialTheme.typography.titleMedium,
                                modifier = Modifier.padding(vertical = 8.dp)
                            )
                        }

                        items(vouchers) { voucher ->
                            VoucherCard(
                                voucher = voucher,
                                onClick = { onVoucherClick(voucher) }
                            )
                        }
                    }
                }
            }

            is VoucherUiState.Loading -> {
                Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator()
                }
            }

            is VoucherUiState.Error -> {
                ErrorView(state.message) { viewModel.loadVouchers() }
            }
        }
    }
}

@Composable
fun VoucherCard(voucher: StoredVoucher, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        elevation = CardDefaults.cardElevation(4.dp)
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = voucher.memo ?: "Voucher ${voucher.voucherId.take(8)}",
                    style = MaterialTheme.typography.titleMedium
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "${voucher.faceValue} ${voucher.unit}",
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Bold
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "Issued ${voucher.issuedAt.format()}",
                    style = MaterialTheme.typography.bodySmall
                )
                if (voucher.expiresAt != null) {
                    Text(
                        text = "Expires ${Instant.fromEpochSeconds(voucher.expiresAt).format()}",
                        style = MaterialTheme.typography.bodySmall,
                        color = if (voucher.isExpired()) Color.Red else Color.Gray
                    )
                }
            }

            StatusBadge(status = voucher.status)
        }
    }
}

@Composable
fun StatusBadge(status: VoucherStatus) {
    val (color, icon) = when (status) {
        VoucherStatus.ISSUED -> Color.Blue to Icons.Default.CheckCircle
        VoucherStatus.DELIVERED -> Color.Cyan to Icons.Default.Send
        VoucherStatus.REDEEMED -> Color.Green to Icons.Default.Check
        VoucherStatus.REVOKED -> Color.Red to Icons.Default.Cancel
        VoucherStatus.EXPIRED -> Color.Gray to Icons.Default.Schedule
    }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .background(color.copy(alpha = 0.1f), RoundedCornerShape(12.dp))
            .padding(horizontal = 8.dp, vertical = 4.dp)
    ) {
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(4.dp))
        Text(status.name, style = MaterialTheme.typography.bodySmall, color = color)
    }
}

// composeApp/commonMain/ui/voucher/IssueVoucherScreen.kt
@Composable
fun IssueVoucherScreen(
    viewModel: VoucherViewModel,
    onSuccess: (String) -> Unit, // Navigate to share screen with token
    onCancel: () -> Unit
) {
    var amount by remember { mutableStateOf("") }
    var memo by remember { mutableStateOf("") }
    var expiryDays by remember { mutableStateOf("7") }
    var isIssuing by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Issue Voucher") },
                navigationIcon = {
                    IconButton(onClick = onCancel) {
                        Icon(Icons.Default.ArrowBack, "Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            TextField(
                value = amount,
                onValueChange = { amount = it.filter { c -> c.isDigit() } },
                label = { Text("Amount (sats)") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth()
            )

            TextField(
                value = memo,
                onValueChange = { memo = it },
                label = { Text("Memo (optional)") },
                modifier = Modifier.fillMaxWidth()
            )

            TextField(
                value = expiryDays,
                onValueChange = { expiryDays = it.filter { c -> c.isDigit() } },
                label = { Text("Expires in (days)") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth()
            )

            Button(
                onClick = {
                    isIssuing = true
                    val request = IssueVoucherRequest(
                        amount = amount.toLongOrNull() ?: 0,
                        unit = "sat",
                        mintUrl = "https://mint.example.com", // TODO: User-selected mint
                        expiresInDays = expiryDays.toIntOrNull(),
                        memo = memo.ifBlank { null }
                    )

                    viewModel.issueVoucher(request) { result ->
                        result.onSuccess { token ->
                            isIssuing = false
                            onSuccess(token)
                        }.onFailure { error ->
                            isIssuing = false
                            // Show error toast
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = amount.isNotBlank() && !isIssuing
            ) {
                if (isIssuing) {
                    CircularProgressIndicator(Modifier.size(24.dp))
                } else {
                    Text("Issue Voucher")
                }
            }
        }
    }
}

// composeApp/commonMain/ui/voucher/ShareVoucherScreen.kt
@Composable
fun ShareVoucherScreen(
    token: String,
    onDone: () -> Unit
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Share Voucher") },
                navigationIcon = {
                    IconButton(onClick = onDone) {
                        Icon(Icons.Default.Close, "Close")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // QR Code
            QRCodeImage(data = token, modifier = Modifier.size(300.dp))

            Text("Scan QR code to redeem", style = MaterialTheme.typography.titleMedium)

            // Token display
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant
                )
            ) {
                SelectionContainer {
                    Text(
                        text = token,
                        modifier = Modifier.padding(16.dp),
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                OutlinedButton(
                    onClick = { copyToClipboard(token) },
                    modifier = Modifier.weight(1f)
                ) {
                    Icon(Icons.Default.ContentCopy, "Copy")
                    Spacer(Modifier.width(4.dp))
                    Text("Copy Token")
                }

                Button(
                    onClick = { /* Share via Nostr relay */ },
                    modifier = Modifier.weight(1f)
                ) {
                    Icon(Icons.Default.Send, "Send")
                    Spacer(Modifier.width(4.dp))
                    Text("Send to Nostr")
                }
            }

            Button(
                onClick = onDone,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Done")
            }
        }
    }
}

@Composable
expect fun QRCodeImage(data: String, modifier: Modifier = Modifier)
```

**QR Code Implementation (Web)**:

```kotlin
// composeApp/jsMain/ui/components/QRCodeImage.kt
@Composable
actual fun QRCodeImage(data: String, modifier: Modifier) {
    var qrCodeDataUrl by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(data) {
        // Use qrcode.js library
        val QRCode = js("require('qrcode')")
        QRCode.toDataURL(data) { error, url ->
            if (error == null) {
                qrCodeDataUrl = url as String
            }
        }
    }

    qrCodeDataUrl?.let { url ->
        Image(
            painter = rememberImagePainter(url),
            contentDescription = "QR Code",
            modifier = modifier
        )
    }
}
```

**Acceptance Criteria**:
- Voucher list displays issued vouchers
- Can issue voucher with amount, memo, expiry
- Share screen shows QR code and token
- Can copy token to clipboard
- Can redeem voucher by pasting token

**Effort**: 6 days

---

#### 2.5. Voucher Repository (IndexedDB)

**Implement voucher persistence**:

```kotlin
// voucher-module/commonMain/repository/VoucherRepository.kt
interface VoucherRepository {
    suspend fun saveVoucher(voucher: StoredVoucher): Result<Unit>
    suspend fun listVouchers(): Result<List<StoredVoucher>>
    suspend fun getVoucher(id: String): Result<StoredVoucher>
    suspend fun updateVoucherStatus(id: String, status: VoucherStatus): Result<Unit>
    suspend fun deleteVoucher(id: String): Result<Unit>
}

// voucher-module/jsMain/repository/IndexedDBVoucherRepository.kt
class IndexedDBVoucherRepository : VoucherRepository {
    override suspend fun saveVoucher(voucher: StoredVoucher): Result<Unit> = runCatching {
        val db = openDatabase()
        val tx = db.transaction(arrayOf("vouchers"), "readwrite")
        val store = tx.objectStore("vouchers")

        val json = Json.encodeToString(StoredVoucher.serializer(), voucher)
        store.put(json, voucher.voucherId)

        tx.oncomplete = { db.close() }
    }

    override suspend fun listVouchers(): Result<List<StoredVoucher>> = runCatching {
        val db = openDatabase()
        val tx = db.transaction(arrayOf("vouchers"), "readonly")
        val store = tx.objectStore("vouchers")
        val request = store.getAll()

        suspendCoroutine { cont ->
            request.onsuccess = {
                val results = request.result.unsafeCast<Array<String>>()
                val vouchers = results.map { Json.decodeFromString(StoredVoucher.serializer(), it) }
                db.close()
                cont.resume(vouchers.sortedByDescending { it.issuedAt })
            }
        }
    }
}
```

**Acceptance Criteria**:
- Vouchers persist in IndexedDB
- Can list, get, update, delete vouchers
- Vouchers survive page refresh

**Effort**: 2 days

---

#### 2.6. Integration Testing

**Write integration tests for voucher flows**:

```kotlin
// voucher-module/commonTest/kotlin/usecases/VoucherFlowTest.kt
class VoucherFlowTest {
    @Test
    fun `issue and redeem voucher flow`() = runTest {
        // Arrange
        val mockMintClient = mockk<MintApiClient>()
        val mockProofRepo = mockk<ProofRepository>()
        val mockVoucherRepo = mockk<VoucherRepository>()

        val issueUseCase = IssueVoucherUseCase(mockVoucherRepo, mockProofRepo, mockMintClient, ...)
        val redeemUseCase = RedeemVoucherUseCase(mockVoucherRepo, mockProofRepo, mockMintClient, ...)

        // Setup mocks
        coEvery { mockProofRepo.selectProofs(any(), any(), any()) } returns Result.success(sampleProofs)
        coEvery { mockMintClient.swapProofs(any(), any(), any()) } returns Result.success(swapResponse)
        coEvery { mockVoucherRepo.saveVoucher(any()) } returns Result.success(Unit)

        // Act: Issue voucher
        val issueResult = issueUseCase(IssueVoucherRequest(1000, "sat", "https://mint.example.com"))
        assertTrue(issueResult.isSuccess)

        val token = issueResult.getOrThrow().token

        // Setup redeem mocks
        coEvery { mockMintClient.checkProofStates(any(), any()) } returns Result.success(unspentStates)
        coEvery { mockProofRepo.saveProofs(any(), any()) } returns Result.success(Unit)

        // Act: Redeem voucher
        val redeemResult = redeemUseCase(token)
        assertTrue(redeemResult.isSuccess)
        assertEquals(1000, redeemResult.getOrThrow().amountReceived)
    }
}
```

**Acceptance Criteria**:
- Integration tests pass
- Full flow (issue → share → redeem) works end-to-end

**Effort**: 2 days

---

### Phase 2 Deliverables

- [x] Ktor HTTP client for Mint API
- [x] Proof management (selection, storage)
- [x] Token encoding/decoding (V4 CBOR)
- [x] Voucher use cases (issue, redeem)
- [ ] Voucher UI screens (list, issue, share, redeem)
- [x] Voucher repository (in-memory for Phase 2)
- [ ] Integration tests

**Total Effort**: 25 days (~4 weeks with buffer)

### Phase 2 Task Tracking

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 2.1 | Ktor HTTP Client for Mint API | M (4d) | ✅ DONE | ef864f9 | MintApiClient with getInfo, getKeySets, swapProofs, checkProofStates; HttpClientFactory with JSON config; All Cashu NUT models (NUT-00 to NUT-07) | 1.5 |
| 2.2 | Proof Management and Token Encoding | L (5d) | ✅ DONE | 21204d8 | ProofRepository interface with CRUD operations; IndexedDBProofRepository (JS) with "cashu_proofs" database; JvmProofRepository (in-memory); TokenEncoder with V4 CBOR + Bech32; FIFO coin selection algorithm; InsufficientBalanceException handling | 2.1 |
| 2.3 | Voucher Use Cases | XL (6d) | ✅ DONE | 3394fed | IssueVoucherUseCase with P2PK secret generation (NUT-11); RedeemVoucherUseCase with proof state checking; VoucherRepository interface; In-memory implementations for JS/JVM; Complete exception hierarchy; Schnorr signature verification | 1.3, 2.1, 2.2 |
| 2.4 | Voucher UI Screens | XL (6d) | 📋 TODO | - | List, issue, share (QR), redeem screens | 2.3 |
| 2.5 | Voucher Repository (IndexedDB) | M (2d) | 📋 TODO | - | Voucher persistence, status updates | 2.3 |
| 2.6 | Integration Testing | M (2d) | 📋 TODO | - | End-to-end voucher flow tests | 2.3, 2.4, 2.5 |

[↑ Back to top](#imani-wallet---kotlin-multiplatform-implementation-roadmap)

---

## Phase 3: Web Polish & Production

**Goal**: Production-ready web application with security hardening, performance optimization, and deployment.

**Duration**: 2 weeks

**Depends On**: Phase 2 complete

### Tasks

#### 3.1. Security Hardening

- [ ] Implement passphrase-based encryption for private keys (Argon2 or PBKDF2)
- [ ] Add session timeout and auto-lock
- [ ] Implement CSP headers in deployment
- [ ] Add input validation for all user inputs
- [ ] Security audit (manual + automated tools)

**Effort**: 3 days

---

#### 3.2. Performance Optimization

- [ ] Code splitting for lazy loading
- [ ] Optimize bundle size (<500KB target)
- [ ] Implement service worker for offline support (PWA)
- [ ] Add loading skeletons for better perceived performance
- [ ] Lighthouse audit (target score ≥90)

**Effort**: 2 days

---

#### 3.3. Error Handling & User Feedback

- [ ] Implement toast notifications for success/error
- [ ] Add retry logic for network failures
- [ ] Implement error boundaries
- [ ] Add "Contact Support" with pre-filled error details

**Effort**: 2 days

---

#### 3.4. Production Deployment

- [ ] Set up CI/CD for web deployment (Vercel/Netlify)
- [ ] Configure custom domain and SSL
- [ ] Set up error tracking (Sentry or similar)
- [ ] Configure analytics (privacy-respecting)
- [ ] Write deployment documentation

**Effort**: 2 days

---

#### 3.5. End-to-End Testing

- [ ] Write Playwright E2E tests for critical flows:
  - Create identity → issue voucher → share → redeem
  - Import identity from mnemonic
  - Error scenarios (expired voucher, insufficient balance)
- [ ] Cross-browser testing (Chrome, Firefox, Safari)
- [ ] Mobile responsive testing

**Effort**: 3 days

---

### Phase 3 Deliverables

- [ ] Security hardened (encryption, CSP, validation)
- [ ] Performance optimized (bundle size, PWA)
- [ ] Production deployment (CI/CD, monitoring)
- [ ] E2E tests passing

**Total Effort**: 12 days (2 weeks with buffer)

### Phase 3 Task Tracking

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 3.1 | Security Hardening | M (3d) | 📋 TODO | - | Passphrase encryption (Argon2/PBKDF2), CSP, validation | 2.6 |
| 3.2 | Performance Optimization | M (2d) | 📋 TODO | - | Code splitting, bundle optimization, PWA, Lighthouse ≥90 | 2.6 |
| 3.3 | Error Handling & User Feedback | M (2d) | 📋 TODO | - | Toasts, retry logic, error boundaries | 2.6 |
| 3.4 | Production Deployment | M (2d) | 📋 TODO | - | CI/CD (Vercel/Netlify), SSL, monitoring (Sentry) | 3.1, 3.2 |
| 3.5 | End-to-End Testing | M (3d) | 📋 TODO | - | Playwright E2E tests, cross-browser, mobile responsive | 3.3, 3.4 |

[↑ Back to top](#imani-wallet---kotlin-multiplatform-implementation-roadmap)

---

## Phase 4: Android Port

**Goal**: Port web application to Android with native features (Keystore, SQLDelight).

**Duration**: 3 weeks

**Depends On**: Phase 3 complete

### Tasks

#### 4.1. Android Module Setup

- [ ] Create `androidApp` module
- [ ] Configure Android Gradle plugin
- [ ] Set up Jetpack Compose
- [ ] Configure Android-specific dependencies (SQLDelight Android driver, Keystore)

**Effort**: 2 days

---

#### 4.2. Platform-Specific Implementations

- [ ] Implement `CryptoAdapter` for Android (Android Keystore)
- [ ] Implement `StorageAdapter` for Android (SQLDelight with Android driver)
- [ ] Implement biometric authentication (optional)

**Effort**: 4 days

---

#### 4.3. Android UI Adaptations

- [ ] Adapt UI for Material 3 on Android
- [ ] Add Android-specific navigation (back button handling)
- [ ] Implement Android sharing (share intent)
- [ ] Add QR scanner using CameraX

**Effort**: 5 days

---

#### 4.4. Testing & Publishing

- [ ] Android unit tests
- [ ] Android instrumentation tests
- [ ] Test on physical devices
- [ ] Generate signed APK/AAB
- [ ] Publish to Google Play Store (internal testing)

**Effort**: 4 days

---

### Phase 4 Deliverables

- [ ] Android app with native Keystore
- [ ] SQLDelight database
- [ ] Android-specific UI (Material 3)
- [ ] Published to Play Store (internal)

**Total Effort**: 15 days (3 weeks)

[↑ Back to top](#imani-wallet---kotlin-multiplatform-implementation-roadmap)

---

## Phase 5: iOS Port

**Goal**: Port to iOS with native features (Keychain, SQLDelight).

**Duration**: 4 weeks

**Depends On**: Phase 4 complete

### Tasks

#### 5.1. iOS Module Setup

- [ ] Create `iosApp` Xcode project
- [ ] Integrate Kotlin Multiplatform framework
- [ ] Configure SwiftUI entry point
- [ ] Set up CocoaPods for dependencies

**Effort**: 3 days

---

#### 5.2. Platform-Specific Implementations

- [ ] Implement `CryptoAdapter` for iOS (iOS Keychain)
- [ ] Implement `StorageAdapter` for iOS (SQLDelight with Native driver)
- [ ] Implement biometric authentication (Face ID/Touch ID)

**Effort**: 5 days

---

#### 5.3. iOS UI Adaptations

- [ ] Adapt UI for iOS design patterns
- [ ] Add iOS-specific navigation (swipe back)
- [ ] Implement iOS sharing (share sheet)
- [ ] Add QR scanner using AVFoundation

**Effort**: 6 days

---

#### 5.4. Testing & Publishing

- [ ] iOS unit tests
- [ ] iOS UI tests (XCUITest)
- [ ] Test on physical devices and simulator
- [ ] Generate archive for App Store
- [ ] Publish to App Store (TestFlight)

**Effort**: 4 days

---

### Phase 5 Deliverables

- [ ] iOS app with native Keychain
- [ ] SQLDelight database
- [ ] iOS-specific UI (SwiftUI integration)
- [ ] Published to App Store (TestFlight)

**Total Effort**: 18 days (4 weeks)

[↑ Back to top](#imani-wallet---kotlin-multiplatform-implementation-roadmap)

---

## Testing Strategy

### Unit Tests (60%)

**Scope**: All domain logic, use cases, repositories

**Tools**: Kotlin Test, MockK

**Example**:
```kotlin
class IssueVoucherUseCaseTest {
    @Test
    fun `invoke creates voucher with correct amount`() = runTest {
        val mockRepo = mockk<VoucherRepository>()
        coEvery { mockRepo.saveVoucher(any()) } returns Result.success(Unit)

        val useCase = IssueVoucherUseCase(mockRepo, ...)
        val result = useCase(IssueVoucherRequest(1000, "sat", "https://mint.example.com"))

        assertTrue(result.isSuccess)
        verify { mockRepo.saveVoucher(match { it.faceValue == 1000L }) }
    }
}
```

---

### Integration Tests (30%)

**Scope**: API integration, storage, crypto

**Tools**: Ktor MockEngine, In-memory storage

**Example**:
```kotlin
class MintApiIntegrationTest {
    @Test
    fun `getInfo returns mint information`() = runTest {
        val mockEngine = MockEngine { request ->
            respond(
                content = """{"name": "Test Mint", "version": "1.0.0"}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json")
            )
        }

        val client = MintApiClient(HttpClient(mockEngine))
        val result = client.getInfo("https://mint.example.com")

        assertTrue(result.isSuccess)
        assertEquals("Test Mint", result.getOrThrow().name)
    }
}
```

---

### E2E Tests (10%)

**Scope**: Critical user journeys

**Tools**: Playwright (web), Espresso (Android), XCUITest (iOS)

**Example (Playwright)**:
```kotlin
test("issue and share voucher flow") {
    page.goto("http://localhost:8080")

    // Create identity
    page.click("text=Create Identity")
    page.fill("input[name=label]", "Test Identity")
    page.click("button:has-text('Create')")
    page.click("button:has-text('I've saved it')")

    // Issue voucher
    page.click("text=Issue Voucher")
    page.fill("input[name=amount]", "1000")
    page.fill("input[name=memo]", "Test voucher")
    page.click("button:has-text('Issue')")

    // Verify QR code displayed
    expect(page.locator("canvas")).toBeVisible()
}
```

[↑ Back to top](#imani-wallet---kotlin-multiplatform-implementation-roadmap)

---

## Success Metrics

### Functional Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Voucher issuance success rate | ≥95% | IndexedDB query logs |
| Voucher redemption success rate | ≥90% | User-reported failures |
| Identity creation success rate | ≥98% | Error logs |

### Performance Metrics

| Metric | Target (Web) | Target (Mobile) | Measurement |
|--------|--------------|-----------------|-------------|
| Initial load time | <3s | <2s | Lighthouse / App startup |
| Voucher issuance time | <2s | <1.5s | Performance.now() |
| Bundle size (Web) | <500KB gzipped | N/A | Webpack analyzer |
| APK size (Android) | N/A | <10MB | Build output |

### Quality Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Unit test coverage | ≥80% | Kover |
| E2E test coverage | All critical paths | Test count |
| Lighthouse score (Web) | ≥90 | Lighthouse CI |

[↑ Back to top](#imani-wallet---kotlin-multiplatform-implementation-roadmap)

---

## Appendix

### Recommended Libraries

**All Platforms (Common)**:
- kotlinx.coroutines: 1.7.3
- kotlinx.serialization: 1.6.2
- kotlinx-datetime: 0.5.0
- ktor-client: 2.3.7
- koin: 3.5.3

**Web-Specific**:
- @noble/secp256k1: 2.0.0
- @noble/hashes: 1.3.3
- @scure/bip39: 1.2.1
- qrcode: 1.5.3

**Android-Specific**:
- androidx.compose: 1.6.0
- androidx.navigation: 2.7.6
- androidx.security:security-crypto: 1.1.0-alpha06
- sqldelight-android-driver: 2.0.1

**iOS-Specific**:
- sqldelight-native-driver: 2.0.1

[↑ Back to top](#imani-wallet---kotlin-multiplatform-implementation-roadmap)

---

### Development Environment Setup

**Prerequisites**:
- JDK 21
- IntelliJ IDEA 2024.1+
- Node.js 18+ (for web)
- Android Studio (for Android)
- Xcode 15+ (for iOS, macOS only)

**Quick Start**:
```bash
# Clone repository
git clone https://github.com/your-org/imani-wallet
cd imani-wallet

# Build all modules
./gradlew build

# Run web app
./gradlew :imani-web:jsBrowserDevelopmentRun

# Run Android app (with connected device/emulator)
./gradlew :imani-app:installDebug

# Run iOS app (macOS only)
./gradlew :imani-identity:linkReleaseFrameworkIosArm64
open iosApp/iosApp.xcodeproj
```

[↑ Back to top](#imani-wallet---kotlin-multiplatform-implementation-roadmap)

---

## Change Log

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2025-11-17 | Claude Code | Initial Kotlin voucher client roadmap |
| 1.1.0 | 2025-11-17 | Claude Code | Added task tracking tables for Phases 0-3 with dependencies, added back to top links |
| 1.2.0 | 2025-11-17 | Claude Code | Rebranded as "Imani Wallet" with mission statement, brand identity, updated package names to xyz.imani.*, updated all module names |
| 1.2.1 | 2025-11-17 | Claude Code | Changed package naming from xyz.imani.* to cash.imani.* for better domain alignment |

[↑ Back to top](#imani-wallet---kotlin-multiplatform-implementation-roadmap)
