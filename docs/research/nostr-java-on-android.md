# Can `nostr-java` run on Android?

Research note, 2026-08-21. Read-only investigation of `~/IdeaProjects/nostr-java` (v2.0.7)
and `~/IdeaProjects/nsecbunker-java` (v0.2.0), for the purpose of building an Android-native
Nostr signer (NIP-55 intent/ContentProvider, NIP-46 optional).

> **Why this file lives here.** `imani-wallet/docs/` currently holds only `HANDOFF.md` and
> `superpowers/`, so there is no established convention for research notes. `docs/research/`
> is a sensible home; adopt or move it as you like.

---

## Verdict

**No, not as shipped — but the distance is short and you own the repo.**
`nostr-java-core` + `-event` + `-identity` are ~5,300 LOC with a clean dependency set and
**six** concrete Android incompatibilities, every one of which is a small, local fix that is
simultaneously a bug fix or a no-op on the JVM. `nostr-java-client` is unusable on Android and
always will be: it is 1,008 LOC of Spring Boot WebSocket that transitively drags in embedded
Tomcat. A signer does not need it.

The Java 21 bytecode target — the thing that looks like the first hard blocker — **is not one**.
R8 has accepted class file major 65 since AGP 8.2 (§1). Do not spend time on it.

Two of the six are silent-corruption risks rather than crashes, and those are the ones that
matter: `jackson-module-blackbird` (calls `LambdaMetafactory`, which does not exist on Android)
and `java.beans.Transient` (does not exist on Android, so Jackson stops excluding six derived
getters and emits malformed events). Budget **~2.5 days** to a working signer on the core three
modules, **~5 days** including a replacement relay client, and **~5-7 more** to production-safe.

---

## Blocker table

| # | Blocker | Module | Verdict | Fix | Days |
|---|---|---|---|---|---|
| 1 | `<java.version>21</java.version>` → class file major 65 | all | **NON-ISSUE** on AGP ≥ 8.2 | R8 accepts major 65 from R8 8.2 / AGP 8.2; current AGP 9.3 accepts up to 71. Nothing to do. Requires `compileSdk` ≥ 34 because the code uses records — see §1. | 0 |
| 2 | `jackson-module-blackbird` calls `LambdaMetafactory`, absent on Android | core, event | **BLOCKER** | Delete 5 `.addModule(new BlackbirdModule())` calls in 4 files + the dependency. Pure perf optimisation; plain databind is the fallback. | 0.5 |
| 3 | `java.beans.Transient` absent on Android → Jackson emits 6 extra properties, one of which mutates the event | event | **BLOCKER** | Swap `java.beans.Transient` → `com.fasterxml.jackson.annotation.JsonIgnore`. One file, 7 lines. | 0.25 |
| 4 | `java.util.HexFormat` is API **34+**; used on the critical path | core | **BLOCKER** (if minSdk < 34) | Replace the two `HexFormat` uses in `NostrUtil` with a hand-rolled hex codec. | 0.25 |
| 5 | `java.net.http.HttpClient` does not exist on Android at any API level | core | **WORKAROUND** | Only `Nip05Validator` uses it. Excise the class from the Android build, or `-dontwarn java.net.http.**` and never call it. | 0.5 |
| 6 | `Thread.ofVirtual()` — no virtual threads on Android (API 36 `isVirtual()` always returns false) | core, client | **WORKAROUND** | Same file as #5 in core (`Nip05Validator`, static initialiser). In client — module is dropped anyway. | (in #5) |
| 7 | NIP-44 `Cipher.getInstance("ChaCha20")` + `IvParameterSpec` only works if BC is JCA-registered; on Android `Security.addProvider` is a **no-op** because the platform already owns the name `"BC"` | core | **BLOCKER** | Use BouncyCastle's *lightweight* `ChaCha7539Engine` directly (already on the classpath, already used for HKDF). Verified byte-identical. Also fixes a latent JVM bug and removes the API-28 floor. | 0.5 |
| 8 | `KeyPairGenerator.getInstance("ECDSA", "BC")` resolves to the platform's *stripped* BC; `"ECDSA"` is not a documented Android algorithm name | core | **BLOCKER** | A secp256k1 private key is 32 random bytes in `[1, n-1]`. Use `SecureRandom` + range check; delete the provider round-trip entirely. | 0.25 |
| 9 | Spring Boot WebSocket + embedded Tomcat | client | **BLOCKER** (module is unusable) | Exclude `nostr-java-client`. Write relay I/O with OkHttp — needed only for the optional NIP-46 mode. | 2-3 |
| 10 | Bundled `bcprov-jdk18on` vs platform BouncyCastle | core | **NON-ISSUE** | Platform BC is repackaged to `com.android.org.bouncycastle`; no class collision. SpongyCastle is obsolete. See §3. | 0 |
| 11 | Lombok | all | **NON-ISSUE** | `provided` scope, compile-time only. Confirmed at `nostr-java-core/pom.xml:52-55`. | 0 |
| 12 | 64K dex method limit | all | **NON-ISSUE** | bcprov is large but R8 shrinking handles it; multidex exists. Not worth measuring yet. | 0 |
| 13 | NIP-49, BIP-32, BIP-39 **entirely absent** | — | **BLOCKER** *if you need them* | Zero hits repo-wide. Must be written. `scrypt` is absent from Android's JCA but bundled BC has `org.bouncycastle.crypto.generators.SCrypt`. | 2 |
| 14 | NIP-44 has no official spec test vectors | core | **Production-safety** | Only two round-trip tests exist. Wire up the official `nip44.vectors.json`. | 1 |

---

## Findings

### 1. Toolchain / bytecode

`nostr-java/pom.xml:73-75` sets `<java.version>21</java.version>` with
`maven.compiler.source`/`target` both bound to it, so the artifacts are class file **major
version 65**.

