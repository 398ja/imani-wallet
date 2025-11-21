# Compose for Web Canvas Testing Limitations

**Document Type**: Explanation (Diátaxis)
**Last Updated**: 2025-11-21

## Overview

Imani Wallet uses **Compose Multiplatform for Web**, which renders the entire UI to a `<canvas>` element using Skiko (Skia for Kotlin). This approach has significant implications for E2E testing with tools like Playwright.

## The Problem

### Canvas Rendering vs DOM

Traditional web apps render UI as **DOM elements**:
```html
<button data-testid="shop-tab">Shop</button>
```

Compose for Web renders UI as **canvas pixels**:
```html
<canvas id="ComposeTarget"></canvas>
<!-- All UI is drawn here as pixels -->
```

**Result**: Playwright cannot:
- Find buttons by text (`page.click('text=Shop')`) ❌
- Query elements by test IDs (`page.locator('[data-testid="shop-tab"]')`) ❌
- Read text content (`page.textContent('.voucher-amount')`) ❌
- Fill form inputs (`page.fill('input[name=amount]', '100')`) ❌

## Current Test Coverage

### ✅ What Works (16 tests passing)

1. **Basic Application Tests**
   - Canvas visibility and dimensions
   - Page load without critical errors
   - Onboarding/home screen detection

2. **PWA Functionality**
   - Service worker registration
   - Manifest.json validation
   - Offline capability checks
   - PWA icon availability

3. **Security Tests**
   - CSP header validation (meta tag)
   - HTTPS requirements
   - Secure cookie settings

4. **Visual Regression Tests** (4 tests)
   - Screenshot comparison for:
     - Desktop home screen (1920x1080)
     - Mobile viewport (375x667)
     - Tablet viewport (768x1024)
     - Bottom navigation bar

5. **Canvas Interaction Tests** (4 tests)
   - Coordinate-based tab navigation
   - Click events via x/y positions
   - State changes detected via screenshots

### ❌ What's Skipped (30 tests)

1. **Identity Management** (6 tests)
   - Create identity with label
   - Display public key (npub)
   - Show mnemonic backup
   - Import from mnemonic
   - Validate invalid mnemonic

2. **Voucher Flow** (12 tests)
   - Issue voucher with amount/memo
   - Share voucher (QR code)
   - Redeem voucher token
   - Full lifecycle (Alice → Bob)
   - Error scenarios (invalid token, insufficient balance)
   - Voucher history display

3. **Marketplace Features** (8 tests)
   - Navigate to Shop/Merchant/Settings tabs (via text)
   - Merchant search and discovery
   - Create offer form
   - P2P transfer flows
   - Favorites persistence

4. **Mobile Responsiveness** (4 tests)
   - Touch-friendly button sizes (44x44px)
   - Portrait/landscape orientation
   - Device compatibility (iPhone, Pixel, iPad)
   - Text readability on small screens

## Testing Strategies for Canvas Apps

### 1. Coordinate-Based Clicking ✅ (Currently Used)

Click at specific x,y percentages of the canvas:

```typescript
async function clickCanvas(page: Page, xPercent: number, yPercent: number) {
  const canvas = page.locator('canvas#ComposeTarget');
  const box = await canvas.boundingBox();
  const x = box.x + (box.width * xPercent);
  const y = box.y + (box.height * yPercent);
  await page.mouse.click(x, y);
}

// Click Settings tab (bottom right)
await clickCanvas(page, 0.83, 0.96);
```

**Pros**:
- Works immediately
- No code changes needed
- Simple to implement

**Cons**:
- ⚠️ **Fragile**: Breaks when UI layout changes
- ⚠️ **Maintenance burden**: Must update coordinates for every UI change
- ⚠️ **No semantic meaning**: `0.83, 0.96` doesn't tell you what you're clicking

### 2. Visual Regression Testing ✅ (Currently Used)

Compare screenshots to detect changes:

```typescript
await expect(page).toHaveScreenshot('home-screen.png', {
  maxDiffPixelRatio: 0.05,
  threshold: 0.3,
});
```

**Pros**:
- Detects unintended visual changes
- Works for any canvas app
- Good for smoke testing

**Cons**:
- ⚠️ **False positives**: Font rendering, animations, timestamps
- ⚠️ **Storage**: Large baseline images
- ⚠️ **No interaction validation**: Only checks appearance

### 3. DOM Overlay Buttons ❌ (Attempted, abandoned)

Create invisible DOM buttons positioned over canvas elements:

```kotlin
// Overlay button at bottom navigation position
Button(
    onClick = { onTabSelected(AppTab.Shop) },
    modifier = Modifier
        .testable("shop-tab") // Creates DOM button
        .onGloballyPositioned { coordinates ->
            // Update button position
        }
)
```

