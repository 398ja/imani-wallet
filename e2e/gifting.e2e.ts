/**
 * Local end-to-end for gifting.imani.casa (#410), in a real browser.
 *
 *   npx vite build --config apps/gifting/vite.config.ts
 *   npx tsx e2e/gifting.e2e.ts
 *
 * One Node server on one port, as the edge would be: the REAL built site, plus fakes for the only
 * outside services the page talks to: handle resolution (`/api/v1/resolve`), the gateway's nostr
 * cache (stall record + kind-0), the Purchase Draft API and checkout (payment-adapter's contract,
 * whose Java side has its own tests), and a fake Stripe Checkout that "pays" and returns to
 * `success_url`, as Stripe would.
 *
 * Drives Chromium through the guest happy path to a handle, the review page's Edit link, a double
 * Pay, and the email path's sealing, and checks the edge cases the stall page must refuse.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'

import { unseal } from '../apps/gifting/src/lib/gift.ts'

const PORT = 18920
const ORIGIN = `http://localhost:${PORT}`
const DIST = 'apps/gifting/dist'

const stallSk = generateSecretKey()
const stall = getPublicKey(stallSk)
const bobSk = generateSecretKey()
const bob = getPublicKey(bobSk)
const movedBob = getPublicKey(generateSecretKey())
const plainSk = generateSecretKey()
const plain = getPublicKey(plainSk)
const issuerSk = generateSecretKey()
const oliveSk = generateSecretKey()
const olive = getPublicKey(oliveSk)
const issuer = getPublicKey(issuerSk)

/** handle → pubkey, as the gateway's resolver answers. Mutable: Bob's handle moves mid-test. */
const handles: Record<string, string> = {
  'alice@imani.casa': stall,
  'bob@example.com': bob,
  'plain@imani.casa': plain,
  'olive@imani.casa': olive,
}

const now = () => Math.floor(Date.now() / 1000)
const record = (sk: Uint8Array, content: Record<string, unknown>) =>
  finalizeEvent({ kind: 30078, created_at: now() - 60, tags: [['d', 'imani:merchant']], content: JSON.stringify(content) }, sk)
const kind0 = (sk: Uint8Array, content: Record<string, unknown>) => finalizeEvent({ kind: 0, created_at: now() - 60, tags: [], content: JSON.stringify(content) }, sk)
const events = [
  record(stallSk, { active: true, categories: [], issuanceCurrency: 'EUR', voucherValidityDays: 90, acceptsCards: true }),
  kind0(stallSk, { name: 'Alice Bakery', about: 'Bread and cakes' }),
  record(plainSk, { active: true, categories: [], issuanceCurrency: 'EUR', voucherValidityDays: 90 }),
  kind0(plainSk, { name: 'Plain Stall' }),
  kind0(bobSk, { name: 'Bob' }),
  // A stall whose online shop takes checkout codes (contract §4).
  record(oliveSk, {
    active: true, categories: [], issuanceCurrency: 'EUR', voucherValidityDays: 90, acceptsCards: true,
    online_shop: { url: 'https://olive.example', redeem_key: getPublicKey(generateSecretKey()), platform: 'woocommerce', since: now() - 86400 },
  }),
  kind0(oliveSk, { name: 'Olive Grove' }),
]

interface Draft {
  draftId: string
  expiresAt: string
  stallPubkey: string
  amountMinor: number
  currency: string
  delivery: Record<string, unknown>
  message?: string
  from?: string
  sealed?: string
  gift?: string
  session?: string
  invalidated?: boolean
}
const drafts = new Map<string, Draft>()
let stripeSessions = 0
const stripeMetadata: Array<Record<string, string>> = []
/** What a webhook would hand the issuer: the pinned delivery per paid draft. */
const paid: Draft[] = []

const results: Array<[string, boolean, string?]> = []
const check = (name: string, ok: boolean, detail?: string) => {
  results.push([name, ok, detail])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  (${detail})` : ''}`)
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => res(b))
  })

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }

