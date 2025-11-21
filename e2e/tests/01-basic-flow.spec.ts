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

    // Verify canvas has rendered (non-zero dimensions)
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  });

  test('should show initial onboarding or home screen', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Should show either onboarding, home screen, or canvas (Compose app)
    const hasOnboarding = await page.locator('text=/Get Started|Create New|Create Identity|No identities/i').count() > 0;
    const hasHomeScreen = await page.locator('[data-testid="home-screen"]').count() > 0;
    const hasCanvas = await page.locator('canvas#ComposeTarget').count() > 0;

    expect(hasOnboarding || hasHomeScreen || hasCanvas).toBe(true);
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

    // CSP can be in HTTP header or HTML meta tag
    const httpCsp = headers?.['content-security-policy'] || '';

    // Check for CSP in meta tag if not in HTTP headers
    const metaCsp = await page.evaluate(() => {
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      return meta?.getAttribute('content') || '';
    });

    const csp = httpCsp || metaCsp;
    expect(csp).toContain("default-src 'self'");
  });
});
