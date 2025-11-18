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

- JDK 21+
- Gradle 8.5+
- Node.js 18+ (for web target)

### Build

```bash
# Build all modules
./gradlew build

# Run web app in development mode
./gradlew :imani-web:jsBrowserDevelopmentRun

# Run tests
./gradlew test
```

## Documentation

- [Implementation Roadmap](../cashu-client/docs/how-to/kotlin-voucher-client-roadmap.md)
- [Technical Specification](../cashu-client/docs/explanation/kotlin-client-spec-detailed.md)

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