async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const send = (status: number, obj?: unknown) =>
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(obj === undefined ? '' : JSON.stringify(obj))
  const body = req.method === 'GET' ? '' : await readBody(req)
  const path = url.pathname

  if (path.startsWith('/api/v1/resolve/')) {
    const hex = handles[decodeURIComponent(path.slice('/api/v1/resolve/'.length))]
    return hex ? (send(200, { hex_pubkey: hex }), true) : (send(404, { error: 'NIP05_001' }), true)
  }
  if (path === '/api/v1/nostr/query') {
    const f = JSON.parse(body) as { kinds: number[]; authors: string[] }
    return send(200, { events: events.filter((e) => f.kinds.includes(e.kind) && f.authors.includes(e.pubkey)) }), true
  }
  if (path === '/api/v1/gifting/issuer-key') return send(200, { pubkey: issuer }), true
  if (path === '/api/v1/gifting/drafts' && req.method === 'POST') {
    const r = JSON.parse(body) as {
      stallPubkey: string
      amountMinor: number
      currency: string
      delivery: { kind: string; handle?: string; email?: string; refundPubkey?: string; sealed?: string }
      message?: string
      from?: string
      buyerEmail?: string
      gift?: string
    }
    if (r.stallPubkey !== stall && r.stallPubkey !== olive) return send(409, { error: 'this stall cannot accept card payments yet' }), true
    if (!req.headers.authorization && !r.buyerEmail) return send(422, { error: 'We need your email for the receipt and the return link.' }), true
    const delivery: Record<string, unknown> = { kind: r.delivery.kind, refundPubkey: r.delivery.refundPubkey, claimWindowDays: 30 }
    if (r.delivery.kind === 'handle') {
      // Re-resolved and PINNED at draft time.
      const hex = handles[r.delivery.handle ?? '']
      if (!hex) return send(422, { error: "We couldn't find that handle." }), true
      delivery.recipientPubkey = hex
    }
    if (r.delivery.kind === 'email') delivery.email = r.delivery.email
    const d: Draft = {
      draftId: randomUUID(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      stallPubkey: r.stallPubkey,
      amountMinor: r.amountMinor,
      currency: r.currency,
      delivery,
      message: r.message,
      from: r.from,
      sealed: r.delivery.sealed,
      gift: r.gift,
    }
    drafts.set(d.draftId, d)
    return send(201, { ...d, sealed: undefined }), true
  }
  const m = path.match(/^\/api\/v1\/gifting\/drafts\/([0-9a-f-]+)$/)
  if (m) {
    const d = drafts.get(m[1])
    if (req.method === 'DELETE') {
      if (d && !d.session) d.invalidated = true
      return send(204), true
    }
    if (!d) return send(404, { error: 'no such gift' }), true
    return send(200, { ...d, sealed: undefined, session: undefined }), true
  }
  if (path === '/api/v1/checkout/purchase') {
    const { draftId, ...rest } = JSON.parse(body) as { draftId: string }
    // G15: a guest also sends their own return link, to be mailed before Stripe. Nothing else.
    check('Pay sends the draft id (and a guest\'s return link) only', Object.keys(rest).every((k) => k === 'returnLink'), JSON.stringify(rest))
    const d = drafts.get(draftId)
    if (!d) return send(404, { error: 'no such gift' }), true
    if (d.invalidated) return send(409, { error: 'DRAFT_INVALIDATED' }), true
    // One session per draft: a second Pay answers the same URL.
    if (!d.session) {
      stripeSessions += 1
      stripeMetadata.push({ draft_id: d.draftId })
      d.session = `${ORIGIN}/fake-stripe/pay?draft=${d.draftId}`
    }
    return send(200, { checkoutUrl: d.session, reference: d.draftId }), true
  }
  if (path === '/fake-stripe/pay') {
    // Stripe takes the card, the webhook records the debt from draft_id (the pinned delivery), and
    // the buyer is sent back to success_url.
    const d = drafts.get(url.searchParams.get('draft') ?? '')!
    if (!paid.includes(d)) paid.push(d)
    res.writeHead(302, { Location: `/return?draft=${d.draftId}&session=cs_e2e` }).end()
    return true
  }
  return false
}

