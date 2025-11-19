# Android E2E Testing - Quick Start Guide

## ✅ Current Status

**E2E Tests**: ✅ 49 tests ready to run
**Compilation**: ✅ Build successful
**Test Files**: 7 files (1,898 lines of test code)

---

## 🚀 Running E2E Tests

### Prerequisites

1. **Android device or emulator** must be connected
2. **USB debugging** enabled (for physical devices)
3. **Android SDK** installed and `adb` in PATH

**⚠️ Important - Emulator Requirements**:
- **Recommended API Level**: API 34 (Android 14) or below
- **⚠️ Avoid API 36+**: Android 16 preview has breaking changes in `InputManager` that cause test failures
- **Minimum API Level**: API 26 (Android 8.0) as per app's `minSdk`

**Creating a compatible emulator** (Android Studio):
1. Tools → Device Manager → Create Device
2. Select: **Pixel 6** (or similar)
3. System Image: **API 34** (Android 14.0 - recommended) or **API 33** (Android 13.0)
4. Finish and start the emulator

### Check Connected Devices

```bash
adb devices -l
```

**Expected output:**
```
List of devices attached
emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
```

If no devices listed:
- **Emulator**: Start from Android Studio → Tools → Device Manager → Start emulator
- **Physical device**: Enable USB debugging in Developer Options

---

## 🎯 Running Tests

### Run All E2E Tests (49 tests)

```bash
./gradlew :imani-android:connectedAndroidTest
```

**Time**: ~10-15 minutes (on emulator)

### Run Specific Test Suite

```bash
# Sanity tests (3 tests, ~1 minute)
./gradlew :imani-android:connectedAndroidTest --tests "cash.imani.android.e2e.SanityTest"

# Basic flow tests (8 tests, ~3 minutes)
./gradlew :imani-android:connectedAndroidTest --tests "cash.imani.android.e2e.BasicFlowTest"

# Identity tests (5 tests, ~2 minutes)
./gradlew :imani-android:connectedAndroidTest --tests "cash.imani.android.e2e.IdentityFlowTest"

# Voucher tests (8 tests, ~4 minutes)
./gradlew :imani-android:connectedAndroidTest --tests "cash.imani.android.e2e.CompleteVoucherFlowTest"

# Mobile-specific tests (10 tests, ~5 minutes)
./gradlew :imani-android:connectedAndroidTest --tests "cash.imani.android.e2e.MobileSpecificTest"

# Edge cases (15 tests, ~6 minutes)
./gradlew :imani-android:connectedAndroidTest --tests "cash.imani.android.e2e.EdgeCasesTest"
```

### Run Single Test

```bash
./gradlew :imani-android:connectedAndroidTest \
  --tests "cash.imani.android.e2e.SanityTest.should_load_the_application"
```

---

## 📊 Viewing Test Results

### HTML Report

```bash
# Open test report in browser
open imani-android/build/reports/androidTests/connected/index.html

# Or manually navigate to:
imani-android/build/reports/androidTests/connected/index.html
```

### Terminal Output

```bash
# Run with detailed output
./gradlew :imani-android:connectedAndroidTest --info

# Watch logs in real-time
adb logcat | grep -E "TestRunner|E2E"
```

---

## 🐛 Troubleshooting

### Error: "No connected devices"

```bash
# Check device connection
adb devices

# Restart adb server
adb kill-server && adb start-server

# Check device is authorized
adb devices
# Should show "device" not "unauthorized"
```

### Error: "Installation failed"

```bash
# Uninstall old version
adb uninstall cash.imani.wallet.debug

# Clean and rebuild
./gradlew clean :imani-android:assembleDebugAndroidTest
```

### Error: "NoSuchMethodException: InputManager.getInstance"

**Symptom**:
```
java.lang.RuntimeException: java.util.concurrent.ExecutionException:
java.lang.RuntimeException: java.lang.NoSuchMethodException:
android.hardware.input.InputManager.getInstance []
```

**Cause**: Android 16 (API 36) preview has breaking changes in `InputManager`.

**Solution**: Use a stable API level emulator:

```bash
# Check emulator API level
adb shell getprop ro.build.version.sdk
# Output: 36 = Android 16 (problematic)
# Output: 34 = Android 14 (recommended)

# Solution: Create new emulator with API 34
# Android Studio → Tools → Device Manager → Create Device
# Select: API 34 (Android 14.0)
```

### Tests Timeout

```bash
# Increase timeout (add to gradle.properties)
android.testInstrumentationRunnerArguments.timeout_msec=600000

# Or run specific tests individually
```

### Emulator Performance Issues

