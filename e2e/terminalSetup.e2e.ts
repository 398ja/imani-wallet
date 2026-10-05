/**
 * #160 phase 2, two real browsers: an owner adds a terminal, a fresh device receives it.
 *
 * Context A registers a stall and adds a terminal from Settings → Terminals. Context B is a
 * fresh browser with nothing in storage: it opens /terminal/setup, shows its code, receives
 * the credential by DM, shows the same check code as A, takes a passphrase, and tells the
 * stall. A's row turns In service without a reload. No `localStorage` is injected anywhere.
 *
 * Needs a stack whose gateway-customer mints the stall co-key (imani-gateway-customer#187).
 * Against an older gateway, A's wallet refuses the credential, which this reports plainly.
 *
 * Run: E2E_BASE=http://localhost:5177 tsx e2e/terminalSetup.e2e.ts
 */
import { chromium, type Browser, type Page } from 'playwright'
import { registerMerchant } from './register.mts'

const BASE = process.env.E2E_BASE ?? 'http://localhost:5177'
const failures: string[] = []

function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

async function text(page: Page): Promise<string> {
  return (await page.locator('body').innerText()).replace(/\s+/g, ' ')
}

async function main() {
  const browser: Browser = await chromium.launch()
  const owner = await (await browser.newContext()).newPage()
  const device = await (await browser.newContext()).newPage()
  const errors: string[] = []
  owner.on('pageerror', (e) => errors.push(`A: ${e.message}`))
  device.on('pageerror', (e) => errors.push(`B: ${e.message}`))

  console.log('\nA registers a stall')
  await registerMerchant(owner, BASE)
  check('A is registered', !owner.url().includes('onboarding'), owner.url())

  console.log('\nB, a fresh device, offers to become a terminal')
  await device.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle' })
  await device.getByRole('link', { name: 'Set this device up as a terminal' }).click()
  const codeEl = device.getByTestId('terminal-code')
  await codeEl.waitFor({ timeout: 15_000 })
  const deviceKey = (await codeEl.innerText()).trim()
  check('B shows a 64-hex code', /^[0-9a-f]{64}$/.test(deviceKey), deviceKey)
  check('B says the code is not a secret', /not a secret/.test(await text(device)))
  const bStorage = await device.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('terminal')))
  check('B has stored nothing yet', bStorage.length === 0, bStorage.join(','))

  console.log('\nA adds it')
  await owner.goto(`${BASE}/settings/terminals/add`, { waitUntil: 'networkidle' })
  await owner.getByRole('button', { name: 'Add terminal' }).waitFor({ timeout: 15_000 })
  await owner.getByLabel('Name').fill('Front counter')
  await owner.getByRole('button', { name: /Redemption only/ }).click()
  await owner.getByLabel("Or enter the device's key").fill(deviceKey)
  await owner.getByRole('button', { name: 'Continue' }).click()
  await owner.getByRole('button', { name: 'Add terminal' }).click()
  await owner
    .getByRole('heading', { name: /Waiting for the device/ })
    .waitFor({ timeout: 90_000 })
    .catch(() => {})
  const aAdded = await text(owner)
  check('A says it was sent and is waiting', /Sent to Front counter/.test(aAdded), aAdded.slice(-300))
  const aCode = aAdded.match(/Check code (\d{3} \d{3})/)?.[1] ?? ''
  check('A shows a check code', aCode.length === 7)
  if (!aCode) {
    if (/without a way for you to revoke it/.test(aAdded)) {
      console.log(
        '\n  This gateway-customer does not mint the stall co-key (imani-gateway-customer#187),\n' +
          '  so the owner\'s wallet refused the credential, as it should. Deploy #187 and rerun.',
      )
    }
    await browser.close()
    console.log(`\n${failures.length} FAILED: ${failures.join(', ')}\n`)
    process.exit(1)
  }

  // The device accepts only the offer the owner's setup code names (#160 review), so the
  // operator enters A's setup code on B, as the camera would read it.
  const setup = (await owner.getByTestId('setup-code').innerText().catch(() => '')).trim()
  check('A shows a setup code naming its stall', /^imani-terminal:1:[0-9a-f]{64}:/.test(setup), setup)
  await device.getByLabel('Or enter the setup code').fill(setup)
  await device.getByRole('button', { name: 'Continue' }).click()

  console.log('\nB receives it')
  await device.getByText('Check this is your stall').waitFor({ timeout: 60_000 }).catch(() => {})
  const bOffer = await text(device)
  check('B shows the same check code as A', aCode !== '' && bOffer.includes(aCode), bOffer.slice(0, 300))
  check('B names the stall', /Test Stall/.test(bOffer), bOffer.slice(0, 200))
  await device.getByRole('button', { name: 'They match' }).click()
  await device.getByLabel('Passphrase', { exact: true }).fill('counter-pass')
  await device.getByLabel('Repeat passphrase').fill('counter-pass')
  await device.getByRole('button', { name: 'Finish setup' }).click()
  await device.getByText('This terminal is set up').waitFor({ timeout: 30_000 }).catch(() => {})
  check('B is set up', /This terminal is set up/.test(await text(device)))

  console.log('\nA sees it In service without a reload')
  await owner.goto(`${BASE}/settings/terminals`, { waitUntil: 'networkidle' })
  const turned = await owner
    .waitForFunction(() => !/Waiting for the device/.test(document.body.innerText), undefined, {
      timeout: 60_000,
    })
    .then(
      () => true,
      () => false,
    )
  check("A's row turned In service without a reload", turned, (await text(owner)).slice(0, 300))
  check('no uncaught errors', errors.length === 0, errors.join('; '))

  await browser.close()
  console.log(failures.length === 0 ? '\nAll checks passed.\n' : `\n${failures.length} FAILED: ${failures.join(', ')}\n`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E harness error:', e)
  process.exit(1)
})