**Why abandoned**:
- ⚠️ **Complex**: Requires expect/actual for each platform
- ⚠️ **Timing issues**: Must sync with Compose layout
- ⚠️ **Maintenance**: Double the code (Compose + overlay)
- ⚠️ **Performance**: Extra layout passes
- ⚠️ **Tests hung**: Initialization order problems

### 4. Native Test Frameworks ✅ (Recommended for Android/iOS)

Use platform-specific test tools that understand Compose:

**Android**:
```kotlin
@Test
fun testShopTabNavigation() {
    composeTestRule.onNodeWithTag("shop-tab").performClick()
    composeTestRule.onNodeWithText("My Vouchers").assertIsDisplayed()
}
```

**iOS**: Use XCUITest with accessibility identifiers

**Pros**:
- ✅ Native Compose semantics support
- ✅ Test tags and content descriptions work
- ✅ Stable, maintained by JetBrains

**Cons**:
- Only for native platforms (not web)

## Recommendations

### For Web Testing

1. **Keep coordinate-based tests minimal**
   - Only test critical paths (login, purchase flow)
   - Document coordinates clearly (`NAV.shop = { x: 0.17, y: 0.96 }`)
   - Update immediately when layout changes

2. **Focus on visual regression**
   - Test major screens (home, checkout, profile)
   - Use different viewports (mobile, tablet, desktop)
   - Review diffs carefully for false positives

3. **Test business logic separately**
   - Unit test ViewModels (state management)
   - Integration test repositories (network, storage)
   - Mock Compose UI layer

### For Native Testing

1. **Add semantic properties to Compose components**:
   ```kotlin
   Button(
       onClick = { ... },
       modifier = Modifier.semantics { testTag = "shop-tab" }
   ) {
       Text("Shop")
   }
   ```

2. **Write Android instrumented tests**:
   ```kotlin
   @Test
   fun completeVoucherFlow() {
       // Create identity
       composeTestRule.onNodeWithTag("create-identity-button").performClick()
       composeTestRule.onNodeWithTag("identity-label-input").performTextInput("Alice")

       // Issue voucher
       composeTestRule.onNodeWithTag("issue-voucher-button").performClick()
       composeTestRule.onNodeWithTag("amount-input").performTextInput("1000")

       // Assertions work naturally
       composeTestRule.onNodeWithText("Voucher issued").assertIsDisplayed()
   }
   ```

3. **Run on emulators/devices** in CI/CD

## Test Maintenance Guide

### When UI Layout Changes

1. **Update coordinate tests**:
   ```typescript
   // e2e/tests/07-canvas-interaction.spec.ts
   const NAV = {
     shop: { x: 0.17, y: 0.96 },      // Update these
     merchant: { x: 0.5, y: 0.96 },
     settings: { x: 0.83, y: 0.96 },
   };
   ```

2. **Regenerate visual baselines**:
   ```bash
   npx playwright test --update-snapshots
   ```

3. **Review diff reports** carefully

### When Adding New Features

1. **Web**: Add coordinate tests only if critical
2. **Android**: Add semantic tags + instrumented tests
3. **iOS**: Add accessibility identifiers + XCUITests

## Future Improvements

### Compose for Web Accessibility (Experimental)

JetBrains is working on DOM accessibility for Compose Web:
- **Semantic properties** exported to ARIA attributes
- **DOM overlay generation** for interactive elements
- **Screen reader support**

**Status**: Not production-ready (as of 2025-11)

**Track**: https://youtrack.jetbrains.com/issue/CMP-3410

### Alternative: Hybrid Rendering

Some apps use **Compose for UI + HTML forms**:
```kotlin
// Compose UI
Box {
    Canvas { /* Beautiful graphics */ }

    // HTML form overlay (testable)
    HtmlView {
        <input data-testid="amount-input" />
        <button data-testid="submit-button" />
    }
}
```

**Pros**: Best of both worlds
**Cons**: More complex, loses Compose benefits

## Summary

| Test Type | Web Support | Native Support | Recommended |
|-----------|-------------|----------------|-------------|
| Unit tests (ViewModel) | ✅ Full | ✅ Full | **Always** |
| Integration tests (Repo) | ✅ Full | ✅ Full | **Always** |
| Visual regression | ✅ Works | ✅ Works | **Web only** |
| Coordinate clicks | ⚠️ Fragile | N/A | **Minimal use** |
| Semantic testing | ❌ No DOM | ✅ Native APIs | **Native only** |

**Web E2E**: Accept limitations, focus on visual + critical paths
**Native E2E**: Full semantic testing with Compose test APIs

---

## Related Documents

- [Playwright Compose Testing](https://playwright.dev/docs/best-practices#testing-canvas-applications)
- [Compose Multiplatform Testing](https://www.jetbrains.com/help/kotlin-multiplatform-dev/compose-test.html)
- [Android Compose Testing](https://developer.android.com/jetpack/compose/testing)
- [Accessibility in Compose](https://developer.android.com/jetpack/compose/accessibility)