**Language features actually used** (grepped across all four modules' `src/main`):

| Feature | Used? | Where | Survives `--release 17`? | `--release 11`? |
|---|---|---|---|---|
| Records | yes | `nostr-java-core/src/main/java/nostr/util/validator/Nip05Validator.java:73`, `nostr-java-event/src/main/java/nostr/event/json/codec/BaseTagEncoder.java:11`, `.../FiltersEncoder.java:6`, `.../BaseMessageDecoder.java:95` | yes (Java 16) | **no** |
| Arrow `switch` + `yield` | yes | `nostr-java-core/.../bech32/Bech32.java:355-356`, `nostr-java-event/.../BaseMessageDecoder.java:43-59` | yes (Java 14) | **no** |
| Pattern-matching `instanceof` | yes | `nostr-java-event/.../BaseMessageDecoder.java:44`, `.../serializer/BaseTagSerializer.java:25` | yes (Java 16) | **no** |
| Sealed types / `permits` | **no** | — | — | — |
| Text blocks | **no** | — | — | — |
| `var` | effectively no | 0 hits in core/event/identity | yes | yes |
| Virtual threads (`Thread.ofVirtual`) | yes | `Nip05Validator.java:54,58`; `nostr-java-client/.../NostrRelayClient.java:81,83` | **API, not language** — see below | — |

**But you probably do not need to drop at all.** The class-file ceiling is not documented on
developer.android.com (I checked the [AGP release notes](https://developer.android.com/build/releases/gradle-plugin),
[/build/jdks](https://developer.android.com/build/jdks) and [/tools/d8](https://developer.android.com/tools/d8) —
none give a major version). The authoritative source is R8 itself: `JarClassFileReader` raises
`CompilationError("Unsupported class file version: ...")` when the class exceeds
`InternalOptions.SUPPORTED_CF_VERSION`
([JarClassFileReader.java](https://r8.googlesource.com/r8/+/refs/heads/main/src/main/java/com/android/tools/r8/graph/JarClassFileReader.java),
[InternalOptions.java](https://r8.googlesource.com/r8/+/refs/heads/main/src/main/java/com/android/tools/r8/utils/InternalOptions.java),
[CfVersion.java](https://r8.googlesource.com/r8/+/refs/heads/main/src/main/java/com/android/tools/r8/cf/CfVersion.java)).
Reading that constant per release branch:

| R8 | AGP | `SUPPORTED_CF_VERSION` | max class-file major |
|---|---|---|---|
| 3.1.51 | 7.1 | V17 | **61** (Java 17 first accepted) |
| 4.0.48 | 7.4 | V19 | 63 |
| 8.0.27 | 8.0 | V19 | 63 |
| 8.1 | 8.1 | V20 | 64 |
| 8.2 | **8.2** | V21 | **65** (Java 21 first accepted) |
| 8.5.10 | 8.5 | V24 | 68 |
| 9.3 / main | 9.3 | V27 | 71 |

**Java 17 bytecode (61) has been accepted since AGP 7.1; Java 21 bytecode (65) since AGP 8.2.**
Current AGP is 9.3 and accepts 71. So nostr-java's existing major-65 artifacts dex fine on any
AGP you would realistically use, and **blocker #1 is a non-issue**. (Caveat: the AGP↔R8 pairing is
itself unpublished; the mapping above is inferred from R8's own release branches, cross-checked
against [/build/kotlin-support](https://developer.android.com/build/kotlin-support), which lists
Kotlin↔AGP↔R8 minimums consistent with AGP X.Y bundling R8 X.Y from 8.0 onward.)

**One real constraint does follow from the language features.** The code uses records, and
`java.lang.Record` was **added in API 34**
([API 34 diff](https://developer.android.com/sdk/api_diff/34/changes/pkg_java.lang.html)). D8/R8
desugar records for lower `minSdk` via a synthetic `com.android.tools.r8.RecordTag`, but you need
`compileSdk` ≥ 34 so `java.lang.Record` is in `android.jar`. The AGP version that added record
support is **unknown from official docs** — no developer.android.com page states it; the only
source naming a version is the Android Developers Blog ("AGP fully supports records from version
8.1"), which is secondary. In practice: **use AGP ≥ 8.2 and `compileSdk` ≥ 34 and this whole area
disappears.** Note that Android 14 (API 34) is also where the platform picked up text blocks,
pattern-matching `instanceof` and sealed classes
([Android 14 features](https://developer.android.com/about/versions/14/features)), though those
three are compile-time-erased and need no runtime support — `/build/jdks` says so explicitly for
switch expressions: *"Other features, [like] switch expressions, only require the Java compiler to
work on Android."*

Dropping to `--release 17` remains **free** (no source changes) and is worth doing as cheap
insurance if you want to support AGP 7.1-8.1 consumers or simply to stop advertising a Java level
the code does not use. Dropping to 11 would require rewriting records and arrow-switches and is
not worth it.

The only genuinely Java-21 *API* is `Thread.ofVirtual()`, and both core call sites are in
`Nip05Validator` — the same class that is already disqualified by `java.net.http` (§2). Android
has no virtual threads: `java.lang.Thread.Builder` is a 404 in the API reference, and
`Thread.isVirtual()` was added in API 36 purely as a compatibility shim documented as *"This
method always returns false because virtual thread isn't implemented on Android yet."*
([Thread reference](https://developer.android.com/reference/java/lang/Thread))

**Desugaring — and what it does *not* rescue.** `coreLibraryDesugaring` ships in three tiers,
each with an official support table:

- **minimal** (`desugar_jdk_libs_minimal`) — `java.util.function` plus `ConcurrentHashMap`,
  `ConcurrentHashMap.KeySetView`, `ThreadLocalRandom`. [table](https://developer.android.com/studio/write/java11-minimal-support-table)
- **default** (`desugar_jdk_libs`) — adds `java.time` and `java.util.stream`. [table](https://developer.android.com/studio/write/java11-default-support-table)
- **nio** (`desugar_jdk_libs_nio`) — adds `java.nio`. [table](https://developer.android.com/studio/write/java11-nio-support-table)

Configuration and version→min-AGP mapping (1.1.9→4.0.0, 1.2.3→7.3.0, 2.0.3→7.4.0) are on
[the java8-support page](https://developer.android.com/studio/write/java8-support#library-desugaring).
Two properties matter here:

1. **Coverage is member-allowlisted, not package-level.** The tables carry per-method footnotes —
   "Not present in Android T (may not resolve at compilation)" for e.g. `Files.readString`,
   `Path.of`, `LocalDate.datesUntil`; and "Some methods (N) present in Android T are not
   supported" for `Duration` (9 methods), `LocalTime` (2). Do not assume a class is fully covered
   because it is listed.
2. **`java.util.HexFormat` is covered by no tier** — it appears on none of the tables. Neither
   does `java.net.http` (the only `java.net` entries anywhere are `URLDecoder`/`URLEncoder` in the
   nio tier). So **blocker #4 is real**: `HexFormat` is API 34+ with no desugaring escape hatch,
   and if your `minSdk` is below 34 you must replace it. Nothing desugars virtual threads either.

The nostr-java code needs none of what desugaring provides — no `java.time` on the signer path, no
streams beyond one `IntStream`, no `java.nio.file`. **You can likely skip `coreLibraryDesugaring`
entirely**, which is one less moving part.

### 2. Java APIs unavailable or different on Android — per module

This is the section that matters most, so it is broken out by module.

#### `nostr-java-core` — *nearly* clean; one bad file

The crypto and utility code is portable. Two files are not:

| File | Problem |
|---|---|
| `nostr-java-core/src/main/java/nostr/util/validator/Nip05Validator.java` | `import java.net.http.HttpClient/HttpRequest/HttpResponse` (lines 17-19) and `Thread.ofVirtual()` (lines 54, 58) — **both in `static final` initialisers**, so merely loading the class throws on Android. Also uses Blackbird (line 6). |
| `nostr-java-core/src/main/java/nostr/util/NostrUtil.java` | `import java.util.HexFormat` (line 12), `private static final HexFormat HEX = HexFormat.of()` (line 19). API **34+** ([reference](https://developer.android.com/reference/java/util/HexFormat), "Added in API level 34"). This class *is* on the signer's critical path — `bytesToHex`/`hexToBytes` are used by `MessageCipher44`, `Identity`, and the event id path. |

`java.net.http` does not exist on Android at any API level: `/reference/java/net/http/package-summary`,
`/HttpClient` and `/WebSocket` all return **HTTP 404**, and
[the package index](https://developer.android.com/reference/packages) lists only `java.net`. The
Android equivalent is `android.net.http` (Cronet-backed `HttpEngine`, API 34+), a different API.

Note this is a **build** failure, not just a runtime one: since **AGP 8.0**, R8 turns missing
classes into errors that break the build. The AGP 7.0 release notes state it plainly — *"In AGP
7.0, missing class messages will appear as warnings... In AGP 8.0, these warnings will become
errors that break your build"* — and point at the generated
`app/build/outputs/mapping/release/missing_rules.txt`
([AGP 7.0.0 release notes](https://developer.android.com/build/releases/past-releases/agp-7-0-0-release-notes)).
So `java.net.http.**` and `java.beans.**` each need a `-dontwarn` even if you never call them.

Everything else in core is fine: `java.math.BigInteger`, `java.security.MessageDigest`,
`javax.crypto.{Cipher,Mac}`, `java.nio.ByteBuffer`, `java.util.Base64`, `java.util.Arrays`.
There is **no** `ServiceLoader`, **no** JAXB, **no** JMX, **no** dynamic proxies, and no
reflection beyond what Jackson does.

#### `nostr-java-event` — one blocker, one correctness landmine

| File | Problem |
|---|---|
| `nostr-java-event/src/main/java/nostr/event/impl/GenericEvent.java:24` | `import java.beans.Transient`, applied at lines 122, 127, 132, 214, 241, 247. **`java.beans.Transient` does not exist on Android** — `/reference/java/beans/Transient` is a 404. Android's `java.beans` is a five-type stub (`PropertyChangeListener`, `PropertyChangeEvent`, `PropertyChangeListenerProxy`, `PropertyChangeSupport`, `IndexedPropertyChangeEvent`) — [package summary](https://developer.android.com/reference/java/beans/package-summary). |
| `nostr-java-event/src/main/java/nostr/base/IDecoder.java:16`, `nostr/base/json/EventJsonMapper.java:23`, `nostr/event/json/EventJsonMapper.java:44,77` | Blackbird — see below. |

**Why `@Transient` is the dangerous one.** `GenericEvent` carries no class-level
`@JsonIgnoreProperties`, so those six derived getters are excluded from JSON *solely* by
`java.beans.Transient`. On Android the annotation class is absent, Jackson's introspector never
sees it, and bean introspection picks all six up as properties. The published event JSON —
produced by `BaseEventEncoder.encode()` → `EventJsonMapper.getMapper().writeValueAsString(event)`
(`nostr-java-event/src/main/java/nostr/event/json/codec/BaseEventEncoder.java:21`) — would gain
`replaceable`, `ephemeral`, `addressable`, `signed`, `signatureConsumer` and `byteArraySupplier`.
Worse, serialising `byteArraySupplier` invokes `getByteArraySupplier()`
(`GenericEvent.java:247`), whose body calls `this.update()` — which **resets `createdAt` to now
and recomputes the event id mid-serialisation**. That is silent corruption, not a crash.

Fix: replace `java.beans.Transient` with Jackson's own `@JsonIgnore`, which is already imported
in the same file. One file, seven lines, and it is strictly better on the JVM too.

**Blackbird.** `jackson-module-blackbird` generates accessors at runtime via
`java.lang.invoke.LambdaMetafactory`. That class **is not on Android**:
`/reference/java/lang/invoke/LambdaMetafactory` is a 404, and the
[`java.lang.invoke` package summary](https://developer.android.com/reference/java/lang/invoke/package-summary)
(API 26+) lists `CallSite`, `MethodHandle`, `MethodHandles`, `MethodType`, `VarHandle` and
others but no `LambdaMetafactory`. AOSP confirms: there is no `LambdaMetafactory.java` in
[libcore's `java/lang/invoke`](https://android.googlesource.com/platform/libcore/+/refs/heads/main/ojluni/src/main/java/java/lang/invoke/).
ART does implement `invoke-custom`, but D8/R8 rewrite the `LambdaMetafactory` bootstrap at
*build* time; a library that calls it at *runtime* cannot be desugared and fails on device.

This sits squarely on the signer's critical path: `EventSerializer` holds
`private static final ObjectMapper MAPPER = EventJsonMapper.getMapper()`
(`nostr-java-event/src/main/java/nostr/event/serializer/EventSerializer.java:84`) and uses it at
lines 118 and 121 to build the canonical array whose SHA-256 is the event id.

The fix is deletion. Blackbird is a documented performance optimisation and nothing else — the
class Javadoc says so (`nostr/event/json/EventJsonMapper.java:16-18`). Removing the five
`.addModule(new BlackbirdModule())` calls leaves plain reflective `jackson-databind`, which works
on Android.

#### `nostr-java-identity` — clean

245 LOC, three imports beyond Lombok and its own packages (`java.security.NoSuchAlgorithmException`,
`java.util.function.Consumer`, and nostr classes). `Identity.java` and `MessageCipher{,04,44}.java`
introduce nothing Android-hostile. It inherits core's and event's problems and adds none.

#### `nostr-java-client` — unusable, by construction

Five files, 1,008 LOC, all under `nostr/client/springwebsocket/`. Imports
`org.springframework.web.socket.*`, `org.springframework.retry.*`,
`org.springframework.stereotype.Component`, plus `jakarta.websocket.ContainerProvider` and
`WebSocketContainer` (`NostrRelayClient.java:6-22`). See §4 for what that drags in.

### 3. Cryptography

**Implementation.** BIP-340 schnorr is **hand-rolled**, not delegated:
`nostr-java-core/src/main/java/nostr/crypto/schnorr/Schnorr.java` implements `sign` (line 36),
`verify` (line 107) and `genPubKey` (line 168) over a hand-written `BigInteger` curve in
`nostr-java-core/src/main/java/nostr/crypto/Point.java` (208 LOC, imports only `BigInteger`,
`MessageDigest` and Lombok). There is **no `libsecp256k1`**, no JNI, no native code. That is good
news for portability — pure `BigInteger` runs anywhere — and bad news for performance and
side-channel resistance; see Open Questions.

**The complete JCA surface** of core/event/identity is five calls:

```
NostrUtil.java:65                MessageDigest.getInstance("SHA-256")
Schnorr.java:148                 KeyPairGenerator.getInstance("ECDSA", "BC")
nip04/EncryptedDirectMessage:60  Cipher.getInstance("AES/CBC/PKCS5Padding")
nip04/EncryptedDirectMessage:80  Cipher.getInstance("AES/CBC/PKCS5Padding")
nip44/EncryptedPayloads:131      Mac.getInstance("HmacSHA256")
```

plus `Cipher.getInstance(Constants.ENCRYPTION_ALGORITHM)` where `ENCRYPTION_ALGORITHM = "ChaCha20"`
(`EncryptedPayloads.java:41,88` and `:276`). Four of those seven are provider-agnostic and fine on
Android (`SHA-256` 1+, `AES/CBC/PKCS5Padding` 1+, `HmacSHA256` 1+). Two are not.

**Does bundling `bcprov-jdk18on` collide with the platform? No — NON-ISSUE.** Android's copy is
repackaged. AOSP `external/bouncycastle/Android.bp` says so in a comment above the target:
*"A bouncycastle library repackaged in `com.android.org.bouncycastle` for use in the ART module.
Repackaging is needed to avoid conflict with the original `org.bouncycastle` package."*
([Android.bp](https://cs.android.com/android/platform/superproject/main/+/main:external/bouncycastle/Android.bp)).
Your `org.bouncycastle.*` classes occupy a package the platform does not use. The historical
reason for **SpongyCastle** — that the boot classpath owned `org.bouncycastle` — no longer
applies. (Google never published a statement declaring SpongyCastle obsolete, so treat that as
inference from the AOSP repackaging, not documented guidance.)

**But the provider *name* does collide, and that is blocker #7 and #8.** The platform registers
four providers, the third being BouncyCastle under the name `"BC"`
([libcore `security.properties`](https://android.googlesource.com/platform/libcore/+/refs/heads/main/luni/src/main/java/java/security/security.properties)):

```
security.provider.1=com.android.org.conscrypt.OpenSSLProvider     // "AndroidOpenSSL"
security.provider.2=sun.security.provider.CertPathProvider
security.provider.3=com.android.org.bouncycastle.jce.provider.BouncyCastleProvider  // "BC"
security.provider.4=com.android.org.conscrypt.JSSEProvider
```

`Security.addProvider` is a documented no-op when a provider of that name is already installed.
So `Schnorr.java:147`'s `Security.addProvider(new BouncyCastleProvider())` **silently does
nothing on Android**, and the two consequences are:

1. **`KeyPairGenerator.getInstance("ECDSA", "BC")` (`Schnorr.java:148`) binds to the platform's
   stripped BC**, not yours. Android's documented `KeyPairGenerator` algorithms are DH, DSA, EC,
   RSA, XDH — **`"ECDSA"` is not among them**
   ([reference](https://developer.android.com/reference/java/security/KeyPairGenerator)). The
   repackaged provider happens to still register `KeyPairGenerator.ECDSA` internally, so it may
   work today, but Android explicitly warns against exactly this shape: *"Android doesn't
   guarantee a particular provider for a given algorithm. Specifying a provider without using the
   Android Keystore system can cause compatibility problems in future releases."*
   ([Cryptography](https://developer.android.com/privacy-and-security/cryptography)). Android 12
   already *"removes many BouncyCastle implementations of cryptographic algorithms that were
   previously deprecated, including all AES algorithms"*, for all apps regardless of target
   ([Android 12 behavior changes](https://developer.android.com/about/versions/12/behavior-changes-all#bouncy-castle)).

   The fix is to stop asking. A secp256k1 private key is 32 random bytes in `[1, n-1]`; the code
   already has `Point.getn()` and `SecureRandom`. Generating a keypair through a JCA provider only
   to throw away everything but `getS()` is round-trip for nothing. (`generatePrivateKey()` has
   exactly one caller: `nostr-java-event/src/main/java/nostr/base/PrivateKey.java:26`.)
   `SecureRandom.getInstanceStrong()` at `Schnorr.java:149` is itself fine on Android — API 26+,
   and `securerandom.strongAlgorithms=SHA1PRNG:AndroidOpenSSL` is set, so it returns a Conscrypt
   PRNG rather than blocking.

2. **NIP-44 breaks.** This one I verified by running code, because it is counter-intuitive.
   `EncryptedPayloads` does `Cipher.getInstance("ChaCha20")` then
   `cipher.init(..., new IvParameterSpec(chachaNonce))` (`EncryptedPayloads.java:41-45`). On a
   stock JDK 21 that **throws**:

   ```
   before addProvider: FAIL java.security.InvalidAlgorithmParameterException:
                            ChaCha20 algorithm requires ChaCha20ParameterSpec
   after  addProvider: OK, provider=BC
   ```

   JCA does lazy provider selection at `init()`: SunJCE's ChaCha20 rejects `IvParameterSpec`, so
   the call falls through to BouncyCastle, which accepts it. **NIP-44 in nostr-java only works as
   a side effect of BouncyCastle having been registered** — which only happens if
   `Schnorr.generatePrivateKey()` ran earlier in the process. The library's own
   `MessageCipherTest` passes only because both tests call `Schnorr.generatePrivateKey()` first
   (`nostr-java-identity/src/test/java/nostr/encryption/MessageCipherTest.java:13-16,30-33`). **A
   JVM app that loads an existing nsec and never generates one gets an exception on its first
   NIP-44 operation.** That is a live bug today, independent of Android.

   On Android it cannot be papered over: `addProvider` is a no-op, the platform BC has ChaCha
   removed, and Conscrypt's ChaCha20 is API **28+**
   ([Cipher reference](https://developer.android.com/reference/javax/crypto/Cipher): `ChaCha20`,
   modes `NONE`/`Poly1305`, `28+`).

   **The fix removes the whole problem class.** BouncyCastle's *lightweight* API needs no provider
   registration at all — and the file already uses it for HKDF (`HKDFBytesGenerator`,
   `EncryptedPayloads.java:10,221,242`). Swapping the JCA `Cipher` for
   `org.bouncycastle.crypto.engines.ChaCha7539Engine` is ~10 lines. I verified the outputs are
   byte-identical:

   ```
   lightweight = 1f000634e7e46345cb802150eb801c53f55b252731db
   jca(BC)     = 1f000634e7e46345cb802150eb801c53f55b252731db
   IDENTICAL   = true
   ```

   This fixes the JVM bug, removes the provider dependency, and drops the minSdk floor from 28 to
   whatever else you need. Do the same for NIP-04's `AES/CBC/PKCS5Padding` only if you care about
   provider determinism; it is documented from API 1 and is fine as-is.

**NIP coverage — what exists and what does not:**

| NIP | Status | Evidence |
|---|---|---|
| BIP-340 schnorr sign/verify | **present**, hand-rolled | `nostr-java-core/src/main/java/nostr/crypto/schnorr/Schnorr.java:36,107`; `nostr/crypto/Point.java` |
| NIP-01 event id + serialisation | **present** | `nostr-java-event/src/main/java/nostr/event/serializer/EventSerializer.java:161` (SHA-256), `GenericEvent.java:149-156` |
| NIP-04 (legacy) | **present** | `nostr-java-core/src/main/java/nostr/crypto/nip04/EncryptedDirectMessage.java` (111 LOC), wrapped by `nostr-java-identity/.../MessageCipher04.java` |
| **NIP-44 v2** | **present and spec-shaped**, but see the ChaCha caveat | `nostr-java-core/src/main/java/nostr/crypto/nip44/EncryptedPayloads.java` (285 LOC). `VERSION = 2` (`:283`), HKDF-Extract with salt `"nip44-v2"` (`:127-134`), HKDF-Expand to 76 bytes = 32 key + 12 nonce + 32 hmac (`:242-250`), the power-of-two padding scheme (`calcPaddedLen`, `:239`), and the `version‖nonce‖ciphertext‖mac` base64 envelope (`:54-60`). Conversation key uses the `02`-prefixed even-Y convention (`MessageCipher44.java:39-41`). |
| Bech32 (npub/nsec/note) | **present** | `nostr-java-core/src/main/java/nostr/crypto/bech32/Bech32.java` |
| **NIP-49** (scrypt nsec encryption) | **ABSENT** | Zero hits for `nip49`/`scrypt` repo-wide. |
| **BIP-32 / BIP-39** | **ABSENT** | Zero hits for `bip32`/`bip39`/`mnemonic`/`xprv` repo-wide. |

**Does anything need scrypt?** Not today — nothing in nostr-java uses it. If you add NIP-49,
note that **Android's JCA has no scrypt**: `SCRYPT` does not appear in the
[`SecretKeyFactory` algorithm table](https://developer.android.com/reference/javax/crypto/SecretKeyFactory)
(which offers PBKDF2withHmacSHA1 10+, and the SHA-224/256/384/512 variants 26+). You would use
the bundled BC's `org.bouncycastle.crypto.generators.SCrypt` lightweight class — same pattern as
the ChaCha fix, no provider involved. Similarly there is **no HKDF** in Android's JCA
(`javax.crypto.KDF` is a 404; HPKE's `android.crypto.hpke` arrives at API 37 and does not expose
standalone extract/expand) — but nostr-java already uses BC's lightweight `HKDFBytesGenerator`,
so this is a non-issue.

### 4. Dependency graph

**Verified by running** `./mvnw -o dependency:tree` in `~/IdeaProjects/nostr-java` (exit 0).

`nostr-java-core`:
```
+- org.apache.commons:commons-lang3:3.18.0            OK
+- com.fasterxml.jackson.core:jackson-databind:2.18.1 OK (reflective; see §2 re: Blackbird)
+- com.fasterxml.jackson.module:jackson-module-blackbird:2.19.2   ** REMOVE **
+- org.bouncycastle:bcprov-jdk18on:1.81               OK (repackaging means no collision)
+- org.projectlombok:lombok:1.18.40:provided          OK — compile-time only
\- org.slf4j:slf4j-api:2.0.17                         OK — API only, no backend
```

`-event` adds nothing new; `-identity` adds nothing at all. **The Android-facing dependency set
for a signer is five jars: commons-lang3, jackson-databind (+core, +annotations), bcprov,
slf4j-api.** No Guava (so no jre/android flavour question), no Netty, no OkHttp, no JAXB, no
logging backend. slf4j-api with no binding is a no-op; bind `slf4j-android` or a trivial
`Logger` shim if you want logs.

`nostr-java-client` is the opposite:
```
+- org.springframework.boot:spring-boot-starter-websocket:3.5.5
|  +- spring-boot-starter-web -> spring-boot-starter-tomcat
|  |  +- org.apache.tomcat.embed:tomcat-embed-core:10.1.44      ** embedded servlet container **
|  |  +- tomcat-embed-el, tomcat-embed-websocket
|  |  \- org.springframework:spring-webmvc:6.2.10
|  \- org.springframework:spring-messaging:6.2.10
+- org.springframework:spring-websocket:6.2.10 -> spring-context, spring-aop, spring-core, spring-web
+- org.springframework.retry:spring-retry:2.0.12
+- org.springframework:spring-aspects:6.2.10 -> org.aspectj:aspectjweaver:1.9.24   ** load-time weaving **
\- org.awaitility:awaitility:4.3.0 (compile scope — a test library at compile scope)
```
Embedded Tomcat and AspectJ weaving on Android is a non-starter. Note also that
`spring-boot-starter-test` pulls `logback-classic` at **compile** scope transitively
(via `spring-boot-starter`), and `jakarta.xml.bind-api` at test scope.

**Method count:** not worth measuring. bcprov is the only large jar; R8 shrinking plus multidex
cover it. Revisit only if a build actually fails.

### 5. `nsecbunker-java`

**The headline: it is a NIP-46 *client*, not a signer. The server half you need does not exist.**

- `README.md:8` — *"A comprehensive Java **client** library for interacting with nsecBunker instances."*
- `nsecbunker-protocol/src/main/java/xyz/tcheeric/nsecbunker/protocol/nip46/Nip46Request.java:148,160,173,189,205,221,237,249,260` — static factories that **build outbound** requests (`connect`, `get_public_key`, `sign_event`, `nip04_*`, `nip44_*`, `ping`, `get_relays`). These are the only references to `Nip46Method.*` in any `src/main/java`.
- `nsecbunker-client/src/main/java/xyz/tcheeric/nsecbunker/client/transport/RelayNip46Transport.java:153` — `createRequestHandler()` returns a `Function<Nip46Request, Nip46Response>` that calls `sendRequestAsync(...)`, which encrypts, signs a wrapper event, broadcasts to the relay pool and awaits a `CompletableFuture`. Send-and-await, not receive-and-answer.
- A method dispatcher exists **only in test sources**: `nsecbunker-protocol/src/test/java/xyz/tcheeric/nsecbunker/protocol/testing/MockBunkerServer.java:362-383`, and its `sign_event` handler is an explicit stub — line 373: *"Default sign_event handler - return the same event (not actually signing)"*.
- Grep for `case SIGN_EVENT` / `registerHandler` / `handleRequest` across all `src/main/java`: zero hits. The only private key held anywhere is the **admin** key for authenticating admin RPCs (`nsecbunker-admin/.../AdminConfig.java:41`).

**What is reusable:** the wire types — `Nip46Method`, `Nip46Request`, `Nip46Response`,
`Nip46Encoder`, `Nip46Decoder`. `Nip46Decoder.tryDecodeRequest` already parses *inbound*
requests and `Nip46Request.java:90` resolves an inbound method string via
`Nip46Method.tryFromValue`, so the parsing half of a server is there. You would write the
dispatcher, key store, permission gate and the actual signing. `MockBunkerServer` is published as
a test-jar (`nsecbunker-protocol/pom.xml:98-105`) and is a usable structural template.

**Spring containment is clean — genuinely good news.** Seven of eight modules
(`core`, `connection`, `protocol`, `admin`, `client`, `monitoring`, `account`) have **zero**
`import org.springframework` hits and no Spring coordinates in their POMs. All Spring lives in
`nsecbunker-spring-boot-starter` (`nsecbunker-spring-boot-starter/pom.xml:41-56`, Boot 3.5.9),
along with logback, log4j-to-slf4j, jakarta.annotation and micrometer. Verified against
`mvn -o dependency:tree` across all 15 reactor modules.

**Android-hostile APIs in first-party source: none.** Grepping the seven non-Spring modules'
`src/main/java` (111 files) for `java.net.http`, `jakarta.`, `javax.`, `java.beans`,
`Thread.ofVirtual`, `StructuredTaskScope`, `ServiceLoader`, `HexFormat`, `blackbird`,
`bouncycastle`, `logback`, `log4j` returns nothing. The `spi` packages in `nsecbunker-account`
are hand-rolled interfaces — no `ServiceLoader`, no `META-INF/services` anywhere.

**The risk is entirely inherited from nostr-java**, and it pins the *old* version:
`nostr-java.version=2.0.0` (`nsecbunker-java/pom.xml:57`), bringing
`jackson-module-blackbird:2.17.0` and `bcprov-jdk18on:1.81` into every module. Fixing nostr-java
fixes nsecbunker-java. One extra oddity: `net.bytebuddy:byte-buddy:1.17.8` appears at **compile**
scope under `jackson-databind` — bytecode generation, not Android-safe; worth a
`dependency:analyze` on its own. No Netty, Jetty, Tyrus, JAXB or Guava anywhere. `okhttp:4.12.0`
and `kotlin-stdlib` are Android-native.

**Java version:** the root POM declares `--release 21` but has not earned it. Across all
`*/src/main/java`: zero records, zero sealed types, zero text blocks, zero arrow switches, zero
`yield`, zero pattern-matching `instanceof`, zero virtual threads, `var` in one file.
Concurrency is `CompletableFuture` + atomics on platform threads. `--release 17` — arguably
lower — is free.

---

## Recommended port plan

### The recommendation: **(b), executed with (a)'s mechanics but without a variant artifact**

Take `nostr-java-core` + `-event` + `-identity`. Drop `-client`. Write relay I/O with OkHttp
when and if you build the NIP-46 mode.

A signer needs exactly four things: key handling, event serialisation + id computation, BIP-340
signing, and NIP-44 encrypt/decrypt. All four live in those three modules; **none of them live in
`-client`**. Relay I/O is needed only for the optional NIP-46 mode, and NIP-55 — intent and
ContentProvider based — needs no network at all.

**Do not ship an `-android` classifier.** Option (a) proposes a parallel artifact, and it is the
wrong shape here: every fix in the blocker table is either a strict bug fix (#3, #7, #8) or a
behaviour-neutral simplification (#2, #4) on the JVM as well. There is nothing to fork. Two
artifacts means two test matrices and a drift bug six months out. Fix the main artifacts, publish
at `--release 17`, and let Android consumers simply omit `nostr-java-client`.

Concretely, the POM change is one deletion — and optionally one line:

```xml
<!-- pom.xml: OPTIONAL. Not required on AGP >= 8.2, which accepts major 65.
     Free insurance (no source changes) if you want AGP 7.1-8.1 consumers. -->
<maven.compiler.release>17</maven.compiler.release>
```
```xml
<!-- nostr-java-core/pom.xml + nostr-java-event/pom.xml: delete -->
<dependency>
  <groupId>com.fasterxml.jackson.module</groupId>
  <artifactId>jackson-module-blackbird</artifactId>
</dependency>
```

...and on the Android side, nothing but the three normal dependencies plus, defensively:

```
-dontwarn java.net.http.**
-dontwarn java.beans.**
```

### Ordered steps

**Phase 1 — must do before any code runs (~1.5 days)**

1. Set the Android module to **AGP ≥ 8.2, `compileSdk` ≥ 34**. That is the entire "Java 21
   bytecode" story — no POM change required. Optionally also set `--release 17` in nostr-java's
   root POM as free insurance. *(0.25d)*
2. Delete the five `BlackbirdModule` call sites (`IDecoder.java:6,16`;
   `nostr/base/json/EventJsonMapper.java:5,23`; `nostr/event/json/EventJsonMapper.java:6,44,77`;
   `Nip05Validator.java:6,64`) and the dependency from both POMs. *(0.5d)*
3. `java.beans.Transient` → `@JsonIgnore` in `GenericEvent.java` (import + 6 sites). Add a test
   asserting the encoded JSON has exactly the seven NIP-01 keys — this is the one that fails
   silently. *(0.25d)*
4. Replace `HexFormat` in `NostrUtil.java:12,19` with a hand-rolled codec. *(0.25d)*
5. Neutralise `Nip05Validator`: move it out of core, or make the `HttpClient`/virtual-thread
   fields lazy so class-loading does not detonate. A signer never validates NIP-05. *(0.5d)*

**Phase 2 — must do before it is correct (~1 day)**

6. `Schnorr.generatePrivateKey()`: drop `Security.addProvider` + `KeyPairGenerator("ECDSA","BC")`,
   use `SecureRandom` → 32 bytes → reject `0` and `>= n`, retry. *(0.25d)*
7. `EncryptedPayloads`: replace the JCA `Cipher` with BC lightweight `ChaCha7539Engine`. This is a
   **JVM bug fix too** — ship it regardless of Android. Add a test that runs NIP-44 in a fresh JVM
   *without* calling `generatePrivateKey()` first. *(0.5d)*
8. Build a trivial Android app that signs one event and NIP-44 round-trips one message on a real
   device. Everything above is theory until this passes. *(0.25d)*

**Phase 3 — before production (~5-7 days)**

9. Wire the official NIP-44 `nip44.vectors.json` into `nostr-java-core`'s tests. Two round-trip
   assertions is not interop testing, and a signer that produces subtly wrong NIP-44 is worse than
   one that fails loudly. *(1d)*
10. Key storage. Android Keystore **cannot** hold a secp256k1 key — its `KeyPairGenerator`
    algorithms are DH/DSA/EC(NIST)/RSA/XDH. You must store the nsec encrypted-at-rest with a
    Keystore-held AES-GCM wrapping key, gated by `BiometricPrompt`. This is the real security
    work in a signer and it is entirely yours to write. *(2-3d)*
11. NIP-49, if you want importable/exportable encrypted nsecs. Use BC lightweight `SCrypt`. *(2d)*
12. R8 keep rules for Jackson's reflective databind (it *will* strip your event classes'
    accessors), plus a release-build smoke test. *(1d)*

**Phase 4 — only if you build the NIP-46 mode (~2-3 days)**

13. Write a small OkHttp `WebSocket` relay client. OkHttp is already Android-native and already in
    `nsecbunker-java`'s tree. Do not attempt to port `nostr-java-client`. *(2-3d)*
14. If you want NIP-46 *server* behaviour, take `nsecbunker-protocol`'s `Nip46Request`/`Response`/
    `Decoder` for the wire format and write the dispatcher yourself, using `MockBunkerServer` as a
    structural template. *(estimate deferred — depends on your permission model)*

### Why not (c)?

Binding `libsecp256k1` via JNI or adopting a Kotlin-native library is the right call for a
*greenfield* signer with no Java investment. It is the wrong call here for one reason: **you own
nostr-java.** Options (a) and (b) cost days, not weeks, and every change is one you should make
anyway — two of them are live bugs on the JVM. Keep (c) in your pocket for one specific reason:
if hand-rolled `BigInteger` schnorr proves too slow or you need constant-time guarantees for a
signer holding user keys, swapping `Point`/`Schnorr` for JNI `libsecp256k1` is a *localised*
change behind an interface you already have. That is a Phase-5 optimisation, not a prerequisite.

### Rough effort summary

| Bucket | Days |
|---|---|
| Before any code runs (Phase 1) | ~1.5 |
| Before it is correct (Phase 2) | ~1 |
| **Working signer, NIP-55 only** | **~2.5** |
| Before production (Phase 3) | 5-7 |
| NIP-46 mode (Phase 4) | 2-3 |
| **Total, production-safe, both modes** | **~11-13** |

---

## Open questions

1. **The exact AGP version that added record desugaring.** Undocumented on
   developer.android.com; only the Android Developers Blog names 8.1, which is secondary. *How to
   settle:* find the R8 commit introducing the record rewriter / `RecordTag` on
   r8.googlesource.com and correlate it to the R8 branch AGP 8.1 ships. Moot if you use AGP ≥ 8.2,
   which you should anyway for the class-file ceiling.
2. **Whether Conscrypt's API-28+ `ChaCha20` accepts `IvParameterSpec`.** I verified SunJCE rejects
   it and BC accepts it, on the JVM. I did **not** test Conscrypt. *How to settle:* one instrumented
   test on a device. Moot if you take the lightweight-engine fix, which is why that fix is
   recommended over raising minSdk to 28.
3. **Performance of hand-rolled `BigInteger` schnorr on a phone.** `Point.mul` is a naive
   double-and-add over `BigInteger` (`nostr-java-core/src/main/java/nostr/crypto/Point.java`).
   Unknown whether a sign takes 5ms or 500ms on a mid-range device — the latter is a visible UI
   stall in a signer that approves in a dialog. *How to settle:* microbenchmark `Schnorr.sign` on a
   real device. If it is slow, that is the trigger for option (c) behind the existing interface.
4. **Side-channel resistance of the same code.** `Point.mul` is not constant-time and the code was
   not written to be. For a signer holding user keys on a shared device this deserves a real
   opinion from someone who does this for a living. *How to settle:* security review; or moot it by
   moving to `libsecp256k1`.
5. **`net.bytebuddy:byte-buddy` at compile scope in nsecbunker-java's tree.** Unexplained — likely a
   `dependencyManagement` pin leaking. *How to settle:* `mvn dependency:analyze` on that repo.

---

## Appendix: what was verified by running vs. read vs. inferred

**Verified by running:**
- `./mvnw -o dependency:tree` on nostr-java (exit 0) — the full graph in §4.
- `./mvnw -o -pl nostr-java-identity -am test -Dtest=MessageCipherTest` (exit 0) — the NIP-44
  tests pass, and only because they generate a key first.
- Standalone JDK 21 programs proving (a) `Cipher.getInstance("ChaCha20")` + `IvParameterSpec`
  throws without BC registered and succeeds with it, and (b) BC's lightweight `ChaCha7539Engine`
  produces byte-identical output.

**Read from source:** every file:line citation in this document.

**From primary documentation:** all developer.android.com, cs.android.com and
android.googlesource.com links, each quoted inline.

**Inferred, and flagged as such:** that SpongyCastle is obsolete (follows from the AOSP
repackaging comment, but Google never said it); that Jackson will pick up the six derived getters
in the absence of `java.beans.Transient` (follows from Jackson's bean introspection rules and the
absence of any other exclusion on `GenericEvent`, but not tested on a device — it is item 3 in
Phase 1 precisely because it should be pinned down by a test).
