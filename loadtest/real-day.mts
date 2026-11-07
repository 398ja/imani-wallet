/**
 * A real market day (#550): the REAL deployed wallet, driven through every user flow by browser
 * personas, on one clock with the k6 crowd (market-day.js) for the rest of the population.
 *
 *   npx tsx loadtest/real-day.mts --dry-run     # validate pool, keys, env; then exit
 *   npx tsx loadtest/real-day.mts --smoke       # 2 stalls, 3 customers, every journey once
 *   npx tsx loadtest/real-day.mts               # 100 customers (30 browser + 70 k6) + 10 stalls, 20m
 *
 * See loadtest/README.md "A real market day" for the design and the reasons. In short:
 *  - Browser personas (Playwright, one Chromium, one context per persona) for every flow whose
 *    work happens on the device: receive, split, NUT-18V pay, Cashlinks, checkout codes.
 *  - k6 (market-day.js) for the crowd: acquire, poll, drain, atomic-send C2C, pay a stall, and the
 *    stalls' payment-receipt drains.
 *
 * Stall slots: slot 0 = corda, slot 1 = bart (keys from MERCHANT_KEYS_FILE, held in memory only),
 * slots 2.. = pool stalls. STALL_SLOTS=pool makes every slot a pool stall (no real keys needed).
 *
 * Nothing secret is printed or written: every string out of this file passes through redact().
 * Tracing and screenshots are never enabled, so the backup-key import is not recorded anywhere.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { getPublicKey, nip19 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'
import {
  BROWSER_LOCALE, PAYMENT_DONE, SALE_DELIVERED, UNSAVED_RECEIVE, bypassCaptcha, captchaBypassHeaders, createUi, goto,
  pubkeyOf, registerCustomer, screenText,
} from '../e2e/lib/ui.mts'
import { applyCode, placeOrder, processOrder } from '../e2e/lib/shop.mts'
import { loadRealStalls, KeyFileError, type RealStall } from './real-day/keys.mts'
import { conserve, parseBalancePanel, type Balances, type Movement } from './real-day/ledger.mts'
import { classify429, PACED_LIMITS, tokenBucket, type PacedLimit } from './real-day/pacing.mts'
import { redact, registerSecret } from './real-day/redact.mts'
import { buildResult, renderMarkdown, resultName, summariseK6, type Attempt, type K6Summary, type Outcome, type Population } from './real-day/report.mts'
import { amountMinor, formatMinor, nextJourney, rng, seedFor, smokePlan, thinkMs, type Journey } from './real-day/schedule.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const args = new Set(process.argv.slice(2))
const MODE: Population['mode'] = args.has('--dry-run') ? 'dry-run' : args.has('--smoke') ? 'smoke' : 'full'
const env = (k: string, d: string) => process.env[k] ?? d
const num = (k: string, d: number) => Number(process.env[k] ?? d)

const BASE = env('E2E_BASE', env('GATEWAY_URL', 'https://wallet.staging.398ja.xyz')).replace(/\/+$/, '')
const SHOP = env('E2E_SHOP', 'https://shop.staging.398ja.xyz').replace(/\/+$/, '')
const SEED = num('SEED', 550)
const STALLS = num('STALLS', MODE === 'smoke' ? 2 : 10)
const CUSTOMERS = num('CUSTOMERS', MODE === 'smoke' ? 3 : 100)
const BROWSER_CUSTOMERS = Math.min(CUSTOMERS, num('BROWSER_CUSTOMERS', MODE === 'smoke' ? 3 : 30))
const K6_CUSTOMERS = CUSTOMERS - BROWSER_CUSTOMERS
const BROWSER_PERSONAS = num('BROWSER_PERSONAS', 40)
const DAY = env('DAY_DURATION', MODE === 'smoke' ? '5m' : '20m')
const NEW_SHARE = num('NEW_SHARE', 0.2)
const STALL_SLOTS = env('STALL_SLOTS', 'real') // 'real' (corda, bart, pool...) or 'pool'
const POOL_FILE = env('POOL_FILE', join(ROOT, '.loadtest-pool.json'))
const CURRENCY = env('CURRENCY', 'EUR')
const THINK_MIN_S = num('THINK_MIN_S', MODE === 'smoke' ? 2 : 5)
const THINK_MAX_S = num('THINK_MAX_S', MODE === 'smoke' ? 5 : 40)
const RUN_K6 = env('RUN_K6', K6_CUSTOMERS > 0 ? '1' : '0') === '1'

function durationMs(text: string): number {
  let total = 0
  for (const part of text.match(/\d+(\.\d+)?\s*[hms]/g) ?? []) {
    const v = Number.parseFloat(part)
    total += part.endsWith('h') ? v * 3_600_000 : part.endsWith('m') ? v * 60_000 : v * 1000
  }
  if (!total) throw new Error(`DAY_DURATION "${text}" is not a duration like 20m`)
  return total
}

const log = (line: string) => console.log(redact(`${new Date().toISOString().slice(11, 19)} ${line}`))

// ---------------------------------------------------------------------------- identities

type PoolEntry = { index: number; privHex: string; pubHex: string; npub: string }
type StallPersona = { slot: number; name: string; displayName: string; secret: Uint8Array; pubHex: string; real: boolean; currency: string; shop: string | null }
type CustomerPersona = { id: string; index: number; secret: Uint8Array | null; isNew: boolean }

function readPool(): PoolEntry[] {
  if (!existsSync(POOL_FILE)) throw new Error(`no pool at ${POOL_FILE}. Run: node loadtest/pool.mjs --size N`)
  const pool = Object.values(JSON.parse(readFileSync(POOL_FILE, 'utf8')) as Record<string, PoolEntry>).sort((a, b) => a.index - b.index)
  for (const p of pool) {
    registerSecret(p.privHex)
    if (getPublicKey(hexToBytes(p.privHex)) !== p.pubHex) throw new Error(`pool entry #${p.index}: pubHex does not match its key`)
  }
  return pool
}

/** Public stall facts (currency, name, shop) from the relay, so nothing is assumed. */
async function stallFacts(pubHex: string): Promise<{ currency: string; name: string; shop: string | null; active: boolean }> {
  const r = await fetch(`${BASE}/api/v1/nostr/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kinds: [30078, 0], authors: [pubHex], limit: 20 }),
  })
  const events = ((await r.json()) as { events: { kind: number; tags: string[][]; content: string; created_at: number }[] }).events
  const latest = (pred: (e: (typeof events)[0]) => boolean) => events.filter(pred).sort((a, b) => b.created_at - a.created_at)[0]
  const rec = latest((e) => e.kind === 30078 && e.tags.some((t) => t[0] === 'd' && t[1] === 'imani:merchant'))
  const prof = latest((e) => e.kind === 0)
  const parse = (s?: string) => { try { return s ? JSON.parse(s) : {} } catch { return {} } }
  const c = parse(rec?.content)
  const p = parse(prof?.content)
  return { currency: c.issuanceCurrency ?? CURRENCY, name: p.name ?? c.storeDescription ?? pubHex.slice(0, 8), shop: c.online_shop?.url ?? null, active: c.active !== false && !!rec }
}

async function cardReady(pubHex: string): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/v1/card-sales/ready/${pubHex}`, { signal: AbortSignal.timeout(10_000) })
    return r.ok && ((await r.json()) as { ready?: boolean }).ready === true
  } catch {
    return false
  }
}

