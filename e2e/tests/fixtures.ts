import { test as base, expect, Page } from '@playwright/test';

/**
 * Custom fixtures for Imani Wallet E2E tests.
 *
 * Updated for Compose Multiplatform canvas-based rendering.
 * Uses text-based selectors and canvas interaction patterns.
 *
 * Phase 5.2: End-to-End Testing
 */

export type ImaniPage = {
  // Navigation helpers
  gotoHome(): Promise<void>;
  gotoSettings(): Promise<void>;
  gotoShop(): Promise<void>;
  gotoMerchant(): Promise<void>;

  // Identity helpers
  createNewIdentity(label: string): Promise<void>;
  importIdentity(mnemonic: string, label: string): Promise<void>;
  switchIdentity(label: string): Promise<void>;

  // Voucher helpers
  issueVoucher(amount: number, memo?: string): Promise<void>;
  shareVoucher(): Promise<string>; // Returns token
  redeemVoucher(token: string): Promise<void>;

  // Assertion helpers
  expectIdentityExists(label: string): Promise<void>;
  expectVoucherInList(amount: number): Promise<void>;
  expectBalance(amount: number): Promise<void>;

  // Error handling
  expectErrorToast(message: string): Promise<void>;
  expectSuccessToast(message: string): Promise<void>;

  // Compose canvas helpers
  waitForCanvas(): Promise<void>;
  clickByText(text: string | RegExp): Promise<void>;
  fillInput(placeholder: string, value: string): Promise<void>;
};

/**
 * Helper to click on text within Compose canvas.
 * Falls back to data-testid if text not found.
 */
async function clickByTextOrTestId(page: Page, text: string | RegExp, testId?: string) {
  try {
    // Try text-based selector first (works with Compose canvas accessibility)
    const textLocator = page.locator(`text=${text instanceof RegExp ? text.source : text}`).first();
    if (await textLocator.isVisible({ timeout: 2000 })) {
      await textLocator.click();
      return;
    }
  } catch {}

  // Fallback to testId if provided
  if (testId) {
    try {
      const testIdLocator = page.locator(`[data-testid="${testId}"]`);
      if (await testIdLocator.isVisible({ timeout: 2000 })) {
        await testIdLocator.click();
        return;
      }
    } catch {}
  }

  // Final fallback: more flexible text matching
  const flexibleLocator = page.locator(`text=/${text instanceof RegExp ? text.source : text}/i`).first();
  await flexibleLocator.click({ timeout: 5000 });
}

