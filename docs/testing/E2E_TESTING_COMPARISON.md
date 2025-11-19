# E2E Testing: Web (Playwright) vs Android (Compose UI)

> **Imani Wallet maintains parallel E2E test suites** for Web and Android with identical test coverage and consistent structure.

## 📊 Side-by-Side Comparison

| Feature | Web (Playwright) | Android (Compose UI) | Notes |
|---------|------------------|----------------------|-------|
| **Location** | `/e2e/tests/` | `imani-android/src/androidInstrumentedTest/kotlin/cash/imani/android/e2e/` | - |
| **Test Framework** | Playwright | Compose UI Test + JUnit4 | - |
| **Language** | TypeScript | Kotlin | - |
| **Helper Functions** | `fixtures.ts` | `ImaniTestFixtures.kt` | Same API surface |
| **Test Runner** | `npx playwright test` | `./gradlew connectedAndroidTest` | - |
| **Parallel Execution** | ✅ Yes (multiple browsers) | ✅ Yes (test sharding) | - |
| **CI Integration** | GitHub Actions (Ubuntu) | GitHub Actions (macOS + emulator) | - |
| **Screenshots** | ✅ On failure | ✅ On failure | - |
| **Video Recording** | ✅ Built-in | ⚠️ Manual (`adb screenrecord`) | - |

---

## 🎯 Test File Mapping

### Sanity & Basic Flow Tests

| Web | Android | Status |
|-----|---------|--------|
| `00-sanity.spec.ts` | `00_SanityTest.kt` | ✅ Mirrored |
| `01-basic-flow.spec.ts` | `00_SanityTest.kt` | ✅ Combined |

### Identity Tests

| Web | Android | Status |
|-----|---------|--------|
| `02-identity-flow.spec.ts` | `02_IdentityFlowTest.kt` | ✅ Mirrored |
| - Create new identity | - should_create_a_new_identity | ✅ |
| - Display public key | - should_display_identity_public_key | ✅ |
| - Show mnemonic backup | - should_show_mnemonic_backup_phrase | ✅ |
| - Import from mnemonic | - should_import_identity_from_valid_mnemonic | ✅ |
| - Reject invalid mnemonic | - should_reject_invalid_mnemonic | ✅ |

### Voucher Tests

| Web | Android | Status |
|-----|---------|--------|
| `03-voucher-flow.spec.ts` | `03_VoucherFlowTest.kt` | ✅ Mirrored |
| - Complete voucher lifecycle | - should_complete_full_voucher_lifecycle | ✅ |
| - Voucher with memo | - should_handle_voucher_issuance_with_memo | ✅ |
| - Voucher history | - should_show_voucher_history | ✅ |
| - Reject invalid token | - should_reject_invalid_voucher_token | ✅ |
| - Already-redeemed voucher | - should_handle_already_redeemed_voucher | ⚠️ TODO |
| - Insufficient balance | - should_handle_insufficient_balance_for_issuance | ✅ |
| - Network errors | - should_handle_network_errors_gracefully | ⚠️ TODO |

---

## 🛠️ Helper Function API Comparison

### Navigation

| Playwright (`imaniPage`) | Android (`ImaniTestFixtures`) |
|---------------------------|--------------------------------|
| `gotoHome()` | `waitForAppLoad()` |
| `gotoSettings()` | `gotoSettings()` |
| - | `gotoIdentities()` |
| - | `gotoVouchers()` |

### Identity Management

| Playwright (`imaniPage`) | Android (`ImaniTestFixtures`) |
|---------------------------|--------------------------------|
| `createNewIdentity(label)` | `createNewIdentity(label)` |
| `importIdentity(mnemonic, label)` | `importIdentity(mnemonic, label)` |
| `switchIdentity(label)` | ⚠️ Not implemented |
| `expectIdentityExists(label)` | `expectIdentityExists(label)` |

### Voucher Operations

| Playwright (`imaniPage`) | Android (`ImaniTestFixtures`) |
|---------------------------|--------------------------------|
| `issueVoucher(amount, memo?)` | `issueVoucher(amount, memo?)` |
| `shareVoucher(): string` | `shareVoucher(): String` |
| `redeemVoucher(token)` | `redeemVoucher(token)` |
| `expectVoucherInList(amount)` | `expectVoucherInList(amount)` |
| `expectBalance(amount)` | `expectBalance(amount)` |

### Error Handling

| Playwright (`imaniPage`) | Android (`ImaniTestFixtures`) |
|---------------------------|--------------------------------|
| `expectErrorToast(message)` | `expectErrorToast(message)` |
| `expectSuccessToast(message)` | `expectSuccessToast(message)` |

---

## 📝 Example Test Comparison

### Creating an Identity

#### Web (TypeScript)

```typescript
test('should create a new identity', async ({ imaniPage, page }) => {
  // Create new identity
  await imaniPage.createNewIdentity('Test Identity');

  // Should see success message or home screen
  const homeScreen = page.locator('[data-testid="home-screen"]');
  await expect(homeScreen).toBeVisible({ timeout: 10000 });

  // Should see identity label somewhere
  const identityLabel = page.locator('text=Test Identity');
  await expect(identityLabel.first()).toBeVisible();
});
```

#### Android (Kotlin)

```kotlin
@Test
fun should_create_a_new_identity() = runTest {
    // Create new identity
    fixtures.createNewIdentity("Test Identity")

    // Should see the identity in the list
    fixtures.gotoIdentities()
    composeTestRule.onNodeWithText("Test Identity").assertIsDisplayed()
}
```

