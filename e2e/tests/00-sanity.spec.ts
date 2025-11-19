import { test, expect } from '@playwright/test';

/**
 * Quick sanity test to verify Playwright setup.
 */
test.describe('Playwright Setup', () => {
  test('should be able to run a basic test', async ({ page }) => {
    // Just verify we can launch a browser
    await page.goto('about:blank');
    expect(await page.title()).toBe('');
  });

  test('should support JavaScript execution', async ({ page }) => {
    await page.goto('about:blank');

    const result = await page.evaluate(() => {
      return 2 + 2;
    });

    expect(result).toBe(4);
  });
});