async function buildPersonas(pool: PoolEntry[]): Promise<{ stalls: StallPersona[]; customers: CustomerPersona[]; poolStalls: number }> {
  const real: RealStall[] = STALL_SLOTS === 'real' ? loadRealStalls().slice(0, Math.min(2, STALLS)) : []
  const poolStalls = STALLS - real.length
  // The pool's first identities are its stalls (market-day.js's convention). RESERVED_POOL_STALLS
  // keeps them out of the customers even when this run uses fewer of them (smoke with real slots).
  const reserved = Math.max(poolStalls, num('RESERVED_POOL_STALLS', poolStalls))
  const need = reserved + BROWSER_CUSTOMERS + K6_CUSTOMERS
  if (pool.length < need) throw new Error(`the pool holds ${pool.length}, this run needs ${need} (${reserved} pool stalls + ${CUSTOMERS} customers). Run: node loadtest/pool.mjs --size ${need}`)
  const stalls: StallPersona[] = []
  for (const r of real) stalls.push({ slot: r.slot, name: r.name, displayName: r.name, secret: r.secret, pubHex: r.pubHex, real: true, currency: '', shop: null })
  for (let i = 0; i < poolStalls; i++) {
    const p = pool[i]!
    stalls.push({ slot: real.length + i, name: `stall${String(p.index).padStart(4, '0')}`, displayName: '', secret: hexToBytes(p.privHex), pubHex: p.pubHex, real: false, currency: '', shop: null })
  }
  for (const s of stalls) {
    const f = await stallFacts(s.pubHex)
    if (!f.active) throw new Error(`stall ${s.name} (${s.pubHex.slice(0, 8)}) has no active stall record. Pool stalls: node loadtest/stalls.mjs --count ${poolStalls}`)
    Object.assign(s, { currency: f.currency, displayName: f.name, shop: f.shop })
  }
  const random = rng(seedFor(SEED, 'population'))
  const customers: CustomerPersona[] = []
  for (let i = 0; i < BROWSER_CUSTOMERS; i++) {
    const p = pool[reserved + i]!
    const isNew = random() < NEW_SHARE
    customers.push({ id: `cust${String(p.index).padStart(4, '0')}`, index: p.index, secret: isNew ? null : hexToBytes(p.privHex), isNew })
  }
  return { stalls, customers, poolStalls: reserved }
}

// ---------------------------------------------------------------------------- run state

const ui = createUi({ base: BASE })
const attempts: Attempt[] = []
const movements: Movement[] = []
const pageErrors: string[] = []
const unsavedReceives: string[] = []
const notes: string[] = []
const loginReplayUnsaved: string[] = []
/** Every 429 a page saw, with its path, for classifying a journey's failure. */
const refused: { at: number; persona: string; path: string }[] = []
/** When the edge's captcha gate refused a Cashlink lookup (no E2E_CAPTCHA_BYPASS). */
const captchaRefusals: number[] = []
const buckets: Record<PacedLimit, ReturnType<typeof tokenBucket>> = {
  register: tokenBucket('register', PACED_LIMITS.register.perMinute),
  codes: tokenBucket('codes', PACED_LIMITS.codes.perMinute),
  claims: tokenBucket('claims', PACED_LIMITS.claims.perMinute),
}

type Live = { context: BrowserContext; page: Page }
type CustomerState = CustomerPersona & {
  live: Live | null
  pubHex: string
  saved: Awaited<ReturnType<BrowserContext['storageState']>> | null
  /** What the wallet holds, per stall pubkey: total minor and coupon count, as the harness put it there. */
  holds: Record<string, { minor: number; count: number }>
  before: Record<string, number> | null
}

function watch(persona: string, page: Page): void {
  page.on('pageerror', (e) => pageErrors.push(`[${persona}] ${e.message}`))
  page.on('console', (m) => { if (UNSAVED_RECEIVE.test(m.text())) unsavedReceives.push(`[${persona}] ${m.text().slice(0, 300)}`) })
  page.on('response', (r) => {
    if (r.status() === 429) refused.push({ at: Date.now(), persona, path: new URL(r.url()).pathname })
    if ((r.status() === 403 || r.status() === 401) && new URL(r.url()).pathname.includes('/cashback/by-code/')) captchaRefusals.push(Date.now())
  })
}

async function openContext(browser: Browser, persona: string, storageState?: CustomerState['saved'], guardProfile = false): Promise<Live> {
  const context = await browser.newContext({
    locale: BROWSER_LOCALE,
    permissions: ['clipboard-read', 'clipboard-write'],
    ...(storageState ? { storageState } : {}),
  })
  await bypassCaptcha(context)
  if (guardProfile) await guardRealStall(context, persona)
  const page = await context.newPage()
  watch(persona, page)
  return { context, page }
}

/**
 * corda and bart are real stalls: the run must not change their profile, stall record or
 * online_shop. Logging into a fresh browser starts the app's profile syncs (startOnlineShopSync
 * reconciles online_shop against the LOCAL terminal roster, empty on a new device), so their
 * contexts drop any kind-0 or kind-30078 d=imani:merchant publish, on the relay socket and on the
 * gateway's mirror, answer it as refused, and record that it was tried: that attempt is itself a
 * finding (a new device would have rewritten the stall's public record).
 */
