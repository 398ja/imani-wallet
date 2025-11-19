# Android E2E Tests

End-to-end tests for Imani Wallet Android app, mirroring the Playwright tests in `/e2e/`.

## 📂 Test Structure

```
e2e/
├── fixtures/
│   └── ImaniTestFixtures.kt       # Helper functions (like fixtures.ts)
├── 00_SanityTest.kt                # Basic app loads and navigation
├── 01_BasicFlowTest.kt             # Navigation, tabs, back button
├── 02_IdentityFlowTest.kt          # Identity management
├── 03_VoucherFlowTest.kt           # Complete voucher lifecycle
├── 04_MobileSpecificTest.kt        # Android-specific (rotation, etc.)
├── 05_EdgeCasesTest.kt             # Edge cases and stress tests
└── README.md                       # This file
```

## 🎯 Test Coverage

### Sanity Tests (`00_SanityTest.kt`) - 3 tests
- ✅ App loads without crashing
- ✅ Bottom navigation works
- ✅ Navigate between tabs

### Basic Flow Tests (`01_BasicFlowTest.kt`) - 8 tests
- ✅ Load application and show navigation
- ✅ Navigate between all tabs
- ✅ Preserve tab state when switching
- ✅ Share data between tabs
- ✅ Handle back navigation correctly
- ✅ Switch to first tab on back from other tabs
- ✅ Show empty states on fresh install
- ✅ Handle rapid tab switching

### Identity Flow Tests (`02_IdentityFlowTest.kt`) - 5 tests
- ✅ Create new identity
- ✅ Display identity public key
- ✅ Show mnemonic backup phrase
- ✅ Import identity from mnemonic
- ✅ Reject invalid mnemonic

### Voucher Flow Tests (`03_VoucherFlowTest.kt`) - 8 tests
- ✅ Complete voucher lifecycle (issue → share → redeem)
- ✅ Voucher issuance with memo
- ✅ Voucher history
- ✅ Reject invalid voucher token
- ✅ Handle already-redeemed voucher
- ✅ Handle insufficient balance
- ✅ Handle network errors
- ✅ (Additional error scenarios)

### Mobile-Specific Tests (`04_MobileSpecificTest.kt`) - 10 tests
- ✅ Preserve state on screen rotation
- ✅ Preserve navigation state on rotation
- ✅ Preserve form input on rotation
- ✅ Handle system back button correctly
- ✅ Handle app backgrounding
- ✅ Trigger share intent
- ✅ Show biometric prompt if enabled
- ✅ Handle memory pressure
- ✅ Handle rapid rotations
- ✅ Work in landscape mode

### Edge Cases Tests (`05_EdgeCasesTest.kt`) - 15 tests
- ✅ Handle very long identity label
- ✅ Reject empty identity label
- ✅ Handle special characters in label
- ✅ Handle many identities (stress test)
- ✅ Reject zero amount voucher
- ✅ Reject negative amount voucher
- ✅ Handle very large amount
- ✅ Handle very long memo
- ✅ Reject malformed voucher token
- ✅ Prevent concurrent identity creation
- ✅ Maintain data consistency
- ✅ Completely clear data when requested
- ✅ (Additional edge cases)

**Total: 49 tests** (vs 21 web tests - 233% coverage due to mobile-specific tests!)

## 🚀 Running Tests

### Run All E2E Tests

```bash
# On connected device/emulator
./gradlew :imani-android:connectedAndroidTest

# On specific device
adb devices  # List devices
./gradlew :imani-android:connectedAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.deviceSerial=<DEVICE_ID>
```

### Run Specific Test Class

```bash
# Run sanity tests only
./gradlew :imani-android:connectedAndroidTest \
  --tests "cash.imani.android.e2e.SanityTest"

# Run identity flow tests
./gradlew :imani-android:connectedAndroidTest \
  --tests "cash.imani.android.e2e.IdentityFlowTest"

# Run voucher flow tests
./gradlew :imani-android:connectedAndroidTest \
  --tests "cash.imani.android.e2e.CompleteVoucherFlowTest"
```

### Run Specific Test Method

```bash
./gradlew :imani-android:connectedAndroidTest \
  --tests "cash.imani.android.e2e.SanityTest.should_load_the_application"
```

## 📊 Test Reports

After running tests, reports are generated at:

```
imani-android/build/reports/androidTests/connected/index.html
```

Open in browser:

```bash
open imani-android/build/reports/androidTests/connected/index.html
```

## 🎬 Recording Test Runs

### Take Screenshots on Failure

Tests automatically take screenshots on failure. Find them at:

```
imani-android/build/outputs/androidTest-results/connected/<DEVICE>/screenshots/
```

