# Imani Wallet - E2E Test Gap Analysis

> **Document Type**: Reference (Diátaxis)
> **Purpose**: Identify missing E2E tests for comprehensive web app coverage
> **Created**: 2025-11-21
> **Status**: Draft for later implementation

---

## Table of Contents

1. [Current Test Coverage](#current-test-coverage)
2. [Gap Analysis by Feature](#gap-analysis-by-feature)
3. [Priority Matrix](#priority-matrix)
4. [Missing Test Specifications](#missing-test-specifications)
5. [Implementation Notes](#implementation-notes)

---

## Current Test Coverage

### Existing Test Files

| File | Coverage Area | Test Count | Status |
|------|---------------|------------|--------|
| `00-sanity.spec.ts` | Basic app load | ~2 | ✅ Good |
| `01-basic-flow.spec.ts` | App load, PWA, security headers | ~6 | ✅ Good |
| `02-identity-flow.spec.ts` | Create/import identity | ~5 | ⚠️ Partial |
| `03-voucher-flow.spec.ts` | Issue/share/redeem vouchers | ~6 | ⚠️ Partial |
| `04-mobile-responsive.spec.ts` | Mobile viewports, cross-browser | ~7 | ✅ Good |
| `05-marketplace-flow.spec.ts` | Shop/Merchant tabs, responsive | ~8 | ⚠️ Partial |

**Total Tests**: ~34
**Estimated Coverage**: 40%

---

## Gap Analysis by Feature

### Phase 1: Navigation & Foundation

| Feature | Current Coverage | Gap |
|---------|------------------|-----|
| Bottom tab navigation (Shop/Merchant/Settings) | ⚠️ Basic click test | Need full navigation flow tests |
| Tab persistence (state saved on tab switch) | ❌ Not tested | New tests needed |
| Deep linking (`/shop`, `/merchant`, `/settings`) | ❌ Not tested | New tests needed |
| Back button behavior | ❌ Not tested | New tests needed |

### Phase 2: Shop Tab (Customer Features)

| Feature | Current Coverage | Gap |
|---------|------------------|-----|
| Merchant discovery by npub | ⚠️ Basic test | Need full search flow |
| Merchant profile display | ❌ Not tested | New tests needed |
| Offer list display | ❌ Not tested | New tests needed |
| Purchase flow (select offer → pay Lightning) | ❌ Not tested | **Critical gap** |
| Lightning invoice display | ❌ Not tested | New tests needed |
| Payment status polling | ❌ Not tested | New tests needed |
| Voucher delivery after payment | ❌ Not tested | **Critical gap** |
| My Vouchers section | ⚠️ Basic test | Need grouped display test |
| Voucher status badges (ISSUED/REDEEMED) | ❌ Not tested | New tests needed |
| Voucher expiration display | ❌ Not tested | New tests needed |

### Phase 3: Merchant Tab (Business Features)

| Feature | Current Coverage | Gap |
|---------|------------------|-----|
| Merchant dashboard view | ⚠️ Basic visibility test | Need full flow |
| Sales metrics display | ❌ Not tested | New tests needed |
| Create offer flow | ❌ Not tested | **Critical gap** |
| Offer form validation | ❌ Not tested | New tests needed |
| Publish offer to Nostr | ❌ Not tested | **Critical gap** |
| Active offers list | ❌ Not tested | New tests needed |
| Edit/deactivate offer | ❌ Not tested | New tests needed |
| POS (Point of Sale) mode | ❌ Not tested | **Critical gap** |
| QR code scanner for redemption | ❌ Not tested | **Critical gap** |
| Partial redemption flow | ❌ Not tested | New tests needed |
| Sales reports/history | ❌ Not tested | New tests needed |
| Merchant profile setup | ❌ Not tested | New tests needed |
| Share npub (QR/copy) | ❌ Not tested | New tests needed |

### Phase 4: Enhanced Features

| Feature | Current Coverage | Gap |
|---------|------------------|-----|
| P2P voucher transfer (Send to Friend) | ❌ Not tested | **Critical gap** |
| Share voucher via QR | ❌ Not tested | New tests needed |
| Share voucher via clipboard | ❌ Not tested | New tests needed |
| Share voucher via system share | ❌ Not tested | New tests needed |
| Favorite merchants (add/remove) | ⚠️ localStorage test only | Need UI flow tests |
| Favorites persistence | ✅ Tested | Good |
| Camera QR scanner | ❌ Not tested | Requires camera mock |
| Responsive breakpoints (mobile/tablet/desktop) | ✅ Basic viewport tests | Need layout verification |
| Bottom nav (mobile) vs side nav (desktop) | ❌ Not tested | New tests needed |

### Phase 5: Polish & Production

| Feature | Current Coverage | Gap |
|---------|------------------|-----|
| Accessibility (screen reader) | ❌ Not tested | New tests needed |
| Keyboard navigation | ❌ Not tested | New tests needed |
| Focus indicators | ❌ Not tested | New tests needed |
| Error toast display | ⚠️ Helper exists | Need actual tests |
| Success toast display | ⚠️ Helper exists | Need actual tests |
| Network error handling | ⚠️ Basic test | Need full offline mode |
| Loading states | ❌ Not tested | New tests needed |
| Empty states | ❌ Not tested | New tests needed |

---

## Priority Matrix

### P0 - Critical (Block release)

1. **Purchase Flow E2E** - Customer discovers merchant → selects offer → pays Lightning → receives voucher
2. **Create Offer E2E** - Merchant creates offer → publishes to Nostr → visible to customers
3. **Redemption Flow E2E** - Customer shows voucher → Merchant scans → voucher redeemed
4. **P2P Transfer E2E** - User A sends voucher to User B → B redeems

### P1 - High (Core functionality)

5. **POS Mode** - Merchant enters POS → scans voucher → confirms redemption
6. **Partial Redemption** - Use 100 sat voucher for 30 sat purchase → 70 sat remaining
7. **Tab Navigation** - Switch between tabs → state preserved
8. **Merchant Discovery** - Search by npub → view profile → see offers

### P2 - Medium (Enhanced UX)

9. **Favorites Flow** - Star merchant → appears in favorites section
10. **QR Scanner** - Open scanner → detect QR → process token
11. **Error Handling** - Network offline → show error → retry succeeds
12. **Loading States** - Show skeleton → content loads → display data

### P3 - Low (Polish)

13. **Accessibility** - Keyboard nav, screen reader, focus
14. **Deep Links** - Direct URL to merchant profile
15. **Share Sheet** - System share integration
16. **Multiple Viewports** - Verify layout at each breakpoint

---

## Missing Test Specifications

### Test Suite: 06-purchase-flow.spec.ts

```typescript
/**
 * E2E tests for complete purchase flow.
 * P0 - Critical for release.
 */
test.describe('Purchase Flow', () => {
  test('should complete full purchase: discover → select → pay → receive', async ({ page }) => {
    // 1. Navigate to Shop tab
    // 2. Enter merchant npub in search
    // 3. View merchant profile
    // 4. Select an offer
    // 5. Click "Buy" button
    // 6. Verify Lightning invoice displayed (QR + bolt11)
    // 7. Mock Lightning payment (or use testnut)
    // 8. Verify voucher appears in "My Vouchers"
  });

  test('should show payment pending state while waiting', async ({ page }) => {
    // Verify polling UI and timeout handling
  });

  test('should handle payment failure gracefully', async ({ page }) => {
    // Verify error message and retry option
  });

  test('should handle invoice expiration', async ({ page }) => {
    // Invoice expires after X minutes
  });
});
```

### Test Suite: 07-merchant-flow.spec.ts

```typescript
/**
 * E2E tests for merchant operations.
 * P0/P1 - Critical for release.
 */
test.describe('Merchant Dashboard', () => {
  test('should create and publish new offer', async ({ page }) => {
    // 1. Navigate to Merchant tab
    // 2. Click "Create Offer"
    // 3. Fill offer form (name, description, price, quantity)
    // 4. Click "Publish"
    // 5. Verify offer appears in "Active Offers"
    // 6. Verify offer visible on Nostr (mock or real relay)
  });

  test('should display sales metrics', async ({ page }) => {
    // Verify today's sales, total revenue, active offers count
  });

  test('should deactivate an offer', async ({ page }) => {
    // Click deactivate → confirm → offer removed from active list
  });
});

test.describe('POS Mode', () => {
  test('should redeem voucher via QR scan', async ({ page }) => {
    // 1. Enter POS mode
    // 2. Mock camera with QR code image
    // 3. Verify voucher details displayed
    // 4. Confirm redemption
    // 5. Verify success message
  });

  test('should handle partial redemption', async ({ page }) => {
    // 100 sat voucher → 30 sat purchase → 70 sat change
  });

  test('should reject already-redeemed voucher', async ({ page }) => {
    // Scan same voucher twice → error on second attempt
  });

  test('should reject expired voucher', async ({ page }) => {
    // Scan expired voucher → show error
  });
});
```

### Test Suite: 08-p2p-transfer.spec.ts

```typescript
/**
 * E2E tests for P2P voucher transfers.
 * P0 - Critical for release.
 */
test.describe('P2P Transfer', () => {
  test('should send voucher to another user', async ({ page, context }) => {
    // 1. User A creates voucher
    // 2. User A clicks "Send to Friend"
    // 3. Copy token
    // 4. Open new tab as User B
    // 5. User B pastes token and redeems
    // 6. Verify User A's voucher marked as transferred
    // 7. Verify User B has voucher
  });

  test('should show QR code for sharing', async ({ page }) => {
    // Click share → verify QR code visible
  });

  test('should copy token to clipboard', async ({ page }) => {
    // Click copy → verify clipboard contains token
  });
});
```

### Test Suite: 09-navigation.spec.ts

```typescript
/**
 * E2E tests for navigation and state management.
 * P1 - High priority.
 */
test.describe('Tab Navigation', () => {
  test('should preserve state when switching tabs', async ({ page }) => {
    // 1. Go to Shop tab, start typing in search
    // 2. Switch to Merchant tab
    // 3. Switch back to Shop tab
    // 4. Verify search text preserved
  });

  test('should handle browser back button', async ({ page }) => {
    // Navigate deep → press back → verify correct screen
  });

  test('should support deep links', async ({ page }) => {
    // Go to /merchant directly → verify Merchant tab active
  });
});
```

### Test Suite: 10-accessibility.spec.ts

```typescript
/**
 * E2E tests for accessibility (WCAG 2.1 AA).
 * P3 - Polish.
 */
test.describe('Accessibility', () => {
  test('should support keyboard navigation', async ({ page }) => {
    // Tab through elements → verify focus order
  });

  test('should have visible focus indicators', async ({ page }) => {
    // Tab to button → verify focus ring visible
  });

  test('should announce to screen readers', async ({ page }) => {
    // Check aria-labels on key elements
  });

  test('should have sufficient color contrast', async ({ page }) => {
    // Use axe-playwright for automated contrast check
  });
});
```

---

## Implementation Notes

### Test Infrastructure Needs

1. **Camera Mock** - For QR scanner tests, need to inject mock video stream
2. **Lightning Mock** - For payment tests, either mock or use testnut.cashu.space
3. **Nostr Mock** - For publish/query tests, either mock or use local relay
4. **Clipboard API** - Browser clipboard API for copy tests
5. **axe-playwright** - For automated accessibility testing

### Compose Canvas Challenges

Since Imani Wallet uses Compose Multiplatform with canvas rendering:

- **No DOM elements** - Cannot use standard selectors (data-testid)
- **Text-based selectors** - Must use `text=` locators
- **Canvas clicks** - May need coordinate-based clicking for some elements
- **Accessibility** - Canvas renders text visually but may not expose to assistive tech

### Recommended Test Execution Order

1. Run `00-sanity.spec.ts` first (fast fail if broken)
2. Run `01-basic-flow.spec.ts` (app loads correctly)
3. Run `02-identity-flow.spec.ts` (identity works)
4. Run `06-purchase-flow.spec.ts` (P0 critical path)
5. Run `07-merchant-flow.spec.ts` (P0 critical path)
6. Run `08-p2p-transfer.spec.ts` (P0 critical path)
7. Run remaining tests in parallel

### Estimated Implementation Effort

| Test Suite | Estimated Time | Dependencies |
|------------|----------------|--------------|
| 06-purchase-flow | 2 days | Lightning mock |
| 07-merchant-flow | 2 days | Nostr mock, camera mock |
| 08-p2p-transfer | 1 day | Multi-context setup |
| 09-navigation | 0.5 days | None |
| 10-accessibility | 1 day | axe-playwright |

**Total**: ~6.5 days for full E2E coverage

---

## Summary

### Coverage Gap

- **Current**: ~40% coverage (basic flows, app load, responsive)
- **Target**: ~90% coverage (all P0/P1 features)
- **Missing**: ~50% (purchase, merchant, POS, P2P, navigation)

### Critical Missing Tests (P0)

1. ❌ Purchase flow (discover → pay → receive)
2. ❌ Create offer flow (form → publish → visible)
3. ❌ Redemption flow (scan → redeem → confirm)
4. ❌ P2P transfer flow (send → receive → redeem)

### Recommended Next Steps

1. Implement Lightning payment mock (testnut integration)
2. Implement camera mock for QR scanner
3. Write P0 test suites (06, 07, 08)
4. Add to CI pipeline
5. Track coverage metrics

---

*Last updated: 2025-11-21*
