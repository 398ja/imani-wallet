/**
 * imani-wallet#267 item 1: a card purchase end to end against the LOCAL stack, with a real Stripe
 * test key and the Stripe CLI. Nothing here is mocked: Stripe test mode takes a real 4242 payment,
 * `stripe listen` forwards its real webhook, payment-adapter records it, purchase-issuer mints and
 * files the sale record, and the assertions read what each service holds.
 *
 *   H1  one connected account seeded to `charges_enabled`, the stall enrolled (delegated) at the issuer
 *   H2  pay 4242 on Stripe's own Checkout page
 *       -> exactly ONE `stripe_purchase` row for the pi_, DISCHARGED, with a voucher id
 *       -> exactly ONE coupon for that payment on the stall's list (`GET /api/v1/purchases?stall=`)
 *       -> the stall's sale record carries a `delegated` warrant with `ref = pi_` (merchant record)
 *   F1  decline 4000 0000 0000 0002: no row, nothing minted
 *   F2  the paid event replayed (`stripe events resend`): still one row, one coupon
 *   F3  delayed webhook: pay with the listener DOWN (no row), bring it back and resend: one row,
 *       one coupon, discharged
 *
 * Credentials come from the environment ONLY (never commit them):
 *   set -a; . ~/.config/imani/stripe-test.env; set +a     # STRIPE_SECRET_KEY=sk_test_...
 *
 * Needs, and SKIPS cleanly (exit 0) when any is missing:
 *   - STRIPE_SECRET_KEY starting `sk_test_`
 *   - the `stripe` CLI on PATH
 *   - payment-adapter at E2E_PA (default http://localhost:28087), started with
 *     STRIPE_CONNECT_WEBHOOK_SECRET = the secret `stripe listen --print-secret` prints
 *   - purchase-issuer at E2E_ISSUER (default http://localhost:8791) and the gateway at E2E_GATEWAY
 *     (default http://localhost:8082), test mode
 *   - E2E_STALL_SK: hex key of a stall already enrolled for card sales at the issuer (`local-sell`)
 *   - E2E_PA_DB_CONTAINER (default cashu-mint-payment-adapter-db-1), E2E_PA_DB (default payment_adapter)
 *
 *   npx tsx e2e/card-purchase.e2e.mts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { hexToBytes } from '@noble/hashes/utils'
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'

const PA = (process.env.E2E_PA ?? 'http://localhost:28087').replace(/\/$/, '')
const ISSUER = (process.env.E2E_ISSUER ?? 'http://localhost:8791').replace(/\/$/, '')
const GATEWAY = (process.env.E2E_GATEWAY ?? 'http://localhost:8082').replace(/\/$/, '')
const WEBHOOK_PATH = process.env.E2E_WEBHOOK_PATH ?? '/api/v1/stripe/connect/webhooks'
const DB_CONTAINER = process.env.E2E_PA_DB_CONTAINER ?? 'cashu-mint-payment-adapter-db-1'
const DB = process.env.E2E_PA_DB ?? 'payment_adapter'
const ORIGIN = (process.env.E2E_ORIGIN ?? PA).replace(/\/$/, '')
const KEY = process.env.STRIPE_SECRET_KEY ?? ''
const STALL_SK = process.env.E2E_STALL_SK ?? ''
const AMOUNT = 650

const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `: ${detail}`}`)
  if (!ok) failures.push(name)
}
function skip(reason: string): never {
  console.log(`SKIP  card-purchase e2e: ${reason}`)
  process.exit(0)
}

// ---------------------------------------------------------------- prerequisites

if (!KEY) skip('STRIPE_SECRET_KEY is not set (source ~/.config/imani/stripe-test.env)')
if (!KEY.startsWith('sk_test_')) skip('STRIPE_SECRET_KEY is not a test key; this test never runs live')
try {
  execFileSync('stripe', ['--version'], { stdio: 'ignore' })
} catch {
  skip('the Stripe CLI (`stripe`) is not installed')
}
if (!/^[0-9a-f]{64}$/i.test(STALL_SK)) skip('E2E_STALL_SK (an enrolled stall key) is not set')
async function up(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) })
    return true
  } catch {
    return false
  }
}
for (const [name, url] of [['payment-adapter', PA], ['purchase-issuer', ISSUER], ['gateway', GATEWAY]] as const) {
  if (!(await up(url))) skip(`${name} is not reachable at ${url}`)
}

const STALL = getPublicKey(hexToBytes(STALL_SK))

// ---------------------------------------------------------------- helpers

async function stripe(method: string, path: string, form: Record<string, string> = {}, account?: string) {
  const r = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(account ? { 'Stripe-Account': account } : {}),
    },
    body: method === 'GET' ? undefined : new URLSearchParams(form).toString(),
  })
  const json = (await r.json()) as Record<string, unknown>
  if (!r.ok) throw new Error(`stripe ${method} ${path}: ${JSON.stringify(json.error ?? json)}`)
  return json
}

function sql(statement: string): string {
  const user = execFileSync('docker', ['exec', DB_CONTAINER, 'printenv', 'POSTGRES_USER']).toString().trim()
  return execFileSync('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', user, '-d', DB, '-A', '-t', '-c', statement])
    .toString()
    .trim()
}
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`

function nip98(url: string, method: string, body?: string): string {
  const tags: string[][] = [['u', url], ['method', method]]
  if (body) {
    const hash = execFileSync('sha256sum', { input: body }).toString().split(' ')[0]
    tags.push(['payload', hash])
  }
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, hexToBytes(STALL_SK))
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

async function until<T>(what: () => Promise<T | undefined> | T | undefined, ms = 90_000): Promise<T | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await what()
    if (v !== undefined) return v
    await new Promise((r) => setTimeout(r, 2000))
  }
  return undefined
}

function rowsFor(pi: string): Array<{ status: string; voucher: string }> {
  const out = sql(`select status || '|' || coalesce(voucher_id,'') from stripe_purchase where payment_intent_id=${quote(pi)}`)
  return out === '' ? [] : out.split('\n').map((l) => ({ status: l.split('|')[0], voucher: l.split('|')[1] }))
}

async function stallList(): Promise<Array<{ voucher_id: string; ref: string }>> {
  const url = `${ORIGIN}/api/v1/purchases?stall=${STALL}`
  const r = await fetch(`${PA}/api/v1/purchases?stall=${STALL}`, { headers: { Authorization: nip98(url, 'GET') } })
  return r.ok ? ((await r.json()) as Array<{ voucher_id: string; ref: string }>) : []
}

/** The stall's sale-record rows, unwrapped with the stall key (the merchant's own ledger input). */
async function saleRecordRows(): Promise<Array<Record<string, unknown>>> {
  const r = await fetch(`${GATEWAY}/api/v1/nostr/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kinds: [1059], tags: { '#p': [STALL] }, limit: 200 }),
  })
  if (!r.ok) return []
  const events = ((await r.json()) as { events?: Array<Record<string, unknown>> }).events ?? []
  const sk = hexToBytes(STALL_SK)
  const rows: Array<Record<string, unknown>> = []
  for (const e of events) {
    try {
      const wrap = { ...e, created_at: e.createdAt ?? e.created_at } as unknown as Event
      const seal = JSON.parse(nip44.decrypt(wrap.content, nip44.getConversationKey(sk, wrap.pubkey))) as Event
      const rumor = JSON.parse(nip44.decrypt(seal.content, nip44.getConversationKey(sk, seal.pubkey))) as { content: string }
      const msg = JSON.parse(rumor.content) as { type?: string; rows?: Array<Record<string, unknown>> }
      if (msg.type === 'imani-terminal-sale/1') rows.push(...(msg.rows ?? []))
    } catch {
      // not a sale record for this stall
    }
  }
  return rows
}

let listener: ChildProcess | null = null
function listen(): void {
  listener = spawn('stripe', ['listen', '--api-key', KEY, '--forward-connect-to', `${PA}${WEBHOOK_PATH}`], { stdio: 'ignore' })
}
function stopListening(): void {
  listener?.kill('SIGTERM')
  listener = null
}

/** A Checkout Session for this stall, paid (or declined) with `card` on Stripe's own page. */
async function buy(card: string): Promise<{ pi?: string; session: string }> {
  const r = await fetch(`${PA}/api/v1/checkout/purchase`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stallPubkey: STALL, amountMinor: AMOUNT, buyerPubkey: 'c'.repeat(64) }),
  })
  const body = (await r.json()) as { checkoutUrl?: string }
  if (!r.ok || !body.checkoutUrl) throw new Error(`checkout refused: HTTP ${r.status} ${JSON.stringify(body)}`)
  const session = new URL(body.checkoutUrl).pathname.split('/').find((p) => p.startsWith('cs_')) ?? ''
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(body.checkoutUrl, { waitUntil: 'load' })
    await page.locator('#email').fill('e2e-buyer@example.invalid').catch(() => {})
    await page.locator('#cardNumber').fill(card)
    await page.locator('#cardExpiry').fill('12 / 34')
    await page.locator('#cardCvc').fill('123')
    await page.locator('#billingName').fill('E2E Buyer').catch(() => {})
    await page.locator('#billingPostalCode').fill('SW1A 1AA').catch(() => {})
    await page.locator('button[type=submit]').click()
    await page.waitForTimeout(8000)
  } finally {
    await browser.close()
  }
  const account = sql(`select stripe_account_id from connected_stripe_account where merchant_pubkey=${quote(STALL)}`)
  const s = await stripe('GET', `/checkout/sessions/${session}`, {}, account)
  return { pi: typeof s.payment_intent === 'string' ? s.payment_intent : undefined, session }
}

/** The connected account's `checkout.session.completed` for this session (Connect events live there). */
async function paidEventFor(session: string): Promise<string | undefined> {
  const events = await stripe('GET', '/events?type=checkout.session.completed&limit=20', {}, account)
  const hit = (events.data as Array<{ id: string; data: { object: { id: string } } }>).find((e) => e.data.object.id === session)
  return hit?.id
}

// ---------------------------------------------------------------- H1: seed

console.log('H1  seed a connected account to charges_enabled, stall delegated')
const existing = sql(`select stripe_account_id from connected_stripe_account where merchant_pubkey=${quote(STALL)} and charges_enabled`)
let account = existing
if (!account) {
  // Custom, not Express: test mode can complete a Custom account's requirements over the API with
  // Stripe's test fixtures, which Express onboarding cannot do without a browser.
  const created = await stripe('POST', '/accounts', {
    type: 'custom',
    country: 'GB',
    'capabilities[card_payments][requested]': 'true',
    'capabilities[transfers][requested]': 'true',
    business_type: 'individual',
    'individual[first_name]': 'E2E',
    'individual[last_name]': 'Stall',
    'individual[dob][day]': '1',
    'individual[dob][month]': '1',
    'individual[dob][year]': '1901',
    'individual[address][line1]': 'address_full_match',
    'individual[address][city]': 'London',
    'individual[address][postal_code]': 'SW1A 1AA',
    'individual[email]': 'e2e-stall@example.invalid',
    'individual[phone]': '+447700900000',
    'business_profile[mcc]': '5734',
    'business_profile[url]': 'https://example.invalid',
    'external_account': 'btok_gb',
    'tos_acceptance[date]': String(Math.floor(Date.now() / 1000)),
    'tos_acceptance[ip]': '127.0.0.1',
  })
  account = String(created.id)
  const ready = await until(async () => ((await stripe('GET', `/accounts/${account}`)).charges_enabled === true ? true : undefined), 60_000)
  check('Stripe says the account is charges_enabled', ready === true)
  sql(
    `insert into connected_stripe_account (id, merchant_pubkey, stripe_account_id, onboarding_complete, charges_enabled,` +
      ` payouts_enabled, default_currency, created_at, updated_at) values (gen_random_uuid(), ${quote(STALL)}, ${quote(account)},` +
      ` true, true, true, 'gbp', now(), now()) on conflict (merchant_pubkey) do update set stripe_account_id=excluded.stripe_account_id,` +
      ` charges_enabled=true, onboarding_complete=true`,
  )
}
check('payment-adapter holds the account', account.startsWith('acct_'))
const readiness = (await (await fetch(`${ISSUER}/api/v1/card-sales/ready/${STALL}`)).json()) as { ready?: boolean }
check('the stall is delegated and ready at the issuer', readiness.ready === true, JSON.stringify(readiness))
if (failures.length) {
  console.log(`\nFAILED (${failures.length}) during setup: ${failures.join(', ')}`)
  process.exit(1)
}

try {
  listen()
  await new Promise((r) => setTimeout(r, 5000))

  // -------------------------------------------------------------- H2: pay 4242
  console.log('H2  pay 4242')
  const paid = await buy('4242424242424242')
  check('Stripe has a payment intent', Boolean(paid.pi))
  const pi = paid.pi ?? 'pi_missing'
  const discharged = await until(() => {
    const rows = rowsFor(pi)
    return rows.length === 1 && rows[0].status === 'DISCHARGED' && rows[0].voucher ? rows : undefined
  })
  check('exactly one stripe_purchase row, DISCHARGED, with a voucher', discharged !== undefined, JSON.stringify(rowsFor(pi)))
  const voucher = discharged?.[0].voucher ?? ''
  const listed = (await stallList()).filter((p) => p.ref === pi)
  check('exactly one coupon for the payment on the stall list', listed.length === 1 && listed[0].voucher_id === voucher)
  const record = await until(async () => (await saleRecordRows()).find((r) => r.voucher_id === voucher))
  const warrant = record ? (JSON.parse(String(record.issuance_warrant)) as { form?: string; ref?: string }) : {}
  check('the merchant record carries a delegated warrant with the pi_', warrant.form === 'delegated' && warrant.ref === pi)

  // -------------------------------------------------------------- F1: decline
  console.log('F1  decline 4000 0000 0000 0002')
  const declined = await buy('4000000000000002')
  await new Promise((r) => setTimeout(r, 10_000))
  const declinedRows = declined.pi ? rowsFor(declined.pi) : []
  check('a declined card records nothing and mints nothing', declinedRows.length === 0, JSON.stringify(declinedRows))

  // -------------------------------------------------------------- F2: replay
  console.log('F2  replay the paid event')
  const event = await paidEventFor(paid.session)
  check('the paid event is found', Boolean(event))
  if (event) execFileSync('stripe', ['events', 'resend', event, '--api-key', KEY, '--stripe-account', account], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 15_000))
  check('still exactly one row after the replay', rowsFor(pi).length === 1)
  check('still exactly one coupon after the replay', (await stallList()).filter((p) => p.ref === pi).length === 1)

  // -------------------------------------------------------------- F3: delayed webhook
  console.log('F3  delayed webhook')
  stopListening()
  const late = await buy('4242424242424242')
  const latePi = late.pi ?? 'pi_missing'
  await new Promise((r) => setTimeout(r, 10_000))
  check('no row while the webhook is held back', rowsFor(latePi).length === 0)
  listen()
  await new Promise((r) => setTimeout(r, 5000))
  const lateEvent = await paidEventFor(late.session)
  if (lateEvent) execFileSync('stripe', ['events', 'resend', lateEvent, '--api-key', KEY, '--stripe-account', account], { stdio: 'ignore' })
  const lateRows = await until(() => {
    const rows = rowsFor(latePi)
    return rows.length === 1 && rows[0].status === 'DISCHARGED' ? rows : undefined
  })
  check('the late webhook records one row and discharges it', lateRows !== undefined, JSON.stringify(rowsFor(latePi)))
  check('one coupon for the late payment', (await stallList()).filter((p) => p.ref === latePi).length === 1)
} finally {
  stopListening()
}

console.log(failures.length ? `\nFAILED (${failures.length}): ${failures.join(', ')}` : '\nALL PASS')
process.exit(failures.length ? 1 : 0)
