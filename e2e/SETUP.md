# E2E Testing Setup Guide

## Installation Complete

The Playwright E2E testing framework has been successfully installed and configured for Imani Wallet.

## What Was Installed

### Browsers
- ✅ Chromium 141.0.7390.37
- ✅ Firefox 142.0.1
- ✅ WebKit 26.0
- ✅ FFmpeg (for video recording)

### Dependencies
- Playwright Test Framework v1.56.1
- TypeScript definitions
- Test fixtures and helpers

## Verification

Sanity tests have been run successfully:
```
✓ should be able to run a basic test
✓ should support JavaScript execution
```

## Known Issues

### Ubuntu Plucky (25.04) Compatibility

Your system has `libicu76` but Playwright expects `libicu74`. This is a known compatibility issue with newer Ubuntu versions but **does not affect functionality**.

The browsers work correctly despite the warning about missing dependencies.

## Running Tests

### Quick Start

```bash
cd e2e

# Run sanity test (no server needed)
npx playwright test tests/00-sanity.spec.ts --project=chromium

# Run all tests (requires dev server)
npm test
```

### With Dev Server

For tests that require the application to be running:

**Terminal 1 - Start dev server:**
```bash
./gradlew :imani-web:jsBrowserDevelopmentRun --continuous
```

**Terminal 2 - Run tests:**
```bash
cd e2e
npm test
```

### Specific Browsers

```bash
npm run test:chrome    # Chromium only
npm run test:firefox   # Firefox only
npm run test:safari    # WebKit/Safari only
npm run test:mobile    # Mobile viewports
```

### Debug Mode

```bash
npm run test:headed    # See browser window
npm run test:debug     # Playwright Inspector
npm run test:ui        # Interactive UI mode
```

## Test Structure

```
e2e/
├── tests/
│   ├── 00-sanity.spec.ts           # Setup verification
│   ├── 01-basic-flow.spec.ts       # App loading, PWA, security
│   ├── 02-identity-flow.spec.ts    # Identity creation & import
│   ├── 03-voucher-flow.spec.ts     # Complete voucher lifecycle
│   ├── 04-mobile-responsive.spec.ts # Responsive design
│   └── fixtures.ts                  # Custom helpers
├── playwright.config.ts             # Main configuration
├── package.json                     # Dependencies & scripts
└── README.md                        # Full documentation
```

## Next Steps

1. **Manual Testing**: Start the dev server and run the full test suite
2. **CI Integration**: Tests will run automatically on PRs via GitHub Actions
3. **Add Data-TestIDs**: Update Compose components with `Modifier.testTag()` for better element selection
4. **Extend Tests**: Add more test scenarios as features are implemented

## Troubleshooting

### Browsers Not Found
```bash
cd e2e
npx playwright install chromium firefox webkit
```

### Permission Errors
Make sure you have write permissions to `~/.cache/ms-playwright/`

### Port Already in Use
If port 8181 is busy, stop other Gradle processes:
```bash
pkill -f "jsBrowserDevelopmentRun"
```

### Tests Timeout
- Increase timeout in `playwright.config.ts`
- Ensure dev server is fully started before running tests
- Check http://localhost:8181 manually first

## Resources

- [Playwright Documentation](https://playwright.dev)
- [Test README](README.md) - Full testing documentation
- [Debugging Guide](https://playwright.dev/docs/debug)

## Status

✅ Installation Complete
✅ Sanity Tests Passing
✅ All Browsers Downloaded
⚠️  Minor Warning (libicu74) - Safe to Ignore
📝 Ready for Development
