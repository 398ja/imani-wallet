# Imani Wallet E2E Tests

End-to-end tests for Imani Wallet using Playwright.

## Setup

```bash
cd e2e
npm install
npx playwright install --with-deps
```

## Running Tests

### All Tests (All Browsers)
```bash
npm test
```

### Specific Browser
```bash
npm run test:chrome   # Chromium only
npm run test:firefox  # Firefox only
npm run test:safari   # WebKit (Safari) only
```

### Mobile Tests
```bash
npm run test:mobile   # Mobile viewports
```

### Development
```bash
npm run test:headed   # See browser window
npm run test:debug    # Debug mode with Playwright Inspector
npm run test:ui       # Interactive UI mode
```

## Test Structure

```
tests/
  ├── fixtures.ts              # Custom test fixtures and helpers
  ├── 01-basic-flow.spec.ts    # Basic app loading and PWA tests
  ├── 02-identity-flow.spec.ts # Identity creation and import
  ├── 03-voucher-flow.spec.ts  # Complete voucher lifecycle
  └── 04-mobile-responsive.spec.ts # Mobile and cross-browser tests
```

## Test Scenarios

### 1. Basic Flow
- Application loads without errors
- Service worker registers
- PWA manifest is valid
- Security headers present

### 2. Identity Management
- Create new identity
- Display public key (npub format)
- Show mnemonic backup
- Import identity from mnemonic
- Validate mnemonic input

### 3. Voucher Lifecycle
- Issue voucher with memo
- Share voucher (get token)
- Redeem voucher in new identity
- View voucher history
- Handle invalid tokens
- Prevent double redemption
- Handle insufficient balance
- Handle network errors gracefully

### 4. Mobile & Cross-Browser
- Responsive design (320px - 1920px)
- Touch-friendly UI (44px minimum buttons)
- Portrait and landscape orientations
- Multiple device types (iPhone, Pixel, iPad)
- Chromium, Firefox, WebKit compatibility
- WebAssembly support

## Configuration

Tests use `playwright.config.ts` which:
- Runs tests in parallel
- Retries failed tests on CI (2 retries)
- Captures screenshots on failure
- Records video on failure
- Generates HTML, JSON, and JUnit reports

## CI Integration

Tests run automatically on:
- Pull requests
- Push to main/master branch
- Manual workflow dispatch

See `.github/workflows/e2e-tests.yml` for CI configuration.

## Debugging

### Failed Tests

```bash
# Show test report
npm run report

# Run specific test
npx playwright test tests/03-voucher-flow.spec.ts

# Debug specific test
npx playwright test tests/03-voucher-flow.spec.ts --debug
```

### Screenshots and Videos

Failed test artifacts are saved to:
- Screenshots: `test-results/`
- Videos: `test-results/`
- HTML Report: `playwright-report/`

### Interactive Mode

```bash
npm run test:ui
```

This opens Playwright's UI mode where you can:
- See test execution in real-time
- Time-travel through test steps
- Inspect DOM at each step
- View network requests
- Debug with browser DevTools

## Test Data

Tests use test fixtures with:
- Isolated browser contexts
- Fresh storage for each test
- Deterministic test mnemonic (test only!)
- Mock Cashu mint (if needed)

## Writing New Tests

1. Use fixtures from `fixtures.ts`:
   ```typescript
   import { test, expect } from './fixtures';

   test('my test', async ({ imaniPage }) => {
     await imaniPage.createNewIdentity('Test');
     // ...
   });
   ```

2. Add `data-testid` attributes to components:
   ```kotlin
   Button(
     onClick = { },
     modifier = Modifier.testTag("my-button")
   )
   ```

3. Use page object pattern for reusable actions
4. Add proper waits and timeouts
5. Clean up state in `beforeEach`

## Best Practices

- **Isolation**: Each test should be independent
- **Determinism**: Tests should pass consistently
- **Speed**: Keep tests fast (<30s per test)
- **Readability**: Use descriptive test names
- **Assertions**: Check actual behavior, not implementation
- **Wait Strategies**: Use proper waits, avoid fixed timeouts
- **Error Handling**: Expect and test error states

## Troubleshooting

### Tests Timeout
- Increase timeout in `playwright.config.ts`
- Check if dev server is running
- Verify network connectivity

### Flaky Tests
- Add proper waits (`waitForSelector`, `waitForLoadState`)
- Use `test.only()` to isolate
- Check for race conditions

### CI Failures
- Review CI logs and screenshots
- Run tests locally with `CI=true npm test`
- Check for environment differences

## Resources

- [Playwright Docs](https://playwright.dev)
- [Best Practices](https://playwright.dev/docs/best-practices)
- [Debugging Guide](https://playwright.dev/docs/debug)