### Record Video (Emulator Only)

```bash
# Start screen recording
adb shell screenrecord /sdcard/test-recording.mp4

# Run tests in another terminal
./gradlew :imani-android:connectedAndroidTest

# Stop recording (Ctrl+C) and pull video
adb pull /sdcard/test-recording.mp4 .
```

## 🔧 Debugging Tests

### Run in Debug Mode

```bash
# Build debug APK
./gradlew :imani-android:assembleDebug

# Install on device
adb install imani-android/build/outputs/apk/debug/imani-android-debug.apk

# Run tests with debugger attached (from IDE)
# Set breakpoints in test files and run "Debug 'SanityTest'"
```

### View Logs

```bash
# Real-time logs while tests run
adb logcat | grep -E "E2E|TestRunner"

# Clear logs before test
adb logcat -c && ./gradlew :imani-android:connectedAndroidTest
```

## 🎭 Test Fixtures

The `ImaniTestFixtures` class provides helper methods that mirror Playwright fixtures:

### Navigation Helpers
- `waitForAppLoad()` - Wait for app to fully load
- `gotoIdentities()` - Navigate to Identities tab
- `gotoVouchers()` - Navigate to Vouchers tab
- `gotoSettings()` - Navigate to Settings tab

### Identity Helpers
- `createNewIdentity(label)` - Create a new identity
- `importIdentity(mnemonic, label)` - Import identity from mnemonic

### Voucher Helpers
- `issueVoucher(amount, memo?)` - Issue a new voucher
- `shareVoucher()` - Get voucher token for sharing
- `redeemVoucher(token)` - Redeem a voucher

### Assertion Helpers
- `expectIdentityExists(label)` - Assert identity is in list
- `expectVoucherInList(amount)` - Assert voucher is visible
- `expectBalance(amount)` - Assert balance matches
- `expectErrorToast(message)` - Assert error message shown
- `expectSuccessToast(message)` - Assert success message shown

### Storage Helpers
- `clearAppData()` - Clear all app data (like clearing localStorage in web)

## 📝 Writing New Tests

Follow this template:

```kotlin
package cash.imani.android.e2e

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import cash.imani.android.MainActivity
import cash.imani.android.e2e.fixtures.ImaniTestFixtures
import kotlinx.coroutines.test.runTest
import org.junit.Before
import org.junit.Rule
import org.junit.Test

class MyNewTest {

    @get:Rule
    val composeTestRule = createAndroidComposeRule<MainActivity>()

    private lateinit var fixtures: ImaniTestFixtures

    @Before
    fun setup() {
        fixtures = ImaniTestFixtures(composeTestRule)
        fixtures.clearAppData() // Start fresh
    }

    /**
     * Describe what this test does.
     */
    @Test
    fun should_do_something() = runTest {
        // Arrange
        fixtures.createNewIdentity("Test")

        // Act
        fixtures.issueVoucher(100)

        // Assert
        fixtures.expectVoucherInList(100)
    }
}
```

## 🐛 Common Issues

### Test Fails with "Node not found"
**Solution**: Increase timeouts or add `composeTestRule.waitForIdle()` before assertions.

### Test Fails Intermittently
**Solution**:
1. Disable animations (already configured in `testOptions`)
2. Add `delay(500)` after navigation
3. Use `waitUntil` instead of fixed delays

### Database Not Cleared Between Tests
**Solution**: Call `fixtures.clearAppData()` in `@Before` setup method.

### Tests Timeout
**Solution**: Increase timeout in `composeTestRule.waitUntil(timeoutMillis = 15000) { ... }`

## 🔗 Related Documentation

- [Compose Testing Cheat Sheet](https://developer.android.com/jetpack/compose/testing-cheatsheet)
- [Playwright E2E Tests](/e2e/README.md) - Web equivalent
- [Android Testing Guide](https://developer.android.com/training/testing)
- [Compose UI Testing](https://developer.android.com/jetpack/compose/testing)

## 📚 CI/CD Integration

### GitHub Actions

```yaml
name: Android E2E Tests

on:
  push:
    branches: [ main, develop, feature/* ]
  pull_request:
    branches: [ main ]

jobs:
  e2e-tests:
    runs-on: macos-latest

    steps:
      - uses: actions/checkout@v4

      - name: Set up JDK 21
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '21'

      - name: Run E2E tests
        uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 34
          arch: x86_64
          profile: pixel_6
          script: ./gradlew :imani-android:connectedAndroidTest

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-test-results
          path: |
            **/build/reports/androidTests/
            **/build/outputs/androidTest-results/
```

---

**Status**: 🚧 Tests implemented, awaiting UI feature completion

**Last Updated**: 2025-11-19
