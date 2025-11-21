import { test, expect } from '@playwright/test';

/**
 * Visual regression tests for Compose canvas-based UI.
 * Uses screenshot comparison instead of DOM interaction.
 */
test.describe('Visual Regression Tests', () => {
  test('should render home screen correctly', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Wait for canvas to be fully rendered
    const canvas = page.locator('canvas#ComposeTarget');
    await expect(canvas).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000); // Allow animations to settle

    // Take screenshot for comparison
    await expect(page).toHaveScreenshot('home-screen.png', {
      maxDiffPixelRatio: 0.05,
      threshold: 0.3,
    });
  });

  test('should render correctly on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 }); // iPhone SE
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const canvas = page.locator('canvas#ComposeTarget');
    await expect(canvas).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    await expect(page).toHaveScreenshot('home-screen-mobile.png', {
      maxDiffPixelRatio: 0.05, // Allow 5% difference
      threshold: 0.3,
    });
  });

  test('should render correctly on tablet viewport', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 }); // iPad
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const canvas = page.locator('canvas#ComposeTarget');
    await expect(canvas).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    await expect(page).toHaveScreenshot('home-screen-tablet.png', {
      maxDiffPixelRatio: 0.05,
      threshold: 0.3,
    });
  });

  test('should render bottom navigation correctly', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const canvas = page.locator('canvas#ComposeTarget');
    await expect(canvas).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Screenshot just the bottom navigation area
    const box = await canvas.boundingBox();
    if (box) {
      await expect(page).toHaveScreenshot('bottom-nav.png', {
        clip: {
          x: 0,
          y: box.height - 80, // Bottom 80px for nav
          width: box.width,
          height: 80,
        },
        maxDiffPixelRatio: 0.05,
        threshold: 0.3,
      });
    }
  });
});