async function serveStatic(path: string, res: ServerResponse) {
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '')
  let file = join(DIST, safe)
  try {
    if (!(await stat(file)).isFile()) throw new Error('dir')
  } catch {
    file = join(DIST, 'index.html')
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    // NAP 0002: never `same-origin`, or the wallet's signer popup loses its opener.
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  })
  res.end(await readFile(file))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN)
  try {
    if (await api(req, res, url)) return
    await serveStatic(url.pathname, res)
  } catch (e) {
    res.writeHead(500).end(String(e))
  }
})

async function main() {
  await new Promise<void>((r) => server.listen(PORT, r))
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const text = () => page.locator('body').innerText()
  try {
    // ── The stall page's refusals ───────────────────────────────────────────
    await page.goto(`${ORIGIN}/shop/a%20b`)
    await page.getByText("This link isn't a valid shop link.").waitFor()
    check('a malformed handle says so, no form', (await page.locator('form').count()) === 0)

    await page.goto(`${ORIGIN}/shop/nobody`)
    await page.getByText("We couldn't find this shop.").waitFor()
    check('an unknown handle: "We couldn\'t find this shop."', (await page.locator('form').count()) === 0)

    await page.goto(`${ORIGIN}/shop/plain`)
    await page.getByText("doesn't take card payments online yet").waitFor()
    check('a stall without acceptsCards gets no form', (await page.locator('form').count()) === 0)

    await page.goto(`${ORIGIN}/shop/alice@imani.casa`)
    await page.waitForURL(`${ORIGIN}/shop/alice`)
    check('the full default-domain handle redirects to the bare form', page.url() === `${ORIGIN}/shop/alice`)
    await page.getByRole('heading', { name: 'Alice Bakery' }).waitFor()
    check('the shop is named from its profile', /Bread and cakes/.test(await text()))
    check('noindex by default (G1)', (await page.locator('meta[name=robots]').getAttribute('content')) === 'noindex')
    check('there is no way to send to a handle (#410 rework)', (await page.getByLabel(/handle/i).count()) === 0 && !/Deliver to/.test(await text()))
    check('a stall with no online shop shows no voucher/code choice', (await page.getByRole('radiogroup').count()) === 0)

    // ── Guest, to an email ─────────────────────────────────────────────────
    await page.getByLabel('Amount (EUR)').fill('20')
    await page.getByLabel('Their email address').fill('bob@example.com')
    await page.getByLabel('Message (optional)').fill('see https://evil.example')
    await page.getByLabel('Your email').fill('buyer@example.com')
    await page.getByRole('button', { name: 'Review' }).click()
    await page.getByText("The message can't contain links.").waitFor()
    check('a message with a link is refused', page.url().endsWith('/shop/alice'))
    await page.getByLabel('Message (optional)').fill('Happy birthday')
    await page.getByRole('button', { name: 'Review' }).click()

    await page.waitForURL(/\/shop\/alice\/review$/)
    await page.getByRole('heading', { name: 'Check your gift' }).waitFor()
    const review = await text()
    check('review shows the amount in the stall currency', /€20\.00/.test(review), review.slice(0, 400))
    check('review shows the recipient email', /bob@example\.com/.test(review))
    check('review names the merchant of record and the refund terms', /Paid to Alice Bakery via Stripe/.test(review) && /refunds are Alice Bakery/.test(review))
    const firstDraft = [...drafts.values()].at(-1)!
    check('the draft is an email voucher with a guest refund key and no gift field', firstDraft.delivery.kind === 'email' && firstDraft.gift === undefined && /^[0-9a-f]{64}$/.test(String(firstDraft.delivery.refundPubkey)))

    // Edit keeps the rest of the form.
    await page.getByRole('button', { name: 'Edit message' }).click()
    await page.waitForURL(/\/shop\/alice#message$/)
    check('Edit keeps every other field', (await page.getByLabel('Amount (EUR)').inputValue()) === '20' && (await page.getByLabel('Their email address').inputValue()) === 'bob@example.com')
    await page.getByLabel('Message (optional)').fill('Happy birthday, Bob')
    await page.getByRole('button', { name: 'Review' }).click()
    await page.getByRole('heading', { name: 'Check your gift' }).waitFor()
    check('editing invalidated the old draft', firstDraft.invalidated === true)
    const draft = [...drafts.values()].at(-1)!
    check('the new draft carries the edited message', draft.message === 'Happy birthday, Bob')

    // Double Pay → one Stripe session. Two clicks in the same task, as a double tap delivers them.
    await page.getByRole('button', { name: /^Pay / }).waitFor()
    await Promise.all([
      page.waitForURL(/\/return\?/),
      page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /^Pay /.test(x.textContent?.trim() ?? ''))!
        b.click()
        b.click()
      }),
    ])
    await page.getByRole('heading', { name: 'Thank you' }).waitFor()
    check('one Checkout Session for the draft', stripeSessions === 1, String(stripeSessions))
    check('Stripe metadata is the draft id only (G9)', JSON.stringify(stripeMetadata) === JSON.stringify([{ draft_id: draft.draftId }]))
    check('the paid gift goes to the email reviewed', paid.length === 1 && paid[0].delivery.email === 'bob@example.com')
    check('the return page shows no claim link (G8)', !/#k=|\/claim#/.test(await text()))
    const back = await page.getByTestId('return-link').locator('a').getAttribute('href')
    check('a guest gets the return link to their own refund key R (option D)', /\/gift-return#r=[0-9a-f]{64}$/.test(back ?? ''), back ?? '')

    // Paying the same draft again (back button) answers the same session.
    const again = await page.evaluate(async (id) => (await fetch('/api/v1/checkout/purchase', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draftId: id }) })).json(), draft.draftId)
    check('back + Pay again: the same session URL, no second session', again.checkoutUrl === draft.session && stripeSessions === 1)

    // ── Guest, to an email: ℓ and R are sealed to the issuer, never sent in the clear ───
    await page.goto(`${ORIGIN}/shop/alice`)
    await page.getByLabel('Their email address').fill('carol@example.com')
    await page.getByRole('button', { name: 'Review' }).click()
    await page.getByRole('heading', { name: 'Check your gift' }).waitFor()
    const emailReview = await text()
    check('the email address is shown large with the claim deadline', /carol@example\.com/.test(emailReview) && /isn't claimed by/.test(emailReview))
    const emailDraft = [...drafts.values()].at(-1)!
    const opened = unseal(issuerSk, emailDraft.sealed ?? '')
    check(
      'the seal opens only for the issuer and is bound to stall, amount and address (G4)',
      opened.stallPubkey === stall && opened.amountMinor === 2000 && opened.recipient === 'carol@example.com' && /^[0-9a-f]{64}$/.test(String(opened.linkSecret)),
    )
    check('the seal carries the link secret only, never the refund secret (G-R3)', !('refundSecret' in opened))
    check('the draft never echoes the seal back to the page', !(await page.evaluate(() => document.body.innerHTML)).includes('v1.'))

    // ── A stall with an online shop: voucher or shop code (VITE_GIFTING_CODE_GIFTS=on) ──
    await page.goto(`${ORIGIN}/shop/olive`)
    await page.getByRole('radiogroup', { name: 'What to send' }).waitFor()
    check('voucher is chosen by default', await page.getByRole('radio', { name: 'Voucher' }).isChecked())
    await page.getByText('Shop code').click()
    check('the shop code can be chosen', await page.getByRole('radio', { name: 'Shop code' }).isChecked())
    check('the choice says where the code is used', /checkout on olive\.example/.test(await page.getByTestId('gift-kind-hint').innerText()))
    await page.getByLabel('Amount (EUR)').fill('15')
    await page.getByLabel('Their email address').fill('dan@example.com')
    await page.getByLabel('Your email').fill('buyer@example.com')
    await page.getByRole('button', { name: 'Review' }).click()
    await page.getByRole('heading', { name: 'Check your gift' }).waitFor()
    const codeDraft = [...drafts.values()].at(-1)!
    check('a code gift asks for gift: code, to an email', codeDraft.gift === 'code' && codeDraft.delivery.email === 'dan@example.com')
    check('review calls it a shop code for the online shop', /Shop code/.test(await text()) && /checkout on olive\.example/.test(await page.getByTestId('review-kind').innerText()))

    check('no page errors', errors.length === 0, errors.join(' | '))
  } finally {
    await browser.close()
    server.close()
  }
  const failed = results.filter(([, ok]) => !ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

void main()
