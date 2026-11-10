/**
 * End to end test of the support snapshot (#589) on the LOCAL stack, with real wallet data.
 *
 *   E2E_BASE=http://localhost:5176 npx tsx e2e/support-snapshot-local.e2e.mts
 *
 * Needs the stack from deploy/up.sh plus imani-deploy's docker-compose.support-snapshot.yml layer
 * (support-blossom, its edge, support-snapshot) and gateway-core publishing support_npub.
 *
 *  1. Registers a merchant with a stall and a customer, and sells the customer a voucher, so both
 *     wallets hold real vouchers, transactions and (for the stall) takings.
 *  2. For each of them: support issues a code (the operator CLI inside the support-snapshot
 *     container), the user enters it, consents, sees the size, and taps Upload now.
 *  3. Support side: the audit trail shows the snapshot accepted and the blob deleted, the wallet's
 *     record reaches "deleted from server", the data matches what the wallet holds, and nothing the
 *     AI tools return contains a handle, a pubkey or an npub of either account.
 */
import { execFileSync } from 'node:child_process'
import { nip19 } from 'nostr-tools'
import { chromium, type Browser, type Page } from 'playwright'

const BASE = process.env.E2E_BASE ?? 'http://localhost:5176'
const CONTAINER = process.env.SUPPORT_CONTAINER ?? 'imani-test-support-snapshot-1'
const PW = 'correct horse battery'
const AMOUNT = '2.50'

