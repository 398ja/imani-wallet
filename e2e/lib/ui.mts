/**
 * The browser recipes the staging suites share: navigate, unlock, read the balance, sell, send,
 * read the bell, log in with a backup key, scan a pasted code.
 *
 * Lifted out of `e2e/postdeploy-staging.e2e.mts` (which imports them, unchanged in behaviour) so
 * the real-day load test (`loadtest/real-day.mts`, #550) drives the app with the SAME steps rather
 * than a fork of them. Screen labels are the app's own (src/pages); change them there and here.
 *
 * Everything that depends on the deployment is bound by `createUi({ base })`. Nothing here logs:
 * a caller that records screen text is expected to redact it (loadtest/real-day/redact.mts).
 */
import type { BrowserContext, Page } from 'playwright'
import { getPublicKey, nip19 } from 'nostr-tools'
import { TEST_PASSPHRASE, TEST_STALL_NAME } from '../register.mts'

export { registerCustomer, registerMerchant, TEST_PASSPHRASE, TEST_STALL_NAME } from '../register.mts'
export { bypassCaptcha, captchaBypassHeaders } from '../captchaBypass.mts'

/** Amounts are read off the screen, so the browser's locale is pinned to the one they are parsed in. */
export const BROWSER_LOCALE = 'en-GB'
/** Matches every path in shared/tokenRedemption.js that leaves a settled receive unsaved. */
export const UNSAVED_RECEIVE = /needs reconciliation|RECEIVE_SETTLED_NOT_SAVED|ReceiveSettledNotSaved|settled but not saved|not saved here/i
export const FAILURE_WORDS = /failed|error|could not|NOT been delivered|never finished|refused/i
/** The only screen that means a sale landed: anything short of it is still pending, or failed. */
export const SALE_DELIVERED = /It is in their wallet now/
export const PAYMENT_DONE = /^(Sent|Paid|Partly sent)$/m

export async function screenText(page: Page, limit = 1500): Promise<string> {
  return (await page.locator('body').innerText()).replace(/\n{2,}/g, '\n').slice(0, limit)
}

export function oneLine(text: string): string {
  return text.replace(/\n/g, ' | ')
}

/**
 * An amount as shown by the wallet in the pinned en-GB locale ("€1,234.56"), in whole cents so
 * amounts compare exactly. Anything that is not an amount ("?", an empty balance) is NaN.
 */
export function cents(text: string): number {
  const digits = text.replace(/[^\d.-]/g, '')
  return digits ? Math.round(Number.parseFloat(digits) * 100) : Number.NaN
}

/**
 * Navigates, retrying a navigation the BROWSER aborted. Docker creating or removing a bridge
 * on the machine running the suite makes Chromium fail in-flight loads with
 * ERR_NETWORK_CHANGED; that is the test host, not staging (same helper as terminals.e2e.ts).
 */
export async function goto(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60_000 })
      return
    } catch (e) {
      if (attempt === 4 || !/ERR_NETWORK_CHANGED|ERR_NETWORK_IO_SUSPENDED|net::ERR_ABORTED/.test(String(e))) throw e
      await page.waitForTimeout(2000)
    }
  }
}

export async function pubkeyOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const match = /^imani-wallet:profile:([0-9a-f]{64})$/.exec(localStorage.key(i) ?? '')
      if (match) return match[1]
    }
    return ''
  })
}

export async function handleOf(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText.match(/@((?:cust|till)\d+)/)?.[1] ?? '')
}

export function visibleToasts(page: Page): Promise<string[]> {
  return page.locator('[data-sonner-toast], [role="status"]').allInnerTexts()
}

export type UiOptions = {
  base: string
  passphrase?: string
  /** Called every time a wallet was found locked mid-run (its NAP session had lapsed). */
  onLapse?: (url: string) => void
}

