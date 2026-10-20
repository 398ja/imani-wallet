/**
 * Register a real merchant against the live test stack.
 *
 * Exported so the terminals E2E can reach the screens that need a stall,
 * without duplicating the onboarding walk.
 */
import type { Page } from 'playwright'

/** The passphrase every registered test wallet is locked with. */
export const TEST_PASSPHRASE = 'correct horse battery'
/** The display name every registered test merchant trades under. */
export const TEST_STALL_NAME = 'Test Stall'

export async function registerMerchant(p: Page, base: string): Promise<string> {
  const handle = 'till' + Date.now().toString().slice(-7)
  await p.goto(`${base}/onboarding`, { waitUntil: 'networkidle' })
  await p.getByRole('button', { name: /^Register$/i }).first().click()
  await p.waitForTimeout(400)
  await p.locator('input[placeholder="your_handle"]').fill(handle)
  await p.locator('input[placeholder="Passphrase"]').fill(TEST_PASSPHRASE)
  await p.locator('input[placeholder="Confirm passphrase"]').fill(TEST_PASSPHRASE)
  await p.getByText('I am a merchant').click()
  await p.waitForTimeout(400)
  await p.getByRole('button', { name: 'Continue' }).click()
  await p.waitForTimeout(600)
  await p.locator('input:visible').first().fill(TEST_STALL_NAME)
  await p.getByRole('button', { name: 'Continue' }).click()
  await p.waitForTimeout(800)
  await p.getByRole('button', { name: /^food$/i }).click()
  await p.waitForTimeout(300)
  await p.getByRole('button', { name: /Create merchant account/i }).click()

  // The backup-key step. Acknowledged the way a real user must.
  await p.getByText(/I have saved my backup key/i).click({ timeout: 60_000 })
  await p.getByRole('button', { name: /Continue to my wallet/i }).click()
  for (let i = 0; i < 30; i++) {
    await p.waitForTimeout(1000)
    if (!p.url().includes('onboarding')) break
  }
  return handle
}

/**
 * Register a plain customer — no stall, no categories.
 *
 * Returns the PUBKEY rather than the handle, because the notification inbox is
 * keyed on pubkey and a test that seeds it needs the same key the app reads.
 * Read out of the running app rather than derived here, so a change to where
 * the session lives fails the probe instead of silently seeding a key nothing
 * looks at.
 */
export async function registerCustomer(p: Page, base: string): Promise<string> {
  const handle = 'cust' + Date.now().toString().slice(-7)
  await p.goto(`${base}/onboarding`, { waitUntil: 'networkidle' })
  await p.getByRole('button', { name: /^Register$/i }).first().click()
  await p.waitForTimeout(400)
  await p.locator('input[placeholder="your_handle"]').fill(handle)
  await p.locator('input[placeholder="Passphrase"]').fill(TEST_PASSPHRASE)
  await p.locator('input[placeholder="Confirm passphrase"]').fill(TEST_PASSPHRASE)
  // No "I am a merchant": the customer path skips the stall steps entirely
  // and its submit button says "Create account", not "Continue".
  await p.getByRole('button', { name: /Create account/i }).click()
  await p.waitForTimeout(1500)

  await p.getByText(/I have saved my backup key/i).click({ timeout: 60_000 })
  await p.getByRole('button', { name: /Continue to my wallet/i }).click()
  for (let i = 0; i < 30; i++) {
    await p.waitForTimeout(1000)
    if (!p.url().includes('onboarding')) break
  }

  // The app's own session record is the source of truth for the pubkey.
  return p.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const match = /"pubkey"\s*:\s*"([0-9a-f]{64})"/.exec(raw)
      if (match) return match[1]
    }
    return ''
  })
}
