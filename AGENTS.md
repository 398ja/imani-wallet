# Repo Guidelines

The Cashu protocol is defined in the NUT specifications maintained at [cashubtc/nuts](https://github.com/cashubtc/nuts):
- When implementing features, consult the NUT specifications:

- [NUT-00](https://github.com/cashubtc/nuts/blob/main/00.md) - Notation, Proof, and Token formats
- [NUT-01](https://github.com/cashubtc/nuts/blob/main/01.md) - Mint public key endpoints
- [NUT-02](https://github.com/cashubtc/nuts/blob/main/02.md) - Keysets and keyset IDs
- [NUT-03](https://github.com/cashubtc/nuts/blob/main/03.md) - Swap (token redemption)
- [NUT-04](https://github.com/cashubtc/nuts/blob/main/04.md) - Minting tokens
- [NUT-05](https://github.com/cashubtc/nuts/blob/main/05.md) - Melting tokens (Lightning)
- [NUT-06](https://github.com/cashubtc/nuts/blob/main/06.md) - Mint information
- [NUT-07](https://github.com/cashubtc/nuts/blob/main/07.md) - Token state check
- [NUT-08](https://github.com/cashubtc/nuts/blob/main/08.md) - Overpaid Lightning fees
- [NUT-09](https://github.com/cashubtc/nuts/blob/main/09.md) - Restore signatures
- [NUT-10](https://github.com/cashubtc/nuts/blob/main/10.md) - Spending conditions
- [NUT-11](https://github.com/cashubtc/nuts/blob/main/11.md) - Pay-to-Pubkey (P2PK)
- [NUT-12](https://github.com/cashubtc/nuts/blob/main/12.md) - DLEQ proofs
- [NUT-13](https://github.com/cashubtc/nuts/blob/main/13.md) - Deterministic secrets
- [NUT-14](https://github.com/cashubtc/nuts/blob/main/14.md) - Hashed Timelock Contracts (HTLC)
- [NUT-15](https://github.com/cashubtc/nuts/blob/main/15.md) - Partial multi-path payments
- [NUT-16](https://github.com/cashubtc/nuts/blob/main/16.md) - Animated QR codes (Bolts)
- [NUT-17](https://github.com/cashubtc/nuts/blob/main/17.md) - WebSocket subscriptions
- [NUT-18](https://github.com/cashubtc/nuts/blob/main/18.md) - Payment requests
- [NUT-19](https://github.com/cashubtc/nuts/blob/main/19.md) - Cached responses

## Project

- Maintain the versions in `gradle/libs.versions.toml` for centralized dependency management
- Use Gradle version catalog for all dependencies
- Follow Kotlin Multiplatform (KMP) source set conventions

## Coding

- When writing code, follow the "Clean Code" principles:
  - [Clean Code](https://dev.398ja.xyz/books/Clean_Code.pdf)
    - Relevant chapters: 2 (Meaningful Names), 3 (Functions), 4 (Comments), 7 (Error Handling), 10 (Classes), 17 (Smells and Heuristics)
  - [Clean Architecture](https://dev.398ja.xyz/books/Clean_Architecture.pdf)
    - Relevant chapters: All chapters in part III and IV, 7-14
- [Design Patterns](https://github.com/iluwatar/java-design-patterns)
  - Follow design patterns as described, adapting for Kotlin idioms
- When committing code, follow the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification
- When adding new features, ensure they are compliant with the Cashu specification (NUTs) provided above
- Follow Kotlin idioms and best practices:
  - Use data classes for domain models
  - Prefer immutability (val over var, List over MutableList)
  - Use named parameters for readability
  - Leverage Kotlin null safety
  - Use extension functions when appropriate
  - Follow Kotlin naming conventions (camelCase for functions/properties, PascalCase for classes)

## Kotlin Multiplatform Guidelines

- **Source Sets**: Place platform-independent code in `commonMain`, tests in `commonTest`
- **Platform-Specific**: Use `expect/actual` pattern for platform-specific implementations
- **Dependencies**: Only use multiplatform-compatible libraries in `commonMain`:
  - ✅ `kotlinx.coroutines`, `kotlinx.serialization`, `kotlinx.datetime`, Ktor Client
  - ❌ Java-only libraries (nostr-java, java.time, java.io)
- **Module Dependencies**:
  - `imani-identity` has no dependencies
  - `imani-voucher` depends on `imani-identity`
  - `imani-app` depends on both modules
- **Package Structure**: `cash.imani.{module}.{layer}` (e.g., `cash.imani.identity.domain`)

## Documentation

- When generating documentation:
  - Follow the Diátaxis framework and classify each document as a tutorial, how-to guide, reference, or explanation
  - Place new Markdown files under `docs/<section>` or `project/<section>` matching the chosen category
  - Start each document with a top-level `#` heading and a short introduction that states the purpose
  - Link the document from the main README.md or relevant parent document
  - Use relative links to reference other documents and keep code snippets minimal and tested
  - Consult the following resources on Diátaxis for guidance:
    - https://github.blog/developer-skills/documentation-done-right-a-developers-guide/
    - https://diataxis.fr/
    - https://diataxis.fr/start-here/
    - https://diataxis.fr/how-to-use-diataxis/
    - https://diataxis.fr/tutorials/
    - https://diataxis.fr/how-to-guides/
    - https://diataxis.fr/tutorials-how-to/
    - https://diataxis.fr/quality/
    - https://diataxis.fr/complex-hierarchies/
    - https://diataxis.fr/compass/

## Testing

- Always run `./gradlew test` from the repository root before committing your changes
- Include the command's output in the PR description
- If tests fail due to dependency or network issues, mention this in the PR
- Update the documentation files if you add or modify features
- Update `build.gradle.kts` files for new modules or dependencies, ensuring Kotlin Multiplatform compatibility
- Add unit tests for new functionality, covering edge cases. Follow "Clean Code" principles on unit tests (Chapter 9)
- Ensure modifications to existing code do not break functionality and pass all tests
- Add integration tests for new features to verify end-to-end functionality
- Ensure new dependencies or configurations do not introduce security vulnerabilities
- Add a comment on top of every test method to describe the test in plain English

### Kotlin Test Structure and Clean Code Principles

All tests should follow Clean Code principles (Chapter 9: "Unit Tests"):

**1. AAA Pattern (Arrange-Act-Assert / Given-When-Then)**:
Every test should be structured in three clear sections:

```kotlin
@Test
fun `should validate user input correctly`() {
    // Given: Set up test data and preconditions
    val identity = Identity(
        id = "test-id",
        label = "Test",
        publicKey = "0".repeat(64),
        privateKey = "1".repeat(64),
        createdAt = Clock.System.now(),
        lastUsedAt = null
    )

    // When: Execute the operation being tested
    val result = identity.isActive()

    // Then: Verify the expected outcome
    assertTrue(result)
}
```

**2. One Assert Per Test (or Concept)**:
- Prefer testing one concept per test method
- Multiple asserts are acceptable if they verify the same logical concept
- Split unrelated assertions into separate test methods

**3. F.I.R.S.T. Principles**:
- **Fast**: Tests should run quickly (< 1 second for unit tests)
- **Independent**: Tests should not depend on each other
- **Repeatable**: Tests should produce the same result every time
- **Self-Validating**: Tests should have boolean output (pass/fail)
- **Timely**: Write tests before or with the code (TDD/BDD)

**4. Descriptive Test Names**:
Use clear, behavior-describing names using backticks for natural language:

```kotlin
// ✅ Good: Clear what's being tested
@Test
fun `isActive returns true when last used within 90 days`() { }

@Test
fun `constructor validates label length`() { }

@Test
fun `withLabel creates new identity with updated label`() { }

// ❌ Bad: Unclear or implementation-focused
@Test
fun testMethod1() { }

@Test
fun checkValidation() { }
```

**5. Test Comments**:
Add a brief comment above each test explaining **what** is being tested:

```kotlin
/**
 * Tests that Identity considers itself active if used within
 * the last 90 days, preventing premature dormancy flagging.
 */
@Test
fun `isActive returns true when last used within 90 days`() {
    // Given: Identity used 30 days ago
    val now = Clock.System.now()
    val identity = Identity(
        id = "test-id",
        label = "Test",
        publicKey = "0".repeat(64),
        privateKey = "1".repeat(64),
        createdAt = now.minus(100.days),
        lastUsedAt = now.minus(30.days)
    )

    // When: Checking if active
    val result = identity.isActive()

    // Then: Should be active
    assertTrue(result)
}
```

**6. Edge Cases and Boundary Conditions**:
Always test:
- Null inputs (where applicable with nullable types)
- Empty collections
- Boundary values (0, -1, MAX_VALUE)
- Invalid inputs (validation failures)
- Concurrent access (when applicable)

**7. Test Data Builders**:
For complex objects, use helper methods or factory functions:

```kotlin
private fun createVoucher(
    status: VoucherStatus = VoucherStatus.ISSUED,
    expiresAt: Long? = null
): StoredVoucher {
    return StoredVoucher(
        voucherId = "voucher-1",
        issuerId = "issuer-1",
        unit = "sat",
        faceValue = 1000,
        expiresAt = expiresAt,
        memo = "Test voucher",
        issuerSignature = "signature",
        issuerPublicKey = "0".repeat(64),
        issuedAt = Clock.System.now(),
        status = status
    )
}
```

**8. Test Organization**:
```
{module}/src/
├── commonTest/kotlin/          # Shared tests for all platforms
│   └── cash/imani/{module}/
│       └── domain/             # Domain model tests
├── jvmTest/kotlin/             # JVM-specific tests
├── jsTest/kotlin/              # JS-specific tests
└── iosTest/kotlin/             # iOS-specific tests
```

**9. Running Tests**:

```bash
# All tests
./gradlew test

# Specific module
./gradlew :imani-identity:test

# Specific platform
./gradlew :imani-identity:jvmTest
./gradlew :imani-identity:jsTest

# Specific test class
./gradlew :imani-identity:jvmTest --tests "IdentityTest"

# Specific test method
./gradlew :imani-identity:jvmTest --tests "IdentityTest.isActive returns true when last used within 90 days"
```

**Example of Well-Structured Kotlin Test Class**:

```kotlin
/**
 * Unit tests for Identity domain model.
 * Tests validation, business logic, and immutability patterns.
 */
class IdentityTest {

    private val validPublicKey = "0".repeat(64)
    private val validPrivateKey = "1".repeat(64)

    @Test
    fun `constructor validates id is not blank`() {
        // Given: Empty ID
        assertFailsWith<IllegalArgumentException> {
            // When: Creating identity with empty ID
            Identity(
                id = "",
                label = "Test",
                publicKey = validPublicKey,
                privateKey = validPrivateKey,
                createdAt = Clock.System.now(),
                lastUsedAt = null
            )
        }
        // Then: Exception thrown (implicit by assertFailsWith)
    }

    @Test
    fun `isActive returns true when last used within 90 days`() {
        // Given: Identity used 30 days ago
        val now = Clock.System.now()
        val identity = Identity(
            id = "test-id",
            label = "Test",
            publicKey = validPublicKey,
            privateKey = validPrivateKey,
            createdAt = now.minus(100.days),
            lastUsedAt = now.minus(30.days)
        )

        // When: Checking if active
        val result = identity.isActive()

        // Then: Should be active
        assertTrue(result)
    }
}
```

**Reference**: "Clean Code" by Robert C. Martin, Chapter 9: "Unit Tests"

## Error Handling

### Exception Hierarchy

Use Kotlin's exception hierarchy effectively:

- **Domain Exceptions**: Create sealed classes or specific exception types for domain errors
- **Infrastructure Exceptions**: Use for recoverable errors in infrastructure layers
- **Use Result Types**: Consider using Kotlin's `Result<T>` for expected failures

### Error Message Format

All error messages must follow this template:

```
{WHAT_HAPPENED}. {WHY_IT_HAPPENED}. Suggestion: {ACTIONABLE_STEP}.
```

**Example:**
```kotlin
throw IllegalArgumentException(
    "Public key must be exactly 64 hex characters, got ${hex.length}. " +
    "Suggestion: Ensure the key is a valid 32-byte secp256k1 public key encoded as hex."
)
```

### Creating Custom Exceptions

```kotlin
/**
 * Thrown when a voucher operation fails due to expired voucher.
 *
 * @param voucherId The ID of the expired voucher
 * @param expiresAt The expiration timestamp
 * @param cause The underlying cause (optional)
 */
class VoucherExpiredException(
    val voucherId: String,
    val expiresAt: Long,
    message: String,
    cause: Throwable? = null
) : Exception(message, cause)
```

### Throwing Exceptions

- **Context is king**: Include relevant context in error messages
- **Be specific**: "Failed to parse public key '${input}'" is better than "Invalid key"
- **Preserve the cause**: Always include the original exception as a cause when wrapping
- **Use require/check**: Use Kotlin's `require` for arguments, `check` for state

**Good Example:**
```kotlin
init {
    require(id.isNotBlank()) { "Identity ID cannot be blank" }
    require(label.trim().length in 1..100) {
        "Identity label must be 1-100 characters, got ${label.trim().length}"
    }
    require(publicKey.length == 64) {
        "Public key must be exactly 64 hex characters (32 bytes), got ${publicKey.length}"
    }
}
```

## Pull Requests

- Always follow the repository's PR submission guidelines
- Summarize the changes made and describe how they were tested
- Include any limitations or known issues in the description
- Ensure all new features are compliant with the Cashu specification (NUTs) provided above
- Reference the task in `project/kotlin-voucher-client-roadmap.md` if applicable

## Versioning and Commits

- Follow the semantic versioning rules described at [semver.org](https://semver.org/) when updating project versions
- Use conventional commit types to signal whether a change is a fix, feature, or breaking change
- After completing each task, update the task status and commit ID in `project/kotlin-voucher-client-roadmap.md`
- Always do multiple commits and avoid, as much as possible, group commits
- Each commit should represent a single logical change

## Logging

- Write each log entry to explain what happened, why it happened, and the resulting impact
- Keep formatting consistent: prefer structured logging with key-value pairs
- Include only the context needed to interpret the event—identifiers, parameters, correlation IDs
- Omit or mask secrets, personal data, and cryptographic material (except public keys)
- State the exact state transition or decision clearly
- For warnings and errors, name the failing operation, summarize the triggering condition, and note any user-facing impact
- Focus `DEBUG`/`TRACE` messages on diagnostic value by logging specific variables and branch choices
- Present dynamic data as ordered key-value pairs (e.g., `user_id=123`)
- Use neutral, professional language in all logs
- Avoid duplicating the same event across multiple levels or components
- Maintain tense consistency (present tense for in-progress actions, past tense for completed outcomes)

## Build Commands Reference

```bash
# Build all modules
./gradlew build

# Run all tests
./gradlew test

# Run tests for specific module
./gradlew :imani-identity:test
./gradlew :imani-voucher:test

# Run specific platform tests
./gradlew :imani-identity:jvmTest
./gradlew :imani-identity:jsTest

# Run specific test class
./gradlew :imani-identity:jvmTest --tests "IdentityTest"

# Clean build
./gradlew clean

# Run web app in development mode
./gradlew :imani-web:jsBrowserDevelopmentRun

# Check for dependency updates
./gradlew dependencyUpdates
```

## Migration from Java (cashu-client)

When converting Java code from the cashu-client project:

1. Consult `project/JAVA_TO_KOTLIN_MIGRATION.md` for intentional differences
2. Key differences to apply:
   - Convert byte arrays to hex strings for keys (KMP-friendly)
   - Use Kotlin data classes with immutability
   - Replace Java enums with Kotlin enums (sealed classes where appropriate)
   - Use kotlinx.datetime instead of java.time
   - Use kotlinx.serialization instead of Jackson
   - Remove nostr-java dependencies (platform-specific crypto in Phase 1+)
3. Maintain ~75% code reuse while adapting for Kotlin Multiplatform
4. Preserve all business logic and validation rules from Java
5. Document any intentional deviations in `project/JAVA_TO_KOTLIN_MIGRATION.md`
