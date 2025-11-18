# Imani Wallet

> **Built on Trust, Secured by Math**

Imani Wallet is a self-custody digital voucher application built with Kotlin Multiplatform. Imani (Swahili for "faith" and "trust") represents the 7th principle of Kwanzaa - trust in cryptography, community, and self-custody.

## About Imani

**Imani** (ee-MAH-nee) embodies:
- **Trust in Cryptography**: Mathematical proofs secure your value
- **Trust in Community**: Peer-to-peer exchange without intermediaries
- **Trust in Self**: Self-sovereign identity and self-custody
- **Trust in the System**: Transparent, open-source, verifiable code

## Features

- 🔐 **Self-Sovereign Identity**: You control your keys
- 🎁 **Digital Vouchers**: Issue and redeem value tokens
- 📱 **QR Code Sharing**: Instant, offline-capable transfers
- 🔄 **Nostr Relay Backup**: Decentralized, censorship-resistant
- ✅ **Cryptographic Verification**: Math-backed trust
- 🌍 **Cross-Platform**: Web, Android, iOS from one codebase

## Project Structure

```
imani-wallet/
├── imani-identity/     # Identity management module
├── imani-voucher/      # Voucher operations module
├── imani-app/          # Compose Multiplatform UI
└── imani-web/          # Web application deployment
```

## Getting Started

### Prerequisites

- **JDK 21+** (Temurin recommended)
- **Node.js 18+** (for web target)
- **IntelliJ IDEA 2023.3+** (Ultimate or Community Edition)
- **Git** for version control

> **Note**: Gradle 8.5 is included via the wrapper (`./gradlew`), no separate installation needed.

### Clone and Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/imani-wallet.git
cd imani-wallet

# Verify Gradle wrapper
./gradlew --version

# Build all modules
./gradlew build
```

### Development Workflow

#### IntelliJ IDEA Setup

1. **Open Project**: File → Open → Select `imani-wallet` directory
2. **Import as Gradle Project**: IntelliJ will auto-detect the Gradle structure
3. **SDK Configuration**: File → Project Structure → Project SDK → Set to JDK 21
4. **Gradle JVM**: Settings → Build, Execution, Deployment → Build Tools → Gradle → Gradle JVM → Set to Project SDK

#### Run Configurations

The project includes pre-configured run configurations in the `.run/` directory:

- **Build All**: Builds all modules (`./gradlew build`)
- **Test All**: Runs all tests (`./gradlew test`)
- **Run Web App (Dev)**: Starts web development server with hot reload
- **Ktlint Check**: Runs code style checks
- **Ktlint Format**: Auto-formats code to match style guidelines

Access these from the run configurations dropdown in IntelliJ IDEA.

#### Command Line Tasks

```bash
# Build all modules
./gradlew build

# Run web app in development mode (hot reload enabled)
./gradlew :imani-web:jsBrowserDevelopmentRun --continuous

# Run all tests
./gradlew test

# Run tests for specific module
./gradlew :imani-identity:test
./gradlew :imani-voucher:test

# Code style check
./gradlew ktlintCheck

# Auto-format code
./gradlew ktlintFormat

# Generate code coverage report
./gradlew koverXmlReport

# Clean build directories
./gradlew clean
```

### Code Style

This project uses **ktlint** for consistent Kotlin code formatting. Configuration is defined in `.editorconfig`.

**Before committing**, always run:
```bash
./gradlew ktlintFormat ktlintCheck
```

**IDE Integration** (IntelliJ IDEA):
- Settings → Editor → Code Style → Kotlin → Set from... → EditorConfig
- This will automatically apply ktlint rules in the IDE

### Testing

Tests follow **Clean Code** principles (Chapter 9: Unit Tests):
- **AAA Pattern**: Given/When/Then structure
- **F.I.R.S.T. Principles**: Fast, Independent, Repeatable, Self-Validating, Timely
- **Descriptive Names**: Use backticks for natural language test names

Example test structure:
```kotlin
@Test
fun `isActive returns true when last used within 90 days`() {
    // Given: Identity used 30 days ago
    val identity = createTestIdentity(lastUsedAt = 30.days.ago)

    // When: Checking if active
    val result = identity.isActive()

    // Then: Should be active
    assertTrue(result)
}
```

Run tests with:
```bash
./gradlew test                                  # All tests
./gradlew :imani-identity:jvmTest              # JVM tests only
./gradlew :imani-identity:jsTest               # JS tests only
```

### Web Development

To develop the web application:

```bash
# Start development server with hot reload
./gradlew :imani-web:jsBrowserDevelopmentRun --continuous

# Open browser to http://localhost:8080
```

The web app will automatically reload when you make changes to the code.

### Troubleshooting

**Gradle Build Fails**:
- Ensure JDK 21 is installed: `java -version`
- Clean and rebuild: `./gradlew clean build`

**Web App Not Starting**:
- Check Node.js version: `node --version` (requires 18+)
- Verify port 8080 is not in use

**IDE Not Recognizing Kotlin Files**:
- Invalidate Caches: File → Invalidate Caches → Invalidate and Restart
- Reimport Gradle project: Gradle sidebar → Reload All Gradle Projects

### Next Steps

- Read the [Implementation Roadmap](project/kotlin-voucher-client-roadmap.md) for project overview
- Check [AGENTS.md](AGENTS.md) for development guidelines and coding standards
- Review [CLAUDE.md](CLAUDE.md) for AI assistant integration guidelines

## Documentation

### Project Documentation
- [Implementation Roadmap](project/kotlin-voucher-client-roadmap.md)
- [Kotlin Client Technical Specification](project/explanation/kotlin-client-spec-detailed.md)
- [Web Client Specification (High-Level)](project/explanation/web-client-spec.md)
- [Web Client Detailed Specification](project/explanation/web-client-spec-detailed.md)

### Reference Documentation
- [NUT Specifications Analysis](docs/reference/nut-specifications-web-client-analysis.md)
- [How-To Guide: Kotlin Voucher Client Roadmap](docs/how-to/kotlin-voucher-client-roadmap.md)

## Technology Stack

- **Language**: Kotlin 1.9+
- **UI**: Compose Multiplatform 1.6+
- **HTTP**: Ktor Client 2.3+
- **Serialization**: kotlinx.serialization 1.6+
- **DI**: Koin 3.5+
- **Storage**: SQLDelight 2.0+

## License

See [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please see our contribution guidelines.

---

**Built with ❤️ using Kotlin Multiplatform**
