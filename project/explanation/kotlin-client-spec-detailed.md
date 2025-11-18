# Imani Wallet - Kotlin Multiplatform Technical Specification

> **Product Name**: Imani Wallet
> **Tagline**: Built on Trust, Secured by Math
> **Document Type**: Explanation (Diátaxis)
> **Version**: 1.1.0
> **Last Updated**: 2025-11-17
> **Related Documents**:
> - [Imani Wallet Implementation Roadmap](../../docs/how-to/kotlin-voucher-client-roadmap.md)
> - [Web Client Specification (High-Level)](./web-client-spec.md)
> - [Web Client Detailed Specification (TypeScript)](./web-client-spec-detailed.md)
> - [NUT Specifications Analysis for Web Client](../../docs/reference/nut-specifications-web-client-analysis.md)

## About Imani

**Imani** (ee-MAH-nee) is Swahili for "faith" and "trust" - the 7th principle of Kwanzaa. This document provides the detailed technical specification for **Imani Wallet**, a Kotlin Multiplatform application that reuses the existing Java 21 codebase from cashu-client. The goal is to maximize code reuse (60-80%) while creating native applications for Desktop (JVM), Android, iOS, and Web (Kotlin/JS) using **Compose Multiplatform** for UI.

**Core Philosophy**: Trust in cryptography, trust in community, trust in self-custody

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Technology Stack](#technology-stack)
3. [Architecture](#architecture)
4. [Code Reuse Strategy](#code-reuse-strategy)
5. [Module Migration Plan](#module-migration-plan)
6. [Platform-Specific Implementations](#platform-specific-implementations)
7. [Data Models](#data-models)
8. [Security Implementation](#security-implementation)
9. [State Management](#state-management)
10. [Error Handling](#error-handling)
11. [Testing Strategy](#testing-strategy)
12. [Deployment](#deployment)
13. [Comparison: Kotlin vs. TypeScript Web Client](#comparison-kotlin-vs-typescript-web-client)

---

## Executive Summary

### Goals

- **Maximize Code Reuse**: Reuse 60-80% of existing Java 21 codebase by converting to Kotlin and extracting platform-independent logic
- **Native Performance**: Build native applications for Desktop, Android, iOS, and Web using Kotlin Multiplatform
- **Consistent UX**: Use Compose Multiplatform for shared UI across all platforms
- **Security-First**: Client-side encryption, secure key storage, no server-side secrets
- **Protocol Compliance**: Full NUT-00 to NUT-24 compliance via existing cashu-lib and cashu-wallet libraries

### Key Advantages Over TypeScript Web Client

| Aspect | Kotlin Multiplatform | TypeScript Web |
|--------|---------------------|----------------|
| **Code Reuse** | 60-80% from existing Java codebase | 0% (new codebase) |
| **Platforms** | Desktop, Android, iOS, Web | Web only |
| **Performance** | Native performance on all platforms | Browser-constrained |
| **Offline Support** | Native file system, databases | localStorage only |
| **Security** | Platform native keychains/keyst ores | Web Crypto API only |
| **Development Time** | Faster (reuse existing logic) | Slower (rewrite from scratch) |
| **Team Skills** | Java/Kotlin team can contribute | Requires JavaScript expertise |

### Target Platforms

1. **Desktop (JVM)**: macOS, Windows, Linux via Compose for Desktop
2. **Android**: Native Android app via Jetpack Compose
3. **iOS**: Native iOS app via Compose Multiplatform (Kotlin/Native)
4. **Web**: Browser-based SPA via Kotlin/JS + Compose for Web

---

## Technology Stack

### Core Technologies

| Layer | Technology | Version | Purpose |
|-------|------------|---------|---------|
| **Language** | Kotlin | 1.9+ | Multiplatform language |
| **UI Framework** | Compose Multiplatform | 1.6+ | Declarative UI across all platforms |
| **Build System** | Gradle | 8.5+ with Kotlin DSL | Multiplatform build configuration |
| **Serialization** | kotlinx.serialization | 1.6+ | JSON serialization (replaces Jackson) |
| **HTTP Client** | Ktor Client | 2.3+ | Cross-platform HTTP (replaces Spring RestTemplate) |
| **Cryptography** | Tink or Bouncy Castle Kotlin | Latest | Cross-platform crypto (replaces Bouncy Castle JVM) |
| **Database** | SQLDelight | 2.0+ | Cross-platform SQL (generates Kotlin from SQL) |
| **State Management** | Kotlin Flows + StateFlow | Stdlib | Reactive state management |
| **Dependency Injection** | Koin | 3.5+ | Lightweight DI for KMP |
| **Testing** | Kotlin Test + Kotest | Latest | Multiplatform testing |

### Platform-Specific Technologies

#### Desktop (JVM)
- **UI**: Compose for Desktop
- **Database**: SQLite via JDBC
- **Keystore**: Java KeyStore (JKS)
- **File I/O**: java.nio.file

#### Android
- **UI**: Jetpack Compose
- **Database**: SQLDelight with Android driver
- **Keystore**: Android Keystore
- **File I/O**: Android file system

#### iOS
- **UI**: Compose Multiplatform for iOS
- **Database**: SQLDelight with Native driver
- **Keystore**: iOS Keychain via cinterop
- **File I/O**: NSFileManager via cinterop

#### Web (Kotlin/JS)
- **UI**: Compose for Web (experimental)
- **Database**: IndexedDB via JS interop
- **Keystore**: Web Crypto API via JS interop
- **File I/O**: File API via JS interop

---

## Architecture

### Multiplatform Module Structure

```
cashu-multiplatform/
├── shared/                           # Shared Kotlin Multiplatform code
│   ├── commonMain/                   # Common code (all platforms)
│   │   ├── kotlin/
│   │   │   ├── domain/               # Domain entities (Identity, WalletState, Voucher)
│   │   │   ├── data/                 # Repositories, data sources
│   │   │   ├── usecases/             # Application use cases
│   │   │   ├── network/              # Ktor HTTP client, Mint API
│   │   │   ├── crypto/               # Cryptography interfaces
│   │   │   └── storage/              # Storage interfaces
│   │   └── resources/                # Shared resources (strings, assets)
│   │
│   ├── commonTest/                   # Common tests
│   │
│   ├── jvmMain/                      # JVM-specific implementations
│   │   └── kotlin/
│   │       ├── crypto/               # Bouncy Castle for JVM
│   │       ├── storage/              # SQLite via JDBC
│   │       └── keystore/             # Java KeyStore
│   │
│   ├── androidMain/                  # Android-specific implementations
│   │   └── kotlin/
│   │       ├── crypto/               # Android Keystore
│   │       ├── storage/              # SQLDelight Android driver
│   │       └── ui/                   # Android-specific UI components
│   │
│   ├── iosMain/                      # iOS-specific implementations
│   │   └── kotlin/
│   │       ├── crypto/               # iOS Keychain via cinterop
│   │       ├── storage/              # SQLDelight Native driver
│   │       └── ui/                   # iOS-specific UI components
│   │
│   └── jsMain/                       # Web-specific implementations
│       └── kotlin/
│           ├── crypto/               # Web Crypto API
│           ├── storage/              # IndexedDB
│           └── ui/                   # Web-specific UI components
│
├── composeApp/                       # Compose Multiplatform UI
│   ├── commonMain/                   # Shared UI code
│   │   └── kotlin/
│   │       ├── ui/
│   │       │   ├── identity/         # Identity management screens
│   │       │   ├── wallet/           # Wallet screens
│   │       │   ├── voucher/          # Voucher screens
│   │       │   ├── settings/         # Settings screens
│   │       │   └── components/       # Reusable UI components
│   │       ├── viewmodels/           # ViewModels for MVVM
│   │       ├── navigation/           # Navigation logic
│   │       └── theme/                # Material Design theme
│   │
│   ├── desktopMain/                  # Desktop-specific UI
│   ├── androidMain/                  # Android-specific UI
│   ├── iosMain/                      # iOS-specific UI
│   └── jsMain/                       # Web-specific UI
│
├── desktop/                          # Desktop application entry point
│   └── src/
│       └── jvmMain/
│           └── kotlin/Main.kt        # Desktop main()
│
├── android/                          # Android application
│   └── src/
│       └── main/
│           ├── kotlin/MainActivity.kt
│           └── AndroidManifest.xml
│
├── ios/                              # iOS application (Xcode project)
│   └── iosApp/
│       └── ContentView.swift         # iOS entry point
│
└── web/                              # Web application
    └── src/
        └── jsMain/
            └── kotlin/Main.kt        # Web entry point
```

### Architecture Layers (Clean Architecture)

```
┌───────────────────────────────────────────────────────────────┐
│                    Presentation Layer                          │
│  ┌────────────────────────────────────────────────────────┐   │
│  │  Compose Multiplatform UI (commonMain)                 │   │
│  │  - Identity screens, Wallet screens, Voucher screens   │   │
│  │  - ViewModels (StateFlow, Flows)                       │   │
│  │  - Navigation (Compose Navigation)                     │   │
│  └────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
                             │
┌───────────────────────────────────────────────────────────────┐
│                    Application Layer                           │
│  ┌────────────────────────────────────────────────────────┐   │
│  │  Use Cases (commonMain)                                │   │
│  │  - CreateIdentityUseCase, IssueVoucherUseCase         │   │
│  │  - RedeemVoucherUseCase, SendTokensUseCase            │   │
│  │  - RefreshBalanceUseCase                               │   │
│  └────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
                             │
┌───────────────────────────────────────────────────────────────┐
│                    Domain Layer                                │
│  ┌────────────────────────────────────────────────────────┐   │
│  │  Domain Entities (commonMain)                          │   │
│  │  - Identity, WalletState, StoredVoucher, Proof        │   │
│  │  - MintInfo, KeySet, MintQuote, MeltQuote             │   │
│  │  - Repository interfaces (no implementations)         │   │
│  └────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
                             │
┌───────────────────────────────────────────────────────────────┐
│                    Data Layer (Platform-Specific)              │
│  ┌────────────────────────────────────────────────────────┐   │
│  │  Repositories (commonMain)                             │   │
│  │  - IdentityRepository, WalletRepository               │   │
│  │  - VoucherRepository, ProofRepository                 │   │
│  ├────────────────────────────────────────────────────────┤   │
│  │  Data Sources (expect/actual pattern)                 │   │
│  │  - LocalDataSource (SQLDelight)                       │   │
│  │  - RemoteDataSource (Ktor Client)                     │   │
│  │  - KeystoreDataSource (platform-specific)             │   │
│  └────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
                             │
┌───────────────────────────────────────────────────────────────┐
│              Infrastructure Layer (Platform-Specific)          │
│  ┌────────────────────────────────────────────────────────┐   │
│  │  Adapters (expect/actual pattern)                     │   │
│  │  - CryptoAdapter (Tink/Bouncy Castle/Web Crypto)      │   │
│  │  - StorageAdapter (SQLite/IndexedDB)                  │   │
│  │  - KeystoreAdapter (JKS/Keychain/Web Crypto)          │   │
│  │  - NetworkAdapter (Ktor with platform engines)        │   │
│  └────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
```

---

## Code Reuse Strategy

### Existing Java Modules → Kotlin Multiplatform Conversion

| Existing Java Module | Conversion Strategy | Target KMP Module | Reuse % |
|---------------------|---------------------|-------------------|---------|
| **identity-domain** | Direct Kotlin conversion | `shared/commonMain/domain/identity` | 95% |
| **identity-api** | Convert to Kotlin interfaces | `shared/commonMain/data/identity` | 95% |
| **identity-application** | Convert to use cases | `shared/commonMain/usecases/identity` | 90% |
| **identity-infrastructure** | Split: common + platform | `shared/commonMain` + `shared/*Main` | 70% |
| **wallet-core-base** (domain) | Direct Kotlin conversion | `shared/commonMain/domain/wallet` | 90% |
| **wallet-core-cashu** (logic) | Convert protocols | `shared/commonMain/usecases/wallet` | 85% |
| **wallet-core-nostr** | Replace nostr-java with Ktor | `shared/commonMain/network/nostr` | 75% |
| **wallet-core-app** | Split: use cases + platform | `shared/commonMain/usecases` + platform | 60% |
| **wallet-storage-file** | Replace with SQLDelight | `shared/*Main/storage` | 50% (schema reuse) |
| **wallet-storage-h2** | Replace with SQLDelight | `shared/*Main/storage` | 40% (schema reuse) |

### Conversion Workflow

#### Phase 1: Domain Layer Conversion (Week 1-2)

**Steps**:
1. Create new KMP project with Gradle Kotlin DSL
2. Convert Java Records to Kotlin `data class`:
   ```java
   // Java (identity-domain)
   public record Identity(String id, String label, PublicKey publicKey, ...) {}
   ```
   ```kotlin
   // Kotlin (commonMain)
   @Serializable
   data class Identity(
       val id: String,
       val label: String,
       val publicKey: PublicKey,
       ...
   )
   ```

3. Convert domain entities:
   - `Identity`, `PrivateKey`, `PublicKey` → `shared/commonMain/domain/identity`
   - `WalletState`, `WalletToken`, `StoredVoucher` → `shared/commonMain/domain/wallet`
   - `Proof`, `MintInfo`, `KeySet`, `MintQuote`, `MeltQuote` → `shared/commonMain/domain/cashu`

4. Remove JVM-specific dependencies (nostr-java types replaced with Kotlin equivalents)

**Deliverable**: Domain models in `commonMain` compilable for all platforms

---

#### Phase 2: Application Layer Conversion (Week 3-4)

**Steps**:
1. Convert use cases from `identity-application`:
   ```java
   // Java
   public class CreateIdentityUseCase {
       private final IdentityRepository repository;
       public Identity execute(String label) { ... }
   }
   ```
   ```kotlin
   // Kotlin
   class CreateIdentityUseCase(
       private val repository: IdentityRepository
   ) {
       suspend operator fun invoke(label: String): Result<Identity> = runCatching {
           repository.createIdentity(label)
       }
   }
   ```

2. Convert wallet use cases:
   - `IssueVoucherUseCase`, `RedeemVoucherUseCase`
   - `MintTokensUseCase`, `MeltTokensUseCase`, `SwapProofsUseCase`
   - `RefreshBalanceUseCase`, `SendTokensUseCase`

3. Replace blocking calls with `suspend` functions
4. Replace exceptions with `Result<T>` or sealed classes

**Deliverable**: Use cases in `commonMain` with repository interfaces

---

#### Phase 3: Infrastructure Layer - expect/actual Pattern (Week 5-6)

**Crypto Adapter**:
```kotlin
// commonMain - interface
expect class CryptoAdapter {
    suspend fun generateRandomBytes(length: Int): ByteArray
    suspend fun sha256(data: ByteArray): ByteArray
    suspend fun encryptAES256GCM(plaintext: ByteArray, key: ByteArray): EncryptedData
    suspend fun decryptAES256GCM(ciphertext: EncryptedData, key: ByteArray): ByteArray
    suspend fun deriveKey(passphrase: String, salt: ByteArray, iterations: Int): ByteArray
    suspend fun schnorrSign(privateKey: ByteArray, message: ByteArray): ByteArray
    suspend fun schnorrVerify(publicKey: ByteArray, message: ByteArray, sig: ByteArray): Boolean
}

// jvmMain - Bouncy Castle implementation
actual class CryptoAdapter {
    actual suspend fun generateRandomBytes(length: Int): ByteArray {
        return SecureRandom().generateSeed(length)
    }
    // ... using Bouncy Castle
}

// jsMain - Web Crypto API implementation
actual class CryptoAdapter {
    actual suspend fun generateRandomBytes(length: Int): ByteArray {
        return window.crypto.getRandomValues(Uint8Array(length)).unsafeCast<ByteArray>()
    }
    // ... using Web Crypto API
}
```

**Storage Adapter** (SQLDelight):
```kotlin
// Define schema in .sq files (shared)
// queries/Identity.sq
CREATE TABLE Identity (
    id TEXT PRIMARY KEY NOT NULL,
    label TEXT NOT NULL,
    publicKey TEXT NOT NULL,
    encryptedPrivateKey TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    lastUsedAt INTEGER NOT NULL
);

insertIdentity:
INSERT INTO Identity(id, label, publicKey, encryptedPrivateKey, createdAt, lastUsedAt)
VALUES (?, ?, ?, ?, ?, ?);

selectAll:
SELECT * FROM Identity;

selectById:
SELECT * FROM Identity WHERE id = ?;

// commonMain - repository
class IdentityRepositoryImpl(
    private val database: Database
) : IdentityRepository {
    override suspend fun createIdentity(label: String): Identity {
        // SQLDelight generates type-safe queries
        val id = UUID.randomUUID().toString()
        val keypair = cryptoAdapter.generateKeypair()
        database.identityQueries.insertIdentity(
            id, label, keypair.publicKey.toHex(),
            encryptedPrivateKey, now(), now()
        )
        return Identity(id, label, keypair.publicKey, ...)
    }
}

// jvmMain - SQLite driver
actual fun createDatabase(): Database {
    val driver = JdbcSqliteDriver("jdbc:sqlite:wallet.db")
    Database.Schema.create(driver)
    return Database(driver)
}

// androidMain - Android driver
actual fun createDatabase(context: Context): Database {
    val driver = AndroidSqliteDriver(Database.Schema, context, "wallet.db")
    return Database(driver)
}

// jsMain - IndexedDB wrapper (custom)
actual fun createDatabase(): Database {
    // Use IndexedDB via JS interop
    // Or use SQLite.js compiled to WASM
}
```

**Network Adapter** (Ktor Client):
```kotlin
// commonMain
class MintApiClient(
    private val httpClient: HttpClient
) {
    suspend fun getInfo(mintUrl: String): MintInfo {
        return httpClient.get("$mintUrl/v1/info").body()
    }

    suspend fun getKeySets(mintUrl: String): List<KeySet> {
        return httpClient.get("$mintUrl/v1/keys").body()
    }

    suspend fun quoteMint(mintUrl: String, amount: Long, unit: String): MintQuote {
        return httpClient.post("$mintUrl/v1/mint/quote/bolt11") {
            contentType(ContentType.Application.Json)
            setBody(MintQuoteRequest(amount, unit))
        }.body()
    }
}

// Platform engines configured automatically
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
        // Platform-specific engine selected automatically:
        // JVM: OkHttp or CIO
        // Android: OkHttp
        // iOS: Darwin
        // JS: Fetch API
    }
}
```

**Deliverable**: Platform-specific adapters compiled for each target

---

#### Phase 4: Compose Multiplatform UI (Week 7-10)

**Shared UI Components**:
```kotlin
// commonMain/ui/components/IdentityCard.kt
@Composable
fun IdentityCard(
    identity: Identity,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        elevation = CardDefaults.cardElevation(defaultElevation = 4.dp)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = identity.label,
                style = MaterialTheme.typography.titleMedium
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = identity.publicKey.toNpub(),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = "Last used: ${identity.lastUsedAt.format()}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
```

**ViewModels with StateFlow**:
```kotlin
// commonMain/viewmodels/IdentityViewModel.kt
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
                    _uiState.value = IdentityUiState.Error(error.message ?: "Unknown error")
                }
        }
    }

    fun createIdentity(label: String) {
        viewModelScope.launch {
            createIdentityUseCase(label)
                .onSuccess {
                    loadIdentities() // Refresh list
                }
                .onFailure { error ->
                    _uiState.value = IdentityUiState.Error(error.message ?: "Failed to create identity")
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

**Screens**:
```kotlin
// commonMain/ui/identity/IdentityListScreen.kt
@Composable
fun IdentityListScreen(
    viewModel: IdentityViewModel = koinViewModel(),
    onIdentityClick: (Identity) -> Unit,
    onCreateClick: () -> Unit
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(title = { Text("Identities") })
        },
        floatingActionButton = {
            FloatingActionButton(onClick = onCreateClick) {
                Icon(Icons.Default.Add, contentDescription = "Create Identity")
            }
        }
    ) { padding ->
        when (val state = uiState) {
            is IdentityUiState.Loading -> {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center
                ) {
                    CircularProgressIndicator()
                }
            }

            is IdentityUiState.Success -> {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
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
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            text = state.message,
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.error
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        Button(onClick = { viewModel.loadIdentities() }) {
                            Text("Retry")
                        }
                    }
                }
            }
        }
    }
}
```

**Navigation**:
```kotlin
// commonMain/navigation/AppNavigation.kt
sealed class Screen(val route: String) {
    object IdentityList : Screen("identity_list")
    object IdentityCreate : Screen("identity_create")
    object WalletDashboard : Screen("wallet_dashboard")
    object VoucherList : Screen("voucher_list")
    object VoucherIssue : Screen("voucher_issue")
    object VoucherRedeem : Screen("voucher_redeem")
    object Settings : Screen("settings")
}

@Composable
fun AppNavigation() {
    val navController = rememberNavController()

    NavHost(
        navController = navController,
        startDestination = Screen.IdentityList.route
    ) {
        composable(Screen.IdentityList.route) {
            IdentityListScreen(
                onIdentityClick = { /* navigate to details */ },
                onCreateClick = { navController.navigate(Screen.IdentityCreate.route) }
            )
        }

        composable(Screen.IdentityCreate.route) {
            CreateIdentityScreen(
                onSuccess = {
                    navController.popBackStack()
                },
                onCancel = {
                    navController.popBackStack()
                }
            )
        }

        // ... other screens
    }
}
```

**Deliverable**: Working UI on all platforms with shared code

---

## Platform-Specific Implementations

### Desktop (JVM)

**Main Entry Point**:
```kotlin
// desktop/src/jvmMain/kotlin/Main.kt
fun main() = application {
    // Initialize Koin DI
    startKoin {
        modules(
            platformModule(), // JVM-specific dependencies
            sharedModule()    // Shared dependencies
        )
    }

    Window(
        onCloseRequest = ::exitApplication,
        title = "Cashu Wallet",
        state = rememberWindowState(width = 1200.dp, height = 800.dp)
    ) {
        MaterialTheme {
            AppNavigation()
        }
    }
}

// Platform module for JVM
val platformModule = module {
    single<CryptoAdapter> { JvmCryptoAdapter() }
    single<StorageAdapter> { JvmStorageAdapter() }
    single<KeystoreAdapter> { JavaKeystoreAdapter() }
    single { createDatabase() }
}
```

**Java KeyStore Integration**:
```kotlin
// shared/jvmMain/kotlin/keystore/JavaKeystoreAdapter.kt
actual class KeystoreAdapter {
    private val keyStore = KeyStore.getInstance("JCEKS").apply {
        val file = File(System.getProperty("user.home"), ".cashu/keystore.jks")
        if (file.exists()) {
            file.inputStream().use { load(it, PASSWORD) }
        } else {
            load(null, PASSWORD)
        }
    }

    actual suspend fun storeKey(alias: String, key: ByteArray) {
        val secretKey = SecretKeySpec(key, "AES")
        val entry = KeyStore.SecretKeyEntry(secretKey)
        keyStore.setEntry(alias, entry, KeyStore.PasswordProtection(PASSWORD))
        saveKeyStore()
    }

    actual suspend fun retrieveKey(alias: String): ByteArray? {
        val entry = keyStore.getEntry(alias, KeyStore.PasswordProtection(PASSWORD))
        return (entry as? KeyStore.SecretKeyEntry)?.secretKey?.encoded
    }
}
```

---

### Android

**Main Entry Point**:
```kotlin
// android/src/main/kotlin/MainActivity.kt
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Initialize Koin DI
        startKoin {
            androidContext(this@MainActivity)
            modules(
                platformModule(),
                sharedModule()
            )
        }

        setContent {
            MaterialTheme {
                AppNavigation()
            }
        }
    }
}

// Platform module for Android
val platformModule = module {
    single<CryptoAdapter> { AndroidCryptoAdapter(androidContext()) }
    single<StorageAdapter> { AndroidStorageAdapter() }
    single<KeystoreAdapter> { AndroidKeystoreAdapter() }
    single { createDatabase(androidContext()) }
}
```

**Android Keystore Integration**:
```kotlin
// shared/androidMain/kotlin/keystore/AndroidKeystoreAdapter.kt
actual class KeystoreAdapter {
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply {
        load(null)
    }

    actual suspend fun storeKey(alias: String, key: ByteArray) {
        // Android Keystore encrypts keys automatically
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val keySpec = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(false) // Change to true for biometric
            .build()

        val keyGenerator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            "AndroidKeyStore"
        )
        keyGenerator.init(keySpec)
        keyGenerator.generateKey()

        // Store encrypted key in SharedPreferences
        val prefs = context.getSharedPreferences("cashu_keys", Context.MODE_PRIVATE)
        prefs.edit().putString(alias, Base64.encodeToString(key, Base64.DEFAULT)).apply()
    }

    actual suspend fun retrieveKey(alias: String): ByteArray? {
        val prefs = context.getSharedPreferences("cashu_keys", Context.MODE_PRIVATE)
        val encoded = prefs.getString(alias, null) ?: return null
        return Base64.decode(encoded, Base64.DEFAULT)
    }
}
```

---

### iOS

**Main Entry Point** (Swift):
```swift
// ios/iosApp/ContentView.swift
import SwiftUI
import shared

@main
struct iOSApp: App {
    init() {
        // Initialize Koin from shared Kotlin code
        KoinKt.doInitKoin()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    var body: some View {
        ComposeView()
            .ignoresSafeArea(.all)
    }
}

struct ComposeView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController {
        MainViewControllerKt.MainViewController()
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}
}
```

**Compose Entry Point** (Kotlin):
```kotlin
// shared/iosMain/kotlin/MainViewController.kt
fun MainViewController(): UIViewController {
    return ComposeUIViewController {
        MaterialTheme {
            AppNavigation()
        }
    }
}
```

**iOS Keychain Integration**:
```kotlin
// shared/iosMain/kotlin/keystore/IOSKeystoreAdapter.kt
actual class KeystoreAdapter {
    actual suspend fun storeKey(alias: String, key: ByteArray) {
        val query = mapOf(
            kSecClass to kSecClassGenericPassword,
            kSecAttrAccount to alias,
            kSecValueData to key.toNSData(),
            kSecAttrAccessible to kSecAttrAccessibleWhenUnlocked
        )

        SecItemDelete(query as CFDictionary)
        val status = SecItemAdd(query as CFDictionary, null)

        if (status != errSecSuccess) {
            throw IOException("Failed to store key in Keychain: $status")
        }
    }

    actual suspend fun retrieveKey(alias: String): ByteArray? {
        val query = mapOf(
            kSecClass to kSecClassGenericPassword,
            kSecAttrAccount to alias,
            kSecReturnData to kCFBooleanTrue,
            kSecMatchLimit to kSecMatchLimitOne
        )

        val result = memScoped {
            val ref = alloc<CFTypeRefVar>()
            val status = SecItemCopyMatching(query as CFDictionary, ref.ptr)

            if (status == errSecSuccess) {
                (ref.value as NSData).toByteArray()
            } else {
                null
            }
        }

        return result
    }
}
```

---

### Web (Kotlin/JS)

**Main Entry Point**:
```kotlin
// web/src/jsMain/kotlin/Main.kt
fun main() {
    // Initialize Koin DI
    startKoin {
        modules(
            platformModule(),
            sharedModule()
        )
    }

    CanvasBasedWindow("Cashu Wallet") {
        MaterialTheme {
            AppNavigation()
        }
    }
}

// Platform module for Web
val platformModule = module {
    single<CryptoAdapter> { WebCryptoAdapter() }
    single<StorageAdapter> { IndexedDBStorageAdapter() }
    single<KeystoreAdapter> { WebCryptoKeystoreAdapter() }
    single { createDatabase() }
}
```

**Web Crypto API Integration**:
```kotlin
// shared/jsMain/kotlin/crypto/WebCryptoAdapter.kt
actual class CryptoAdapter {
    private val crypto = kotlinx.browser.window.crypto

    actual suspend fun generateRandomBytes(length: Int): ByteArray {
        val array = Uint8Array(length)
        crypto.getRandomValues(array)
        return array.unsafeCast<ByteArray>()
    }

    actual suspend fun sha256(data: ByteArray): ByteArray = suspendCoroutine { cont ->
        val promise = crypto.subtle.digest("SHA-256", data.toJsUint8Array())
        promise.then(
            onFulfilled = { result ->
                cont.resume(Uint8Array(result).unsafeCast<ByteArray>())
            },
            onRejected = { error ->
                cont.resumeWithException(CryptoException("SHA-256 failed: $error"))
            }
        )
    }

    actual suspend fun encryptAES256GCM(
        plaintext: ByteArray,
        key: ByteArray
    ): EncryptedData = suspendCoroutine { cont ->
        val iv = generateRandomBytes(12)

        val promise = crypto.subtle.importKey(
            "raw",
            key.toJsUint8Array(),
            js("({ name: 'AES-GCM' })"),
            false,
            js("['encrypt']")
        ).then { cryptoKey ->
            crypto.subtle.encrypt(
                js("({ name: 'AES-GCM', iv: iv.toJsUint8Array() })"),
                cryptoKey,
                plaintext.toJsUint8Array()
            )
        }

        promise.then(
            onFulfilled = { result ->
                val ciphertext = Uint8Array(result).unsafeCast<ByteArray>()
                cont.resume(EncryptedData(ciphertext, iv))
            },
            onRejected = { error ->
                cont.resumeWithException(CryptoException("Encryption failed: $error"))
            }
        )
    }
}
```

**IndexedDB Storage**:
```kotlin
// shared/jsMain/kotlin/storage/IndexedDBStorageAdapter.kt
actual class StorageAdapter {
    private val dbName = "cashu-wallet"
    private val dbVersion = 1

    actual suspend fun saveWalletState(state: WalletState) {
        val db = openDatabase()
        val transaction = db.transaction(arrayOf("walletState"), "readwrite")
        val store = transaction.objectStore("walletState")

        val json = Json.encodeToString(WalletState.serializer(), state)
        store.put(json, "current")

        transaction.oncomplete = { db.close() }
    }

    actual suspend fun loadWalletState(): WalletState? = suspendCoroutine { cont ->
        val db = openDatabase()
        val transaction = db.transaction(arrayOf("walletState"), "readonly")
        val store = transaction.objectStore("walletState")
        val request = store.get("current")

        request.onsuccess = {
            val json = request.result as? String
            val state = json?.let { Json.decodeFromString(WalletState.serializer(), it) }
            db.close()
            cont.resume(state)
        }

        request.onerror = {
            db.close()
            cont.resumeWithException(StorageException("Failed to load state"))
        }
    }

    private fun openDatabase(): IDBDatabase = /* IndexedDB open logic */
}
```

---

## Data Models

All data models are defined in `shared/commonMain` using Kotlin `data class` with `kotlinx.serialization`:

```kotlin
// shared/commonMain/kotlin/domain/identity/Identity.kt
@Serializable
data class Identity(
    val id: String,
    val label: String,
    val publicKey: String, // Hex-encoded secp256k1 public key
    @Contextual
    val createdAt: Instant,
    @Contextual
    val lastUsedAt: Instant
) {
    fun toNpub(): String {
        // Convert hex public key to npub (bech32)
        return Bech32.encode("npub", publicKey.hexToBytes())
    }

    fun isActive(): Boolean {
        val ninetyDaysAgo = Clock.System.now().minus(90.days)
        return lastUsedAt > ninetyDaysAgo
    }
}

@Serializable
data class PrivateKey(
    val bytes: ByteArray // Never serialized unencrypted
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is PrivateKey) return false
        return bytes.contentEquals(other.bytes)
    }

    override fun hashCode(): Int {
        return bytes.contentHashCode()
    }
}

// shared/commonMain/kotlin/domain/wallet/WalletState.kt
@Serializable
data class WalletState(
    val schema: WalletSchemaMetadata,
    @Contextual
    val exportedAt: Instant,
    val tokens: List<WalletToken>,
    val history: List<WalletHistoryEvent>,
    val quarantined: List<QuarantinedHistoryEvent>,
    val encryptedMnemonic: String? = null,
    val deterministicMode: Boolean = false,
    val derivationCounters: Map<String, Int> = emptyMap(),
    val vouchers: List<StoredVoucher> = emptyList(),
    val voucherBackupState: VoucherBackupState? = null
)

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
    val status: VoucherStatus
) {
    fun isExpired(): Boolean {
        val expiry = expiresAt ?: return false
        return Clock.System.now().epochSeconds > expiry
    }

    fun isActive(): Boolean {
        return status == VoucherStatus.ISSUED && !isExpired()
    }
}

@Serializable
enum class VoucherStatus {
    ISSUED,
    DELIVERED,
    REDEEMED,
    REVOKED,
    EXPIRED
}

// shared/commonMain/kotlin/domain/cashu/Proof.kt
@Serializable
data class Proof(
    val amount: Int,
    val secret: String,
    val C: String,
    val id: String // KeySet ID
)

@Serializable
data class MintInfo(
    val url: String,
    val name: String,
    val pubkey: String,
    val version: String,
    val description: String,
    val units: List<String>,
    val mintMethods: List<String>,
    val meltMethods: List<String>
)

@Serializable
data class KeySet(
    val id: String,
    val unit: String,
    val active: Boolean,
    val keys: Map<Int, String> // amount -> public key (hex)
)

@Serializable
data class MintQuote(
    val quoteId: String,
    val amount: Long,
    val unit: String,
    val request: String, // Lightning invoice
    @Contextual
    val expiresAt: Instant,
    val paid: Boolean
)
```

---

## Security Implementation

### Encryption at Rest

**Passphrase-Based Key Derivation**:
```kotlin
// shared/commonMain/kotlin/security/KeyDerivation.kt
interface KeyDerivationService {
    suspend fun deriveKey(
        passphrase: String,
        salt: ByteArray,
        iterations: Int = 100000,
        keyLength: Int = 32
    ): ByteArray
}

// jvmMain - Argon2 via Bouncy Castle
class JvmKeyDerivationService : KeyDerivationService {
    override suspend fun deriveKey(
        passphrase: String,
        salt: ByteArray,
        iterations: Int,
        keyLength: Int
    ): ByteArray = withContext(Dispatchers.IO) {
        val argon2 = Argon2BytesGenerator()
        val params = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withIterations(iterations)
            .withMemoryAsKB(65536) // 64 MB
            .withParallelism(1)
            .withSalt(salt)
            .build()

        argon2.init(params)
        val key = ByteArray(keyLength)
        argon2.generateBytes(passphrase.toByteArray(), key)
        key
    }
}

// jsMain - argon2-browser via JS interop
class WebKeyDerivationService : KeyDerivationService {
    override suspend fun deriveKey(
        passphrase: String,
        salt: ByteArray,
        iterations: Int,
        keyLength: Int
    ): ByteArray = suspendCoroutine { cont ->
        val argon2 = js("require('argon2-browser')")
        val promise = argon2.hash(js("""({
            pass: passphrase,
            salt: salt,
            type: argon2.ArgonType.Argon2id,
            mem: 65536,
            time: iterations,
            parallelism: 1,
            hashLen: keyLength
        })"""))

        promise.then(
            onFulfilled = { result -> cont.resume(result.hash.unsafeCast<ByteArray>()) },
            onRejected = { error -> cont.resumeWithException(CryptoException("Argon2 failed: $error")) }
        )
    }
}
```

**State Encryption**:
```kotlin
// shared/commonMain/kotlin/storage/EncryptedStorage.kt
class EncryptedStorageService(
    private val cryptoAdapter: CryptoAdapter,
    private val keyDerivation: KeyDerivationService
) {
    private var encryptionKey: ByteArray? = null
    private var salt: ByteArray? = null

    suspend fun unlock(passphrase: String): Boolean {
        salt = getSalt() ?: generateSalt()
        encryptionKey = keyDerivation.deriveKey(passphrase, salt!!)

        // Verify passphrase by attempting to decrypt existing state
        return try {
            loadWalletState()
            true
        } catch (e: Exception) {
            encryptionKey = null
            false
        }
    }

    fun lock() {
        encryptionKey = null
        // Clear from memory
    }

    suspend fun saveWalletState(state: WalletState) {
        val key = encryptionKey ?: throw SecurityException("Storage is locked")

        val json = Json.encodeToString(WalletState.serializer(), state)
        val encrypted = cryptoAdapter.encryptAES256GCM(json.encodeToByteArray(), key)

        storageAdapter.saveEncryptedData("wallet-state", encrypted)
    }

    suspend fun loadWalletState(): WalletState? {
        val key = encryptionKey ?: throw SecurityException("Storage is locked")

        val encrypted = storageAdapter.loadEncryptedData("wallet-state") ?: return null
        val decrypted = cryptoAdapter.decryptAES256GCM(encrypted, key)

        return Json.decodeFromString(WalletState.serializer(), decrypted.decodeToString())
    }

    private suspend fun getSalt(): ByteArray? {
        return storageAdapter.loadSalt()
    }

    private suspend fun generateSalt(): ByteArray {
        val salt = cryptoAdapter.generateRandomBytes(16)
        storageAdapter.saveSalt(salt)
        return salt
    }
}
```

### Session Management

**Auto-Lock After Inactivity**:
```kotlin
// shared/commonMain/kotlin/security/SessionManager.kt
class SessionManager(
    private val encryptedStorage: EncryptedStorageService,
    private val timeoutMillis: Long = 30 * 60 * 1000 // 30 minutes
) {
    private var lastActivityTime = 0L
    private var lockTimer: Job? = null

    fun recordActivity() {
        lastActivityTime = Clock.System.now().toEpochMilliseconds()
        resetLockTimer()
    }

    private fun resetLockTimer() {
        lockTimer?.cancel()
        lockTimer = CoroutineScope(Dispatchers.Default).launch {
            delay(timeoutMillis)
            lock()
        }
    }

    fun lock() {
        lockTimer?.cancel()
        encryptedStorage.lock()
        // Trigger UI update to show unlock screen
    }

    fun isLocked(): Boolean {
        return encryptedStorage.isLocked()
    }
}
```

---

## State Management

### ViewModels with StateFlow

All state is managed using Kotlin `StateFlow` and `Flow`:

```kotlin
// shared/commonMain/kotlin/viewmodels/WalletViewModel.kt
class WalletViewModel(
    private val refreshBalanceUseCase: RefreshBalanceUseCase,
    private val addMintUseCase: AddMintUseCase,
    private val listMintsUseCase: ListMintsUseCase
) : ViewModel() {

    private val _uiState = MutableStateFlow<WalletUiState>(WalletUiState.Loading)
    val uiState: StateFlow<WalletUiState> = _uiState.asStateFlow()

    private val _balances = MutableStateFlow<Map<String, Long>>(emptyMap())
    val balances: StateFlow<Map<String, Long>> = _balances.asStateFlow()

    init {
        loadWallet()
    }

    fun loadWallet() {
        viewModelScope.launch {
            _uiState.value = WalletUiState.Loading

            try {
                val mints = listMintsUseCase().getOrThrow()
                val balances = refreshBalanceUseCase().getOrThrow()

                _balances.value = balances.totalsByUnit
                _uiState.value = WalletUiState.Success(mints, balances)
            } catch (e: Exception) {
                _uiState.value = WalletUiState.Error(e.message ?: "Failed to load wallet")
            }
        }
    }

    fun addMint(url: String) {
        viewModelScope.launch {
            addMintUseCase(url)
                .onSuccess {
                    loadWallet()
                }
                .onFailure { error ->
                    _uiState.value = WalletUiState.Error(error.message ?: "Failed to add mint")
                }
        }
    }

    fun refreshBalance() {
        viewModelScope.launch {
            refreshBalanceUseCase()
                .onSuccess { balances ->
                    _balances.value = balances.totalsByUnit
                }
                .onFailure { /* Log error */ }
        }
    }
}

sealed interface WalletUiState {
    object Loading : WalletUiState
    data class Success(val mints: List<MintConfig>, val balance: Balance) : WalletUiState
    data class Error(val message: String) : WalletUiState
}
```

---

## Error Handling

### Result Pattern

All operations return `Result<T>` instead of throwing exceptions:

```kotlin
// shared/commonMain/kotlin/usecases/voucher/IssueVoucherUseCase.kt
class IssueVoucherUseCase(
    private val voucherRepository: VoucherRepository,
    private val walletRepository: WalletRepository,
    private val identityRepository: IdentityRepository
) {
    suspend operator fun invoke(request: IssueVoucherRequest): Result<IssueVoucherResult> = runCatching {
        // Validate request
        require(request.amount > 0) { "Amount must be positive" }
        require(request.unit.isNotBlank()) { "Unit must not be blank" }

        // Select proofs
        val proofs = walletRepository.selectProofs(request.amount, request.unit, request.mintUrl)
            .getOrThrow()

        // Create P2PK secret if recipient provided
        val secret = if (request.lockToPubkey != null) {
            createP2PKSecret(request.lockToPubkey)
        } else {
            generateRandomSecret()
        }

        // Swap proofs to create voucher tokens
        val voucherTokens = walletRepository.swapProofs(proofs, secret, request.mintUrl)
            .getOrThrow()

        // Create voucher payload
        val voucher = StoredVoucher(
            voucherId = UUID.randomUUID().toString(),
            issuerId = identityRepository.getActiveIdentity().id,
            unit = request.unit,
            faceValue = request.amount,
            expiresAt = request.expiresInDays?.let {
                Clock.System.now().plus(it.days).epochSeconds
            },
            memo = request.memo,
            issuerSignature = "", // Will be filled after signing
            issuerPublicKey = identityRepository.getActiveIdentity().publicKey,
            issuedAt = Clock.System.now(),
            status = VoucherStatus.ISSUED
        )

        // Sign voucher
        val signedVoucher = signVoucher(voucher)

        // Store voucher
        voucherRepository.saveVoucher(signedVoucher)

        // Create token string
        val token = encodeToken(voucherTokens)

        IssueVoucherResult(
            voucher = signedVoucher,
            token = token,
            backedUp = false,
            message = "Voucher issued successfully"
        )
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
```

### Exception Hierarchy

```kotlin
// shared/commonMain/kotlin/domain/exceptions/WalletOperationException.kt
sealed class WalletOperationException(
    val errorCode: String,
    val retryable: Boolean,
    override val message: String,
    val suggestion: String,
    cause: Throwable? = null
) : Exception(message, cause) {

    fun getFormattedMessage(): String {
        return "$message. Suggestion: $suggestion"
    }
}

class ProofImportException(
    message: String,
    suggestion: String = "Verify the token format is correct (bech32-encoded Cashu token)",
    cause: Throwable? = null
) : WalletOperationException("PROOF_IMPORT_FAILED", false, message, suggestion, cause)

class QuoteExpiredException(
    quoteId: String,
    expiredAt: Instant
) : WalletOperationException(
    "QUOTE_EXPIRED",
    false,
    "Quote $quoteId expired at $expiredAt",
    "Request a new quote and complete the payment within the validity period",
    null
)

class VoucherRedemptionException(
    message: String,
    suggestion: String,
    retryable: Boolean = false,
    cause: Throwable? = null
) : WalletOperationException("VOUCHER_REDEMPTION_FAILED", retryable, message, suggestion, cause) {

    companion object {
        fun alreadyRedeemed(voucherId: String) = VoucherRedemptionException(
            "Voucher $voucherId has already been redeemed",
            "Contact the voucher issuer to request a new voucher"
        )

        fun expired(voucherId: String, expiredAt: Instant) = VoucherRedemptionException(
            "Voucher $voucherId expired at $expiredAt",
            "Contact the voucher issuer to request a new voucher or extension"
        )

        fun signatureInvalid(voucherId: String) = VoucherRedemptionException(
            "Voucher $voucherId has an invalid signature",
            "This voucher may be counterfeit or corrupted. Do not redeem it"
        )
    }
}
```

---

## Testing Strategy

### Common Tests (All Platforms)

```kotlin
// shared/commonTest/kotlin/domain/identity/IdentityTest.kt
class IdentityTest {
    @Test
    fun `isActive returns true when last used within 90 days`() {
        val now = Clock.System.now()
        val identity = Identity(
            id = "test-id",
            label = "Test Identity",
            publicKey = "0".repeat(64),
            createdAt = now.minus(100.days),
            lastUsedAt = now.minus(30.days)
        )

        assertTrue(identity.isActive())
    }

    @Test
    fun `isActive returns false when last used over 90 days ago`() {
        val now = Clock.System.now()
        val identity = Identity(
            id = "test-id",
            label = "Test Identity",
            publicKey = "0".repeat(64),
            createdAt = now.minus(200.days),
            lastUsedAt = now.minus(100.days)
        )

        assertFalse(identity.isActive())
    }
}

// shared/commonTest/kotlin/usecases/CreateIdentityUseCaseTest.kt
class CreateIdentityUseCaseTest {
    private lateinit var useCase: CreateIdentityUseCase
    private lateinit var mockRepository: IdentityRepository

    @BeforeTest
    fun setup() {
        mockRepository = mockk()
        useCase = CreateIdentityUseCase(mockRepository)
    }

    @Test
    fun `invoke creates identity with label`() = runTest {
        // Arrange
        val label = "My Identity"
        val expectedIdentity = Identity(
            id = "test-id",
            label = label,
            publicKey = "0".repeat(64),
            createdAt = Clock.System.now(),
            lastUsedAt = Clock.System.now()
        )

        coEvery { mockRepository.createIdentity(label) } returns expectedIdentity

        // Act
        val result = useCase(label)

        // Assert
        assertTrue(result.isSuccess)
        assertEquals(expectedIdentity, result.getOrNull())
        coVerify(exactly = 1) { mockRepository.createIdentity(label) }
    }
}
```

### Platform-Specific Tests

```kotlin
// shared/jvmTest/kotlin/crypto/JvmCryptoAdapterTest.kt
class JvmCryptoAdapterTest {
    private val cryptoAdapter = JvmCryptoAdapter()

    @Test
    fun `generateRandomBytes generates different values`() = runTest {
        val bytes1 = cryptoAdapter.generateRandomBytes(32)
        val bytes2 = cryptoAdapter.generateRandomBytes(32)

        assertEquals(32, bytes1.size)
        assertEquals(32, bytes2.size)
        assertFalse(bytes1.contentEquals(bytes2))
    }

    @Test
    fun `encryptAES256GCM and decryptAES256GCM roundtrip`() = runTest {
        val key = cryptoAdapter.generateRandomBytes(32)
        val plaintext = "Hello, Cashu!".encodeToByteArray()

        val encrypted = cryptoAdapter.encryptAES256GCM(plaintext, key)
        val decrypted = cryptoAdapter.decryptAES256GCM(encrypted, key)

        assertContentEquals(plaintext, decrypted)
    }
}
```

### UI Tests (Compose)

```kotlin
// composeApp/commonTest/kotlin/ui/identity/IdentityListScreenTest.kt
@OptIn(ExperimentalTestApi::class)
class IdentityListScreenTest {
    @Test
    fun `displays loading indicator when state is loading`() = runComposeUiTest {
        setContent {
            val viewModel = mockk<IdentityViewModel> {
                every { uiState } returns MutableStateFlow(IdentityUiState.Loading)
            }

            IdentityListScreen(
                viewModel = viewModel,
                onIdentityClick = {},
                onCreateClick = {}
            )
        }

        onNodeWithTag("loading-indicator").assertIsDisplayed()
    }

    @Test
    fun `displays identity list when state is success`() = runComposeUiTest {
        val identities = listOf(
            Identity("id1", "Label 1", "0".repeat(64), Clock.System.now(), Clock.System.now()),
            Identity("id2", "Label 2", "1".repeat(64), Clock.System.now(), Clock.System.now())
        )

        setContent {
            val viewModel = mockk<IdentityViewModel> {
                every { uiState } returns MutableStateFlow(IdentityUiState.Success(identities))
            }

            IdentityListScreen(
                viewModel = viewModel,
                onIdentityClick = {},
                onCreateClick = {}
            )
        }

        onNodeWithText("Label 1").assertIsDisplayed()
        onNodeWithText("Label 2").assertIsDisplayed()
    }
}
```

---

## Deployment

### Desktop (JVM)

**Build**:
```bash
./gradlew :desktop:packageDistributionForCurrentOS
```

**Output**: Platform-specific installers (.dmg for macOS, .exe for Windows, .deb/.rpm for Linux)

---

### Android

**Build**:
```bash
./gradlew :android:assembleRelease
```

**Output**: `android/build/outputs/apk/release/android-release.apk`

**Publishing**: Google Play Store

---

### iOS

**Build** (requires macOS with Xcode):
```bash
./gradlew :shared:linkReleaseFrameworkIosArm64
```

Then open `ios/iosApp.xcodeproj` in Xcode and build.

**Publishing**: Apple App Store

---

### Web (Kotlin/JS)

**Build**:
```bash
./gradlew :web:jsBrowserProductionWebpack
```

**Output**: `web/build/dist/js/productionExecutable/`

**Deployment**: Deploy to static hosting (Vercel, Netlify, Cloudflare Pages)

---

## Comparison: Kotlin vs. TypeScript Web Client

| Aspect | Kotlin Multiplatform | TypeScript Web |
|--------|---------------------|----------------|
| **Code Reuse from Existing Codebase** | 60-80% (direct conversion) | 0% (new codebase) |
| **Platforms Supported** | Desktop, Android, iOS, Web | Web only |
| **UI Framework** | Compose Multiplatform (native) | React + Radix UI |
| **State Management** | Kotlin Flows + StateFlow (type-safe) | Zustand + Immer |
| **HTTP Client** | Ktor Client (multiplatform) | Axios + TanStack Query |
| **Database** | SQLDelight (type-safe SQL) | IndexedDB or SQLite.js |
| **Cryptography** | Tink or Bouncy Castle Kotlin | Web Crypto API + @noble/* |
| **Testing** | Kotlin Test (multiplatform) | Vitest + Playwright |
| **Bundle Size** | N/A (native apps) | ~500KB gzipped (web only) |
| **Performance** | Native performance | Browser VM performance |
| **Offline Support** | Native file system, SQLite | localStorage, IndexedDB |
| **Security** | Platform native keystores | Web Crypto API only |
| **Development Team** | Java/Kotlin developers | JavaScript/TypeScript team |
| **Development Time** | **Faster** (reuse existing logic) | Slower (rewrite from scratch) |
| **Maintenance** | Single codebase for all platforms | Separate web codebase |
| **Distribution** | App stores (Desktop, Mobile) + Web | Web only (URL) |

### Recommendation

**Choose Kotlin Multiplatform if**:
- You want native apps for Desktop, Android, and iOS (not just web)
- Your team is already proficient in Java/Kotlin
- You want to maximize reuse of the existing 40,000+ line Java codebase
- You need platform-native performance and security (keystores)
- You want a single codebase maintained by one team

**Choose TypeScript Web Client if**:
- You only need a web application (no mobile/desktop)
- Your team has strong JavaScript/TypeScript expertise
- You prefer the JavaScript ecosystem (npm packages)
- You want faster initial prototyping for web-only features
- You're willing to maintain a separate codebase

### Hybrid Approach (Recommended)

Build the **Kotlin Multiplatform client** first (to maximize reuse), then:
1. **Target Web via Kotlin/JS** (Compose for Web)
2. If Kotlin/JS web performance is insufficient, use the TypeScript web client as a **supplemental** web-only version
3. Share API contracts and data models between both

This gives you:
- Native apps (Desktop, Android, iOS) from Kotlin codebase
- High-performance web app (Kotlin/JS)
- Optional TypeScript web app for better web-specific UX

---

## Appendix

### A. Gradle Configuration Example

```kotlin
// build.gradle.kts (root)
plugins {
    kotlin("multiplatform") version "1.9.21" apply false
    kotlin("plugin.serialization") version "1.9.21" apply false
    id("org.jetbrains.compose") version "1.6.0" apply false
    id("com.android.application") version "8.2.0" apply false
}

// shared/build.gradle.kts
plugins {
    kotlin("multiplatform")
    kotlin("plugin.serialization")
    id("com.android.library")
    id("app.cash.sqldelight") version "2.0.1"
}

kotlin {
    jvm()
    androidTarget()
    iosX64()
    iosArm64()
    iosSimulatorArm64()
    js(IR) {
        browser()
    }

    sourceSets {
        commonMain.dependencies {
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")
            implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.2")
            implementation("io.ktor:ktor-client-core:2.3.7")
            implementation("io.ktor:ktor-client-content-negotiation:2.3.7")
            implementation("io.ktor:ktor-serialization-kotlinx-json:2.3.7")
            implementation("app.cash.sqldelight:runtime:2.0.1")
            implementation("io.insert-koin:koin-core:3.5.3")
        }

        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation("io.mockk:mockk:1.13.9")
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.7.3")
        }

        jvmMain.dependencies {
            implementation("io.ktor:ktor-client-okhttp:2.3.7")
            implementation("app.cash.sqldelight:sqlite-driver:2.0.1")
            implementation("org.bouncycastle:bcprov-jdk18on:1.77")
        }

        androidMain.dependencies {
            implementation("io.ktor:ktor-client-okhttp:2.3.7")
            implementation("app.cash.sqldelight:android-driver:2.0.1")
            implementation("androidx.security:security-crypto:1.1.0-alpha06")
        }

        iosMain.dependencies {
            implementation("io.ktor:ktor-client-darwin:2.3.7")
            implementation("app.cash.sqldelight:native-driver:2.0.1")
        }

        jsMain.dependencies {
            implementation("io.ktor:ktor-client-js:2.3.7")
        }
    }
}

sqldelight {
    databases {
        create("Database") {
            packageName.set("xyz.tcheeric.cashu.db")
        }
    }
}
```

### B. Migration Checklist

- [ ] Phase 1: Convert domain models (Identity, WalletState, StoredVoucher, Proof)
- [ ] Phase 2: Convert use cases (CreateIdentityUseCase, IssueVoucherUseCase, etc.)
- [ ] Phase 3: Implement expect/actual for crypto, storage, keystore
- [ ] Phase 4: Implement Ktor HTTP client (replace Spring RestTemplate)
- [ ] Phase 5: Implement SQLDelight schema (migrate from H2)
- [ ] Phase 6: Build Compose UI screens (Identity, Wallet, Voucher)
- [ ] Phase 7: Platform-specific builds (Desktop, Android, iOS, Web)
- [ ] Phase 8: Testing (unit, integration, UI tests)
- [ ] Phase 9: Security audit (keystore, encryption, signatures)
- [ ] Phase 10: Deployment to app stores and web hosting

---

## Change Log

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2025-11-17 | Claude Code | Initial Kotlin Multiplatform specification |

