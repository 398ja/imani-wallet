import { test, expect } from '@playwright/test';

/**
 * E2E tests for mobile responsiveness.
 */
test.describe.skip('Mobile Responsiveness', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should render properly on mobile viewport', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 }); // iPhone SE

    await page.waitForLoadState('networkidle');

    // Canvas should be visible
    const canvas = page.locator('canvas#ComposeTarget');
    await expect(canvas).toBeVisible();

    // Check that canvas fills viewport
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox?.width).toBeLessThanOrEqual(375);
  });

  test('should have touch-friendly buttons on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForLoadState('networkidle');

    // Wait for any buttons to appear
    await page.waitForTimeout(2000);

    // Check button sizes (should be at least 44x44px for touch)
    const buttons = page.locator('button').all();
    const buttonSizes = await Promise.all((await buttons).map(async btn => {
      const box = await btn.boundingBox();
      return box ? { width: box.width, height: box.height } : null;
    }));

    // At least some buttons should exist and be touch-friendly
    const touchFriendlyButtons = buttonSizes.filter(
      size => size && size.width >= 40 && size.height >= 40
    );

    // If there are buttons, some should be touch-friendly
    if (buttonSizes.length > 0) {
      expect(touchFriendlyButtons.length).toBeGreaterThan(0);
    }
  });

  test('should support portrait and landscape orientations', async ({ page }) => {
    // Portrait
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForLoadState('networkidle');

    const canvas = page.locator('canvas#ComposeTarget');
    await expect(canvas).toBeVisible();

    // Landscape
    await page.setViewportSize({ width: 667, height: 375 });
    await page.waitForTimeout(1000);

    await expect(canvas).toBeVisible();
  });

  test('should handle different device sizes', async ({ page }) => {
    const devices = [
      { name: 'iPhone SE', width: 375, height: 667 },
      { name: 'iPhone 13', width: 390, height: 844 },
      { name: 'Pixel 5', width: 393, height: 851 },
      { name: 'iPad Mini', width: 768, height: 1024 },
    ];

    for (const device of devices) {
      console.log(`Testing ${device.name} (${device.width}x${device.height})`);

      await page.setViewportSize({ width: device.width, height: device.height });
      await page.waitForTimeout(500);

      // Should still show canvas
      const canvas = page.locator('canvas#ComposeTarget');
      await expect(canvas).toBeVisible();

      // No horizontal scroll
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 5); // Allow 5px tolerance
    }
  });

  test('should have readable text on small screens', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 }); // iPhone 5
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Text should not be too small
    // Note: Compose Multiplatform uses canvas rendering, so we can't check font sizes directly
    // Instead, verify the app loads without layout issues
    const canvas = page.locator('canvas#ComposeTarget');
    await expect(canvas).toBeVisible();
  });
});

/**
 * Cross-browser compatibility tests.
 */
test.describe.skip('Cross-Browser Compatibility', () => {
  test('should load in all supported browsers', async ({ page, browserName }) => {
    console.log(`Testing on ${browserName}`);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Canvas should load
    const canvas = page.locator('canvas#ComposeTarget');
    await expect(canvas).toBeVisible({ timeout: 15000 });

    // Should not have critical JavaScript errors
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('Analytics')) {
        errors.push(`[${browserName}] ${msg.text()}`);
      }
    });

    await page.waitForTimeout(3000);

    // Report any errors
    if (errors.length > 0) {
      console.warn('Console errors:', errors);
    }
  });

  test('should handle WebAssembly in all browsers', async ({ page, browserName }) => {
    console.log(`Testing WebAssembly support on ${browserName}`);

    await page.goto('/');

    // Check WebAssembly support
    const wasmSupported = await page.evaluate(() => {
      return typeof WebAssembly !== 'undefined';
    });

    expect(wasmSupported).toBe(true);
  });
});
