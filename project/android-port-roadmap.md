# Imani Wallet - Android Port Roadmap

> **Product Name**: Imani Wallet Android
> **Platform**: Android (Kotlin Multiplatform)
> **Document Type**: How-To Guide (Diátaxis)
> **Version**: 1.0.0
> **Last Updated**: 2025-11-19
> **Related Documents**:
> - [Main Roadmap](kotlin-voucher-client-roadmap.md)
> - [Kotlin Client Detailed Specification](explanation/kotlin-client-spec-detailed.md)
> - [Java to Kotlin Migration Guide](JAVA_TO_KOTLIN_MIGRATION.md)

## Table of Contents

1. [Overview](#overview)
2. [Phase 4.1: Android Module Setup](#phase-41-android-module-setup)
3. [Phase 4.2: Platform-Specific Implementations](#phase-42-platform-specific-implementations)
4. [Phase 4.3: Android UI Adaptations](#phase-43-android-ui-adaptations)
5. [Phase 4.4: Testing & Publishing](#phase-44-testing--publishing)
6. [Android-Specific Guidelines](#android-specific-guidelines)
7. [Testing Strategy](#testing-strategy)
8. [Success Metrics](#success-metrics)

---

## Overview

**Goal**: Port Imani Wallet to Android with native platform features, achieving feature parity with the web version while **heavily reusing cashu-client Java code**.

**Duration**: 2 weeks (~10 days) - Reduced from 3 weeks due to ≥90% code reuse

**Prerequisites**:
- Phase 3 (Web Polish & Production) completed
- Working web application with all features
- Core modules (`imani-identity`, `imani-voucher`) tested and stable

**Target Devices**:
- Android 8.0 (API 26) and above
- Phone and tablet form factors
- Portrait and landscape orientations

**Key Android Features**:
- Android Keystore for secure key storage
- SQLDelight with Android driver for persistence
- Biometric authentication (fingerprint, face unlock)
- Camera for QR scanning
- Share functionality (send vouchers via other apps)
- Material 3 design system

---

## Code Reuse Strategy: Leverage cashu-client Java Code

**Critical Principle**: Android runs on JVM, so we **directly reuse cashu-client Java code** rather than rewriting in Kotlin.

### What We Reuse from cashu-client (≥90% code reuse)

| Component | cashu-client Module | Reuse Strategy | Notes |
|-----------|---------------------|----------------|-------|
| **Crypto Operations** | `identity-domain` | ✅ Direct Java dependency | secp256k1, Schnorr signatures, key generation |
| **Nostr Integration** | `nostr-repository` | ✅ Direct Java dependency | NostrGatewayService, event publishing/querying |
| **Proof Management** | `wallet-core-base` | ✅ Direct Java dependency | ProofRecord, proof selection, token encoding |
| **Mint API Client** | `cashu-api-client` | ✅ Direct Java dependency | All NUT endpoints (info, keys, swap, melt, etc.) |
| **Use Cases** | `wallet-core-base` | ✅ Direct Java dependency | IssueVoucherUseCase, RedeemVoucherUseCase |
| **Domain Models** | `wallet-core-base`, `identity-domain` | ✅ Direct Java dependency | Identity, WalletState, Proof, etc. |

### What We Add for Android (≤10% new code)

| Component | Purpose | Implementation | Effort |
|-----------|---------|----------------|--------|
| **Storage Adapters** | Persist to Android SQLite | Wrap cashu-client repositories with SQLDelight/Room | 2 days |
| **Keystore Wrapper** | Encrypt private keys at rest | Use Android Keystore to encrypt `PrivateKey.bytes` | 1 day |
| **Compose UI** | Android-native UI | Reuse `imani-app` Compose code (already multiplatform) | 3 days |
| **Android Features** | Camera, biometric, sharing | Platform-specific Android APIs | 2 days |

### Architecture: Thin Android Layer Over Java Core

```
┌─────────────────────────────────────────────┐
│         Android UI (Compose)                 │  ← 3 days (reuse imani-app)
├─────────────────────────────────────────────┤
│  Android Platform Features                   │  ← 2 days (camera, biometric)
│  - QR Scanner (CameraX)                      │
│  - Biometric Auth                            │
│  - Share Intent                              │
├─────────────────────────────────────────────┤
│  Storage Adapters (SQLDelight/Room)         │  ← 2 days (thin wrapper)
│  - IdentityRepository → Android DB          │
│  - VoucherRepository → Android DB           │
├─────────────────────────────────────────────┤
│  Keystore Wrapper                           │  ← 1 day (encrypt PrivateKey)
│  - Encrypt/decrypt private keys             │
├═════════════════════════════════════════════┤
│                                             │
│      cashu-client Java Code (REUSED)       │  ← 0 days (already exists)
│                                             │
│  - Identity Domain (crypto, keys)          │
│  - Nostr Repository (NostrGatewayService)  │
│  - Wallet Core (use cases, proof mgmt)     │
│  - Cashu API Client (mint communication)   │
│  - All domain models and business logic    │
│                                             │
└─────────────────────────────────────────────┘
```

### Updated Effort Estimate

| Phase | Original Estimate | Revised Estimate | Savings |
|-------|-------------------|------------------|---------|
| 4.1: Module Setup | 2 days | 1 day | -1 day (simpler Gradle config) |
| 4.2: Platform Implementations | 4 days | 3 days | -1 day (no crypto rewrite) |
| 4.3: Android UI | 5 days | 3 days | -2 days (reuse imani-app) |
| 4.4: Testing | 4 days | 3 days | -1 day (fewer new components) |
| **Total** | **15 days** | **10 days** | **-5 days** |

**New Duration**: 2 weeks instead of 3 weeks

### Dependency Configuration

```kotlin
// imani-android/build.gradle.kts
dependencies {
    // Reuse cashu-client Java modules directly
    implementation(project(":cashu-client:identity-domain"))
    implementation(project(":cashu-client:wallet-core-base"))
    implementation(project(":cashu-client:nostr-repository"))
    implementation(project(":cashu-client:cashu-api-client"))

    // Only add Android-specific wrappers
    implementation(project(":imani-identity"))      // Thin KMP wrapper
    implementation(project(":imani-voucher"))       // Thin KMP wrapper
    implementation(project(":imani-app"))           // Compose UI (shared)

    // Android platform libraries
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.security.crypto)   // For Keystore
    implementation(libs.sqldelight.android.driver)  // For storage
}
```

---

## Phase 4.1: Android Module Setup

**Goal**: Set up Android application module with proper build configuration and dependencies to **reuse cashu-client Java modules**.

**Duration**: 1 day (reduced from 2 days - simpler Gradle config)

### Tasks

#### 4.1.1. Android Application Module Creation

**Create `imani-android` module with proper Gradle configuration**:

```kotlin
// settings.gradle.kts
include(":imani-android")

// imani-android/build.gradle.kts
plugins {
    kotlin("multiplatform")
    id("com.android.application")
    id("org.jetbrains.compose")
}

kotlin {
    androidTarget()

    sourceSets {
        val androidMain by getting {
            dependencies {
                implementation(project(":imani-identity"))
                implementation(project(":imani-voucher"))
                implementation(project(":imani-app"))

                // Android-specific
                implementation(libs.androidx.core.ktx)
                implementation(libs.androidx.lifecycle.runtime.ktx)
                implementation(libs.androidx.activity.compose)
                implementation(libs.androidx.biometric)
                implementation(libs.androidx.security.crypto)

                // Compose
                implementation(libs.androidx.compose.ui)
                implementation(libs.androidx.compose.material3)
                implementation(libs.androidx.compose.ui.tooling.preview)

                // Camera
                implementation(libs.androidx.camera.camera2)
                implementation(libs.androidx.camera.lifecycle)
                implementation(libs.androidx.camera.view)

                // QR Code
                implementation(libs.zxing.core)

                // SQLDelight
                implementation(libs.sqldelight.android.driver)

                // Ktor
                implementation(libs.ktor.client.okhttp)

                // Koin
                implementation(libs.koin.android)
                implementation(libs.koin.androidx.compose)
            }
        }

        val androidUnitTest by getting {
            dependencies {
                implementation(kotlin("test"))
                implementation(libs.mockk.android)
                implementation(libs.androidx.test.core)
                implementation(libs.robolectric)
            }
        }

        val androidInstrumentedTest by getting {
            dependencies {
                implementation(libs.androidx.test.runner)
                implementation(libs.androidx.test.espresso.core)
                implementation(libs.androidx.compose.ui.test.junit4)
            }
        }
    }
}

android {
    namespace = "cash.imani.android"
    compileSdk = 34

    defaultConfig {
        applicationId = "cash.imani.wallet"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        vectorDrawables {
            useSupportLibrary = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            isDebuggable = true
            applicationIdSuffix = ".debug"
        }
    }

    signingConfigs {
        create("release") {
            // TODO: Configure signing for release builds
            // Use environment variables or gradle.properties
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.8"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}
```

**Acceptance Criteria**:
- Android module builds successfully
- All dependencies resolve
- Can run empty activity on emulator
- Proper namespace and package structure

**Effort**: 1 day

**Task Tracking**:

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 4.1.1 | Android Application Module Creation | M (1d) | 📋 TODO | - | Create imani-android module, configure build.gradle.kts, set up dependencies | Phase 3 complete |

---

#### 4.1.2. Android Manifest and Application Class

**Create AndroidManifest.xml and Application class**:

```xml
<!-- imani-android/src/androidMain/AndroidManifest.xml -->
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-feature
        android:name="android.hardware.camera"
        android:required="false" />

    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.USE_BIOMETRIC" />

    <application
        android:name=".ImaniApplication"
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/Theme.ImaniWallet"
        android:usesCleartextTraffic="false"
        android:networkSecurityConfig="@xml/network_security_config">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:theme="@style/Theme.ImaniWallet"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>

            <!-- Handle cashu token URLs -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="cashu" />
            </intent-filter>
        </activity>

        <!-- File provider for sharing -->
        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths" />
        </provider>

    </application>

</manifest>
```

```kotlin
// imani-android/src/androidMain/kotlin/cash/imani/android/ImaniApplication.kt
package cash.imani.android

import android.app.Application
import cash.imani.android.di.androidModule
import cash.imani.app.di.appModule
import org.koin.android.ext.koin.androidContext
import org.koin.android.ext.koin.androidLogger
import org.koin.core.context.startKoin
import org.koin.core.logger.Level

class ImaniApplication : Application() {

    override fun onCreate() {
        super.onCreate()

        initKoin()
    }

    private fun initKoin() {
        startKoin {
            androidLogger(Level.ERROR)
            androidContext(this@ImaniApplication)
            modules(
                appModule,
                androidModule
            )
        }
    }
}
```

**Acceptance Criteria**:
- Manifest declares all required permissions
- Application class initializes Koin
- Deep linking for cashu:// URLs configured
- Network security config prevents cleartext traffic

**Effort**: 0.5 days

**Task Tracking**:

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 4.1.2 | Android Manifest and Application Class | S (0.5d) | 📋 TODO | - | Create AndroidManifest.xml, ImaniApplication.kt, configure permissions and deep linking | 4.1.1 |

---

#### 4.1.3. Version Catalog Updates

**Add Android-specific dependencies to `gradle/libs.versions.toml`**:

```toml
[versions]
# Existing versions...
androidx-core = "1.12.0"
androidx-lifecycle = "2.7.0"
androidx-activity-compose = "1.8.2"
androidx-biometric = "1.2.0-alpha05"
androidx-security = "1.1.0-alpha06"
androidx-camera = "1.3.1"
zxing = "3.5.3"
mockk = "1.13.9"
robolectric = "4.11.1"
espresso = "3.5.1"

[libraries]
# Android Core
androidx-core-ktx = { module = "androidx.core:core-ktx", version.ref = "androidx-core" }
androidx-lifecycle-runtime-ktx = { module = "androidx.lifecycle:lifecycle-runtime-ktx", version.ref = "androidx-lifecycle" }
androidx-activity-compose = { module = "androidx.activity:activity-compose", version.ref = "androidx-activity-compose" }

# Security
androidx-biometric = { module = "androidx.biometric:biometric", version.ref = "androidx-biometric" }
androidx-security-crypto = { module = "androidx.security:security-crypto", version.ref = "androidx-security" }

# Camera
androidx-camera-camera2 = { module = "androidx.camera:camera-camera2", version.ref = "androidx-camera" }
androidx-camera-lifecycle = { module = "androidx.camera:camera-lifecycle", version.ref = "androidx-camera" }
androidx-camera-view = { module = "androidx.camera:camera-view", version.ref = "androidx-camera" }

# QR Code
zxing-core = { module = "com.google.zxing:core", version.ref = "zxing" }

# SQLDelight
sqldelight-android-driver = { module = "app.cash.sqldelight:android-driver", version.ref = "sqldelight" }

# Ktor
ktor-client-okhttp = { module = "io.ktor:ktor-client-okhttp", version.ref = "ktor" }

# Testing
mockk-android = { module = "io.mockk:mockk-android", version.ref = "mockk" }
androidx-test-core = { module = "androidx.test:core", version = "1.5.0" }
androidx-test-runner = { module = "androidx.test:runner", version = "1.5.2" }
androidx-test-espresso-core = { module = "androidx.test.espresso:espresso-core", version.ref = "espresso" }
androidx-compose-ui-test-junit4 = { module = "androidx.compose.ui:ui-test-junit4", version.ref = "compose" }
robolectric = { module = "org.robolectric:robolectric", version.ref = "robolectric" }
```

**Acceptance Criteria**:
- All Android dependencies in version catalog
- No dependency conflicts
- Build succeeds with new dependencies

**Effort**: 0.5 days

**Task Tracking**:

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 4.1.3 | Version Catalog Updates | S (0.5d) | 📋 TODO | - | Add Android dependencies to gradle/libs.versions.toml | 4.1.1 |

---

### Phase 4.1 Deliverables

- [x] Android module with proper build configuration
- [x] AndroidManifest.xml with permissions and deep linking
- [x] Application class with Koin initialization
- [x] Version catalog with Android dependencies

**Total Effort**: 2 days

### Phase 4.1 Task Tracking Summary

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 4.1.1 | Android Application Module Creation | M (1d) | ✅ DONE | afaa7b2 | Created complete Android module with KMP layout, build config, dependencies | Phase 3 complete |
| 4.1.2 | Android Manifest and Application Class | S (0.5d) | ✅ DONE | afaa7b2 | AndroidManifest.xml (permissions), ImaniApplication.kt (Koin), MainActivity.kt (stub) | 4.1.1 |
| 4.1.3 | Version Catalog Updates | S (0.5d) | ✅ DONE | afaa7b2 | Added Android Gradle Plugin, AndroidX, Camera, Biometric, SQLDelight, Koin dependencies | 4.1.1 |

[↑ Back to top](#imani-wallet---android-port-roadmap)

---

## Phase 4.2: Platform-Specific Implementations

**Goal**: Add thin Android wrappers for storage and encryption. **NO crypto reimplementation** - all delegated to cashu-client.

**Duration**: 3 days (reduced from 4 days - wrapping, not rewriting)

### Tasks

#### 4.2.1. Android Keystore Wrapper (NOT Crypto Reimplementation)

**IMPORTANT**: We **DO NOT** reimplement crypto. We **wrap** cashu-client's Java crypto code and add Android Keystore encryption for private keys at rest.

**Strategy**:
1. ✅ **Reuse** cashu-client's `identity-domain` module for all crypto operations
2. ✅ Add thin Android Keystore wrapper to encrypt `PrivateKey.bytes` when storing
3. ✅ Delegate all crypto operations (signing, verification) to existing Java code

```kotlin
// imani-android/src/main/kotlin/cash/imani/android/security/KeystoreManager.kt
package cash.imani.android.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Manages Android Keystore for encrypting private keys at rest.
 *
 * NOTE: This does NOT handle cryptographic operations (signing, verification).
 * Those are delegated to cashu-client's identity-domain module.
 */
class KeystoreManager {

    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    /**
     * Encrypts PrivateKey.bytes using Android Keystore.
     *
     * @param privateKeyBytes The private key bytes from cashu-client's PrivateKey class
     * @param alias The keystore alias for this key
     * @return Encrypted private key with IV prepended
     */
    fun encryptPrivateKey(privateKeyBytes: ByteArray, alias: String): ByteArray {
        val secretKey = getOrCreateSecretKey(alias)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey)

        val iv = cipher.iv
        val encrypted = cipher.doFinal(privateKeyBytes)

        // Prepend IV to encrypted data (first 12 bytes)
        return iv + encrypted
    }

    /**
     * Decrypts PrivateKey.bytes using Android Keystore.
     *
     * @param encryptedData Encrypted private key with IV prepended
     * @param alias The keystore alias for this key
     * @return Decrypted private key bytes (to reconstruct cashu-client's PrivateKey)
     */
    fun decryptPrivateKey(encryptedData: ByteArray, alias: String): ByteArray {
        val secretKey = getOrCreateSecretKey(alias)

        // Extract IV (first 12 bytes for GCM)
        val iv = encryptedData.copyOfRange(0, 12)
        val encrypted = encryptedData.copyOfRange(12, encryptedData.size)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(128, iv))

        return cipher.doFinal(encrypted)
    }

    private fun getOrCreateSecretKey(alias: String): SecretKey {
        keyStore.getKey(alias, null)?.let { return it as SecretKey }

        val keyGenerator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            "AndroidKeyStore"
        )

        val spec = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(false)  // Can be true for biometric unlock
            .build()

        keyGenerator.init(spec)
        return keyGenerator.generateKey()
    }

}
```

**Usage with cashu-client's Identity class**:

```kotlin
// imani-android/src/main/kotlin/cash/imani/android/repository/AndroidIdentityManager.kt
package cash.imani.android.repository

import cash.z_eus.cashu.identity.domain.Identity
import cash.z_eus.cashu.identity.domain.PrivateKey
import cash.z_eus.cashu.identity.domain.PublicKey
import cash.imani.android.security.KeystoreManager

/**
 * Android wrapper for cashu-client's Identity class.
 * Adds Android Keystore encryption for private key storage.
 */
class AndroidIdentityManager(
    private val keystoreManager: KeystoreManager,
    private val database: IdentityDatabase  // SQLDelight or Room
) {

    /**
     * Creates new identity using cashu-client's Identity class.
     * Private key encrypted with Android Keystore before storage.
     */
    fun createIdentity(label: String): Identity {
        // Use cashu-client's Identity factory method (all crypto is in Java)
        val identity = Identity.generateNew(label)

        // Encrypt private key bytes for Android storage
        val encryptedPrivKey = keystoreManager.encryptPrivateKey(
            identity.privateKey.bytes,
            "identity_${identity.id}"
        )

        // Store encrypted private key in Android database
        database.identityQueries.insert(
            id = identity.id,
            label = identity.label,
            publicKeyHex = identity.publicKey.toHex(),
            encryptedPrivateKey = encryptedPrivKey,
            createdAt = identity.createdAt,
            lastUsedAt = identity.lastUsedAt
        )

        return identity
    }

    /**
     * Loads identity from Android database.
     * Decrypts private key using Android Keystore.
     */
    fun loadIdentity(id: String): Identity {
        val record = database.identityQueries.selectById(id).executeAsOne()

        // Decrypt private key from Keystore
        val privateKeyBytes = keystoreManager.decryptPrivateKey(
            record.encryptedPrivateKey,
            "identity_$id"
        )

        // Reconstruct cashu-client's Identity object
        return Identity(
            id = record.id,
            label = record.label,
            privateKey = PrivateKey(privateKeyBytes),  // cashu-client class
            publicKey = PublicKey.fromHex(record.publicKeyHex),  // cashu-client class
            createdAt = record.createdAt,
            lastUsedAt = record.lastUsedAt
        )
    }

    /**
     * Signs Nostr event using cashu-client's Identity.sign() method.
     * NO crypto reimplementation - delegates to Java.
     */
    fun signNostrEvent(identityId: String, event: nostr.event.BaseEvent): nostr.event.Event {
        val identity = loadIdentity(identityId)

        // Use cashu-client's sign method (Schnorr signature in Java)
        return identity.sign(event)
    }
```

**Dependencies**:
```kotlin
// imani-android/build.gradle.kts
dependencies {
    // ✅ REUSE cashu-client Java modules (NO crypto reimplementation)
    implementation(project(":cashu-client:identity-domain"))

    // Only add Android-specific encryption for storage
    implementation(libs.androidx.security.crypto)
}
```

**Acceptance Criteria**:
- ✅ Reuses cashu-client's Identity class for all crypto operations
- ✅ Private keys encrypted in Android Keystore (AES-GCM)
- ✅ Can create, load, and sign with identities
- ✅ Keys survive app restart
- ✅ Works on Android 8.0+ (API 26+)
- ❌ NO crypto reimplementation (all delegated to cashu-client)

**Effort**: 1 day (reduced from 2 days - no crypto to write!)

**Task Tracking**:

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 4.2.1 | Android Keystore Wrapper | S (1d) | 📋 TODO | - | Wrap cashu-client's Identity with Keystore encryption (NO crypto reimplementation) | 4.1.1 |

---

#### 4.2.2. SQLDelight Android Database

**Implement SQLDelight schema and Android driver**:

```sql
-- imani-identity/src/commonMain/sqldelight/cash/imani/identity/Identity.sq

CREATE TABLE IdentityEntity (
    id TEXT NOT NULL PRIMARY KEY,
    label TEXT NOT NULL,
    publicKey TEXT NOT NULL,
    encryptedPrivateKey BLOB NOT NULL,
    createdAt INTEGER NOT NULL,
    lastUsedAt INTEGER NOT NULL
);

-- Queries
selectAll:
SELECT * FROM IdentityEntity ORDER BY lastUsedAt DESC;

selectById:
SELECT * FROM IdentityEntity WHERE id = ?;

insert:
INSERT OR REPLACE INTO IdentityEntity(id, label, publicKey, encryptedPrivateKey, createdAt, lastUsedAt)
VALUES (?, ?, ?, ?, ?, ?);

deleteById:
DELETE FROM IdentityEntity WHERE id = ?;

updateLastUsed:
UPDATE IdentityEntity SET lastUsedAt = ? WHERE id = ?;
```

```kotlin
// imani-identity/androidMain/kotlin/cash/imani/identity/repository/AndroidIdentityRepository.kt
package cash.imani.identity.repository

import android.content.Context
import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import cash.imani.identity.IdentityDatabase
import cash.imani.identity.crypto.AndroidCryptoAdapter
import cash.imani.identity.domain.Identity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.datetime.Instant

class AndroidIdentityRepository(
    context: Context,
    private val cryptoAdapter: AndroidCryptoAdapter
) : IdentityRepository {

    private val driver: SqlDriver = AndroidSqliteDriver(
        IdentityDatabase.Schema,
        context,
        "identity.db"
    )

    private val database = IdentityDatabase(driver)
    private val queries = database.identityQueries

    override suspend fun createIdentity(label: String): Result<Identity> = runCatching {
        withContext(Dispatchers.IO) {
            val keypair = cryptoAdapter.generateKeypair()
            val now = kotlinx.datetime.Clock.System.now()

            val identity = Identity(
                id = java.util.UUID.randomUUID().toString(),
                label = label,
                publicKey = keypair.publicKey.toHex(),
                privateKey = keypair.privateKey.toHex(), // Will be encrypted below
                createdAt = now,
                lastUsedAt = now
            )

            // Encrypt private key using Keystore
            val encryptedPrivKey = cryptoAdapter.encryptPrivateKey(
                keypair.privateKey,
                "identity_${identity.id}"
            )

            queries.insert(
                id = identity.id,
                label = identity.label,
                publicKey = identity.publicKey,
                encryptedPrivateKey = encryptedPrivKey,
                createdAt = now.toEpochMilliseconds(),
                lastUsedAt = now.toEpochMilliseconds()
            )

            identity
        }
    }

    override suspend fun listIdentities(): Result<List<Identity>> = runCatching {
        withContext(Dispatchers.IO) {
            queries.selectAll().executeAsList().map { entity ->
                Identity(
                    id = entity.id,
                    label = entity.label,
                    publicKey = entity.publicKey,
                    privateKey = "", // Don't expose in list
                    createdAt = Instant.fromEpochMilliseconds(entity.createdAt),
                    lastUsedAt = Instant.fromEpochMilliseconds(entity.lastUsedAt)
                )
            }
        }
    }

    override suspend fun getIdentity(id: String): Result<Identity> = runCatching {
        withContext(Dispatchers.IO) {
            val entity = queries.selectById(id).executeAsOne()

            Identity(
                id = entity.id,
                label = entity.label,
                publicKey = entity.publicKey,
                privateKey = "", // Use getPrivateKey() separately
                createdAt = Instant.fromEpochMilliseconds(entity.createdAt),
                lastUsedAt = Instant.fromEpochMilliseconds(entity.lastUsedAt)
            )
        }
    }

    override suspend fun deleteIdentity(id: String): Result<Unit> = runCatching {
        withContext(Dispatchers.IO) {
            queries.deleteById(id)
        }
    }

    suspend fun getPrivateKey(id: String): Result<ByteArray> = runCatching {
        withContext(Dispatchers.IO) {
            val entity = queries.selectById(id).executeAsOne()
            cryptoAdapter.decryptPrivateKey(entity.encryptedPrivateKey, "identity_$id")
        }
    }
}
```

**SQLDelight Configuration**:

```kotlin
// imani-identity/build.gradle.kts
plugins {
    // ... existing plugins
    id("app.cash.sqldelight") version "2.0.1"
}

sqldelight {
    databases {
        create("IdentityDatabase") {
            packageName.set("cash.imani.identity")
        }
    }
}
```

**Acceptance Criteria**:
- SQLDelight schema compiles
- Can create, read, update, delete identities
- Private keys encrypted at rest
- Database survives app restart
- Migrations work (for future schema changes)

**Effort**: 2 days

**Task Tracking**:

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 4.2.2 | SQLDelight Android Database | M (2d) | 📋 TODO | - | Create SQLDelight schema for Identity and Voucher, AndroidIdentityRepository, AndroidVoucherRepository | 4.2.1 |

---

#### 4.2.3. Biometric Authentication (Optional)

**Implement biometric authentication for unlocking wallet**:

```kotlin
// imani-android/src/androidMain/kotlin/cash/imani/android/security/BiometricAuthenticator.kt
package cash.imani.android.security

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

class BiometricAuthenticator(
    private val activity: FragmentActivity
) {

    fun canAuthenticate(): Boolean {
        val biometricManager = BiometricManager.from(activity)
        return when (biometricManager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)) {
            BiometricManager.BIOMETRIC_SUCCESS -> true
            else -> false
        }
    }

    suspend fun authenticate(
        title: String = "Authenticate",
        subtitle: String = "Verify your identity to continue",
        description: String = "Use your fingerprint or face to unlock Imani Wallet"
    ): Result<Unit> = suspendCancellableCoroutine { continuation ->

        val executor = ContextCompat.getMainExecutor(activity)

        val biometricPrompt = BiometricPrompt(
            activity,
            executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    continuation.resume(Result.success(Unit))
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    continuation.resume(Result.failure(Exception("Authentication error: $errString")))
                }

                override fun onAuthenticationFailed() {
                    continuation.resume(Result.failure(Exception("Authentication failed")))
                }
            }
        )

        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(subtitle)
            .setDescription(description)
            .setNegativeButtonText("Cancel")
            .build()

        biometricPrompt.authenticate(promptInfo)
    }
}
```

**Usage in MainActivity**:

```kotlin
// imani-android/src/androidMain/kotlin/cash/imani/android/MainActivity.kt
class MainActivity : ComponentActivity() {

    private lateinit var biometricAuthenticator: BiometricAuthenticator
    private var isUnlocked by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        biometricAuthenticator = BiometricAuthenticator(this)

        lifecycleScope.launch {
            if (biometricAuthenticator.canAuthenticate()) {
                val result = biometricAuthenticator.authenticate()
                if (result.isSuccess) {
                    isUnlocked = true
                }
            } else {
                isUnlocked = true // Skip biometric if not available
            }
        }

        setContent {
            ImaniTheme {
                if (isUnlocked) {
                    AppNavigation()
                } else {
                    LockScreen()
                }
            }
        }
    }
}
```

**Acceptance Criteria**:
- Biometric prompt shows on app launch
- App unlocks on successful authentication
- Falls back gracefully if biometric not available
- Works with fingerprint and face unlock

**Effort**: 1 day (optional)

**Task Tracking**:

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 4.2.3 | Biometric Authentication (Optional) | S (1d) | 📋 TODO | - | BiometricAuthenticator, lock screen, integration with MainActivity | 4.1.2 |

---

### Phase 4.2 Deliverables

- [x] Android Keystore crypto adapter
- [x] SQLDelight database with Android driver
- [x] Identity repository with encrypted storage
- [ ] Biometric authentication (optional)

**Total Effort**: 4 days (5 days with biometric)

### Phase 4.2 Task Tracking Summary

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 4.2.1 | Android Keystore Crypto Adapter | M (2d) | 📋 TODO | - | CryptoAdapter using Android Keystore, secp256k1-kmp-jni-android | 4.1.1, Phase 1 |
| 4.2.2 | SQLDelight Android Database | M (2d) | 📋 TODO | - | SQLDelight schema, Android driver, repositories | 4.2.1 |
| 4.2.3 | Biometric Authentication (Optional) | S (1d) | 📋 TODO | - | BiometricAuthenticator, lock screen | 4.1.2 |

[↑ Back to top](#imani-wallet---android-port-roadmap)

---

## Phase 4.3: Android UI Adaptations

**Goal**: **Reuse imani-app Compose UI** with Android-specific features (camera, biometric, sharing).

**Duration**: 3 days (reduced from 5 days - UI already exists in imani-app)

### Tasks

#### 4.3.1. Material 3 Theme for Android

**Adapt Material 3 theme for Android with dynamic colors**:

```kotlin
// imani-android/src/androidMain/kotlin/cash/imani/android/ui/theme/Theme.kt
package cash.imani.android.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import cash.imani.app.ui.theme.ImaniColors

private val LightColorScheme = lightColorScheme(
    primary = ImaniColors.Primary,
    secondary = ImaniColors.Accent,
    tertiary = ImaniColors.Secondary,
    background = ImaniColors.Background,
    surface = ImaniColors.Surface,
    onPrimary = ImaniColors.OnPrimary,
    onSecondary = ImaniColors.OnSecondary,
    onBackground = ImaniColors.OnBackground,
    onSurface = ImaniColors.OnSurface
)

private val DarkColorScheme = darkColorScheme(
    primary = ImaniColors.Primary,
    secondary = ImaniColors.Accent,
    tertiary = ImaniColors.Secondary,
    // ... dark mode colors
)

@Composable
fun ImaniTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true, // Android 12+
    content: @Composable () -> Unit
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context)
            else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColorScheme
        else -> LightColorScheme
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = ImaniTypography,
        content = content
    )
}
```

**Acceptance Criteria**:
- Theme adapts to system dark mode
- Dynamic colors work on Android 12+ (API 31+)
- Imani brand colors used as fallback
- Matches web version visual design

**Effort**: 1 day

**Task Tracking**:

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 4.3.1 | Material 3 Theme for Android | S (1d) | 📋 TODO | - | Android theme with dynamic colors, dark mode support | 4.1.1 |

---

#### 4.3.2. Android Navigation

**Implement Android-specific navigation with back button handling**:

```kotlin
// imani-android/src/androidMain/kotlin/cash/imani/android/ui/navigation/AppNavigation.kt
package cash.imani.android.ui.navigation

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import cafe.adriel.voyager.navigator.Navigator
import cash.imani.app.ui.identity.IdentityListScreen
import cash.imani.app.ui.voucher.VoucherListScreen

@Composable
fun AppNavigation() {
    Navigator(IdentityListScreen()) { navigator ->
        // Handle Android back button
        BackHandler(enabled = navigator.size > 1) {
            navigator.pop()
        }

        CurrentScreen(navigator)
    }
}

@Composable
private fun CurrentScreen(navigator: Navigator) {
    val screen = navigator.lastItem
    screen.Content()
}
```

**Bottom Navigation**:

```kotlin
// imani-android/src/androidMain/kotlin/cash/imani/android/ui/navigation/BottomNavigation.kt
package cash.imani.android.ui.navigation

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController

sealed class BottomNavItem(val route: String, val icon: ImageVector, val label: String) {
    object Identities : BottomNavItem("identities", Icons.Default.Person, "Identities")
    object Vouchers : BottomNavItem("vouchers", Icons.Default.CardGiftcard, "Vouchers")
    object Settings : BottomNavItem("settings", Icons.Default.Settings, "Settings")
}

@Composable
fun MainScreen() {
    val navController = rememberNavController()
    val items = listOf(
        BottomNavItem.Identities,
        BottomNavItem.Vouchers,
        BottomNavItem.Settings
    )

    Scaffold(
        bottomBar = {
            NavigationBar {
                val currentRoute by navController.currentBackStackEntryAsState()
                    .map { it?.destination?.route }

                items.forEach { item ->
                    NavigationBarItem(
                        icon = { Icon(item.icon, contentDescription = item.label) },
                        label = { Text(item.label) },
                        selected = currentRoute == item.route,
                        onClick = {
                            navController.navigate(item.route) {
                                popUpTo(navController.graph.startDestinationId) {
                                    saveState = true
                                }
                                launchSingleTop = true
                                restoreState = true
                            }
                        }
                    )
                }
            }
        }
    ) { paddingValues ->
        NavHost(
            navController = navController,
            startDestination = BottomNavItem.Identities.route,
            modifier = Modifier.padding(paddingValues)
        ) {
            composable(BottomNavItem.Identities.route) {
                IdentityListScreen(/* ... */)
            }
            composable(BottomNavItem.Vouchers.route) {
                VoucherListScreen(/* ... */)
            }
            composable(BottomNavItem.Settings.route) {
                SettingsScreen()
            }
        }
    }
}
```

**Acceptance Criteria**:
- Back button navigates correctly
- Bottom navigation works
- Deep links handled (cashu:// URLs)
- State preserved on navigation

**Effort**: 1 day

**Task Tracking**:

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 4.3.2 | Android Navigation | S (1d) | 📋 TODO | - | Voyager navigation, back button handling, bottom navigation | 4.3.1 |

---

#### 4.3.3. QR Code Scanner (CameraX)

**Implement QR code scanner using CameraX**:

```kotlin
// imani-android/src/androidMain/kotlin/cash/imani/android/ui/components/QRScanner.kt
package cash.imani.android.ui.components

import android.Manifest
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.rememberPermissionState
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

@OptIn(ExperimentalPermissionsApi::class)
@Composable
fun QRScanner(
    onQRCodeScanned: (String) -> Unit,
    onDismiss: () -> Unit
) {
    val cameraPermission = rememberPermissionState(Manifest.permission.CAMERA)

    LaunchedEffect(Unit) {
        if (!cameraPermission.hasPermission) {
            cameraPermission.launchPermissionRequest()
        }
    }

    when {
        cameraPermission.hasPermission -> {
            CameraPreview(onQRCodeScanned, onDismiss)
        }
        cameraPermission.shouldShowRationale -> {
            PermissionRationale(onDismiss)
        }
        else -> {
            PermissionDenied(onDismiss)
        }
    }
}

@Composable
private fun CameraPreview(
    onQRCodeScanned: (String) -> Unit,
    onDismiss: () -> Unit
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val cameraExecutor: ExecutorService = remember { Executors.newSingleThreadExecutor() }

    var hasScanned by remember { mutableStateOf(false) }

    DisposableEffect(Unit) {
        onDispose {
            cameraExecutor.shutdown()
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        AndroidView(
            factory = { ctx ->
                val previewView = PreviewView(ctx)
                val cameraProviderFuture = ProcessCameraProvider.getInstance(ctx)

                cameraProviderFuture.addListener({
                    val cameraProvider = cameraProviderFuture.get()

                    val preview = Preview.Builder().build().also {
                        it.setSurfaceProvider(previewView.surfaceProvider)
                    }

                    val imageAnalysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                        .also { analysis ->
                            analysis.setAnalyzer(cameraExecutor) { imageProxy ->
                                processImageProxy(imageProxy) { qrCode ->
                                    if (!hasScanned) {
                                        hasScanned = true
                                        onQRCodeScanned(qrCode)
                                    }
                                }
                            }
                        }

                    val cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA

                    try {
                        cameraProvider.unbindAll()
                        cameraProvider.bindToLifecycle(
                            lifecycleOwner,
                            cameraSelector,
                            preview,
                            imageAnalysis
                        )
                    } catch (e: Exception) {
                        // Handle error
                    }
                }, ContextCompat.getMainExecutor(ctx))

                previewView
            },
            modifier = Modifier.fillMaxSize()
        )

        // Close button
        IconButton(
            onClick = onDismiss,
            modifier = Modifier.padding(16.dp)
        ) {
            Icon(Icons.Default.Close, "Close")
        }
    }
}

private fun processImageProxy(
    imageProxy: ImageProxy,
    onQRCodeDetected: (String) -> Unit
) {
    val mediaImage = imageProxy.image
    if (mediaImage != null) {
        val image = InputImage.fromMediaImage(
            mediaImage,
            imageProxy.imageInfo.rotationDegrees
        )

        val scanner = BarcodeScanning.getClient()
        scanner.process(image)
            .addOnSuccessListener { barcodes ->
                for (barcode in barcodes) {
                    barcode.rawValue?.let { value ->
                        onQRCodeDetected(value)
                    }
                }
            }
            .addOnCompleteListener {
                imageProxy.close()
            }
    } else {
        imageProxy.close()
    }
}
```

**Dependencies**:

```kotlin
// Add to imani-android/build.gradle.kts
dependencies {
    implementation("com.google.mlkit:barcode-scanning:17.2.0")
    implementation("com.google.accompanist:accompanist-permissions:0.34.0")
}
```

**Acceptance Criteria**:
- Camera permission requested
- QR codes detected and scanned
- Supports cashu:// tokens
- Works in portrait and landscape
- Graceful handling when camera unavailable

**Effort**: 2 days

**Task Tracking**:

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 4.3.3 | QR Code Scanner (CameraX) | M (2d) | 📋 TODO | - | CameraX integration, ML Kit barcode scanning, permission handling | 4.3.2 |

---

#### 4.3.4. Android Share Functionality

**Implement Android sharing (send vouchers to other apps)**:

```kotlin
// imani-android/src/androidMain/kotlin/cash/imani/android/ui/components/ShareSheet.kt
package cash.imani.android.ui.components

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import androidx.core.content.FileProvider
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import java.io.File
import java.io.FileOutputStream

object ShareUtils {

    fun shareVoucherToken(context: Context, token: String) {
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, token)
            putExtra(Intent.EXTRA_SUBJECT, "Imani Voucher")
        }
        context.startActivity(Intent.createChooser(intent, "Share Voucher"))
    }

    fun shareVoucherQR(context: Context, token: String, memo: String?) {
        // Generate QR code bitmap
        val bitmap = generateQRCode(token, 512)

        // Save to cache
        val file = File(context.cacheDir, "voucher_qr.png")
        FileOutputStream(file).use { out ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        }

        // Get content URI
        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file
        )

        // Share
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "image/png"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_TEXT, memo ?: "Imani Voucher")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(Intent.createChooser(intent, "Share QR Code"))
    }

    private fun generateQRCode(content: String, size: Int): Bitmap {
        val writer = QRCodeWriter()
        val bitMatrix = writer.encode(content, BarcodeFormat.QR_CODE, size, size)
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565)

        for (x in 0 until size) {
            for (y in 0 until size) {
                bitmap.setPixel(
                    x,
                    y,
                    if (bitMatrix[x, y]) android.graphics.Color.BLACK
                    else android.graphics.Color.WHITE
                )
            }
        }

        return bitmap
    }
}
```

**Usage in ShareVoucherScreen**:

```kotlin
@Composable
fun ShareVoucherScreen(token: String, memo: String?, onDone: () -> Unit) {
    val context = LocalContext.current

    // ... existing QR code display

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        OutlinedButton(
            onClick = { ShareUtils.shareVoucherToken(context, token) },
            modifier = Modifier.weight(1f)
        ) {
            Icon(Icons.Default.Share, "Share")
            Spacer(Modifier.width(4.dp))
            Text("Share Token")
        }

        Button(
            onClick = { ShareUtils.shareVoucherQR(context, token, memo) },
            modifier = Modifier.weight(1f)
        ) {
            Icon(Icons.Default.QrCode, "QR")
            Spacer(Modifier.width(4.dp))
            Text("Share QR")
        }
    }
}
```

**FileProvider Configuration**:

```xml
<!-- imani-android/src/androidMain/res/xml/file_paths.xml -->
<?xml version="1.0" encoding="utf-8"?>
<paths>
    <cache-path name="qr_codes" path="." />
</paths>
```

**Acceptance Criteria**:
- Can share voucher token as text
- Can share QR code as image
- Works with all Android share targets (messaging, email, etc.)
- QR code generation works offline

**Effort**: 1 day

**Task Tracking**:

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 4.3.4 | Android Share Functionality | S (1d) | 📋 TODO | - | Share intent, QR code generation, FileProvider | 4.3.3 |

---

### Phase 4.3 Deliverables

- [x] Material 3 theme with dynamic colors
- [x] Android navigation with back button
- [x] QR code scanner (CameraX)
- [x] Share functionality (text and QR)

**Total Effort**: 5 days

### Phase 4.3 Task Tracking Summary

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 4.3.1 | Material 3 Theme for Android | S (1d) | 📋 TODO | - | Dynamic colors, dark mode support | 4.1.1 |
| 4.3.2 | Android Navigation | S (1d) | 📋 TODO | - | Voyager navigation, back button, bottom nav | 4.3.1 |
| 4.3.3 | QR Code Scanner (CameraX) | M (2d) | 📋 TODO | - | CameraX, ML Kit barcode scanning | 4.3.2 |
| 4.3.4 | Android Share Functionality | S (1d) | 📋 TODO | - | Share intent, QR generation | 4.3.3 |

[↑ Back to top](#imani-wallet---android-port-roadmap)

---

## Phase 4.4: Testing & Publishing

**Goal**: Test thoroughly and publish to Google Play Store (internal testing).

**Duration**: 3 days (reduced from 4 days - fewer new components to test)

### Tasks

#### 4.4.1. Android Unit Tests

**Write unit tests for Android-specific code**:

```kotlin
// imani-identity/androidTest/kotlin/cash/imani/identity/crypto/AndroidCryptoAdapterTest.kt
package cash.imani.identity.crypto

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.test.runTest
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@RunWith(AndroidJUnit4::class)
class AndroidCryptoAdapterTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val adapter = AndroidCryptoAdapter()

    @Test
    fun testGenerateKeypair() = runTest {
        // When: Generate keypair
        val keypair = adapter.generateKeypair()

        // Then: Keys have correct size
        assertEquals(32, keypair.publicKey.size)
        assertEquals(32, keypair.privateKey.size)
    }

    @Test
    fun testSchnorrSignAndVerify() = runTest {
        // Given: Keypair and message
        val keypair = adapter.generateKeypair()
        val message = "test message".encodeToByteArray()
        val messageHash = adapter.sha256(message)

        // When: Sign message
        val signature = adapter.schnorrSign(keypair.privateKey, messageHash)

        // Then: Signature verifies
        val isValid = adapter.schnorrVerify(keypair.publicKey, messageHash, signature)
        assertTrue(isValid)
    }

    @Test
    fun testEncryptDecryptPrivateKey() = runTest {
        // Given: Private key
        val keypair = adapter.generateKeypair()
        val alias = "test_key"

        // When: Encrypt and decrypt
        val encrypted = adapter.encryptPrivateKey(keypair.privateKey, alias)
        val decrypted = adapter.decryptPrivateKey(encrypted, alias)

        // Then: Decrypted matches original
        assertEquals(keypair.privateKey.toList(), decrypted.toList())
    }
}
```

**Robolectric Tests** (for non-UI logic):

```kotlin
// imani-identity/test/kotlin/cash/imani/identity/repository/AndroidIdentityRepositoryTest.kt
package cash.imani.identity.repository

import androidx.test.core.app.ApplicationProvider
import cash.imani.identity.crypto.AndroidCryptoAdapter
import kotlinx.coroutines.test.runTest
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
class AndroidIdentityRepositoryTest {

    private lateinit var repository: AndroidIdentityRepository
    private lateinit var cryptoAdapter: AndroidCryptoAdapter

    @Before
    fun setup() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        cryptoAdapter = AndroidCryptoAdapter()
        repository = AndroidIdentityRepository(context, cryptoAdapter)
    }

    @Test
    fun testCreateIdentity() = runTest {
        // When: Create identity
        val result = repository.createIdentity("Test Identity")

        // Then: Success
        assertTrue(result.isSuccess)
        val identity = result.getOrThrow()
        assertEquals("Test Identity", identity.label)
    }

    @Test
    fun testListIdentities() = runTest {
        // Given: Created identity
        repository.createIdentity("Test 1")
        repository.createIdentity("Test 2")

        // When: List identities
        val result = repository.listIdentities()

        // Then: Returns all identities
        assertTrue(result.isSuccess)
        val identities = result.getOrThrow()
        assertEquals(2, identities.size)
    }
}
```

**Acceptance Criteria**:
- All unit tests pass
- Code coverage ≥80%
- Tests run in CI/CD
- Robolectric tests for non-UI logic

**Effort**: 2 days

**Task Tracking**:

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 4.4.1 | Android Unit Tests | M (2d) | 📋 TODO | - | AndroidJUnit4 tests, Robolectric tests, 80% coverage | 4.2.2, 4.3.4 |

---

#### 4.4.2. Android Instrumentation Tests (UI)

**Write UI tests using Compose Test**:

```kotlin
// imani-android/androidTest/kotlin/cash/imani/android/ui/IdentityFlowTest.kt
package cash.imani.android.ui

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class IdentityFlowTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun testCreateIdentityFlow() {
        // Start app
        composeTestRule.setContent {
            ImaniTheme {
                AppNavigation()
            }
        }

        // Click "Create Identity"
        composeTestRule.onNodeWithText("Create Identity").performClick()

        // Enter label
        composeTestRule.onNodeWithText("Identity Label").performTextInput("My Test Identity")

        // Click "Create"
        composeTestRule.onNodeWithText("Create Identity").performClick()

        // Wait for mnemonic screen
        composeTestRule.waitUntil(5000) {
            composeTestRule.onAllNodesWithText("Write down your recovery phrase")
                .fetchSemanticsNodes().isNotEmpty()
        }

        // Verify mnemonic displayed
        composeTestRule.onNodeWithText("Write down your recovery phrase").assertExists()

        // Click "I've saved it"
        composeTestRule.onNodeWithText("I've saved it").performClick()

        // Verify back on identity list
        composeTestRule.onNodeWithText("My Test Identity").assertExists()
    }

    @Test
    fun testIssueVoucherFlow() {
        // ... similar test for voucher issuance
    }
}
```

**Acceptance Criteria**:
- UI tests cover critical flows
- Tests run on emulator
- All tests pass
- Tests run in CI/CD

**Effort**: 1 day

**Task Tracking**:

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 4.4.2 | Android Instrumentation Tests (UI) | S (1d) | 📋 TODO | - | Compose UI tests, critical user flows | 4.4.1 |

---

#### 4.4.3. Device Testing & Optimization

**Test on physical devices and optimize performance**:

**Test Matrix**:
- **Devices**: Pixel 6, Samsung Galaxy S21, OnePlus 9 (or similar)
- **OS Versions**: Android 8.0 (API 26), Android 12 (API 31), Android 14 (API 34)
- **Form Factors**: Phone (small, medium, large), Tablet
- **Orientations**: Portrait, Landscape

**Performance Checklist**:
- [ ] App startup time < 2 seconds
- [ ] Identity creation < 1 second
- [ ] Voucher issuance < 2 seconds
- [ ] QR scanning responsive (< 500ms to detect)
- [ ] No ANR (Application Not Responding) errors
- [ ] Memory usage < 100MB idle, < 200MB active
- [ ] APK size < 10MB

**Tools**:
- Android Profiler (CPU, Memory, Network)
- Layout Inspector
- LeakCanary (for memory leaks)

**Acceptance Criteria**:
- Tests pass on all devices
- Performance targets met
- No crashes or ANRs
- UI responsive on all form factors

**Effort**: 1 day

**Task Tracking**:

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 4.4.3 | Device Testing & Optimization | S (1d) | 📋 TODO | - | Test on physical devices, performance profiling, optimization | 4.4.2 |

---

#### 4.4.4. Google Play Store Publishing

**Prepare and publish to Play Store (internal testing)**:

**Steps**:

1. **Generate Signed APK/AAB**:
```bash
# Create release keystore (one-time)
keytool -genkey -v -keystore imani-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias imani

# Build release AAB
./gradlew :imani-android:bundleRelease
```

2. **Configure signing in gradle.properties**:
```properties
# gradle.properties (DO NOT commit)
IMANI_KEYSTORE_FILE=../imani-release.jks
IMANI_KEYSTORE_PASSWORD=<password>
IMANI_KEY_ALIAS=imani
IMANI_KEY_PASSWORD=<password>
```

3. **Create Play Store Listing**:
- App name: Imani Wallet
- Short description: "Self-custody digital voucher wallet with cryptographic security"
- Full description: (See brand identity section)
- Screenshots: 5-8 screenshots (phone, tablet)
- Feature graphic: 1024x500px
- Icon: 512x512px
- Privacy policy URL

4. **Upload to Internal Testing**:
- Create internal testing release
- Upload AAB
- Add test users (email addresses)
- Submit for review

**Acceptance Criteria**:
- APK/AAB signed with release key
- Play Store listing complete
- Internal testing release published
- Test users can install and run app

**Effort**: 1 day

**Task Tracking**:

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 4.4.4 | Google Play Store Publishing | S (1d) | 📋 TODO | - | Generate signed AAB, Play Store listing, internal testing release | 4.4.3 |

---

### Phase 4.4 Deliverables

- [x] Android unit tests (80% coverage)
- [x] UI instrumentation tests
- [x] Device testing complete
- [x] Published to Play Store (internal testing)

**Total Effort**: 5 days (includes 1 day buffer)

### Phase 4.4 Task Tracking Summary

| ID | Task | Size | Status | Commit | Notes | Dependencies |
|----|------|------|--------|--------|-------|--------------|
| 4.4.1 | Android Unit Tests | M (2d) | 📋 TODO | - | AndroidJUnit4, Robolectric, 80% coverage | 4.2.2, 4.3.4 |
| 4.4.2 | Android Instrumentation Tests (UI) | S (1d) | 📋 TODO | - | Compose UI tests, critical flows | 4.4.1 |
| 4.4.3 | Device Testing & Optimization | S (1d) | 📋 TODO | - | Physical device testing, performance profiling | 4.4.2 |
| 4.4.4 | Google Play Store Publishing | S (1d) | 📋 TODO | - | Signed AAB, Play Store listing, internal testing | 4.4.3 |

[↑ Back to top](#imani-wallet---android-port-roadmap)

---

## Android-Specific Guidelines

### Security Best Practices

1. **Android Keystore**:
   - Use `setUserAuthenticationRequired(false)` for background operations
   - Use `setUserAuthenticationRequired(true)` for sensitive operations (with biometric)
   - Never expose raw private keys in logs or UI

2. **Network Security**:
   - Use network security config to prevent cleartext traffic
   - Pin SSL certificates for mint API (optional)
   - Validate all server responses

3. **ProGuard/R8**:
   - Enable minification for release builds
   - Keep rules for serialization classes
   - Test release builds thoroughly

**ProGuard Rules**:

```proguard
# imani-android/proguard-rules.pro

# Keep Kotlin serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Keep domain models
-keep class cash.imani.identity.domain.** { *; }
-keep class cash.imani.voucher.domain.** { *; }

# Keep Ktor
-keep class io.ktor.** { *; }
-dontwarn io.ktor.**

# Keep SQLDelight
-keep class app.cash.sqldelight.** { *; }
```

### Performance Optimization

1. **LazyColumn Optimization**:
   - Use `key` parameter for stable list items
   - Implement `contentType` for heterogeneous lists
   - Avoid nested LazyColumns

2. **Coroutine Scoping**:
   - Use `viewModelScope` for ViewModel coroutines
   - Use `lifecycleScope` for Activity/Fragment coroutines
   - Cancel coroutines on configuration changes

3. **Image Loading**:
   - Use Coil for QR code display (with caching)
   - Compress QR codes before sharing

### Accessibility

1. **Content Descriptions**:
   - Add `contentDescription` to all icons
   - Use semantic labels for buttons

2. **Touch Targets**:
   - Minimum 48dp touch target size
   - Add padding to small buttons

3. **Color Contrast**:
   - Ensure WCAG AA compliance (4.5:1 ratio)
   - Test with TalkBack enabled

---

## Testing Strategy

### Unit Tests (60%)

**Scope**:
- Android crypto adapter
- SQLDelight repositories
- Use cases
- ViewModels

**Tools**:
- JUnit 4
- Robolectric
- MockK
- Kotlin Coroutines Test

### Instrumentation Tests (30%)

**Scope**:
- UI flows
- Navigation
- QR scanning
- Biometric authentication

**Tools**:
- Espresso
- Compose Test
- AndroidJUnit4

### Manual Tests (10%)

**Scope**:
- Physical device testing
- Performance profiling
- Edge cases (low memory, airplane mode)

---

## Success Metrics

### Functional Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Identity creation success rate | ≥98% | Analytics |
| Voucher issuance success rate | ≥95% | Analytics |
| QR scanning success rate | ≥90% | User feedback |
| Biometric unlock success rate | ≥95% | Analytics |

### Performance Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| App startup time | <2s | Android Profiler |
| Identity creation time | <1s | Benchmarks |
| Voucher issuance time | <2s | Benchmarks |
| QR scanning time | <500ms | Benchmarks |
| APK size | <10MB | Build output |
| Memory usage (idle) | <100MB | Android Profiler |
| Memory usage (active) | <200MB | Android Profiler |

### Quality Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Unit test coverage | ≥80% | Kover |
| Crash-free rate | ≥99.5% | Firebase Crashlytics |
| ANR rate | <0.1% | Play Console |
| Play Store rating | ≥4.0 | User reviews |

---

## Change Log

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2025-11-19 | Claude Code | Initial Android port roadmap with detailed task tracking tables |

[↑ Back to top](#imani-wallet---android-port-roadmap)