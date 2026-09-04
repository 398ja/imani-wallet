/**
 * Register a real merchant against the live test stack.
 *
 * Exported so the terminals E2E can reach the screens that need a stall,
 * without duplicating the onboarding walk.
 */
import type { Page } from 'playwright'

export async function registerMerchant(p: Page, base: string): Promise<string> {
  const handle = 'till' + Date.now().toString().slice(-7)
  await p.goto(`${base}/onboarding`, { waitUntil: 'networkidle' })
  await p.getByRole('button', { name: /^Register$/i }).first().click()
  await p.waitForTimeout(400)
  await p.locator('input[placeholder="your-handle"]').fill(handle)
  await p.locator('input[placeholder="Passphrase"]').fill('correct horse battery')
  await p.locator('input[placeholder="Confirm passphrase"]').fill('correct horse battery')
  await p.getByText('I am a merchant').click()
  await p.waitForTimeout(400)
  await p.getByRole('button', { name: 'Continue' }).click()
  await p.waitForTimeout(600)
  await p.locator('input:visible').first().fill('Test Stall')
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