```bash
# Use hardware acceleration
# Android Studio → Tools → AVD Manager → Edit Device → Show Advanced Settings
# Graphics: Hardware - GLES 2.0

# Or use a physical device (much faster!)
```

---

## 📈 Test Coverage Summary

| Test Suite | Tests | Time | Description |
|------------|-------|------|-------------|
| **Sanity** | 3 | ~1min | App loads, navigation works |
| **Basic Flow** | 8 | ~3min | Tabs, back button, state preservation |
| **Identity** | 5 | ~2min | Create, import, backup |
| **Voucher** | 8 | ~4min | Issue, share, redeem, errors |
| **Mobile-Specific** | 10 | ~5min | Rotation, landscape, backgrounding |
| **Edge Cases** | 15 | ~6min | Validation, stress tests |
| **TOTAL** | **49** | **~21min** | Full E2E coverage |

---

## 🎥 Recording Test Runs

### Take Screenshots on Failure

Screenshots automatically saved to:
```
imani-android/build/outputs/androidTest-results/connected/<device>/screenshots/
```

### Record Video (Emulator)

```bash
# Terminal 1: Start recording
adb shell screenrecord /sdcard/e2e-tests.mp4

# Terminal 2: Run tests
./gradlew :imani-android:connectedAndroidTest

# Terminal 1: Stop recording (Ctrl+C)
# Pull video
adb pull /sdcard/e2e-tests.mp4 .
```

---

## ⚡ Fast Development Workflow

### Run Tests During Development

```bash
# 1. Start emulator
emulator -avd Pixel_6_API_34 &

# 2. Watch for changes and run specific test
./gradlew :imani-android:connectedAndroidTest --tests "SanityTest" --continuous

# 3. Develop features, tests auto-run on changes
```

### Debug Single Test

```bash
# From Android Studio:
# 1. Open test file (e.g., 00_SanityTest.kt)
# 2. Right-click on test method
# 3. Select "Debug 'should_load_the_application'"
# 4. Set breakpoints in test or app code
```

---

## 📱 Running on Multiple Devices

### Run on All Connected Devices

```bash
# Gradle automatically detects all devices
./gradlew :imani-android:connectedAndroidTest

# View results for each device in report
```

### Run on Specific Device

```bash
# List devices
adb devices

# Run on specific device
./gradlew :imani-android:connectedAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.deviceSerial=emulator-5554
```

---

## 🔧 Advanced Options

### Test Sharding (Parallel Execution)

```gradle
// Add to build.gradle.kts testOptions:
shardCount = 4
shardIndex = 1  // Run shard 1 of 4
```

```bash
# Run sharded tests in parallel (4 terminals)
./gradlew :imani-android:connectedAndroidTest -PshardIndex=0 -PshardCount=4
./gradlew :imani-android:connectedAndroidTest -PshardIndex=1 -PshardCount=4
./gradlew :imani-android:connectedAndroidTest -PshardIndex=2 -PshardCount=4
./gradlew :imani-android:connectedAndroidTest -PshardIndex=3 -PshardCount=4
```

### Test Orchestrator (Isolated Tests)

```bash
# Run with orchestrator (prevents test pollution)
./gradlew :imani-android:connectedAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.clearPackageData=true
```

### Generate Coverage Report

```bash
# Run tests with coverage
./gradlew :imani-android:createDebugAndroidTestCoverageReport

# View report
open imani-android/build/reports/coverage/androidTest/debug/index.html
```

---

## 📚 Next Steps

1. **Run the tests**: Start with sanity tests to verify setup
2. **Review results**: Check HTML report for detailed results
3. **Debug failures**: Use Android Studio debugger for failing tests
4. **Add to CI/CD**: See `e2e/README.md` for GitHub Actions setup
5. **Maintain tests**: Update tests as features are added

---

## 🔗 Related Documentation

- [E2E Test Suite README](src/androidInstrumentedTest/kotlin/cash/imani/android/e2e/README.md)
- [E2E Testing Comparison (Web vs Android)](../docs/testing/E2E_TESTING_COMPARISON.md)
- [Android Testing Guide](https://developer.android.com/training/testing)
- [Compose UI Testing](https://developer.android.com/jetpack/compose/testing)

---

**Quick Command Reference:**

```bash
# Run all tests
./gradlew :imani-android:connectedAndroidTest

# Run specific suite
./gradlew :imani-android:connectedAndroidTest --tests "SanityTest"

# View results
open imani-android/build/reports/androidTests/connected/index.html

# Debug
adb logcat | grep E2E
```

Happy testing! 🚀