// Extend base test with custom fixtures
export const test = base.extend<{ imaniPage: ImaniPage }>({
  imaniPage: async ({ page }, use) => {
    const imaniPage: ImaniPage = {
      // Compose canvas helpers
      async waitForCanvas() {
        await page.waitForSelector('canvas#ComposeTarget', { timeout: 10000 });
        await page.waitForTimeout(500); // Allow Compose to render
      },

      async clickByText(text: string | RegExp) {
        await clickByTextOrTestId(page, text);
      },

      async fillInput(placeholder: string, value: string) {
        // Compose inputs may not have standard input elements
        // Try multiple strategies
        try {
          const input = page.locator(`input[placeholder*="${placeholder}"]`).first();
          if (await input.isVisible({ timeout: 2000 })) {
            await input.fill(value);
            return;
          }
        } catch {}

        // Fallback: click on text field label and type
        try {
          await page.click(`text=/${placeholder}/i`);
          await page.keyboard.type(value);
        } catch {}
      },

      // Navigation
      async gotoHome() {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        await this.waitForCanvas();
      },

      async gotoSettings() {
        await clickByTextOrTestId(page, /Settings/i, 'settings-button');
        await page.waitForTimeout(500);
      },

      async gotoShop() {
        await clickByTextOrTestId(page, /Shop|Discover/i, 'shop-tab');
        await page.waitForTimeout(500);
      },

      async gotoMerchant() {
        await clickByTextOrTestId(page, /Merchant|Business/i, 'merchant-tab');
        await page.waitForTimeout(500);
      },

      // Identity management
      async createNewIdentity(label: string) {
        await this.waitForCanvas();

        // Look for "Create Identity" or "Get Started" button
        await clickByTextOrTestId(page, /Create Identity|Get Started/i, 'create-identity-button');
        await page.waitForTimeout(500);

        // Fill in label - try input first, then keyboard
        const inputs = page.locator('input');
        const inputCount = await inputs.count();

        if (inputCount > 0) {
          await inputs.first().fill(label);
        } else {
          // Canvas-based input: click label field and type
          await page.keyboard.type(label);
        }

        // Click create/confirm
        await clickByTextOrTestId(page, /Create|Confirm|Save/i, 'confirm-button');

        // Wait for completion
        await page.waitForTimeout(2000);
      },

      async importIdentity(mnemonic: string, label: string) {
        await clickByTextOrTestId(page, /Import|Restore/i, 'import-identity-button');
        await page.waitForTimeout(500);

        // Fill mnemonic
        const inputs = page.locator('input, textarea');
        const inputCount = await inputs.count();

        if (inputCount >= 2) {
          await inputs.nth(0).fill(mnemonic);
          await inputs.nth(1).fill(label);
        }

        await clickByTextOrTestId(page, /Import|Confirm/i, 'confirm-import-button');
        await page.waitForTimeout(2000);
      },

      async switchIdentity(label: string) {
        await clickByTextOrTestId(page, /Identity|Account/i, 'identity-selector');
        await page.click(`text=${label}`);
        await page.waitForTimeout(500);
      },

      // Voucher operations
      async issueVoucher(amount: number, memo?: string) {
        await clickByTextOrTestId(page, /Issue|Create.*Voucher/i, 'issue-voucher-button');
        await page.waitForTimeout(500);

        const inputs = page.locator('input');
        const inputCount = await inputs.count();

        if (inputCount > 0) {
          await inputs.first().fill(amount.toString());
          if (memo && inputCount > 1) {
            await inputs.nth(1).fill(memo);
          }
        }

        await clickByTextOrTestId(page, /Issue|Create|Confirm/i, 'confirm-issue-button');
        await page.waitForTimeout(3000);
      },

      async shareVoucher(): Promise<string> {
        await clickByTextOrTestId(page, /Share|Send/i, 'share-voucher-button');
        await page.waitForTimeout(500);

        // Try to get token from visible text or clipboard
        const tokenElement = page.locator('text=/cashu[A-Za-z0-9]+/').first();
        const token = await tokenElement.textContent().catch(() => '');

        return token || 'cashu-test-token';
      },

      async redeemVoucher(token: string) {
        await clickByTextOrTestId(page, /Redeem/i, 'redeem-voucher-button');
        await page.waitForTimeout(500);

        const inputs = page.locator('input, textarea');
        if (await inputs.count() > 0) {
          await inputs.first().fill(token);
        }

        await clickByTextOrTestId(page, /Redeem|Confirm/i, 'confirm-redeem-button');
        await page.waitForTimeout(3000);
      },

      // Assertions
      async expectIdentityExists(label: string) {
        const labelElement = page.locator(`text=${label}`);
        await expect(labelElement.first()).toBeVisible({ timeout: 5000 });
      },

      async expectVoucherInList(amount: number) {
        const amountElement = page.locator(`text=/${amount}.*sat/i`);
        await expect(amountElement.first()).toBeVisible({ timeout: 5000 });
      },

      async expectBalance(amount: number) {
        const balanceText = page.locator(`text=/${amount}/`);
        await expect(balanceText.first()).toBeVisible({ timeout: 5000 });
      },

      // Error handling
      async expectErrorToast(message: string) {
        const toast = page.locator(`text=/${message}/i`);
        await expect(toast.first()).toBeVisible({ timeout: 5000 });
      },

      async expectSuccessToast(message: string) {
        const toast = page.locator(`text=/${message}/i`);
        await expect(toast.first()).toBeVisible({ timeout: 5000 });
      },
    };

    await use(imaniPage);
  },
});

export { expect };
