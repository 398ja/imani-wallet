# Imani Wallet - Android Port

Android application for Imani Wallet, built with Kotlin Multiplatform and Jetpack Compose.

## Prerequisites

- **Android SDK**: Install Android SDK via Android Studio or command-line tools
- **Android SDK Version**: API 26+ (Android 8.0) to API 34 (Android 14)
- **Java Version**: JDK 17

## Setup

### 1. Configure Android SDK

Create `local.properties` in the project root with your Android SDK path:

```properties
# local.properties (DO NOT commit this file)
sdk.dir=/path/to/your/Android/Sdk
```

Or set the `ANDROID_HOME` environment variable:

```bash
export ANDROID_HOME=/path/to/your/Android/Sdk
```

### 2. Build the Module

```bash
# From project root
./gradlew :imani-android:assemble

# Build debug APK
./gradlew :imani-android:assembleDebug

# Build release AAB
./gradlew :imani-android:bundleRelease
```

### 3. Run on Device/Emulator

```bash
# Install debug build
./gradlew :imani-android:installDebug

# Or use Android Studio:
# Open project -> Run 'imani-android' configuration
```

## Module Structure

```
imani-android/
├── src/
│   ├── androidMain/
│   │   ├── kotlin/cash/imani/android/
│   │   │   ├── ImaniApplication.kt
│   │   │   └── MainActivity.kt
│   │   ├── AndroidManifest.xml
│   │   └── res/
│   │       ├── values/
│   │       │   ├── strings.xml
│   │       │   ├── colors.xml
│   │       │   └── themes.xml
│   │       └── xml/
│   │           └── file_paths.xml
│   ├── androidUnitTest/
│   └── androidInstrumentedTest/
├── build.gradle.kts
└── proguard-rules.pro
```

## Key Features

- **Reuses cashu-client Java code**: Leverages existing Java modules for crypto and business logic
- **Android Keystore**: Secure private key storage
- **Jetpack Compose UI**: Reuses `imani-app` Compose code
- **Material 3 Design**: Imani brand colors and design system
- **SQLDelight**: Local database with Android driver
- **Camera support**: QR code scanning for voucher redemption
- **Biometric authentication**: Fingerprint and face unlock
- **Deep linking**: Handles `cashu://` URLs

## Development Status

✅ **Phase 4.1.1 - Android Module Setup**: COMPLETED
- [x] Created module directory structure (KMP layout)
- [x] Configured build.gradle.kts with dependencies
- [x] Added AndroidManifest.xml with permissions
- [x] Created minimal Android resources (strings, colors, themes)
- [x] Added ProGuard rules
- [x] Created stub MainActivity and ImaniApplication

📋 **Next Tasks** (see [android-port-roadmap.md](../project/android-port-roadmap.md)):
- [ ] Task 4.2.1: Android Keystore Wrapper
- [ ] Task 4.2.2: SQLDelight Android Database
- [ ] Task 4.3.1: Material 3 Theme
- [ ] Task 4.3.2: Android Navigation

## Dependencies

See `gradle/libs.versions.toml` for complete dependency list.

Key Android dependencies:
- androidx.core:core-ktx:1.12.0
- androidx.activity:activity-compose:1.8.2
- androidx.security:security-crypto:1.1.0-alpha06
- androidx.biometric:biometric:1.2.0-alpha05
- androidx.camera:camera-camera2:1.3.1
- com.google.zxing:core:3.5.3
- app.cash.sqldelight:android-driver:2.0.1

## Testing

```bash
# Run unit tests
./gradlew :imani-android:testDebugUnitTest

# Run instrumentation tests (requires connected device/emulator)
./gradlew :imani-android:connectedAndroidTest
```

## Code Reuse Strategy

This Android port **heavily reuses** existing code:

1. **cashu-client Java modules** (~90%):
   - Identity management (crypto, keys, signing)
   - Nostr integration (event publishing, querying)
   - Proof management (selection, validation)
   - Mint API client (all NUT endpoints)

2. **imani-app Compose UI** (100%):
   - All screens and components shared via KMP
   - Only Android-specific features added (camera, biometric, sharing)

3. **New Android code** (~10%):
   - Android Keystore wrapper for key encryption
   - SQLDelight database adapters
   - Platform-specific features (CameraX, BiometricPrompt, ShareSheet)

## License

See [LICENSE](../LICENSE) file.