const blockedPublishes: string[] = []
/** The real stalls' public records the run must not touch: profile, stall record, terminal roster. */
const GUARDED_D = new Set(['imani:merchant', 'imani:terminals'])
function isProfileEvent(ev: unknown): ev is { kind: number; tags: string[][]; content: string } {
  const e = ev as { kind?: number; tags?: string[][] } | null
  return !!e && (e.kind === 0 || (e.kind === 30078 && !!e.tags?.some((t) => t[0] === 'd' && GUARDED_D.has(t[1] ?? ''))))
}
function describeBlocked(persona: string, via: string, ev: { kind: number; content: string }): string {
  let shop = ''
  if (ev.kind === 30078) {
    try { shop = (JSON.parse(ev.content) as { online_shop?: unknown }).online_shop ? ' (with online_shop)' : ' (WITHOUT online_shop)' } catch { shop = ' (unreadable content)' }
  }
  return `${persona}: blocked a kind-${ev.kind}${ev.kind === 30078 ? ` d=${(ev as { tags?: string[][] }).tags?.find((t) => t[0] === 'd')?.[1]}` : ''} publish via ${via}${shop}`
}
async function guardRealStall(context: BrowserContext, persona: string): Promise<void> {
  await context.routeWebSocket(/^wss?:\/\//, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((message) => {
      try {
        const frame = JSON.parse(String(message)) as unknown[]
        if (frame[0] === 'EVENT' && isProfileEvent(frame[1])) {
          const ev = frame[1] as unknown as { id: string; kind: number; content: string }
          blockedPublishes.push(describeBlocked(persona, 'relay', ev))
          ws.send(JSON.stringify(['OK', ev.id, false, 'blocked: loadtest guard for a real stall']))
          return
        }
      } catch { /* not JSON: pass through */ }
      server.send(message)
    })
    server.onMessage((message) => ws.send(message))
  })
  await context.route((url) => url.pathname === '/api/v1/nostr/events', async (route) => {
    const body = route.request().postDataJSON() as unknown
    if (route.request().method() === 'POST' && isProfileEvent(body)) {
      blockedPublishes.push(describeBlocked(persona, 'gateway mirror', body))
      return route.fulfill({ status: 403, body: '{"error":"blocked by loadtest guard"}', contentType: 'application/json' })
    }
    return route.fallback()
  })
}

/** One page per stall, used by one journey at a time. */
function mutex() {
  let tail = Promise.resolve()
  return <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn)
    tail = run.then(() => undefined, () => undefined)
    return run
  }
}

type StallState = StallPersona & { live: Live; lock: ReturnType<typeof mutex>; before: Record<string, number> | null; cardReady: boolean }

type JourneyResult = { outcome: Outcome; visibleMs?: number; detail?: string; observed?: string }
const ok = (visibleMs: number, observed: string): JourneyResult => ({ outcome: 'ok', visibleMs, observed })
const skip = (detail: string): JourneyResult => ({ outcome: 'skip', detail })
const fail = (detail: string): JourneyResult => ({ outcome: 'fail', detail })

async function record(journey: Journey, persona: string, run: () => Promise<JourneyResult>, page?: Page): Promise<JourneyResult> {
  const startedAt = Date.now()
  let r: JourneyResult
  try {
    r = await run()
  } catch (e) {
    const screen = page ? await screenText(page, 600).catch(() => '') : ''
    r = fail(`${String(e).split('\n')[0]} | screen: ${screen.replace(/\n/g, ' | ')}`)
  }
  const endedAt = Date.now()
  if (r.outcome === 'fail') {
    const mine = refused.filter((x) => x.at >= startedAt && x.at <= endedAt + 1000)
    const paced = mine.find((x) => classify429(x.path))
    if (paced) r = { outcome: 'pacing', detail: `${classify429(paced.path)} limiter refused ${paced.path}: ${r.detail ?? ''}` }
    else if (mine.length) r = { outcome: 'rate-limited', detail: `429 on ${[...new Set(mine.map((x) => x.path))].join(', ')}: ${r.detail ?? ''}` }
  }
  const a: Attempt = { journey, persona, outcome: r.outcome, startedAt, endedAt, visibleMs: r.visibleMs, observed: r.observed, detail: r.detail ? redact(r.detail).slice(0, 800) : undefined }
  attempts.push(a)
  log(`${persona.padEnd(10)} ${journey.padEnd(9)} ${r.outcome}${r.visibleMs !== undefined ? ` ${(r.visibleMs / 1000).toFixed(1)}s` : ''}${r.detail ? ` | ${r.detail.slice(0, 160)}` : ''}`)
  return r
}

// ---------------------------------------------------------------------------- reading money

async function customerBalances(page: Page): Promise<Record<string, number>> {
  await goto(page, `${BASE}/`)
  await ui.unlockIfLocked(page)
  await page.getByText('Total balance').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(2500)
  return parseBalancePanel(await ui.balancePanel(page))
}

async function stallBalances(s: StallState): Promise<Record<string, number>> {
  const text = await ui.stallOwnBalance(s.live.page, s.pubHex)
  const parsed = parseBalancePanel(text)
  return Object.keys(parsed).length ? parsed : { [s.currency]: 0 }
}

/** Polls the customer's home screen until `unit` has risen by `minor` (in place, no reload first). */
async function waitForRise(page: Page, unit: string, from: number, minor: number, windowMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs
  let reloaded = Date.now()
  while (Date.now() < deadline) {
    if (new URL(page.url()).pathname !== '/' || Date.now() - reloaded > 45_000) {
      await goto(page, `${BASE}/`)
      await ui.unlockIfLocked(page)
      reloaded = Date.now()
    }
    const now = parseBalancePanel(await ui.balancePanel(page).catch(() => '?'))[unit] ?? 0
    if (now - from >= minor) return true
    await page.waitForTimeout(1500)
  }
  return false
}

// ---------------------------------------------------------------------------- journeys

type Day = { browser: Browser; stalls: StallState[]; customers: CustomerState[]; random: () => number }

const holdOf = (c: CustomerState, stall: string) => (c.holds[stall] ??= { minor: 0, count: 0 })
const heldStalls = (c: CustomerState, d: Day) => d.stalls.filter((s) => (c.holds[s.pubHex]?.minor ?? 0) >= 50)

