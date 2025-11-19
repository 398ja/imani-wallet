# Imani Wallet Android - Device Testing & Optimization Guide

> **Document Type**: How-To Guide (Diátaxis)
> **Version**: 1.0.0
> **Last Updated**: 2025-11-19

This guide provides comprehensive instructions for testing Imani Wallet Android on physical devices and optimizing performance.

---

## Table of Contents

1. [Device Testing Checklist](#device-testing-checklist)
2. [Performance Profiling](#performance-profiling)
3. [Memory Optimization](#memory-optimization)
4. [Battery Usage Optimization](#battery-usage-optimization)
5. [APK Size Optimization](#apk-size-optimization)
6. [Testing Tools](#testing-tools)

---

## Device Testing Checklist

### Minimum Test Devices

Test on at least **3 physical devices** covering:

| Device Type | Android Version | Screen Size | Biometric |
|-------------|-----------------|-------------|-----------|
| **Low-End** | Android 8.0 (API 26) | 5.5" 720p | Fingerprint |
| **Mid-Range** | Android 10 (API 29) | 6.1" 1080p | Fingerprint + Face |
| **High-End** | Android 14 (API 34) | 6.7" 1440p | Ultrasonic FP + Face |

### Recommended Test Devices

- **Samsung Galaxy A series** (mid-range, common)
- **Google Pixel 4a or newer** (stock Android)
- **Xiaomi/Redmi** (MIUI variations)
- **OnePlus** (OxygenOS)

### Critical Test Scenarios

#### 1. First Launch Experience

- [ ] **Fresh Install**: Uninstall previous version, clear data, install clean
- [ ] **Biometric Enrollment**: Test with/without biometric enrolled
- [ ] **Permissions**: Camera permission request flow
- [ ] **App Launch Time**: Measure cold start time (should be <2s)
- [ ] **Initial DB Creation**: Verify SQLDelight database initializes correctly

#### 2. Identity Management

- [ ] **Create Identity**: Generate keypair, display mnemonic, save to DB
- [ ] **Import Identity**: Test 12-word and 24-word mnemonic import
- [ ] **List Identities**: Display multiple identities, correct sorting
- [ ] **Delete Identity**: Confirm deletion, verify DB removal
- [ ] **Private Key Security**: Verify keys encrypted at rest (check with Android Studio Database Inspector)

#### 3. Biometric Authentication

- [ ] **Available State**: Test with biometric enrolled
- [ ] **Not Enrolled State**: Test without biometric enrolled
- [ ] **Hardware Unavailable**: Test on device without biometric hardware
- [ ] **Failed Authentication**: Intentionally fail biometric, verify retry flow
- [ ] **Fallback**: Verify graceful fallback when biometric fails

#### 4. Voucher Operations

- [ ] **Issue Voucher**: Create voucher with mint, verify proofs selected
- [ ] **Share Voucher**: Generate QR code, share via Android share sheet
- [ ] **Redeem Voucher**: Scan QR code or paste token, verify redemption
- [ ] **Offline Mode**: Test voucher operations with no internet (should cache)
- [ ] **Sync**: Verify Nostr relay sync when back online

#### 5. QR Code Scanning

- [ ] **Camera Permission**: Request permission, handle denial
- [ ] **QR Detection**: Scan voucher QR codes (use test QR codes)
- [ ] **Low Light**: Test scanning in various lighting conditions
- [ ] **Camera Focus**: Verify auto-focus works correctly
- [ ] **Multiple Codes**: Test with multiple QR codes in frame (should detect first)

#### 6. Navigation & UI

- [ ] **Bottom Navigation**: Switch between all 3 tabs, verify state preservation
- [ ] **Back Button**: Test Android back button behavior
- [ ] **Deep Links**: Test `cashu://` deep link handling
- [ ] **Rotation**: Test portrait/landscape orientation changes
- [ ] **Dark Mode**: Test with system dark mode on/off
- [ ] **Dynamic Colors**: Test on Android 12+ with Material You colors

#### 7. Error Handling

- [ ] **Network Errors**: Test with airplane mode, verify error messages
- [ ] **Invalid Token**: Try redeeming invalid voucher token
- [ ] **Mint Unavailable**: Test with mint server down
- [ ] **Database Errors**: Test with corrupted database (rare)
- [ ] **Crash Recovery**: Force stop app, verify state recovery on restart

#### 8. Performance

- [ ] **Smooth Scrolling**: Long identity/voucher lists scroll smoothly (60fps)
- [ ] **Crypto Operations**: Keypair generation completes in <1s
- [ ] **Database Queries**: List queries complete in <100ms
- [ ] **QR Generation**: QR code generates in <500ms
- [ ] **Memory Usage**: App uses <100MB RAM during normal operation

#### 9. Battery & Resource Usage

- [ ] **Background Drain**: No excessive battery drain when app in background
- [ ] **CPU Usage**: Idle app uses <1% CPU
- [ ] **Network Usage**: Minimal data usage (only Nostr relay + mint API)
- [ ] **Storage**: App + data uses <50MB storage

#### 10. Security

- [ ] **Private Keys**: Never visible in logs or UI
- [ ] **Encrypted Storage**: Verify Android Keystore encryption
- [ ] **Screenshot Protection**: Sensitive screens block screenshots (optional)
- [ ] **App Lock**: Biometric required after app backgrounded >5 minutes (optional)

---

## Performance Profiling

### Android Studio Profiler

#### CPU Profiling

```bash
# Run app with CPU profiler
./gradlew installDebug
# Open Android Studio > View > Tool Windows > Profiler
# Select device and app > CPU tab > Record
# Perform actions (create identity, issue voucher)
# Stop recording and analyze flame graph
```

**Target Metrics**:
- Identity creation: <1s total CPU time
- Voucher issuance: <500ms (excluding network)
- QR code generation: <200ms
- Database query: <50ms

#### Memory Profiling

```bash
# Monitor memory allocation
# Profiler > Memory tab > Record allocations
# Look for memory leaks and excessive allocations
```

**Target Metrics**:
- Total memory usage: <100MB
- No memory leaks (heap size should stabilize)
- GC frequency: <1 per minute during idle

#### Network Profiling

```bash
# Monitor network requests
# Profiler > Network tab
# Verify all requests to mint and Nostr relays
```

**Target Metrics**:
- Mint API: <500ms per request
- Nostr relay: <1s for publish/query
- Total data usage: <1MB per session

### Baseline Profile

Generate Baseline Profile for startup optimization:

```bash
# Generate baseline profile
./gradlew :imani-android:generateBaselineProfile

# Verify generated profile
cat imani-android/src/main/baseline-prof.txt
```

### Systrace

For detailed frame timing analysis:

```bash
# Capture systrace
adb shell atrace --async_start gfx input view webview
# Use app for 10 seconds
adb shell atrace --async_stop > trace.html
# Open trace.html in Chrome at chrome://tracing
```

---

## Memory Optimization

### Leak Detection

#### LeakCanary Integration

Add to `build.gradle.kts` (debug builds only):

```kotlin
dependencies {
    debugImplementation("com.squareup.leakcanary:leakcanary-android:2.13")
}
```

Run app in debug mode and monitor logcat for leak reports.

### Memory Analysis Checklist

- [ ] **Bitmap Management**: QR code bitmaps properly recycled
- [ ] **Coroutine Scopes**: All coroutines properly cancelled
- [ ] **Database Cursors**: SQLDelight queries don't leak cursors
- [ ] **Camera Resources**: Camera properly released after scanning
- [ ] **ViewModels**: No activity/fragment references in ViewModels

### Memory Budget

| Component | Memory Budget |
|-----------|---------------|
| UI Layer | 30MB |
| Database | 20MB |
| Crypto Operations | 15MB |
| Image Cache (QR codes) | 10MB |
| Network Cache | 10MB |
| Other | 15MB |
| **Total** | **100MB** |

---

## Battery Usage Optimization

### Battery Testing

```bash
# Reset battery stats
adb shell dumpsys batterystats --reset

# Use app for 1 hour
# Check battery usage
adb shell dumpsys batterystats > battery.txt
# Analyze battery.txt for app usage
```

### Optimization Checklist

- [ ] **No Background Services**: App has no long-running background services
- [ ] **WorkManager**: Use WorkManager for deferred tasks (Nostr sync)
- [ ] **WakeLocks**: No unnecessary wakelocks
- [ ] **Location**: No location access (not needed)
- [ ] **Network**: Batch network requests, use exponential backoff

### Doze Mode Testing

```bash
# Force device into Doze mode
adb shell dumpsys deviceidle force-idle

# Verify app behavior
# Exit Doze mode
adb shell dumpsys deviceidle unforce
```

**Expected Behavior**: App should function normally after exiting Doze mode, with pending operations resuming.

---

## APK Size Optimization

### Current APK Size

```bash
# Build release APK
./gradlew :imani-android:assembleRelease

# Check size
ls -lh imani-android/build/outputs/apk/release/

# Target: <10MB
```

### Size Breakdown

```bash
# Analyze APK contents
./gradlew :imani-android:analyzeReleaseBundle
# Opens Android Studio APK Analyzer
```

### Optimization Techniques

#### 1. R8/ProGuard

Already configured in `build.gradle.kts`:

```kotlin
buildTypes {
    release {
        isMinifyEnabled = true
        proguardFiles(
            getDefaultProguardFile("proguard-android-optimize.txt"),
            "proguard-rules.pro"
        )
    }
}
```

#### 2. Resource Shrinking

Enable in `build.gradle.kts`:

```kotlin
buildTypes {
    release {
        isShrinkResources = true
    }
}
```

#### 3. Vector Drawables

Use vector drawables instead of PNG for icons (already using Material Icons).

#### 4. WebP Images

Convert any PNG/JPG images to WebP:

```bash
# Convert PNG to WebP
for file in *.png; do
    cwebp -q 80 "$file" -o "${file%.png}.webp"
done
```

#### 5. Split APKs

Generate split APKs for different architectures:

```kotlin
android {
    splits {
        abi {
            isEnable = true
            reset()
            include("armeabi-v7a", "arm64-v8a", "x86", "x86_64")
            isUniversalApk = false
        }
    }
}
```

#### 6. App Bundle

Use Android App Bundle (AAB) for Play Store:

```bash
# Build AAB
./gradlew :imani-android:bundleRelease

# Output: imani-android/build/outputs/bundle/release/imani-android-release.aab
```

**AAB Benefits**:
- Dynamic feature delivery
- Per-device APK optimization
- ~20% smaller than universal APK

### Size Target

| Size Metric | Target | Achieved |
|-------------|--------|----------|
| **APK Size** | <10MB | TBD |
| **AAB Size** | <8MB | TBD |
| **Download Size** | <5MB | TBD (Play Store compression) |

---

## Testing Tools

### Recommended Tools

#### 1. Android Studio Profiler

- CPU, Memory, Network, Energy profiling
- Built-in, no setup required

#### 2. Scrcpy

Mirror Android screen to desktop for testing:

```bash
# Install scrcpy
brew install scrcpy  # macOS
sudo apt install scrcpy  # Linux

# Run
scrcpy
```

#### 3. ADB Logcat Filtering

Filter logs for Imani Wallet:

```bash
# Show only app logs
adb logcat | grep "cash.imani"

# Show errors only
adb logcat *:E | grep "cash.imani"

# Save to file
adb logcat > logcat.txt
```

#### 4. Firebase Test Lab (Optional)

Test on 20+ device configurations:

```bash
# Build debug APK and test APK
./gradlew assembleDebug assembleDebugAndroidTest

# Upload to Firebase Test Lab (requires Firebase account)
gcloud firebase test android run \
  --type instrumentation \
  --app imani-android/build/outputs/apk/debug/imani-android-debug.apk \
  --test imani-android/build/outputs/apk/androidTest/debug/imani-android-debug-androidTest.apk \
  --device model=Pixel2,version=28,locale=en,orientation=portrait
```

#### 5. Monkey Testing

Random UI stress testing:

```bash
# Run monkey test (1000 random events)
adb shell monkey -p cash.imani.wallet -v 1000
```

App should not crash during monkey testing.

---

## Performance Benchmarks

### Baseline Metrics (Pixel 4a, Android 11)

| Metric | Target | Achieved | Status |
|--------|--------|----------|--------|
| **Cold Start Time** | <2s | TBD | ⏳ |
| **Identity Creation** | <1s | TBD | ⏳ |
| **Voucher Issuance** | <2s | TBD | ⏳ |
| **QR Code Generation** | <500ms | TBD | ⏳ |
| **QR Code Scanning** | <1s | TBD | ⏳ |
| **Database Query** | <100ms | TBD | ⏳ |
| **Memory Usage** | <100MB | TBD | ⏳ |
| **APK Size** | <10MB | TBD | ⏳ |
| **Frame Rate** | 60fps | TBD | ⏳ |

### How to Measure

#### Cold Start Time

```bash
# Measure cold start
adb shell am start -W -n cash.imani.wallet/.MainActivity
# Look for "TotalTime" in output
```

#### Frame Rate

```bash
# Monitor frame rate
adb shell dumpsys gfxinfo cash.imani.wallet
# Look for "Janky frames" (should be <5%)
```

#### Memory Usage

```bash
# Check memory
adb shell dumpsys meminfo cash.imani.wallet
# Look for "TOTAL PSS" (should be <100MB)
```

---

## Optimization Results

After implementing optimizations, document results here:

### Before Optimization

- Cold start: ___ s
- Memory usage: ___ MB
- APK size: ___ MB
- Frame drops: ___% janky frames

### After Optimization

- Cold start: ___ s (___% improvement)
- Memory usage: ___ MB (___% reduction)
- APK size: ___ MB (___% reduction)
- Frame drops: ___% janky frames (___% improvement)

---

## Continuous Monitoring

### CI/CD Integration

Add performance checks to CI pipeline:

```yaml
# .github/workflows/android-performance.yml
name: Android Performance

on: [pull_request]

jobs:
  performance:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v3
      - name: Set up JDK 17
        uses: actions/setup-java@v3
        with:
          distribution: 'temurin'
          java-version: '17'
      - name: Build release APK
        run: ./gradlew assembleRelease
      - name: Check APK size
        run: |
          APK_SIZE=$(stat -f%z imani-android/build/outputs/apk/release/imani-android-release.apk)
          MAX_SIZE=$((10 * 1024 * 1024))  # 10MB
          if [ $APK_SIZE -gt $MAX_SIZE ]; then
            echo "APK size ($APK_SIZE bytes) exceeds limit ($MAX_SIZE bytes)"
            exit 1
          fi
```

---

## Troubleshooting

### Common Issues

#### 1. Slow QR Code Generation

**Symptom**: QR code takes >1s to generate
**Fix**: Use lower resolution (512x512 instead of 1024x1024)

#### 2. Memory Leaks in Camera

**Symptom**: Memory grows during QR scanning
**Fix**: Ensure CameraX executor is properly shut down in `DisposableEffect`

#### 3. Janky Scrolling

**Symptom**: Identity/voucher list scrolls at <60fps
**Fix**: Use `LazyColumn` (already implemented), ensure no heavy operations in `@Composable`

#### 4. Large APK Size

**Symptom**: APK >15MB
**Fix**: Enable R8 minification, resource shrinking, use App Bundle

---

## Next Steps

After completing device testing:

1. **Document Results**: Fill in benchmark table with actual measurements
2. **Fix Issues**: Address any performance or compatibility issues found
3. **Regression Tests**: Add performance regression tests to CI/CD
4. **User Testing**: Conduct beta testing with real users
5. **Play Store**: Proceed to Task 4.4.4 (Google Play Store publishing)

---

## References

- [Android Performance Best Practices](https://developer.android.com/topic/performance)
- [Android Studio Profiler](https://developer.android.com/studio/profile)
- [Android App Bundle](https://developer.android.com/guide/app-bundle)
- [Baseline Profiles](https://developer.android.com/topic/performance/baselineprofiles)
- [Firebase Test Lab](https://firebase.google.com/docs/test-lab)
