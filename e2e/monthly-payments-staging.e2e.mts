/**
 * Monthly payments (instalment plans) against DEPLOYED staging, API level. No mocks: the public edge,
 * payment-adapter, Postgres and Stripe test mode are all real.
 *
 *   R1  edge routes: POST /plan and the /plans shapes reach payment-adapter, nothing else under /checkout
 *   R2  start refusals: unknown stall (NOT_CONNECTED), below minimum (BELOW_MINIMUM + minAmountMinor),
 *       an Express account (ACCOUNT_NOT_ELIGIBLE)
 *   R3  signed routes: 401 unsigned / wrong URL / wrong verb; list works signed; another key's plan 404s;
 *       summary must be signed BY the stall (403 otherwise)
 *   O1  the stall's own switch (payment-adapter enforces it): an unsaved stall reads off; a save must be
 *       signed by that stall (401 / 403); with E2E_STALL_SK the stall is switched off (a plan is refused
 *       NOT_OFFERED), then on for months and weeks (yearly is INTERVAL_NOT_OFFERED, `day` a 400)
 *   S1  start a plan on an eligible stall: a Stripe Checkout URL in subscription mode, on the stall's
 *       own account, a PENDING plan the buyer can list and read
 *   S2  stop that PENDING plan: Stripe's page is expired, the plan CANCELLED, a second stop is a 409
 *   P1  (E2E_PAY=1) pay instalment 1 with 4242 in Stripe's hosted Checkout (Playwright); invoice.paid
 *       arrives; the plan turns ACTIVE with 1 paid and one voucher; the stall's summary counts it (when
 *       E2E_STALL_SK is given); stop asks Stripe to cancel at period end, and a second stop changes nothing
 *   W1  (E2E_STALL_SK) a weekly plan: Stripe prices it per week, the buyer sees it weekly, it stops.
 *       The stall's switch is then put back as it was found.
 *
 * The eligible stall is passed in: E2E_STALL_SK (hex), or E2E_STALL_PUBKEY when only the public key is
 * known, for a stall that is READY at the card issuer (enrolled, plan allows cards) and whose connected
 * account is eligible (fee payer `account`, losses `stripe`). E2E_STALL_ACCOUNT names its acct_ when the
 * account carries no merchant_pubkey metadata (OAuth accounts do not). Without a stall S1/S2/P1 skip.
 * Plans are now refused unless the stall has switched them on (O1): with E2E_STALL_PUBKEY alone the
 * stall must already have saved that in its Payments settings.
 *
 *   STRIPE_SECRET_KEY=sk_test_... E2E_STALL_PUBKEY=... E2E_STALL_ACCOUNT=acct_... [E2E_PAY=1] \
 *     E2E_EXPRESS_STALL=<pubkey of an Express stall> npx tsx e2e/monthly-payments-staging.e2e.mts
 *
 * P1 leaves a live test subscription set to end at period end; cancel it in Stripe afterwards.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha256'

const BASE = (process.env.E2E_BASE ?? 'https://wallet.staging.398ja.xyz').replace(/\/+$/, '')
const STALL_SK = process.env.E2E_STALL_SK ?? ''
const EXPRESS_STALL = process.env.E2E_EXPRESS_STALL ?? ''
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY ?? ''
const PAY = process.env.E2E_PAY === '1'

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail = ''): boolean {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -> ${detail}`}`)
  return ok
}
function skip(name: string, why: string) {
  console.log(`  SKIP  ${name}: ${why}`)
}

function nip98(sk: Uint8Array, url: string, method: string, body?: string): string {
  const tags = [['u', url], ['method', method]]
  if (method !== 'GET') tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body ?? '')))])
  tags.push(['nonce', bytesToHex(generateSecretKey()).slice(0, 16)])
  const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, sk)
  return 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64')
}

async function call(method: string, path: string, opts: { sk?: Uint8Array; body?: unknown; signUrl?: string; signMethod?: string } = {}) {
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body)
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.sk) headers.Authorization = nip98(opts.sk, opts.signUrl ?? BASE + path, opts.signMethod ?? method, body)
  const res = await fetch(BASE + path, { method, headers, body })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

async function stripe(method: string, path: string, params: Record<string, string> = {}, account?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${STRIPE_KEY}` }
  if (account) headers['Stripe-Account'] = account
  const init: RequestInit = { method, headers }
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    init.body = new URLSearchParams(params).toString()
  }
  const res = await fetch(`https://api.stripe.com/v1${path}${method === 'GET' && Object.keys(params).length ? '?' + new URLSearchParams(params) : ''}`, init)
  return (await res.json()) as any
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const buyerSk = generateSecretKey()
const buyer = getPublicKey(buyerSk)
const otherSk = generateSecretKey()
const stallSk = STALL_SK ? hexToBytes(STALL_SK) : null
const stall = stallSk ? getPublicKey(stallSk) : (process.env.E2E_STALL_PUBKEY ?? '')

console.log(`monthly payments e2e against ${BASE}`)

// ---------------------------------------------------------------- R1 routing
console.log('R1 edge routing')
{
  const r = await call('GET', '/api/v1/checkout/plans')
  check('GET /plans reaches payment-adapter (401 NIP-98, not the gateway)', r.status === 401 && /NIP-98/.test(r.text), `${r.status} ${r.text.slice(0, 80)}`)
  const s = await call('GET', `/api/v1/checkout/plans/summary?stall=${'a'.repeat(64)}`)
  check('GET /plans/summary reaches payment-adapter', s.status === 401 && /NIP-98/.test(s.text), `${s.status}`)
  const id = '00000000-0000-0000-0000-000000000000'
  const g = await call('GET', `/api/v1/checkout/plans/${id}`)
  check('GET /plans/{id} reaches payment-adapter', g.status === 401 && /NIP-98/.test(g.text), `${g.status}`)
  const c = await call('POST', `/api/v1/checkout/plans/${id}/cancel`)
  check('POST /plans/{id}/cancel reaches payment-adapter', c.status === 401 && /NIP-98/.test(c.text), `${c.status}`)
  const p = await call('GET', '/api/v1/checkout/plan')
  check('GET /plan is refused at the edge (POST only)', p.status === 405, `${p.status}`)
  const d = await call('DELETE', `/api/v1/checkout/plans/${id}`)
  check('DELETE /plans/{id} is refused at the edge', d.status === 403 || d.status === 405, `${d.status}`)
  const x = await call('GET', '/api/v1/checkout/plans/x/y/z')
  check('other shapes under /plans are not routed to payment-adapter', !/NIP-98 authorization required/.test(x.text), `${x.status} ${x.text.slice(0, 60)}`)
}

// ---------------------------------------------------------------- R2 start refusals
console.log('R2 plan start refusals')
{
  const unknownStall = getPublicKey(generateSecretKey())
  const r = await call('POST', '/api/v1/checkout/plan', { body: { stallPubkey: unknownStall, buyerPubkey: buyer, amountMinor: 4000, instalments: 3 } })
  check('a stall with no Stripe account: NOT_CONNECTED', r.json?.code === 'NOT_CONNECTED', `${r.status} ${r.text.slice(0, 120)}`)
  if (EXPRESS_STALL) {
    const e = await call('POST', '/api/v1/checkout/plan', { body: { stallPubkey: EXPRESS_STALL, buyerPubkey: buyer, amountMinor: 4000, instalments: 3 } })
    check('an Express (platform-pays) account: ACCOUNT_NOT_ELIGIBLE', e.json?.code === 'ACCOUNT_NOT_ELIGIBLE', `${e.status} ${e.text.slice(0, 120)}`)
  } else skip('Express account refusal', 'E2E_EXPRESS_STALL not set')
  const target = stall || EXPRESS_STALL
  if (target) {
    const b = await call('POST', '/api/v1/checkout/plan', { body: { stallPubkey: target, buyerPubkey: buyer, amountMinor: 500, instalments: 3 } })
    check('below the minimum: BELOW_MINIMUM with minAmountMinor 2000', b.json?.code === 'BELOW_MINIMUM' && b.json?.minAmountMinor === 2000, `${b.status} ${b.text.slice(0, 120)}`)
    const t = await call('POST', '/api/v1/checkout/plan', { body: { stallPubkey: target, buyerPubkey: buyer, amountMinor: 4000, instalments: 25 } })
    check('more than 24 instalments is refused', t.status === 400, `${t.status} ${t.text.slice(0, 120)}`)
  }
  const m = await call('POST', '/api/v1/checkout/plan', { body: {} })
  check('an empty body is a 400', m.status === 400, `${m.status}`)
}

// ---------------------------------------------------------------- R3 signed routes
console.log('R3 signed routes')
{
  const list = await call('GET', '/api/v1/checkout/plans', { sk: buyerSk })
  check('a signed list answers 200 with an array', list.status === 200 && Array.isArray(list.json), `${list.status} ${list.text.slice(0, 80)}`)
  const wrongUrl = await call('GET', '/api/v1/checkout/plans', { sk: buyerSk, signUrl: 'https://evil.example/api/v1/checkout/plans' })
  check('a signature for another origin is refused', wrongUrl.status === 401, `${wrongUrl.status}`)
  const wrongVerb = await call('GET', '/api/v1/checkout/plans', { sk: buyerSk, signMethod: 'POST' })
  check('a signature for another verb is refused', wrongVerb.status === 401, `${wrongVerb.status}`)
  const someone = getPublicKey(generateSecretKey())
  const sum = await call('GET', `/api/v1/checkout/plans/summary?stall=${someone}`, { sk: buyerSk })
  check("a stall summary signed by someone else is 403", sum.status === 403, `${sum.status}`)
  const own = getPublicKey(buyerSk)
  const sumOwn = await call('GET', `/api/v1/checkout/plans/summary?stall=${own}`, { sk: buyerSk })
  check('a summary signed by that key answers {activePlans, monthlyTotals}', sumOwn.status === 200 && sumOwn.json?.activePlans === 0 && Array.isArray(sumOwn.json?.monthlyTotals), `${sumOwn.status} ${sumOwn.text.slice(0, 80)}`)
}

// ---------------------------------------------------------------- O1 the stall's own switch
// payment-adapter enforces the stall's opt-in (it used to be only in the published profile, so this
// suite could start plans on a stall that never turned them on). Needs the stall's secret key to sign.
let settingsBefore: { enabled?: boolean; intervals?: string[] } | null = null
async function saveSettings(sk: Uint8Array, body: unknown) {
  return call('POST', '/api/v1/checkout/plans/settings', { sk, body })
}
console.log('O1 the stall switch is enforced at plan start')
{
  const stranger = getPublicKey(generateSecretKey())
  const read = await call('GET', `/api/v1/checkout/plans/settings?stall=${stranger}`)
  check('a stall that never saved an offer reads as off', read.status === 200 && read.json?.enabled === false, `${read.status} ${read.text.slice(0, 80)}`)
  const unsigned = await call('POST', '/api/v1/checkout/plans/settings', { body: { enabled: true } })
  check('saving unsigned is refused', unsigned.status === 401, `${unsigned.status}`)
  const someoneSk = generateSecretKey()
  const other = await saveSettings(someoneSk, { stallPubkey: stranger, enabled: true })
  check('saving for another stall is refused (403)', other.status === 403, `${other.status}`)
  // (A signature over one body carrying another is covered by StallInstalmentSettingsControllerTest.)
  const own = await call('POST', '/api/v1/checkout/plans/settings', { sk: someoneSk, body: { enabled: true } })
  check('a correctly signed save works for the signer itself', own.status === 200 && own.json?.enabled === true, `${own.status} ${own.text.slice(0, 80)}`)
  await saveSettings(someoneSk, { enabled: false })

  if (stallSk) {
    settingsBefore = (await call('GET', `/api/v1/checkout/plans/settings?stall=${stall}`)).json
    const off = await saveSettings(stallSk, { enabled: false })
    check('the stall switches plans off, signed', off.status === 200 && off.json?.enabled === false, `${off.status}`)
    const refused = await call('POST', '/api/v1/checkout/plan', { body: { stallPubkey: stall, buyerPubkey: buyer, amountMinor: 4000, instalments: 3 } })
    check('a plan on a stall that switched off is refused: NOT_OFFERED', refused.status === 409 && refused.json?.code === 'NOT_OFFERED', `${refused.status} ${refused.text.slice(0, 120)}`)
    const on = await saveSettings(stallSk, { enabled: true, intervals: ['month', 'week'] })
    check('the stall switches plans on for months and weeks', on.status === 200 && on.json?.enabled === true && on.json?.intervals?.join() === 'week,month', `${on.status} ${on.text.slice(0, 80)}`)
    const yearly = await call('POST', '/api/v1/checkout/plan', { body: { stallPubkey: stall, buyerPubkey: buyer, amountMinor: 4000, instalments: 3, interval: 'year' } })
    check('an interval the stall does not offer is refused: INTERVAL_NOT_OFFERED', yearly.status === 409 && yearly.json?.code === 'INTERVAL_NOT_OFFERED', `${yearly.status} ${yearly.text.slice(0, 120)}`)
    const daily = await call('POST', '/api/v1/checkout/plan', { body: { stallPubkey: stall, buyerPubkey: buyer, amountMinor: 4000, instalments: 3, interval: 'day' } })
    check('an unknown interval is a 400', daily.status === 400, `${daily.status}`)
  } else skip('O1 stall switch', 'E2E_STALL_SK not set')
}

// ---------------------------------------------------------------- S1/S2 start and stop
let planId = ''
let sessionId = ''
let account = ''
if (!stall) {
  skip('S1 start, S2 stop, P1 pay', 'E2E_STALL_SK or E2E_STALL_PUBKEY (an eligible, ready stall) not set')
} else {
  console.log('S1 start a plan on an eligible stall')
  const r = await call('POST', '/api/v1/checkout/plan', { body: { stallPubkey: stall, buyerPubkey: buyer, amountMinor: 4000, instalments: 3 } })
  const url: string = r.json?.checkoutUrl ?? ''
  planId = r.json?.planId ?? ''
  check('start answers {checkoutUrl, planId}', r.status === 200 && url.startsWith('https://checkout.stripe.com/') && /^[0-9a-f-]{36}$/.test(planId), `${r.status} ${r.text.slice(0, 160)}`)

  const listed = await call('GET', '/api/v1/checkout/plans', { sk: buyerSk })
  const mine = (listed.json ?? []).find((p: any) => p.planId === planId)
  check('the buyer lists the plan as PENDING, 0 of 3 paid', mine?.status === 'PENDING' && mine?.instalmentsPaid === 0 && mine?.totalInstalments === 3 && mine?.amountMinor === 4000, JSON.stringify(mine))
  const read = await call('GET', `/api/v1/checkout/plans/${planId}`, { sk: buyerSk })
  check('the buyer reads it with no vouchers yet', read.status === 200 && read.json?.plan?.planId === planId && Array.isArray(read.json?.voucherIds) && read.json.voucherIds.length === 0, `${read.status} ${read.text.slice(0, 120)}`)
  const other = await call('GET', `/api/v1/checkout/plans/${planId}`, { sk: otherSk })
  check("another key reading it gets 404, not the plan", other.status === 404, `${other.status}`)
  const otherStop = await call('POST', `/api/v1/checkout/plans/${planId}/cancel`, { sk: otherSk })
  check("another key cannot stop it (404)", otherStop.status === 404, `${otherStop.status}`)

  // The session, from Stripe, on the stall's own account.
  if (STRIPE_KEY) {
    const accts = process.env.E2E_STALL_ACCOUNT ? { data: [{ id: process.env.E2E_STALL_ACCOUNT, metadata: { merchant_pubkey: stall } }] } : await stripe('GET', '/accounts', { limit: '100' })
    account = (accts.data ?? []).find((a: any) => a.metadata?.merchant_pubkey === stall)?.id ?? ''
    if (account) {
      const sessions = await stripe('GET', '/checkout/sessions', { limit: '5' }, account)
      const s = (sessions.data ?? []).find((x: any) => x.metadata?.recurring_plan_id === planId || x.url === url)
      sessionId = s?.id ?? ''
      check('the Checkout Session is on the stall\'s own account, subscription mode, open', !!s && s.mode === 'subscription' && s.status === 'open', JSON.stringify({ id: s?.id, mode: s?.mode, status: s?.status, metadata: s?.metadata }))
      if (s) {
        const items = await stripe('GET', `/checkout/sessions/${s.id}/line_items`, {}, account)
        const li = items.data?.[0]
        check('it charges £40.00 a month', li?.amount_total === 4000 && li?.price?.recurring?.interval === 'month' && li?.currency === 'gbp', JSON.stringify({ amount: li?.amount_total, recurring: li?.price?.recurring, cur: li?.currency }))
      }
    } else skip('Checkout Session inspection', 'no Stripe account carries this stall in metadata')
  } else skip('Checkout Session inspection', 'STRIPE_SECRET_KEY not set')

  if (!PAY) {
    console.log('S2 stop the unfinished plan')
    const stop = await call('POST', `/api/v1/checkout/plans/${planId}/cancel`, { sk: buyerSk })
    check('stopping a PENDING plan answers 200 CANCELLED', stop.status === 200 && stop.json?.status === 'CANCELLED', `${stop.status} ${stop.text.slice(0, 120)}`)
    if (STRIPE_KEY && account && sessionId) {
      const s = await stripe('GET', `/checkout/sessions/${sessionId}`, {}, account)
      check("Stripe's page was expired, so it can no longer be paid", s.status === 'expired', `status=${s.status}`)
    }
    const again = await call('POST', `/api/v1/checkout/plans/${planId}/cancel`, { sk: buyerSk })
    check('stopping it again is a 409 (already ended)', again.status === 409, `${again.status}`)
  }
}

// ---------------------------------------------------------------- P1 pay instalment 1
if (stall && PAY) {
  console.log('P1 pay the first instalment (Stripe test card 4242) and watch the plan')
  if (!STRIPE_KEY || !account || !sessionId) {
    check('prerequisites for paying', false, 'needs STRIPE_SECRET_KEY and the session found in S1')
  } else {
    const s0 = await stripe('GET', `/checkout/sessions/${sessionId}`, {}, account)
    await payInCheckout(String(s0.url))
    const s1 = await stripe('GET', `/checkout/sessions/${sessionId}`, {}, account)
    check('Stripe Checkout completed the session, with a subscription', s1.status === 'complete' && typeof s1.subscription === 'string', JSON.stringify({ status: s1.status, sub: s1.subscription }))
    const sub = typeof s1.subscription === 'string' ? await stripe('GET', `/subscriptions/${s1.subscription}`, {}, account) : null
    check('the subscription is on the stall account, £40/month', sub?.items?.data?.[0]?.price?.unit_amount === 4000 && sub?.items?.data?.[0]?.price?.recurring?.interval === 'month', JSON.stringify({ status: sub?.status }))
    let active: any = null
    for (let i = 0; i < 45 && !active; i++) {
      const read = await call('GET', `/api/v1/checkout/plans/${planId}`, { sk: buyerSk })
      if (read.json?.plan?.status === 'ACTIVE' && read.json?.voucherIds?.length === 1) active = read.json
      else await sleep(4000)
    }
    check('invoice.paid turns the plan ACTIVE, 1 of 3 paid, one voucher issued', !!active && active.plan.instalmentsPaid === 1, JSON.stringify(active ?? (await call('GET', `/api/v1/checkout/plans/${planId}`, { sk: buyerSk })).json))
    if (stallSk) {
      const sum = await call('GET', `/api/v1/checkout/plans/summary?stall=${stall}`, { sk: stallSk })
      const gbp = (sum.json?.monthlyTotals ?? []).find((t: any) => String(t.currency).toLowerCase() === 'gbp')
      check("the stall's summary counts the plan", sum.json?.activePlans >= 1 && gbp?.amountMinor >= 4000, sum.text.slice(0, 160))
    }
    const stop = await call('POST', `/api/v1/checkout/plans/${planId}/cancel`, { sk: buyerSk })
    check('stopping an ACTIVE plan answers 200 with cancelRequested', stop.status === 200 && stop.json?.cancelRequested === true, `${stop.status} ${stop.text.slice(0, 160)}`)
    if (sub) {
      const after = await stripe('GET', `/subscriptions/${sub.id}`, {}, account)
      check('Stripe has the subscription set to end at period end, not cancelled now', after.cancel_at_period_end === true && after.status === 'active', JSON.stringify({ cape: after.cancel_at_period_end, status: after.status }))
    }
    const again = await call('POST', `/api/v1/checkout/plans/${planId}/cancel`, { sk: buyerSk })
    check('stopping it again changes nothing (200, still stopping)', again.status === 200 && again.json?.cancelRequested === true, `${again.status} ${again.text.slice(0, 120)}`)
    const listed = await call('GET', '/api/v1/checkout/plans', { sk: buyerSk })
    const mine = (listed.json ?? []).find((p: any) => p.planId === planId)
    check('the list shows it still ACTIVE and stopping', mine?.status === 'ACTIVE' && mine?.cancelRequested === true, JSON.stringify(mine))
  }
}

/** Pays an open Checkout page with the 4242 test card (the Payment Element layout, seen 2026-11-18). */
async function payInCheckout(url: string): Promise<void> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ locale: 'en-GB' })
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForTimeout(5000)
    const inner = page.frames().find((f) => f.url().includes('elements-inner'))
    const root = inner ?? page.mainFrame()
    await root.locator('#linkAuthentication-emailInput, #email').first().fill('e2e-buyer@example.com').catch(() => {})
    await page.locator('#email').fill('e2e-buyer@example.com').catch(() => {})
    await root.getByText('Card', { exact: true }).first().click({ timeout: 3000 }).catch(() => {})
    await root.locator('#payment-numberInput, #cardNumber').first().fill('4242424242424242')
    await root.locator('#payment-expiryInput, #cardExpiry').first().fill('12 / 34')
    await root.locator('#payment-cvcInput, #cardCvc').first().fill('123')
    await root.locator('#payment-nameInput, #billingName').first().fill('E2E Buyer', { timeout: 2000 }).catch(() => {})
    await page.locator('#billingName').fill('E2E Buyer', { timeout: 2000 }).catch(() => {})
    await root.locator('#payment-postalCodeInput, #billingPostalCode').first().fill('SW1A 1AA', { timeout: 2000 }).catch(() => {})
    await page.locator('#billingPostalCode').fill('SW1A 1AA', { timeout: 2000 }).catch(() => {})
    const optIn = root.locator('#payment-linkOptInInput, #enableStripePass')
    if (await optIn.first().isChecked().catch(() => false)) await optIn.first().uncheck({ force: true }).catch(() => {})
    let submitted = false
    for (const loc of [root.getByTestId('payment-form-submit-button'), page.getByTestId('hosted-payment-submit-button'), page.locator('button[type=submit]')]) {
      if (await loc.first().isVisible().catch(() => false)) {
        await loc.first().click()
        submitted = true
        break
      }
    }
    if (!submitted) throw new Error('no submit button on the Checkout page')
    await page.waitForTimeout(12000)
    if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/monthly-checkout-${Date.now()}.png`, fullPage: true })
  } finally {
    await browser.close()
  }
}

// ---------------------------------------------------------------- W1 a weekly plan
if (stallSk && STRIPE_KEY && account) {
  console.log('W1 a weekly plan is priced weekly on the stall account, then stopped')
  const w = await call('POST', '/api/v1/checkout/plan', { body: { stallPubkey: stall, buyerPubkey: buyer, amountMinor: 2500, instalments: 8, interval: 'week' } })
  check('a weekly plan starts', w.status === 200 && typeof w.json?.planId === 'string', `${w.status} ${w.text.slice(0, 120)}`)
  const weeklyId: string = w.json?.planId ?? ''
  const sessions = await stripe('GET', '/checkout/sessions', { limit: '5' }, account)
  const s = (sessions.data ?? []).find((x: any) => x.metadata?.recurring_plan_id === weeklyId)
  if (s) {
    const items = await stripe('GET', `/checkout/sessions/${s.id}/line_items`, {}, account)
    const li = items.data?.[0]
    check('Stripe prices it at £25.00 a week', li?.amount_total === 2500 && li?.price?.recurring?.interval === 'week', JSON.stringify({ amount: li?.amount_total, recurring: li?.price?.recurring }))
  } else check('the weekly session is on the stall account', false, 'no session carries the plan id')
  const listed = await call('GET', '/api/v1/checkout/plans', { sk: buyerSk })
  check('the buyer sees it as weekly', (listed.json ?? []).find((p: any) => p.planId === weeklyId)?.interval === 'week', '')
  const stop = await call('POST', `/api/v1/checkout/plans/${weeklyId}/cancel`, { sk: buyerSk })
  check('stopping the unpaid weekly plan closes it', stop.status === 200 && stop.json?.status === 'CANCELLED', `${stop.status}`)
}

// Leave the stall's switch as we found it.
if (stallSk && settingsBefore) {
  const restored = await saveSettings(stallSk, {
    enabled: settingsBefore.enabled === true,
    intervals: settingsBefore.intervals?.length ? settingsBefore.intervals : ['month'],
  })
  if (restored.status !== 200) console.log(`  WARN  could not restore the stall's settings: ${restored.status}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`SUMMARY ${JSON.stringify({ passed: results.length - failed.length, failed: failed.length, planId, buyer, account, sessionId })}`)
process.exit(failed.length ? 1 : 0)
