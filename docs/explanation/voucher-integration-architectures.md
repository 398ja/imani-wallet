# Voucher Integration Architecture Options

> **Document Type**: Explanation (Diátaxis)
> **Purpose**: Compare different approaches to integrate cashu-client voucher functionality
> **Audience**: Architects making decisions about system design

## Table of Contents

1. [Overview](#overview)
2. [Option A: Adapter Pattern (Proposed)](#option-a-adapter-pattern-proposed)
3. [Option B: Ktor Backend-for-Frontend (BFF)](#option-b-ktor-backend-for-frontend-bff)
4. [Option C: Port cashu-client to KMP](#option-c-port-cashu-client-to-kmp)
5. [Comparison Matrix](#comparison-matrix)
6. [Recommendation](#recommendation)

---

## Overview

### The Challenge

**cashu-client** (Java/JVM):
- ❌ Not KMP-compatible (uses OkHttp, nostr-java, BouncyCastle)
- ✅ Production-ready voucher implementation (1318 lines)
- ✅ Full Cashu protocol support (NUT-03, NUT-11, etc.)
- ✅ Nostr backup/restore (NIP-17 + NIP-44)

**imani-wallet** (Kotlin Multiplatform):
- ✅ KMP-compatible (works on Web, Android, iOS)
- ❌ Partial voucher implementation (~30% code duplication)
- ✅ Uses Ktor Client (KMP HTTP client)
- ✅ Platform-specific crypto adapters

### Goal

**Reuse cashu-client voucher logic across web and Android platforms.**

---

## Option A: Adapter Pattern (Proposed)

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                 imani-voucher (KMP Module)                       │
├─────────────────────────────────────────────────────────────────┤
│  commonMain/                                                     │
│    └── VoucherAdapter.kt (interface)                            │
│                                                                  │
│  jvmMain/ (Android)              jsMain/ (Web)                  │
│    └── JvmVoucherAdapter         └── WebVoucherAdapter          │
│        └─→ Wraps                     └─→ Reuses existing        │
│           cashu-client                  KMP use cases           │
│           VoucherService                                         │
└─────────────────────────────────────────────────────────────────┘
```

### Implementation

**Interface (commonMain)**:
```kotlin
interface VoucherAdapter {
    suspend fun issueVoucher(request: IssueVoucherRequest): Result<IssueVoucherResult>
    suspend fun redeemVoucher(token: String): Result<RedeemVoucherResult>
    suspend fun listVouchers(): Result<List<StoredVoucher>>
    // ... other methods
}
```

**Android (jvmMain)**:
```kotlin
class JvmVoucherAdapter(
    private val voucherService: VoucherService // cashu-client
) : VoucherAdapter {
    override suspend fun issueVoucher(request: IssueVoucherRequest) =
        withContext(Dispatchers.IO) {
            runCatching {
                // Delegate to cashu-client (100% code reuse)
                val javaResult = voucherService.issueAndBackup(request.toJava())
                javaResult.toKotlin()
            }
        }
}
```

**Web (jsMain)**:
```kotlin
class WebVoucherAdapter(
    private val issueVoucherUseCase: IssueVoucherUseCase
) : VoucherAdapter {
    override suspend fun issueVoucher(request: IssueVoucherRequest) =
        issueVoucherUseCase(request) // Reuse existing KMP code
}
```

### Pros

✅ **Zero deployment complexity** - No backend service required
✅ **Self-sovereign** - All keys stay on device
✅ **Offline-first** - Works without internet (local voucher operations)
✅ **Platform optimizations** - Android gets full cashu-client, web stays lightweight
✅ **Fast** - No network latency for local operations
✅ **Privacy** - No server sees user data
✅ **Quick to implement** - ~2 weeks (11 days)

### Cons

❌ **Code duplication** - Web implementation reimplements some logic (~30%)
❌ **Platform inconsistencies** - Android and web may behave differently
❌ **Testing complexity** - Need platform-specific tests

### Data Flow (Issue Voucher)

**Android**:
```
User → ViewModel → IssueVoucherUseCase → JvmVoucherAdapter
  → cashu-client VoucherService → Mint API → Nostr Backup
```

**Web**:
```
User → ViewModel → IssueVoucherUseCase → WebVoucherAdapter
  → IssueVoucherUseCase (existing) → Mint API → Nostr Backup
```

---

## Option B: Ktor Backend-for-Frontend (BFF)

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│            imani-backend (Ktor Server - JVM)                 │
├──────────────────────────────────────────────────────────────┤
│  ├── Uses cashu-client VoucherService (100% reuse)          │
│  ├── Exposes REST API:                                       │
│  │   POST /api/voucher/issue                                │
│  │   POST /api/voucher/redeem                               │
│  │   GET  /api/voucher/list                                 │
│  │   POST /api/voucher/verify                               │
│  └── Handles:                                                │
│      - Proof selection (SendService)                         │
│      - Token encoding (TokenCodec)                           │
│      - Nostr backup (VoucherBackupService)                   │
└──────────────────────────────────────────────────────────────┘
           ↑                                    ↑
           │ HTTP (Ktor Client)                 │ HTTP (Ktor Client)
           │                                    │
    ┌─────────────────┐              ┌─────────────────┐
    │  Android        │              │  Web (JS)       │
    │  ┌───────────┐  │              │  ┌───────────┐  │
    │  │ Ktor      │  │              │  │ Ktor      │  │
    │  │ Client    │  │              │  │ Client    │  │
    │  └───────────┘  │              │  └───────────┘  │
    └─────────────────┘              └─────────────────┘
```

### Implementation

**Backend (Ktor Server)**:
```kotlin
// imani-backend/src/main/kotlin/cash/imani/backend/Application.kt
fun Application.module() {
    install(ContentNegotiation) {
        json()
    }

    val voucherService = get<VoucherService>() // cashu-client

    routing {
        route("/api/voucher") {
            post("/issue") {
                val request = call.receive<IssueVoucherRequest>()

                // Delegate to cashu-client (100% code reuse!)
                val result = voucherService.issueAndBackup(request.toJava())

                call.respond(HttpStatusCode.OK, result.toJson())
            }

            post("/redeem") {
                val token = call.receive<RedeemRequest>().token
                // TODO: Implement redeem via cashu-client
                call.respond(HttpStatusCode.OK, result)
            }

            get("/list") {
                val vouchers = voucherService.listVouchers()
                call.respond(HttpStatusCode.OK, vouchers)
            }
        }
    }
}
```

**Client (KMP - Both Android & Web)**:
```kotlin
// imani-voucher/src/commonMain/kotlin/cash/imani/voucher/client/VoucherApiClient.kt
class VoucherApiClient(
    private val httpClient: HttpClient,
    private val baseUrl: String = "http://localhost:8080"
) {
    suspend fun issueVoucher(request: IssueVoucherRequest): Result<IssueVoucherResult> =
        runCatching {
            httpClient.post("$baseUrl/api/voucher/issue") {
                contentType(ContentType.Application.Json)
                setBody(request)
            }.body()
        }

    suspend fun redeemVoucher(token: String): Result<RedeemVoucherResult> =
        runCatching {
            httpClient.post("$baseUrl/api/voucher/redeem") {
                contentType(ContentType.Application.Json)
                setBody(mapOf("token" to token))
            }.body()
        }

    suspend fun listVouchers(): Result<List<StoredVoucher>> =
        runCatching {
            httpClient.get("$baseUrl/api/voucher/list").body()
        }
}
```

**Use Case (Same for Android & Web)**:
```kotlin
// imani-voucher/src/commonMain/kotlin/cash/imani/voucher/usecases/IssueVoucherUseCase.kt
class IssueVoucherUseCase(
    private val apiClient: VoucherApiClient // KMP HTTP client
) {
    suspend operator fun invoke(request: IssueVoucherRequest): Result<IssueVoucherResult> {
        return apiClient.issueVoucher(request)
    }
}
```

### Pros

✅ **100% code reuse** - cashu-client runs in one place
✅ **True KMP** - Same Ktor Client code for Android and Web
✅ **Consistency** - Identical behavior across platforms
✅ **Centralized** - Single source of truth for vouchers
✅ **Easy testing** - Test backend once, clients are thin
✅ **Scalability** - Can add caching, rate limiting, monitoring
✅ **Quick client implementation** - Ktor Client is simple

### Cons

❌ **Deployment complexity** - Need to run/host backend service
❌ **Not self-sovereign** - Backend sees all voucher operations
❌ **Network dependency** - Requires internet connection
❌ **Latency** - HTTP round-trip for every operation
❌ **Security risk** - Backend needs access to user keys (!)
❌ **Single point of failure** - Backend down = app broken
❌ **Hosting cost** - Need server infrastructure

### Critical Security Issue: Key Management

**Problem**: Where do private keys live?

**Option B.1: Backend Holds Keys** ❌
```
User → Backend API → Backend uses stored private key → Sign voucher
```
- ❌ NOT self-sovereign (backend can steal funds)
- ❌ Security nightmare (single breach = all users compromised)
- ❌ Violates Imani Wallet principles

**Option B.2: Client Sends Keys to Backend** ❌
```
User → Android/Web → Send private key in HTTP request → Backend signs → Return
```
- ❌ Even worse (keys exposed in transit)
- ❌ TLS not enough (backend still sees keys)

**Option B.3: Client Signs, Backend Validates** ⚠️
```
User → Android/Web (sign voucher) → Send signed voucher to backend → Backend publishes to Nostr
```
- ✅ Keys stay on device
- ⚠️ But then why have backend? (Just use Nostr directly)
- ⚠️ Backend becomes unnecessary middleman

### Data Flow (Issue Voucher)

**Both Android & Web**:
```
User → ViewModel → IssueVoucherUseCase → VoucherApiClient (Ktor)
  → HTTP POST → Backend (cashu-client) → Mint API → Nostr Backup
  ← HTTP 200 ← Response with voucher + token
```

### Deployment

**Local Development**:
```bash
# Terminal 1: Run backend
./gradlew :imani-backend:run

# Terminal 2: Run Android
./gradlew :imani-android:installDebug

# Terminal 3: Run web
./gradlew :imani-web:jsBrowserDevelopmentRun
```

**Production**:
```
Docker:
  - imani-backend:latest (Ktor server)
  - PostgreSQL (wallet state storage)
  - Nginx (reverse proxy)

Deploy to:
  - Fly.io ($5/month)
  - Railway ($5/month)
  - Self-hosted VPS
```

---

## Option C: Port cashu-client to KMP

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│              cashu-client-kmp (Fork & Port)                  │
├──────────────────────────────────────────────────────────────┤
│  commonMain/                                                 │
│    └── VoucherService (ported to pure Kotlin)               │
│                                                               │
│  jvmMain/                                                    │
│    ├── OkHttp → Ktor Client                                 │
│    ├── nostr-java → NostrGatewayService (keep Java)         │
│    └── BouncyCastle → CryptoAdapter                         │
│                                                               │
│  jsMain/                                                     │
│    ├── Ktor Client (JS engine)                              │
│    ├── nostr-tools (JS library)                             │
│    └── Web Crypto API                                        │
└──────────────────────────────────────────────────────────────┘
```

### Required Changes

**Replace JVM-only dependencies**:

1. **HTTP Client**: OkHttp → Ktor Client
   ```kotlin
   // Before (JVM-only)
   val client = OkHttpClient.Builder().build()
   val response = client.newCall(request).execute()

   // After (KMP)
   val client = HttpClient()
   val response = client.get(url)
   ```

2. **Nostr**: nostr-java → Platform-specific
   ```kotlin
   // commonMain
   expect class NostrClient {
       suspend fun publish(event: NostrEvent)
   }

   // jvmMain
   actual class NostrClient {
       private val gateway: NostrGatewayService // Keep Java
   }

   // jsMain
   actual class NostrClient {
       private val pool: SimplePool // nostr-tools
   }
   ```

3. **Crypto**: BouncyCastle → CryptoAdapter
   ```kotlin
   // Already done in Phase 1!
   interface CryptoAdapter {
       suspend fun schnorrSign(privateKey: ByteArray, message: ByteArray): ByteArray
   }
   ```

4. **Time**: java.time.Instant → kotlinx.datetime.Instant
   ```kotlin
   // Before
   val now = java.time.Instant.now()

   // After
   val now = kotlinx.datetime.Clock.System.now()
   ```

5. **JSON**: Jackson → kotlinx.serialization
   ```kotlin
   // Before
   @JsonProperty("voucher_id")
   private String voucherId;

   // After
   @SerialName("voucher_id")
   val voucherId: String
   ```

### Pros

✅ **True KMP** - One codebase for all platforms
✅ **100% code reuse** - Same logic everywhere
✅ **Self-sovereign** - No backend needed
✅ **Offline-first** - Works without internet

### Cons

❌ **MASSIVE effort** - 3-6 months of work
❌ **Maintenance burden** - Need to keep fork in sync with upstream
❌ **Breaking changes** - cashu-client API changes require porting
❌ **Testing overhead** - Re-test on every platform
❌ **Risk** - May introduce bugs during porting

### Effort Estimate

| Task | Lines of Code | Effort |
|------|---------------|--------|
| Port VoucherService | ~1500 | 2 weeks |
| Port SendService | ~800 | 1 week |
| Port NostrGatewayService | ~1200 | 2 weeks |
| Port TokenCodec | ~400 | 3 days |
| Port domain models | ~500 | 3 days |
| Platform-specific impls | ~1000 | 2 weeks |
| Testing | - | 3 weeks |
| **TOTAL** | **~5400 lines** | **~3 months** |

---

## Comparison Matrix

| Criteria | Adapter Pattern | Ktor BFF | Port to KMP |
|----------|----------------|----------|-------------|
| **Code Reuse (Android)** | ≥95% | 100% | 100% |
| **Code Reuse (Web)** | ~70% | 100% | 100% |
| **KMP Compliance** | ⚠️ Partial | ✅ Full | ✅ Full |
| **Self-Sovereign** | ✅ Yes | ❌ No | ✅ Yes |
| **Offline Support** | ✅ Full | ❌ None | ✅ Full |
| **Implementation Effort** | 🟢 2 weeks | 🟡 3 weeks | 🔴 3 months |
| **Deployment Complexity** | 🟢 None | 🔴 High | 🟢 None |
| **Security** | 🟢 Keys on device | 🔴 Keys on server | 🟢 Keys on device |
| **Maintenance** | 🟢 Low | 🟡 Medium | 🔴 High (fork) |
| **Testing Complexity** | 🟡 Platform-specific | 🟢 Backend once | 🔴 All platforms |
| **Network Dependency** | 🟢 Mint only | 🔴 Backend + Mint | 🟢 Mint only |
| **Latency** | 🟢 Local | 🔴 HTTP round-trip | 🟢 Local |
| **Consistency** | ⚠️ May differ | ✅ Identical | ✅ Identical |

---

## Recommendation

### Best Choice: **Option A - Adapter Pattern**

**Reasoning**:

1. **Aligns with Imani Principles**:
   - ✅ Self-sovereign (keys stay on device)
   - ✅ Privacy-first (no server sees data)
   - ✅ Offline-capable

2. **Proven Pattern**:
   - ✅ Already used successfully for CryptoAdapter (Phase 1)
   - ✅ 77% complete on identity integration
   - ✅ Team familiar with approach

3. **Pragmatic**:
   - ✅ Quick to implement (~2 weeks)
   - ✅ No deployment complexity
   - ✅ Low maintenance burden

4. **Good Enough**:
   - ✅ Android gets 95% code reuse (primary target)
   - ⚠️ Web has 30% duplication (acceptable for now)
   - ✅ Can always port to KMP later (Option C)

### When to Consider Option B (BFF)

**Use BFF if**:
- [ ] Building a multi-tenant SaaS (many users, one backend)
- [ ] Need centralized compliance/auditing
- [ ] Users okay with custodial solution
- [ ] Have DevOps team for deployment

**Don't use BFF if**:
- [x] Building self-custody wallet ← **Imani Wallet**
- [x] Privacy is critical
- [x] Offline support required

### When to Consider Option C (Port to KMP)

**Port to KMP if**:
- [ ] Long-term (2+ years) project
- [ ] Large team (5+ developers)
- [ ] cashu-client maintainers willing to collaborate
- [ ] Budget for 3+ months porting effort

**Don't port if**:
- [x] Need quick delivery (Phase 2 deadline) ← **Current**
- [x] Small team
- [x] cashu-client actively changing

---

## Hybrid Approach: Adapter + Optional BFF

**Phase 1-2**: Use Adapter Pattern
- Implement JvmVoucherAdapter (wrap cashu-client)
- Implement WebVoucherAdapter (reuse existing)

**Phase 3+**: Add Optional BFF
- Users can choose:
  - **Self-custody mode**: Use Adapter (default)
  - **Convenience mode**: Use BFF (opt-in)

**Implementation**:
```kotlin
interface VoucherAdapter {
    // Same interface
}

class LocalVoucherAdapter : VoucherAdapter {
    // Existing implementation
}

class RemoteVoucherAdapter(
    private val apiClient: VoucherApiClient // Ktor
) : VoucherAdapter {
    override suspend fun issueVoucher(request: IssueVoucherRequest) =
        apiClient.issueVoucher(request)
}

// In DI
single<VoucherAdapter> {
    if (userPreferences.useRemoteBackend) {
        RemoteVoucherAdapter(get())
    } else {
        LocalVoucherAdapter(get())
    }
}
```

**Benefits**:
- ✅ Users choose self-custody or convenience
- ✅ Can add BFF later without code changes
- ✅ Flexibility for different use cases

---

## Summary

| Approach | Best For | Effort | Security | KMP |
|----------|----------|--------|----------|-----|
| **Adapter** | Self-custody wallets, quick delivery | 2 weeks | ✅ Excellent | ⚠️ Partial |
| **BFF** | SaaS products, consistency > privacy | 3 weeks | ❌ Poor | ✅ Full |
| **Port KMP** | Long-term projects, large teams | 3 months | ✅ Excellent | ✅ Full |

**For Imani Wallet**: Use **Adapter Pattern** now, consider **Port to KMP** in 2026 if project succeeds.
