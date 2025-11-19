import { test, expect } from './fixtures';

/**
 * Basic E2E test: Application loads and basic navigation works.
 */
test.describe('Basic Application Flow', () => {
  test('should load the application', async ({ page }) => {
    await page.goto('/');

    // Wait for Compose canvas to load
    const canvas = page.locator('canvas#ComposeTarget');
    await expect(canvas).toBeVisible({ timeout: 10000 });

    // Check that we don't have any critical errors in console
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    // Wait a bit for any errors to appear
    await page.waitForTimeout(2000);

    // Should not have critical errors (allow monitoring errors)
    const criticalErrors = errors.filter(e =>
      !e.includes('[ErrorTracking]') &&
      !e.includes('[Analytics]')
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test('should show initial onboarding or home screen', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Should show either onboarding or home screen
    const hasOnboarding = await page.locator('text=/Get Started|Create Identity/i').count() > 0;
    const hasHomeScreen = await page.locator('[data-testid="home-screen"]').count() > 0;

    expect(hasOnboarding || hasHomeScreen).toBe(true);
  });
});

/**
 * PWA and offline functionality tests.
 */
test.describe('PWA Functionality', () => {
  test('should register service worker', async ({ page }) => {
    await page.goto('/');

    // Check for service worker registration
    const swRegistered = await page.evaluate(() => {
      return navigator.serviceWorker.getRegistrations().then(regs => regs.length > 0);
    });

    expect(swRegistered).toBe(true);
  });

  test('should have web app manifest', async ({ page }) => {
    const response = await page.request.get('/manifest.json');
    expect(response.ok()).toBe(true);

    const manifest = await response.json();
    expect(manifest.name).toBe('Imani Wallet');
    expect(manifest.short_name).toBe('Imani');
  });

  test('should have required PWA icons', async ({ page }) => {
    const icon192 = await page.request.get('/icons/icon-192x192.png');
    const icon512 = await page.request.get('/icons/icon-512x512.png');

    expect(icon192.ok() || icon512.ok()).toBe(true);
  });
});

/**
 * Security headers test.
 */
test.describe('Security', () => {
  test('should have security headers', async ({ page }) => {
    const response = await page.goto('/');
    const headers = response?.headers();

    // CSP should be present
    expect(headers).toHaveProperty('content-security-policy');

    // Check for important security headers
    const csp = headers?.['content-security-policy'] || '';
    expect(csp).toContain("default-src 'self'");
  });
});