export function createUi(options: UiOptions) {
  const BASE = options.base.replace(/\/+$/, '')
  const PASSPHRASE = options.passphrase ?? TEST_PASSPHRASE
  const onLapse = options.onLapse ?? (() => {})

  /** A fresh session, for a merchant whose session lapsed mid-run. */
  async function relogin(context: BrowserContext, page: Page): Promise<void> {
    await context.clearCookies()
    await goto(page, `${BASE}/`)
    await page.locator('input[placeholder="Passphrase"]').fill(PASSPHRASE)
    await page.getByRole('button', { name: /unlock/i }).first().click()
    await page.waitForTimeout(6000)
  }

  /**
   * Unlocks the wallet if it is showing its lock screen, and says whether it had to.
   *
   * A session can lapse mid-run: the merchant's did twice, after a 401 on /auth/session. The
   * wallet then shows "Unlock" on any route, which is the product working, not the check failing.
   */
  async function unlockIfLocked(page: Page): Promise<boolean> {
    const lock = page.locator('input[placeholder="Passphrase"]')
    const unlocked = page.getByText(/Total balance|Scan the customer's code|Amount \(/)
    await Promise.race([lock.waitFor({ timeout: 30_000 }), unlocked.first().waitFor({ timeout: 30_000 })]).catch(() => {})
    if (!(await lock.isVisible().catch(() => false))) return false
    onLapse(`${new Date().toISOString()} ${page.url()}`)
    await lock.fill(PASSPHRASE)
    await page.getByRole('button', { name: /unlock/i }).first().click()
    await page.waitForTimeout(5000)
    return true
  }

  /** The text of the home screen's balance panel: "€12.00", plus "+ …" lines for other units. */
  async function balancePanel(page: Page): Promise<string> {
    const text = await screenText(page, 800)
    const m = /Total balance\s*\n?([^\n]+)((?:\n\+ [^\n]+)*)/.exec(text)
    return m ? `${m[1]!.trim()}${m[2] ?? ''}` : '?'
  }

  async function balance(page: Page): Promise<string> {
    // `load`, not `networkidle`: the wallet holds a relay subscription open, and on a busy
    // relay networkidle never arrives (the first staging run timed out here).
    await goto(page, `${BASE}/`)
    await unlockIfLocked(page)
    const home = page.getByText('Total balance')
    await home.waitFor({ timeout: 30_000 })
    await page.waitForTimeout(3000)
    return (await screenText(page, 800)).match(/Total balance\s*\n?([^\n]+)/)?.[1]?.trim() ?? '?'
  }

  /**
   * Reads the balance on the page as it stands, without navigating. Used while toasts are being
   * watched: a reload wipes them, and interrupts whatever receive the wallet is in the middle of.
   */
  async function balanceInPlace(page: Page): Promise<string> {
    if (new URL(page.url()).pathname !== '/') return balance(page)
    await unlockIfLocked(page)
    return (await screenText(page, 800)).match(/Total balance\s*\n?([^\n]+)/)?.[1]?.trim() ?? '?'
  }

  async function sell(merchant: Page, customerHandle: string, amount: string): Promise<string> {
    await goto(merchant, `${BASE}/sell`)
    if (await unlockIfLocked(merchant)) await goto(merchant, `${BASE}/sell`)
    if (!merchant.url().includes('/sell')) return `redirected to ${merchant.url()} (no coupon:issue?)`
    await merchant.locator('input[placeholder="name"]').fill(customerHandle, { timeout: 30_000 })
    await merchant.getByRole('button', { name: /^Continue$/ }).click()
    await merchant.locator('input[placeholder="0.00"]').waitFor({ timeout: 30_000 })
    await merchant.locator('input[placeholder="0.00"]').fill(amount)
    await merchant.getByRole('button', { name: /Send voucher/i }).click()
    for (let i = 0; i < 60; i++) {
      await merchant.waitForTimeout(5000)
      const text = await screenText(merchant, 900)
      if (SALE_DELIVERED.test(text) || FAILURE_WORDS.test(text)) return text
    }
    return screenText(merchant, 900)
  }

  /**
   * Sends `amount` to `recipient` from the Send screen and returns the result screen.
   *
   * A multi-voucher payment is not something to construct: the wallet draws several
   * coupons whenever no single one covers the amount (`deliver` in src/lib/pay.ts), so
   * holding N small coupons and sending more than any one of them makes a bundle.
   *
   * `stallName` picks the voucher on "Which voucher?" when the sender holds several stalls'.
   */
  async function send(
    sender: Page,
    recipientPubkey: string,
    amount: string,
    stallName: string | RegExp = TEST_STALL_NAME,
    /** Preselects whose vouchers to spend (`?from=`, as the merchant page's Pay does). */
    fromStall?: string,
  ): Promise<string> {
    await goto(sender, `${BASE}/send?to=${recipientPubkey}${fromStall ? `&from=${fromStall}` : ''}`)
    const amountField = sender.locator('input[placeholder="0.00"]')
    if (!(await amountField.waitFor({ timeout: 15_000 }).then(() => true, () => false))) {
      await sender.getByRole('button').filter({ hasText: stallName }).first().click()
      await amountField.waitFor({ timeout: 30_000 })
    }
    await amountField.fill(amount)
    await sender.getByRole('button', { name: /^Continue$/ }).click()
    await sender.getByRole('button', { name: /^(Pay|Send)$/ }).last().click()
    for (let i = 0; i < 180; i++) {
      await sender.waitForTimeout(5000)
      const text = await screenText(sender, 900)
      if (PAYMENT_DONE.test(text) || FAILURE_WORDS.test(text)) return text
    }
    return screenText(sender, 900)
  }

  async function notificationRows(page: Page): Promise<string[]> {
    await goto(page, `${BASE}/`)
    // The bell is a <details>/<summary>, not a button: its rows are the buttons in its <nav>.
    const bell = page.locator('summary[aria-label^="Notifications"]')
    if (!(await bell.first().waitFor({ timeout: 15_000 }).then(() => true, () => false))) return []
    await bell.first().click()
    await page.waitForTimeout(1500)
    const rows = await page.locator('details[open] nav li').allInnerTexts()
    await bell.first().click()
    return rows.map((r) => r.replace(/\n+/g, ' ').trim()).filter(Boolean)
  }

  /**
   * Onboards by importing a backup key ("Log in" with a backup key). Returns the npub, which
   * Sell accepts in place of a handle. A key with no profile is asked to claim a handle; one is
   * made up (`handlePrefix` + time). A key WITH a profile (a real stall) is never asked.
   *
   * The key goes into one input and nowhere else. Callers must not trace or screenshot this step.
   */
  async function importKey(page: Page, secretKey: Uint8Array, handlePrefix = 'pd', allowNewProfile = true): Promise<string> {
    // Retried once: a browser-side network change during the import (ERR_NETWORK_CHANGED on
    // the test host) left run 6 on /onboarding with nothing to show for it.
    for (let attempt = 1; attempt <= 2; attempt++) {
      await goto(page, `${BASE}/onboarding`)
      if (!page.url().includes('onboarding')) break
      await page.getByRole('button', { name: /^Log in$/ }).first().click()
      // #325: Log in opens the backup chooser; the key form is the secondary link.
      await page.getByRole('button', { name: 'Use your backup key instead' }).click()
      await page.locator('input[aria-label="Backup key"]').fill(nip19.nsecEncode(secretKey))
      await page.locator('input[placeholder="Choose a passphrase"]').fill(PASSPHRASE)
      await page.locator('input[placeholder="Confirm passphrase"]').fill(PASSPHRASE)
      await page.getByRole('button', { name: /^Log in$/ }).last().click()
      // Since #338/#357 a key with no profile must claim a handle (and accept the Terms) before it
      // is let in.
      const finish = page.getByRole('button', { name: 'Finish and log in' })
      if (await finish.waitFor({ timeout: 15_000 }).then(() => true, () => false)) {
        // A real stall already has a profile. Being asked for a handle means the key is not the
        // account it was meant to be, and claiming one would publish a profile over it.
        if (!allowNewProfile) throw new Error('the app asked this key to claim a handle; refusing to publish a profile for it')
        await page.locator('input[aria-label="Handle"]').fill(handlePrefix + Date.now().toString().slice(-8))
        await page.getByRole('checkbox', { name: /I accept the Terms and Conditions/ }).check()
        await finish.click()
      }
      for (let i = 0; i < 30 && page.url().includes('onboarding'); i++) await page.waitForTimeout(1000)
      if (!page.url().includes('onboarding')) break
    }
    return nip19.npubEncode(getPublicKey(secretKey))
  }

  /**
   * Types a code into Scan's "Paste code" field (scanMerchantProfile.e2e.ts). Headless Chromium
   * leaves the camera prompt pending forever, so the field is revealed the way a user would.
   */
  async function scanText(p: Page, text: string): Promise<void> {
    await goto(p, `${BASE}/scan`)
    await unlockIfLocked(p)
    const field = p.getByLabel('Code')
    if (!(await field.isVisible().catch(() => false))) {
      await p.getByRole('button', { name: /Paste code/ }).click()
    }
    await field.fill(text)
    await p.getByRole('button', { name: 'Continue' }).click()
  }

  /**
   * What a stall holds of its OWN coupons, read once off its merchant page: the pass's amount
   * (`.text-amount`; the "BALANCE" label was dropped in #419). No pass is zero.
   */
  async function stallOwnBalance(page: Page, stallPubkey: string): Promise<string> {
    await goto(page, `${BASE}/merchants/${stallPubkey}`)
    await unlockIfLocked(page)
    await page.waitForTimeout(4000)
    const amount = page.locator('.text-amount').first()
    return (await amount.count()) ? (await amount.innerText()).trim() : '€0.00'
  }

  return { BASE, stallOwnBalance, relogin, unlockIfLocked, balance, balancePanel, balanceInPlace, sell, send, notificationRows, importKey, scanText }
}

export type Ui = ReturnType<typeof createUi>