async function arrive(d: Day, c: CustomerState): Promise<JourneyResult> {
  if (c.live) return ok(0, 'already here')
  const started = Date.now()
  const unsavedBefore = unsavedReceives.length
  c.live = await openContext(d.browser, c.id, c.saved ?? undefined)
  const page = c.live.page
  if (c.saved) {
    // Returning: a cold boot that restores from local storage, as a phone does.
    await goto(page, `${BASE}/`)
    await ui.unlockIfLocked(page)
  } else if (c.isNew) {
    await buckets.register.take()
    await registerCustomer(page, BASE)
    c.pubHex = await pubkeyOf(page)
  } else {
    await ui.importKey(page, c.secret!, 'rd', true)
    c.pubHex = getPublicKey(c.secret!)
  }
  if (!/^[0-9a-f]{64}$/.test(c.pubHex)) return fail('no account after onboarding')
  await page.getByText('Total balance').waitFor({ timeout: 60_000 })
  const visible = Date.now() - started
  const bal = await customerBalances(page)
  // A first login on a fresh device re-drains the wallet's history; what it logs then is #123
  // (replays of receives settled elsewhere), not this day's money. Reported, not gated.
  if (!c.before && !c.isNew) {
    // Only this persona's lines: in a full day other wallets are logging at the same time.
    for (let i = unsavedReceives.length - 1; i >= unsavedBefore; i--) {
      if (unsavedReceives[i]!.startsWith(`[${c.id}]`)) loginReplayUnsaved.push(...unsavedReceives.splice(i, 1))
    }
  }
  if (!c.before) c.before = bal
  return ok(visible, c.saved ? 'cold boot restored the wallet' : c.isNew ? 'registered, wallet shown' : 'backup key imported, wallet shown')
}

async function buy(d: Day, c: CustomerState, stall: StallState): Promise<JourneyResult> {
  const page = c.live!.page
  // The customer shows their code; the stall sells to it.
  await goto(page, `${BASE}/receive`)
  await page.getByText('Show this to the merchant.').waitFor({ timeout: 30_000 })
  const before = (await customerBalances(page))[stall.currency] ?? 0
  const minor = amountMinor(d.random)
  const started = Date.now()
  const sold = await stall.lock(() => ui.sell(stall.live.page, c.pubHex.length === 64 ? npubOf(c.pubHex) : c.pubHex, formatMinor(minor)))
  if (!SALE_DELIVERED.test(sold)) return fail(`sale not delivered: ${sold.replace(/\n/g, ' | ').slice(0, 400)}`)
  if (!(await waitForRise(page, stall.currency, before, minor, 120_000))) return fail(`coupon not visible in the wallet within 120s (sold ${formatMinor(minor)} ${stall.currency})`)
  movements.push({ kind: 'sale', stall: stall.name, to: c.id, minor, unit: stall.currency })
  const h = holdOf(c, stall.pubHex)
  h.minor += minor
  h.count += 1
  return ok(Date.now() - started, 'coupon visible in the wallet')
}

async function pay(d: Day, c: CustomerState): Promise<JourneyResult> {
  const choices = heldStalls(c, d)
  if (!choices.length) return skip('holds no coupons to pay with')
  const stall = choices[Math.floor(d.random() * choices.length)]!
  const h = holdOf(c, stall.pubHex)
  const minor = Math.min(h.minor, amountMinor(d.random, 50, 150))
  const page = c.live!.page
  return stall.lock(async () => {
    const sp = stall.live.page
    await goto(sp, `${BASE}/redeem`)
    await ui.unlockIfLocked(sp)
    await sp.locator('input[placeholder="0.00"]').fill(formatMinor(minor), { timeout: 30_000 })
    await sp.getByRole('button', { name: 'Show payment code' }).click()
    await sp.getByText('Waiting for payment').waitFor({ timeout: 60_000 })
    // The till shows a QR and a truncated string; the full request is what Copy copies, and the
    // app keeps it in its own store (src/lib/vreq.ts). Read from there: no camera.
    const request = await sp.evaluate((pk) => {
      const raw = localStorage.getItem(`imani-wallet:payment-requests:${pk}`)
      return raw ? (JSON.parse(raw) as { requestString: string }[])[0]?.requestString ?? '' : ''
    }, stall.pubHex)
    if (!request) return fail('the till showed no payment request')
    await ui.scanText(page, request)
    await page.waitForURL(/\/pay\?/, { timeout: 30_000 })
    const payBtn = page.getByRole('button', { name: /^Pay$/ })
    await payBtn.waitFor({ timeout: 30_000 })
    // Timed from the tap on Pay: the user's action. Scanning is the till's speed, not the system's.
    const started = Date.now()
    await payBtn.click()
    const customerPaid = await page.waitForFunction(() => /^(Paid|Partly paid)$/m.test(document.body.innerText), undefined, { timeout: 120_000 }).then(() => true, () => false)
    const stallPaid = await sp.waitForFunction(() => /\bPaid\b/.test(document.body.innerText) && !/Waiting for payment/.test(document.body.innerText), undefined, { timeout: 120_000 }).then(() => true, () => false)
    if (!customerPaid || !stallPaid) {
      return fail(`Paid not shown on ${!customerPaid ? 'the customer' : 'the stall'}: customer="${(await screenText(page, 300)).replace(/\n/g, ' | ')}" stall="${(await screenText(sp, 300)).replace(/\n/g, ' | ')}"`)
    }
    movements.push({ kind: 'pay', from: c.id, stall: stall.name, minor, unit: stall.currency })
    h.minor -= minor
    return ok(Date.now() - started, 'Paid shown on both sides')
  })
}

async function send(d: Day, c: CustomerState): Promise<JourneyResult> {
  const choices = heldStalls(c, d)
  if (!choices.length) return skip('holds no coupons to send')
  const friends = d.customers.filter((x) => x !== c && x.live && x.pubHex)
  if (!friends.length) return skip('no other customer is in the market to send to')
  const friend = friends[Math.floor(d.random() * friends.length)]!
  const stall = choices[Math.floor(d.random() * choices.length)]!
  const h = holdOf(c, stall.pubHex)
  // A bundle: all of several coupons, which no single one covers (src/lib/pay.ts deliver).
  const bundle = h.count >= 2 && d.random() < 0.5
  const minor = bundle ? h.minor : Math.min(h.minor, 50)
  const fp = friend.live!.page
  const before = (await customerBalances(fp))[stall.currency] ?? 0
  const started = Date.now()
  const shown = await ui.send(c.live!.page, friend.pubHex, formatMinor(minor), stall.displayName || /./, stall.pubHex)
  if (!PAYMENT_DONE.test(shown)) return fail(`send not done: ${shown.replace(/\n/g, ' | ').slice(0, 400)}`)
  if (!(await waitForRise(fp, stall.currency, before, minor, 180_000))) return fail(`recipient ${friend.id} did not see ${formatMinor(minor)} ${stall.currency} arrive`)
  movements.push({ kind: 'send', from: c.id, to: friend.id, minor, unit: stall.currency })
  h.minor -= minor
  if (bundle) h.count = 0
  const fh = holdOf(friend, stall.pubHex)
  fh.minor += minor
  fh.count += bundle ? 2 : 1
  return ok(Date.now() - started, `recipient sees it arrive${bundle ? ' (bundle)' : ''}`)
}