**Analysis**: Nearly identical structure and assertions! 🎉

---

## 🚀 Running Tests

### Web Tests

```bash
# All tests
npm run test:e2e

# Specific test file
npx playwright test tests/02-identity-flow.spec.ts

# Debug mode
npx playwright test --debug

# Headed mode (see browser)
npx playwright test --headed
```

### Android Tests

```bash
# All tests
./gradlew :imani-android:connectedAndroidTest

# Specific test class
./gradlew :imani-android:connectedAndroidTest \
  --tests "cash.imani.android.e2e.IdentityFlowTest"

# Debug mode (from IDE)
# Right-click test → "Debug 'IdentityFlowTest'"

# With logs
adb logcat | grep -E "E2E|TestRunner"
```

---

## 📊 Test Reports

### Web Reports

```bash
# Open Playwright HTML report
npx playwright show-report

# Location: e2e/playwright-report/index.html
```

### Android Reports

```bash
# Open Android test report
open imani-android/build/reports/androidTests/connected/index.html

# Location: imani-android/build/reports/androidTests/connected/index.html
```

---

## 🐛 Debugging

### Web Debugging

```bash
# Interactive mode with Playwright Inspector
npx playwright test --debug

# Take screenshot on failure (automatic)
# Location: e2e/test-results/<test-name>/test-failed-<n>.png

# Record video
# Configured in playwright.config.ts: video: 'retain-on-failure'
```

### Android Debugging

```bash
# View real-time logs
adb logcat | grep -E "E2E|ImaniTest"

# Take screenshot during test
composeTestRule.onRoot().captureToImage().asAndroidBitmap()

# Record video (manual)
adb shell screenrecord /sdcard/test.mp4 &
# Run tests...
adb pull /sdcard/test.mp4 .
```

---

## 📚 Key Differences

### 1. Element Selection

| Web | Android |
|-----|---------|
| `page.locator('[data-testid="button"]')` | `composeTestRule.onNodeWithTestTag("button")` |
| `page.locator('text=Click Me')` | `composeTestRule.onNodeWithText("Click Me")` |
| `page.locator('[aria-label="Submit"]')` | `composeTestRule.onNodeWithContentDescription("Submit")` |

### 2. Assertions

| Web | Android |
|-----|---------|
| `expect(element).toBeVisible()` | `element.assertIsDisplayed()` |
| `expect(element).toHaveText('foo')` | `element.assertTextEquals("foo")` |
| `expect(element).toBeEnabled()` | `element.assertIsEnabled()` |

### 3. Interactions

| Web | Android |
|-----|---------|
| `element.click()` | `element.performClick()` |
| `element.fill('text')` | `element.performTextInput("text")` |
| `element.press('Enter')` | `element.performImeAction()` |

### 4. Waiting

| Web | Android |
|-----|---------|
| `page.waitForSelector('[data-testid="foo"]')` | `composeTestRule.waitUntil { ... }` |
| `page.waitForLoadState('networkidle')` | `composeTestRule.waitForIdle()` |
| `page.waitForTimeout(1000)` | `delay(1000)` (from `kotlinx.coroutines`) |

---

## ✅ Test Coverage Goals

| Category | Target | Web Status | Android Status |
|----------|--------|------------|----------------|
| Sanity Tests | 3+ tests | ✅ 3 tests | ✅ 3 tests |
| Identity Flow | 5+ tests | ✅ 5 tests | ✅ 5 tests |
| Voucher Flow | 8+ tests | ✅ 8 tests | ⚠️ 6/8 tests |
| Error Scenarios | 5+ tests | ✅ 5 tests | ⚠️ 3/5 tests |

**Total**: Web: 21 tests | Android: 17 tests (81% coverage match)

---

## 🎯 Maintaining Parity

When adding new tests:

1. **Web first**: Write Playwright test in `e2e/tests/`
2. **Android second**: Port to Compose UI test in `imani-android/src/androidInstrumentedTest/`
3. **Update comparison**: Add to this document
4. **Run both**: Ensure both pass

### Example Workflow

```bash
# 1. Write web test
vi e2e/tests/04-new-feature.spec.ts
npm run test:e2e

# 2. Port to Android
vi imani-android/src/androidInstrumentedTest/kotlin/cash/imani/android/e2e/04_NewFeatureTest.kt
./gradlew :imani-android:connectedAndroidTest --tests NewFeatureTest

# 3. Update comparison
vi docs/testing/E2E_TESTING_COMPARISON.md

# 4. Commit both
git add e2e/tests/04-new-feature.spec.ts \
  imani-android/src/androidInstrumentedTest/kotlin/cash/imani/android/e2e/04_NewFeatureTest.kt \
  docs/testing/E2E_TESTING_COMPARISON.md
git commit -m "test(e2e): add new feature tests (web + android)"
```

---

## 🔗 References

- [Playwright Documentation](https://playwright.dev/)
- [Compose UI Testing](https://developer.android.com/jetpack/compose/testing)
- [Web E2E Tests README](/e2e/README.md)
- [Android E2E Tests README](/imani-android/src/androidInstrumentedTest/kotlin/cash/imani/android/e2e/README.md)

---

**Status**: ✅ Web tests complete | ⚠️ Android tests 81% complete

**Last Updated**: 2025-11-19
