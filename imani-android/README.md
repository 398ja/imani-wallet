# Imani Wallet Android

> Android application for Imani Wallet built with Kotlin Multiplatform and Jetpack Compose

## Prerequisites

### Android SDK Setup

The Android SDK is **required** to build and run the Android app. Follow these steps to set it up:

#### Option 1: Using Android Studio (Recommended)

1. Download and install [Android Studio](https://developer.android.com/studio)
2. Open Android Studio and go to **Tools > SDK Manager**
3. Install the following:
   - **Android SDK Platform 34** (Android 14)
   - **Android SDK Build-Tools 34.0.0** or higher
   - **Android SDK Platform-Tools**
   - **Android SDK Command-line Tools**
4. Android Studio will automatically create `local.properties` with the SDK path

#### Option 2: Command Line SDK Setup

1. Download Android Command Line Tools from https://developer.android.com/studio#command-tools
2. Extract to a directory (e.g., `~/Android/Sdk`)
3. Install required packages:
   ```bash
   cd ~/Android/Sdk/cmdline-tools/latest/bin
   ./sdkmanager "platforms;android-34" "build-tools;34.0.0" "platform-tools"
   ```
4. Create `local.properties` in project root:
   ```properties
   sdk.dir=/home/YOUR_USERNAME/Android/Sdk
   ```

#### Option 3: Environment Variable

Set the `ANDROID_HOME` environment variable:

```bash
# Add to ~/.bashrc or ~/.zshrc
export ANDROID_HOME=/home/YOUR_USERNAME/Android/Sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin
```

### Verify SDK Installation

```bash
# Check Android SDK path
echo $ANDROID_HOME

# Verify adb is accessible
adb version

# Verify sdkmanager is accessible
sdkmanager --list
```

---

## Building the App

### Debug Build

```bash
# Build debug APK
./gradlew :imani-android:assembleDebug

# Output: imani-android/build/outputs/apk/debug/imani-android-debug.apk
```

### Release Build

```bash
# Build release APK (requires signing configuration)
./gradlew :imani-android:assembleRelease

# Output: imani-android/build/outputs/apk/release/imani-android-release.apk
```

### Install on Device

```bash
# Install debug build to connected device/emulator
./gradlew :imani-android:installDebug

# Or use adb directly
adb install imani-android/build/outputs/apk/debug/imani-android-debug.apk
```

---

## Running Tests

### Unit Tests

```bash
# Run all unit tests (JVM + Android)
./gradlew :imani-android:test

# Run Android-specific unit tests
./gradlew :imani-android:testDebugUnitTest

# With coverage
./gradlew :imani-android:testDebugUnitTest jacocoTestReport
```

### Instrumentation Tests

**Requires a connected device or running emulator.**

```bash
# Run all instrumentation tests
./gradlew :imani-android:connectedAndroidTest

# Run specific test class
./gradlew :imani-android:connectedAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=cash.imani.android.flows.IdentityFlowTest

# With coverage
./gradlew :imani-android:connectedAndroidTest createDebugCoverageReport
```

### Test Coverage Report

```bash
# Generate combined coverage report (unit + instrumentation)
./gradlew :imani-android:jacocoTestReport

# Open report
open imani-android/build/reports/jacoco/jacocoTestReport/html/index.html
```

---

## Running the App

### Using Gradle

```bash
# Run on connected device/emulator
./gradlew :imani-android:installDebug

# Launch manually on device
adb shell am start -n cash.imani.wallet/.MainActivity
```

### Using Android Studio

1. Open project in Android Studio
2. Select `imani-android` run configuration
3. Choose device/emulator
4. Click **Run** (Shift+F10)

---

## Project Structure

```
imani-android/
├── src/
│   ├── androidMain/kotlin/cash/imani/android/
│   │   ├── MainActivity.kt           # App entry point
│   │   ├── di/                        # Dependency injection
│   │   ├── repository/                # Android-specific repositories
│   │   ├── security/                  # Biometric, Keystore
│   │   ├── ui/                        # Android-specific UI
│   │   └── AndroidModule.kt           # Koin module
│   │
│   ├── androidInstrumentedTest/kotlin/cash/imani/android/
│   │   ├── flows/                     # E2E flow tests
│   │   ├── repository/                # Repository tests
│   │   ├── security/                  # Security tests
│   │   └── ui/                        # UI component tests
│   │
│   ├── commonMain/sqldelight/         # SQLDelight schemas
│   │   └── cash/imani/android/db/
│   │       ├── Identity.sq
│   │       └── Voucher.sq
│   │
│   └── androidMain/res/               # Android resources
│       ├── xml/file_paths.xml         # FileProvider paths
│       └── values/strings.xml
│
├── build.gradle.kts                   # Build configuration
├── proguard-rules.pro                 # ProGuard rules
├── baseline-prof.txt                  # Baseline profile
├── DEVICE_TESTING.md                  # Testing guide
└── README.md                          # This file
```

---

## Key Features

### Implemented (Phase 4.1-4.3)

- ✅ **Identity Management**: Create, import, list, delete identities
- ✅ **Android Keystore**: Encrypted private key storage (AES-256-GCM)
- ✅ **SQLDelight Database**: Reactive queries with Flow
- ✅ **Biometric Authentication**: Fingerprint/Face unlock
- ✅ **Material 3 Theme**: Dynamic colors (Android 12+)
- ✅ **Bottom Navigation**: Identities, Vouchers, Settings tabs
- ✅ **QR Code Scanner**: CameraX + ML Kit
- ✅ **Share Functionality**: Android share sheet (text + QR image)
- ✅ **Lock Screen**: Graceful biometric fallback

### Test Coverage

- **Unit Tests**: 58 tests (repositories, security, UI)
- **Instrumentation Tests**: 34 tests (E2E flows, navigation, biometric)
- **Total**: 92 tests covering all critical paths

---

## Dependencies

See `gradle/libs.versions.toml` for version catalog.

### Core

- Kotlin 2.0.21
- Kotlin Multiplatform
- Jetpack Compose (Material 3)
- Koin 3.5.3

### Android-Specific

- AndroidX Core KTX
- AndroidX Lifecycle
- AndroidX Security Crypto (Keystore)
- AndroidX Biometric
- SQLDelight Android Driver

### Camera & QR

- CameraX (Camera2, Lifecycle, View)
- ZXing Core
- ML Kit Barcode Scanning
- Accompanist Permissions

### Reused Modules

- `imani-identity` - Identity management (KMP)
- `imani-voucher` - Voucher operations (KMP)
- `imani-app` - Shared Compose UI (KMP)

---

## Troubleshooting

### Build Fails: "SDK location not found"

**Cause**: Android SDK not configured.

**Solution**: Follow [Android SDK Setup](#android-sdk-setup) above.

### Build Fails: "Failed to find Build Tools revision 34.0.0"

**Cause**: Android SDK Build Tools not installed.

**Solution**:
```bash
sdkmanager "build-tools;34.0.0"
```

### Instrumentation Tests Fail: "No connected devices"

**Cause**: No device or emulator running.

**Solution**:
```bash
# Check connected devices
adb devices

# Start emulator (if installed)
emulator -avd Pixel_4_API_34 &
```

### App Crashes on Launch: "java.lang.SecurityException"

**Cause**: Missing permissions or biometric hardware issues.

**Solution**: Check logcat for specific error:
```bash
adb logcat | grep "cash.imani"
```

### QR Scanner Black Screen

**Cause**: Camera permission denied or CameraX initialization failed.

**Solution**: Grant camera permission in device Settings > Apps > Imani Wallet > Permissions.

---

## Performance Targets

| Metric | Target | How to Measure |
|--------|--------|----------------|
| **Cold Start** | <2s | `adb shell am start -W -n cash.imani.wallet/.MainActivity` |
| **APK Size** | <10MB | Check `build/outputs/apk/release/` |
| **Memory Usage** | <100MB | `adb shell dumpsys meminfo cash.imani.wallet` |
| **Frame Rate** | 60fps | `adb shell dumpsys gfxinfo cash.imani.wallet` |

See [DEVICE_TESTING.md](DEVICE_TESTING.md) for comprehensive performance profiling guide.

---

## Signing Configuration (Release Builds)

For release builds, create `keystore.properties` in project root:

```properties
storeFile=/path/to/your/keystore.jks
storePassword=YOUR_STORE_PASSWORD
keyAlias=YOUR_KEY_ALIAS
keyPassword=YOUR_KEY_PASSWORD
```

Then add to `build.gradle.kts`:

```kotlin
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

android {
    signingConfigs {
        create("release") {
            storeFile = file(keystoreProperties["storeFile"] as String)
            storePassword = keystoreProperties["storePassword"] as String
            keyAlias = keystoreProperties["keyAlias"] as String
            keyPassword = keystoreProperties["keyPassword"] as String
        }
    }
    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
        }
    }
}
```

---

## Development Status

### Phase 4.1: Android Module Setup ✅ DONE

- [x] Created module with KMP layout
- [x] Configured build.gradle.kts
- [x] Added AndroidManifest.xml
- [x] Created MainActivity and Application

### Phase 4.2: Platform-Specific Implementations ✅ DONE

- [x] Android Keystore wrapper (AES-256-GCM encryption)
- [x] SQLDelight Android database (Identity + Voucher schemas)
- [x] Biometric authentication
- [x] AndroidIdentityRepository (29 unit tests)
- [x] AndroidVoucherRepository (29 unit tests)

### Phase 4.3: Android UI Adaptations ✅ DONE

- [x] Material 3 theme with dynamic colors
- [x] Bottom navigation (3 tabs)
- [x] QR code scanner (CameraX + ML Kit)
- [x] Share functionality (text + QR image)
- [x] Lock screen with biometric

### Phase 4.4: Testing & Publishing (IN PROGRESS)

- [x] **Task 4.4.1**: Android Unit Tests (58 tests)
- [x] **Task 4.4.2**: Instrumentation Tests (34 tests)
- [x] **Task 4.4.3**: Device Testing Guide
- [ ] **Task 4.4.4**: Google Play Store Publishing

---

## Next Steps

- [ ] Run tests on physical devices (see [DEVICE_TESTING.md](DEVICE_TESTING.md))
- [ ] Profile performance with Android Studio Profiler
- [ ] Generate baseline profile for startup optimization
- [ ] Create signed release build
- [ ] Prepare Play Store listing (Task 4.4.4)

---

## Resources

- [Kotlin Multiplatform Documentation](https://kotlinlang.org/docs/multiplatform.html)
- [Jetpack Compose Documentation](https://developer.android.com/jetpack/compose)
- [Android Developer Guide](https://developer.android.com/guide)
- [SQLDelight Documentation](https://cashapp.github.io/sqldelight/)
- [Material 3 Design](https://m3.material.io/)

---

## License

See root project LICENSE file.