async function link(d: Day, c: CustomerState): Promise<JourneyResult> {
  const choices = heldStalls(c, d)
  if (!choices.length) return skip('holds no coupons to send as a Cashlink')
  const claimers = d.customers.filter((x) => x !== c && x.live && x.pubHex)
  if (!claimers.length) return skip('no other customer is in the market to claim the link')
  const stall = choices[Math.floor(d.random() * choices.length)]!
  const h = holdOf(c, stall.pubHex)
  const minor = Math.min(h.minor, 50)
  const page = c.live!.page
  const started = Date.now()
  await goto(page, `${BASE}/send/link?from=${stall.pubHex}`)
  await ui.unlockIfLocked(page)
  const amount = page.locator('input[placeholder="0.00"]')
  if (!(await amount.waitFor({ timeout: 20_000 }).then(() => true, () => false))) {
    await page.getByRole('button').filter({ hasText: stall.displayName || /./ }).first().click()
    await amount.waitFor({ timeout: 30_000 })
  }
  await amount.fill(formatMinor(minor))
  await page.getByRole('button', { name: /^Continue$/ }).click()
  await page.getByRole('button', { name: 'Make Cashlink' }).click()
  await page.getByText('Cashlink ready').waitFor({ timeout: 120_000 })
  await page.getByRole('button', { name: /Copy link|Share link/ }).click()
  const url = await page.evaluate(() => navigator.clipboard.readText())
  if (!/\/g#/.test(url)) return fail('no Cashlink on the clipboard')
  movements.push({ kind: 'link-send', from: c.id, minor, unit: stall.currency })
  h.minor -= minor
  const claimer = claimers[Math.floor(d.random() * claimers.length)]!
  const cp = claimer.live!.page
  await buckets.claims.take()
  await goto(cp, url)
  await cp.getByRole('button', { name: 'Add to my wallet' }).click({ timeout: 60_000 })
  await cp.waitForFunction(() => /Voucher added|Voucher unavailable|Voucher waiting/.test(document.body.innerText), undefined, { timeout: 120_000 })
  const text = await screenText(cp, 400)
  if (!/Voucher added/.test(text)) return fail(`link not claimed: ${text.replace(/\n/g, ' | ')}`)
  movements.push({ kind: 'link-claim', to: claimer.id, minor, unit: stall.currency })
  const ch = holdOf(claimer, stall.pubHex)
  ch.minor += minor
  ch.count += 1
  return ok(Date.now() - started, 'link claimed')
}

async function online(d: Day, c: CustomerState): Promise<JourneyResult> {
  const shopStall = d.stalls.find((s) => s.shop)
  if (!shopStall) return skip('no stall in this run publishes an online shop (bart does; slot 1)')
  const h = holdOf(c, shopStall.pubHex)
  if (h.minor < 50) return skip(`holds no ${shopStall.name} coupons to make a code from`)
  const minor = Math.min(h.minor, 100)
  const page = c.live!.page
  await buckets.codes.take()
  const started = Date.now()
  await goto(page, `${BASE}/online?stall=${shopStall.pubHex}`)
  await ui.unlockIfLocked(page)
  await page.waitForFunction(() => !/Checking your vouchers/.test(document.body.innerText), undefined, { timeout: 60_000 }).catch(() => {})
  await page.getByLabel(/^Amount/).fill(formatMinor(minor), { timeout: 30_000 })
  await page.getByRole('button', { name: 'Get code' }).click()
  const code = await page.getByTestId('checkout-code').innerText({ timeout: 120_000 }).then((s) => s.match(/IMANI-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/)?.[0] ?? '', () => '')
  if (!code) return fail(`no checkout code: ${(await screenText(page, 400)).replace(/\n/g, ' | ')}`)
  movements.push({ kind: 'code', from: c.id, minor, unit: shopStall.currency })
  h.minor -= minor
  const madeMs = Date.now() - started
  // The shop side, as the shop does it (checkout-codes-woo-staging.e2e.mts W3/W4): the code in
  // the cart's coupon field, then a cash-on-delivery order. The plugin redeems on Processing,
  // which only the shop's admin can set.
  await buckets.codes.take()
  const shopped = await shopRedeem(d.browser, code)
  if (!shopped.ok) return fail(`code ${code.slice(0, 8)}… made in ${(madeMs / 1000).toFixed(1)}s, shop refused it: ${shopped.detail}`)
  if (!shopped.redeemed) return skip(`code made in ${(madeMs / 1000).toFixed(1)}s and taken by the shop's cart (${shopped.detail}); redemption needs the shop admin (E2E_SHOP_ADMIN_PASSWORD unset)`)
  return ok(Date.now() - started, 'code made and redeemed at the shop')
}

/**
 * The shop's side (e2e/lib/shop.mts, from checkout-codes-woo-staging.e2e.mts): the code in a real
 * cart, then, with the shop admin's password, a cash-on-delivery order set to Processing, which is
 * when the plugin redeems it. Without the password the order is NOT placed: an unpaid order on the
 * shared shop would hold the code with nobody to release it.
 */
async function shopRedeem(browser: Browser, code: string): Promise<{ ok: boolean; redeemed: boolean; detail: string }> {
  const o = { shop: SHOP, productId: num('E2E_SHOP_PRODUCT', 32), adminPassword: process.env.E2E_SHOP_ADMIN_PASSWORD }
  const ctx = await browser.newContext({ locale: BROWSER_LOCALE, serviceWorkers: 'block' })
  try {
    const buyer = await ctx.newPage()
    const { before, after } = await applyCode(buyer, o, code)
    if (!(before - after > 0)) return { ok: false, redeemed: false, detail: `cart total ${before} -> ${after}: ${(await screenText(buyer, 300)).match(/.{0,120}(Imani|IMANI-|coupon).{0,120}/i)?.[0] ?? ''}` }
    if (!o.adminPassword) return { ok: true, redeemed: false, detail: `cart total ${before} -> ${after}` }
    const orderId = await placeOrder(buyer, o)
    if (!orderId) return { ok: false, redeemed: false, detail: 'the order with the code was not placed' }
    const notes = await processOrder(browser, o, orderId)
    const redeemed = /redeemed/i.test(notes) && !/on.hold|failed/i.test(notes)
    return { ok: redeemed, redeemed, detail: `order ${orderId}: ${notes.slice(0, 200)}` }
  } finally {
    await ctx.close().catch(() => {})
  }
}

async function cashlink(d: Day, c: CustomerState): Promise<JourneyResult> {
  const captchaRefused = (since: number) => captchaRefusals.some((t) => t >= since)
  const bypass = Object.keys(captchaBypassHeaders()).length > 0
  const stall = d.stalls[Math.floor(d.random() * d.stalls.length)]!
  const minor = amountMinor(d.random, 50, 100)
  const started = Date.now()
  const gen = await stall.lock(async () => {
    const sp = stall.live.page
    const generated = sp.waitForResponse((r) => r.url().endsWith('/api/v1/portal/cashback/generate') && r.request().method() === 'POST', { timeout: 90_000 })
    await goto(sp, `${BASE}/sell/cashback`)
    await ui.unlockIfLocked(sp)
    await sp.locator('input[placeholder="0.00"]').fill(formatMinor(minor), { timeout: 60_000 })
    await sp.getByRole('button', { name: 'Create Cashlink' }).click()
    const res = await generated
    if (!res.ok()) return { error: `generate answered ${res.status()}` }
    return (await res.json()) as { claimUrl: string; claimKey: string }
  })
  if ('error' in gen) return fail(String(gen.error))
  const page = c.live!.page
  await buckets.claims.take()
  await goto(page, `${BASE}/c/${new URL(gen.claimUrl).pathname.split('/').pop()}#k=${gen.claimKey}`)
  await page.getByRole('button', { name: 'Add to my wallet' }).click({ timeout: 60_000 })
  await page.waitForFunction(() => /Voucher added|Voucher unavailable|Voucher waiting/.test(document.body.innerText), undefined, { timeout: 120_000 })
  const text = await screenText(page, 400)
  if (!/Voucher added/.test(text)) {
    if (!bypass && captchaRefused(started)) return skip(`the edge captcha refused the claim lookup and E2E_CAPTCHA_BYPASS is not set: ${text.replace(/\n/g, ' | ')}`)
    return fail(`Cashlink not claimed: ${text.replace(/\n/g, ' | ')}`)
  }
  movements.push({ kind: 'cashlink', stall: stall.name, to: c.id, minor, unit: stall.currency })
  const h = holdOf(c, stall.pubHex)
  h.minor += minor
  h.count += 1
  return ok(Date.now() - started, 'Cashlink claimed, voucher added')
}

async function browse(d: Day, c: CustomerState): Promise<JourneyResult> {
  const page = c.live!.page
  const stall = d.stalls[Math.floor(d.random() * d.stalls.length)]!
  const started = Date.now()
  const errorsBefore = pageErrors.length
  await goto(page, `${BASE}/`)
  await ui.unlockIfLocked(page)
  await page.getByText('Total balance').waitFor({ timeout: 30_000 })
  await goto(page, `${BASE}/merchants/${stall.pubHex}`)
  await page.getByRole('button', { name: 'Pay with your vouchers' }).waitFor({ timeout: 30_000 })
  await goto(page, `${BASE}/merchants/${stall.pubHex}/transactions`)
  await page.getByText(/^(\d+) entr(y|ies)$|^Nothing yet\.$/).first().waitFor({ timeout: 30_000 })
  const tx = page.locator('a[href^="/transaction/"]').first()
  const href = (await tx.count()) ? await tx.getAttribute('href') : null
  if (href) {
    // Followed by its href: the row may sit inside a collapsed bundle group, out of reach of a click.
    await goto(page, `${BASE}${href}`)
    await page.waitForFunction(() => (document.getElementById('root')?.innerText.length ?? 0) > 20, undefined, { timeout: 30_000 })
  }
  await ui.notificationRows(page)
  await goto(page, `${BASE}/coupons/expiring`)
  await page.waitForTimeout(2000)
  if (pageErrors.length > errorsBefore) return fail(`page error while browsing: ${pageErrors.slice(errorsBefore).join(' || ')}`)
  return ok(Date.now() - started, 'merchant page, transactions, detail, bell, expiring all rendered')
}

async function card(d: Day, c: CustomerState): Promise<JourneyResult> {
  const ready = d.stalls.filter((s) => s.cardReady)
  if (!ready.length) return skip('no stall in this run is card-ready (GET /api/v1/card-sales/ready/<stall> answered ready:false for every one)')
  if (process.env.CARD_PURCHASE === '0') return skip(`stall ${ready.map((s) => s.name).join(', ')} is card-ready; card journey disabled by CARD_PURCHASE=0`)
  const stall = ready[0]!
  const page = c.live!.page
  const before = (await customerBalances(page))[stall.currency] ?? 0
  const minor = 100
  const started = Date.now()
  await goto(page, `${BASE}/buy/${stall.pubHex}`)
  await page.locator('input[placeholder="25.00"]').fill(formatMinor(minor), { timeout: 30_000 })
  await page.getByRole('button', { name: /Pay by card/ }).click()
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 })
  if (!/\/cs_test_/.test(page.url())) return skip('Stripe Checkout is NOT in test mode for this stall; refusing to enter a card')
  await page.locator('#email').fill(`rd${Date.now()}@example.com`, { timeout: 30_000 })
  // Checkout lists card next to Klarna in an accordion; its fields render once card is chosen.
  await page.waitForTimeout(3000)
  await page.locator('[data-testid="card-accordion-item"]').click({ force: true, timeout: 15_000 }).catch(() => {})
  await page.locator('#cardNumber').fill('4242424242424242', { timeout: 30_000 })
  await page.locator('#cardExpiry').fill('12 / 34')
  await page.locator('#cardCvc').fill('123')
  await page.locator('#billingName').fill('Real Day').catch(() => {})
  await page.locator('#billingPostalCode').fill('D02 X285').catch(() => {})
  await page.locator('button[type="submit"], .SubmitButton').first().click()
  await page.waitForURL(/\/buy\/done/, { timeout: 120_000 })
  if (!(await waitForRise(page, stall.currency, before, minor, 300_000))) return fail('paid by card but the coupon did not arrive within 5 minutes')
  movements.push({ kind: 'sale', stall: stall.name, to: c.id, minor, unit: stall.currency })
  const h = holdOf(c, stall.pubHex)
  h.minor += minor
  h.count += 1
  return ok(Date.now() - started, 'card purchase: coupon visible in the wallet')
}

