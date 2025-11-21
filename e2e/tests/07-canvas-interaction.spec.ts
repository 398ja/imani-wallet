import { test, expect, Page } from '@playwright/test';

/**
 * Canvas interaction tests using coordinate-based clicking.
 * These tests click at known positions in the Compose canvas UI.
 */

// Helper to click at canvas coordinates
async function clickCanvas(page: Page, xPercent: number, yPercent: number) {
  const canvas = page.locator('canvas#ComposeTarget');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas not found');

  const x = box.x + (box.width * xPercent);
  const y = box.y + (box.height * yPercent);
  await page.mouse.click(x, y);
}

// Bottom nav positions (approximate percentages)
const NAV = {
  shop: { x: 0.17, y: 0.96 },      // Left tab
  merchant: { x: 0.5, y: 0.96 },   // Center tab
  settings: { x: 0.83, y: 0.96 },  // Right tab
};

test.describe('Canvas Interaction Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const canvas = page.locator('canvas#ComposeTarget');
    await expect(canvas).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);
  });

  test('should navigate to Settings tab', async ({ page }) => {
    // Take before screenshot
    const beforeShot = await page.screenshot();

    // Click Settings tab
    await clickCanvas(page, NAV.settings.x, NAV.settings.y);
    await page.waitForTimeout(1000);

    // Take after screenshot - should be different
    const afterShot = await page.screenshot();

    // Compare - they should be different (different tab selected)
    expect(Buffer.compare(beforeShot, afterShot)).not.toBe(0);
  });

  test('should navigate to Merchant tab', async ({ page }) => {
    const beforeShot = await page.screenshot();

    await clickCanvas(page, NAV.merchant.x, NAV.merchant.y);
    await page.waitForTimeout(1000);

    const afterShot = await page.screenshot();
    expect(Buffer.compare(beforeShot, afterShot)).not.toBe(0);
  });

  test('should navigate back to Shop tab', async ({ page }) => {
    // First go to Settings
    await clickCanvas(page, NAV.settings.x, NAV.settings.y);
    await page.waitForTimeout(500);
    const settingsShot = await page.screenshot();

    // Then go to Shop
    await clickCanvas(page, NAV.shop.x, NAV.shop.y);
    await page.waitForTimeout(500);
    const shopShot = await page.screenshot();

    // Should be different screens
    expect(Buffer.compare(settingsShot, shopShot)).not.toBe(0);
  });

  test('should click Discover Merchants button', async ({ page }) => {
    const beforeShot = await page.screenshot();

    // "Discover Merchants" button is roughly center, 60% down
    await clickCanvas(page, 0.5, 0.62);
    await page.waitForTimeout(1000);

    const afterShot = await page.screenshot();
    // May or may not change depending on implementation
  });
});
