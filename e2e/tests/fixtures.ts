import { test as base, expect } from '@playwright/test';

/**
 * Custom fixtures for Imani Wallet E2E tests.
 *
 * Provides reusable page objects and helper functions.
 */

export type ImaniPage = {
  // Navigation helpers
  gotoHome(): Promise<void>;
  gotoSettings(): Promise<void>;

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
};

// Extend base test with custom fixtures
export const test = base.extend<{ imaniPage: ImaniPage }>({
  imaniPage: async ({ page }, use) => {
    const imaniPage: ImaniPage = {
      // Navigation
      async gotoHome() {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
      },

      async gotoSettings() {
        await page.click('[data-testid="settings-button"]');
        await page.waitForSelector('[data-testid="settings-screen"]');
      },

      // Identity management
      async createNewIdentity(label: string) {
        // Wait for app to load
        await page.waitForSelector('canvas#ComposeTarget', { timeout: 10000 });

        // Look for "Create Identity" or "Get Started" button
        const createButton = page.locator('text=/Create Identity|Get Started/i').first();
        await createButton.waitFor({ timeout: 5000 });
        await createButton.click();

        // Fill in label
        await page.fill('[data-testid="identity-label-input"]', label);

        // Click create/confirm
        await page.click('[data-testid="create-identity-button"]');

        // Wait for identity creation to complete
        await page.waitForSelector('[data-testid="home-screen"]', { timeout: 10000 });
      },

      async importIdentity(mnemonic: string, label: string) {
        // Click import button
        await page.click('[data-testid="import-identity-button"]');

        // Fill mnemonic
        await page.fill('[data-testid="mnemonic-input"]', mnemonic);

        // Fill label
        await page.fill('[data-testid="identity-label-input"]', label);

        // Click import
        await page.click('[data-testid="confirm-import-button"]');

        // Wait for completion
        await page.waitForSelector('[data-testid="home-screen"]', { timeout: 10000 });
      },

      async switchIdentity(label: string) {
        await page.click('[data-testid="identity-selector"]');
        await page.click(`[data-testid="identity-option-${label}"]`);
        await page.waitForLoadState('networkidle');
      },

      // Voucher operations
      async issueVoucher(amount: number, memo?: string) {
        // Click issue/create voucher button
        await page.click('[data-testid="issue-voucher-button"]');

        // Fill amount
        await page.fill('[data-testid="amount-input"]', amount.toString());

        // Fill memo if provided
        if (memo) {
          await page.fill('[data-testid="memo-input"]', memo);
        }

        // Click confirm
        await page.click('[data-testid="confirm-issue-button"]');

        // Wait for success
        await page.waitForSelector('[data-testid="voucher-issued-success"]', { timeout: 15000 });
      },

      async shareVoucher(): Promise<string> {
        // Click first voucher in list
        await page.click('[data-testid="voucher-item"]').first();

        // Click share button
        await page.click('[data-testid="share-voucher-button"]');

        // Get token from clipboard or display
        const tokenElement = page.locator('[data-testid="voucher-token"]');
        const token = await tokenElement.textContent();

        return token || '';
      },

      async redeemVoucher(token: string) {
        // Click redeem button
        await page.click('[data-testid="redeem-voucher-button"]');

        // Fill token
        await page.fill('[data-testid="token-input"]', token);

        // Click confirm
        await page.click('[data-testid="confirm-redeem-button"]');

        // Wait for success
        await page.waitForSelector('[data-testid="voucher-redeemed-success"]', { timeout: 15000 });
      },

      // Assertions
      async expectIdentityExists(label: string) {
        await expect(page.locator(`[data-testid="identity-${label}"]`)).toBeVisible();
      },

      async expectVoucherInList(amount: number) {
        await expect(page.locator(`[data-testid="voucher-amount-${amount}"]`)).toBeVisible();
      },

      async expectBalance(amount: number) {
        const balanceText = await page.locator('[data-testid="balance-display"]').textContent();
        expect(balanceText).toContain(amount.toString());
      },

      // Error handling
      async expectErrorToast(message: string) {
        const toast = page.locator('[data-testid="error-toast"]', { hasText: message });
        await expect(toast).toBeVisible({ timeout: 5000 });
      },

      async expectSuccessToast(message: string) {
        const toast = page.locator('[data-testid="success-toast"]', { hasText: message });
        await expect(toast).toBeVisible({ timeout: 5000 });
      },
    };

    await use(imaniPage);
  },
});

export { expect };