async function leave(d: Day, c: CustomerState): Promise<JourneyResult> {
  if (!c.live) return skip('not in the market')
  // Held in memory only (it holds the wallet's encrypted key): never written to disk.
  c.saved = await c.live.context.storageState({ indexedDB: true })
  const before = await customerBalances(c.live.page)
  await c.live.context.close()
  c.live = null
  await new Promise((r) => setTimeout(r, Math.round(2000 + d.random() * 5000)))
  const r = await arrive(d, c)
  if (r.outcome !== 'ok') return r
  const after = await customerBalances(c.live!.page)
  if (JSON.stringify(after) !== JSON.stringify(before)) return fail(`balance changed across the cold boot: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
  return ok(r.visibleMs ?? 0, 'cold boot restored the wallet and its balance')
}

function npubOf(hex: string): string {
  // Sell accepts an npub in place of a handle (postdeploy's importCustomer).
  return nip19.npubEncode(hex)
}

async function runJourney(d: Day, c: CustomerState, j: Journey): Promise<JourneyResult> {
  const page = () => c.live?.page
  switch (j) {
    case 'arrive': return record(j, c.id, () => arrive(d, c), page())
    case 'buy': {
      const stall = d.stalls[Math.floor(d.random() * d.stalls.length)]!
      return record(j, c.id, () => buy(d, c, stall), page())
    }
    case 'pay': return record(j, c.id, () => pay(d, c), page())
    case 'send': return record(j, c.id, () => send(d, c), page())
    case 'link': return record(j, c.id, () => link(d, c), page())
    case 'online': return record(j, c.id, () => online(d, c), page())
    case 'cashlink': return record(j, c.id, () => cashlink(d, c), page())
    case 'browse': return record(j, c.id, () => browse(d, c), page())
    case 'card': return record(j, c.id, () => card(d, c), page())
    case 'leave': return record(j, c.id, () => leave(d, c), page())
  }
}

// ---------------------------------------------------------------------------- k6 and probes

async function signerUp(): Promise<boolean> {
  return fetch(`${env('SIGNER_URL', 'http://127.0.0.1:8765')}/health`).then((r) => r.ok, () => false)
}

function startK6(poolStalls: number, summaryFile: string): Promise<K6Summary> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn('k6', ['run', '--quiet', join(HERE, 'market-day.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        GATEWAY_URL: BASE,
        CUSTOMER_PEAK: String(K6_CUSTOMERS),
        STALL_COUNT: String(Math.max(1, poolStalls)),
        CUSTOMER_OFFSET: String(BROWSER_CUSTOMERS),
        DAY_DURATION: DAY,
        SUMMARY_FILE: summaryFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const tail: string[] = []
    const keep = (b: Buffer) => { for (const l of b.toString().split('\n')) if (l.trim()) tail.push(redact(l)) ; tail.splice(0, Math.max(0, tail.length - 80)) }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('close', (code) => {
      let data: unknown = null
      try { data = JSON.parse(readFileSync(join(ROOT, summaryFile), 'utf8')) } catch { /* none written */ }
      const s = summariseK6(data, code)
      if (!data) s.note = `k6 wrote no summary: ${tail.slice(-5).join(' / ')}`
      log(`k6 finished (exit ${code})`)
      resolve(s)
    })
  })
}

/**
 * One probe at the start: a handful of cheap, lifted-for-us requests. A 429 means the per-address
 * limits are still on for this IP; a full run then stops rather than measure the limiter.
 */
async function probeRateLimits(): Promise<{ limited: boolean; text: string }> {
  const statuses: number[] = []
  for (let i = 0; i < 6; i++) {
    statuses.push(await fetch(`${BASE}/api/v1/config`).then((r) => r.status, () => 0))
  }
  const limited = statuses.includes(429)
  return { limited, text: limited ? `per-address limits are still ON for this IP (${statuses.join(',')})` : `no 429 on ${statuses.length} probes (${[...new Set(statuses)].join(',')})` }
}

// ---------------------------------------------------------------------------- main

async function dryRun(): Promise<number> {
  const problems: string[] = []
  const say = (ok: boolean, what: string) => { log(`${ok ? 'OK  ' : 'FAIL'} ${what}`); if (!ok) problems.push(what) }
  log(`dry run: ${CUSTOMERS} customers (${BROWSER_CUSTOMERS} browser + ${K6_CUSTOMERS} k6) + ${STALLS} stalls, slots=${STALL_SLOTS}, ${BASE}`)
  let pool: PoolEntry[] = []
  try { pool = readPool(); say(true, `pool ${pool.length} identities, every pubkey matches its key`) } catch (e) { say(false, String((e as Error).message)) }
  if (STALL_SLOTS === 'real') {
    try { const r = loadRealStalls(); say(true, `merchant keys: ${r.map((s) => `${s.name}=${s.pubHex.slice(0, 8)}`).join(', ')} (prefixes match)`) } catch (e) { say(false, e instanceof KeyFileError ? e.message : 'merchant keys unreadable') }
  }
  say(await fetch(`${BASE}/api/v1/config`).then((r) => r.ok, () => false), `${BASE}/api/v1/config answers`)
  if (pool.length && !problems.length) {
    try {
      const { stalls, poolStalls } = await buildPersonas(pool)
      for (const s of stalls) say(true, `stall slot ${s.slot} ${s.name} ${s.pubHex.slice(0, 8)} ${s.currency}${s.shop ? ` shop=${s.shop}` : ''} card-ready=${await cardReady(s.pubHex)}`)
      say(stalls.some((s) => s.shop) || STALL_SLOTS === 'pool', 'a stall with an online shop is in the run (checkout codes)')
      if (RUN_K6) {
        say(await new Promise<boolean>((r) => spawn('k6', ['version']).on('close', (c) => r(c === 0)).on('error', () => r(false))), 'k6 is installed')
        say(await signerUp(), 'the signer answers (node loadtest/signer.mjs)')
        say(poolStalls > 0 || pool.length > BROWSER_CUSTOMERS, 'the k6 crowd has a pool stall to acquire from')
      }
    } catch (e) { say(false, String((e as Error).message)) }
  }
  const p = await probeRateLimits()
  log(`rate-limit probe: ${p.text}`)
  for (const [k, v] of Object.entries(PACED_LIMITS)) log(`paced ${k}: ${v.perMinute}/min under ${v.limit}`)
  log(problems.length ? `dry run FAILED: ${problems.length} problem(s)` : 'dry run OK')
  return problems.length ? 1 : 0
}

async function main(): Promise<number> {
  if (MODE === 'dry-run') return dryRun()
  const dayMs = durationMs(DAY)
  if (BROWSER_CUSTOMERS + STALLS > BROWSER_PERSONAS) throw new Error(`${BROWSER_CUSTOMERS + STALLS} browser personas exceed BROWSER_PERSONAS=${BROWSER_PERSONAS}`)
  const pool = readPool()
  const { stalls: stallPersonas, customers: customerPersonas, poolStalls } = await buildPersonas(pool)
  const population: Population = {
    customers: CUSTOMERS, browserCustomers: BROWSER_CUSTOMERS, k6Customers: K6_CUSTOMERS, stalls: STALLS,
    stallNames: stallPersonas.map((s) => `${s.slot}:${s.name}`), mode: MODE, day: DAY, seed: SEED, base: BASE,
  }
  const probe = await probeRateLimits()
  log(`rate-limit probe: ${probe.text}`)
  if (probe.limited && MODE === 'full') {
    log('per-address limits are still on: stopping rather than measuring the limiter (scripts/loadtest-ratelimit.sh off)')
    return 2
  }
  if (probe.limited) notes.push('Smoke ran with per-address limits ON; 429s are reported apart from app failures.')

  const startMs = Date.now()
  const startedAt = new Date(startMs).toISOString()
  const browser = await chromium.launch()
  const summaryFile = `loadtest/results/.real-day-k6-${startMs}.json`
  let k6: Promise<K6Summary> | null = null
  try {
    // Stalls first: they open for the day before customers arrive.
    const stalls: StallState[] = []
    for (const s of stallPersonas) {
      const live = await openContext(browser, s.name, undefined, s.real)
      await ui.importKey(live.page, s.secret, 'rs', !s.real)
      if (live.page.url().includes('onboarding')) throw new Error(`stall ${s.name} could not log in`)
      const st: StallState = { ...s, live, lock: mutex(), before: null, cardReady: await cardReady(s.pubHex) }
      st.before = await stallBalances(st)
      stalls.push(st)
      log(`stall ${s.slot} ${s.name} open (${s.currency}${s.shop ? ', online shop' : ''}${st.cardReady ? ', card-ready' : ''})`)
    }
    const customers: CustomerState[] = customerPersonas.map((c) => ({ ...c, live: null, pubHex: '', saved: null, holds: {}, before: null }))
    loginReplayUnsaved.push(...unsavedReceives.splice(0))

    if (RUN_K6) {
      if (!(await signerUp())) {
        notes.push('k6 crowd NOT run: the signer (node loadtest/signer.mjs) was not answering.')
      } else {
        k6 = startK6(poolStalls, summaryFile)
        log(`k6 crowd started: ${K6_CUSTOMERS} customers over ${DAY}`)
      }
    } else notes.push(`k6 crowd not run (${K6_CUSTOMERS} k6 customers${K6_CUSTOMERS > 0 ? ', RUN_K6=0' : ''}).`)

    const deadline = startMs + dayMs
    const dayRandom = rng(seedFor(SEED, 'day'))
    const d: Day = { browser, stalls, customers, random: dayRandom }
    if (MODE === 'smoke') {
      for (const step of smokePlan(customers.map((c) => c.id))) {
        const c = customers.find((x) => x.id === step.persona)!
        if (step.journey !== 'arrive' && !c.live) await runJourney(d, c, 'arrive')
        await runJourney(d, c, step.journey)
        await new Promise((r) => setTimeout(r, thinkMs(dayRandom, THINK_MIN_S, THINK_MAX_S)))
      }
    } else {
      await Promise.all(customers.map(async (c, i) => {
        const random = rng(seedFor(SEED, c.id))
        const own: Day = { ...d, random }
        // Arrivals spread over the first tenth of the day.
        await new Promise((r) => setTimeout(r, Math.round(random() * dayMs * 0.1) + i * 500))
        await runJourney(own, c, 'arrive')
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, thinkMs(random, THINK_MIN_S, THINK_MAX_S)))
          if (Date.now() >= deadline) break
          if (!c.live) await runJourney(own, c, 'arrive')
          const j = nextJourney(random, { holdsCoupons: heldStalls(c, own).length > 0 })
          await runJourney(own, c, j)
        }
      }))
    }

    // Afterwards: let the last deliveries land, then read every balance the same way.
    log('day over: settling, then reading every balance')
    await new Promise((r) => setTimeout(r, num('SETTLE_S', 45) * 1000))
    const before: Balances = {}
    const after: Balances = {}
    for (const c of customers) {
      if (!c.before) continue
      before[c.id] = c.before
      if (!c.live) await arrive(d, c).catch(() => undefined)
      after[c.id] = c.live ? await customerBalances(c.live.page).catch(() => ({ [CURRENCY]: Number.NaN })) : { [CURRENCY]: Number.NaN }
    }
    for (const s of stalls) {
      before[s.name] = s.before ?? { [s.currency]: Number.NaN }
      after[s.name] = await stallBalances(s).catch(() => ({ [s.currency]: Number.NaN }))
    }
    const conservation = conserve(before, after, movements)
    const k6Summary = k6 ? await k6 : null

    if (blockedPublishes.length) {
      const counts = new Map<string, number>()
      for (const b of blockedPublishes) counts.set(b, (counts.get(b) ?? 0) + 1)
      notes.push(`Real-stall public records the guard kept from being republished (the app tried on login and retried): ${[...counts].map(([b, n]) => `${b} x${n}`).join('; ')}`)
    }
    if (loginReplayUnsaved.length) notes.push(`FINDING (#123, not gated: first login of an existing wallet on a fresh device): settled-but-not-saved logged for receives from its history, ${loginReplayUnsaved.length} lines: ${loginReplayUnsaved.slice(0, 4).join(' || ')}`)
    const result = buildResult({
      population, startedAt, durationS: (Date.now() - startMs) / 1000, conservation, k6: k6Summary,
      rateLimitProbe: probe.text,
      limits: Object.entries(PACED_LIMITS).map(([k, v]) => `${k}: paced to ${v.perMinute}/min under ${v.limit}`),
      notes, attempts, pageErrors, unsavedReceives, startMs,
    })
    const name = resultName(new Date(startMs), population)
    mkdirSync(join(ROOT, 'loadtest/results'), { recursive: true })
    writeFileSync(join(ROOT, `loadtest/results/${name}.json`), JSON.stringify(result, null, 2) + '\n')
    writeFileSync(join(ROOT, `loadtest/results/${name}.md`), renderMarkdown(result))
    log(`wrote loadtest/results/${name}.{json,md}: ${result.pass ? 'PASS' : 'FAIL'}`)
    return result.pass ? 0 : 1
  } finally {
    await browser.close().catch(() => {})
  }
}

main().then((code) => process.exit(code), (e) => {
  console.error(redact(e instanceof KeyFileError ? e.message : String(e instanceof Error ? e.stack : e)))
  process.exit(1)
})