let failures = 0
const check = (what: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `: ${detail}` : ''}`)
  if (!ok) failures++
}
const fail = (msg: string): never => {
  console.log(`FAIL  ${msg}`)
  process.exit(1)
}
const text = async (p: Page) => (await p.locator('body').innerText()).replace(/\s+/g, ' ')

function support(...args: string[]): string {
  return execFileSync('docker', ['exec', CONTAINER, 'java', '-jar', '/app/support-agent.jar', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

async function pubkeyOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const m = /^imani-wallet:profile:([0-9a-f]{64})$/.exec(localStorage.key(i) ?? '')
      if (m) return m[1]
    }
    return ''
  })
}

async function register(browser: Browser, merchant: boolean): Promise<{ page: Page; handle: string; pubkey: string }> {
  const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage()
  await page.goto(`${BASE}/`, { waitUntil: 'load' })
  await page.getByText('Register').first().click()
  const handle = (merchant ? 'm' : 'c') + Math.random().toString(36).slice(2, 9)
  await page.locator('input[type=text]:visible').first().fill(handle)
  const pw = page.locator('input[type=password]:visible')
  await pw.nth(0).fill(PW)
  await pw.nth(1).fill(PW)
  if (merchant) await page.getByRole('switch').first().check({ force: true })
  const boxes = page.locator('input[type=checkbox]:not([role=switch])')
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check({ force: true })
  if (merchant) {
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.locator('input[placeholder="Bridge Street Coffee"]').fill('Test Stall')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Food' }).click()
    await page.getByRole('button', { name: 'Create merchant account' }).click()
  } else {
    await page.getByRole('button', { name: 'Create account' }).click()
  }
  await page.getByText('You are all set').waitFor({ timeout: 90_000 }).catch(() => fail(`${handle} registration`))
  await page.getByText('I have saved my backup key somewhere safe.').click()
  await page.getByRole('button', { name: 'Continue to my wallet' }).click()
  await page.waitForTimeout(2000)
  const pubkey = await pubkeyOf(page)
  if (!/^[0-9a-f]{64}$/.test(pubkey)) fail(`${handle}: no pubkey in storage`)
  console.log(`PASS  ${merchant ? 'merchant' : 'customer'} registered @${handle}`)
  return { page, handle, pubkey }
}

async function sell(m: Page, customerHandle: string) {
  await m.goto(`${BASE}/sell`, { waitUntil: 'load' })
  await m.locator('input[placeholder="name"]').fill(customerHandle)
  await m.getByRole('button', { name: 'Continue' }).click()
  const amount = m.locator('input[placeholder="0.00"], input[placeholder="0"]').first()
  await amount.waitFor({ timeout: 30_000 })
  await amount.fill(AMOUNT)
  await m.getByRole('button', { name: 'Send voucher' }).click()
  await m.getByText(new RegExp(`Sent to ${customerHandle}`)).waitFor({ timeout: 120_000 }).catch(async () => fail(`sale: ${(await text(m)).slice(-300)}`))
  console.log(`PASS  merchant sold €${AMOUNT} to @${customerHandle}`)
}

async function waitForBalance(c: Page) {
  for (let i = 0; i < 12; i++) {
    await c.goto(`${BASE}/`, { waitUntil: 'load' })
    await c.waitForTimeout(5000)
    if ((await text(c)).includes(`€${AMOUNT}`)) return console.log(`PASS  customer wallet shows €${AMOUNT}`)
  }
  fail('customer never showed the voucher')
}

/** The whole #589 user flow for one account. Returns the wallet's summary line. */
async function snapshot(who: string, page: Page, npub: string, ticket: string): Promise<string> {
  const out = support('snapshot-code', 'issue', npub, `--ticket=${ticket}`)
  const code = /SNAP-[0-9A-Z]{3}-[0-9A-Z]{3}-[0-9A-Z]{3}/.exec(out)?.[0] ?? fail(`${who}: no code in "${out.trim()}"`)
  await page.goto(`${BASE}/settings/help/snapshot?code=${code}`, { waitUntil: 'load' })
  await page.getByTestId('snapshot-continue').click()
  await page.getByTestId('snapshot-consent').waitFor({ timeout: 20_000 }).catch(async () => fail(`${who}: consent never shown: ${(await text(page)).slice(0, 300)}`))
  await page.getByTestId('snapshot-build').click()
  await page.getByTestId('snapshot-size').waitFor({ timeout: 60_000 }).catch(async () => fail(`${who}: build: ${(await text(page)).slice(0, 300)}`))
  const summary = await page.getByTestId('snapshot-summary').innerText()
  const size = await page.getByTestId('snapshot-size').innerText()
  check(`${who}: size and connection advice shown`, /This snapshot is \d/.test(size) && (await page.getByTestId('snapshot-wifi').count()) === 1, size)
  await page.getByTestId('snapshot-upload').click()
  await page.getByTestId('snapshot-sent').waitFor({ timeout: 60_000 }).catch(async () => fail(`${who}: upload: ${(await text(page)).slice(0, 300)}`))
  check(`${who}: wallet says sent for ${ticket}`, (await page.getByTestId('snapshot-sent').innerText()).includes(ticket))
  return summary
}

async function waitForIntake(who: string, npub: string, page: Page) {
  let trail = ''
  for (let i = 0; i < 30 && !/snapshot_deleted/.test(trail); i++) {
    await page.waitForTimeout(4000)
    trail = support('snapshot', 'audit', npub)
  }
  check(`${who}: intake accepted the snapshot`, /snapshot_accepted/.test(trail))
  check(`${who}: intake deleted the blob from support Blossom`, /snapshot_deleted/.test(trail))
  check(`${who}: no rejection in the audit trail`, !/snapshot_rejected|snapshot_delete_failed/.test(trail))
  let records = ''
  for (let i = 0; i < 15 && !records.includes('deleted from server'); i++) {
    await page.reload({ waitUntil: 'load' })
    await page.waitForTimeout(3000)
    records = (await page.getByTestId('snapshot-records').innerText().catch(() => '')) || ''
  }
  check(`${who}: wallet record reaches "deleted from server"`, records.includes('deleted from server'), records.replace(/\s+/g, ' '))
}

function toolOutputs(npub: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const t of ['snapshot_vouchers', 'snapshot_transactions', 'snapshot_pending_sends', 'snapshot_derived', 'snapshot_errors', 'snapshot_console', 'snapshot_environment']) {
    out[t] = support('snapshot', 'tool', npub, t)
  }
  return out
}

async function main() {
  const browser = await chromium.launch()
  try {
    const m = await register(browser, true)
    const c = await register(browser, false)
    await sell(m.page, c.handle)
    await waitForBalance(c.page)

    const accounts = [
      { who: 'customer', ...c, ticket: `T589C${Date.now() % 10000}` },
      { who: 'merchant', ...m, ticket: `T589M${Date.now() % 10000}` },
    ]
    const secrets = accounts.flatMap((a) => [a.handle, a.pubkey, nip19.npubEncode(a.pubkey)])

    for (const a of accounts) {
      const npub = nip19.npubEncode(a.pubkey)
      const summary = await snapshot(a.who, a.page, npub, a.ticket)
      console.log(`      ${a.who} summary: ${summary.replace(/\s+/g, ' ')}`)
      if (a.who === 'customer') check('customer: summary counts the voucher it holds', /^[1-9]\d* vouchers/.test(summary), summary)
      if (a.who === 'merchant') check('merchant: summary includes stall takings', /takings for \d+ terminals/.test(summary), summary)
      check(`${a.who}: summary counts transactions`, /[1-9]\d* transactions/.test(summary), summary)
      await waitForIntake(a.who, npub, a.page)

      const tools = toolOutputs(npub)
      for (const [name, body] of Object.entries(tools)) {
        const hit = secrets.find((s) => body.includes(s))
        check(`${a.who}: ${name} holds no handle, pubkey or npub`, hit === undefined, hit ? `contains ${hit.slice(0, 12)}…` : '')
        check(`${a.who}: ${name} answers`, body.trim().length > 0 && !/^refused|no snapshot/i.test(body.trim()), body.trim().slice(0, 80))
      }
      if (a.who === 'customer') {
        check('customer: snapshot_vouchers lists a voucher', /"vouchers"\s*:\s*\[\s*\{/.test(tools.snapshot_vouchers) || /voucher#\d/.test(tools.snapshot_vouchers), tools.snapshot_vouchers.slice(0, 160))
      }
    }
  } finally {
    await browser.close()
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
