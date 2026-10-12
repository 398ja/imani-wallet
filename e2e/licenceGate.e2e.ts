/**
 * imani-wallet#197 on a full local stack: a licensed stall's paid till sells, and a spent licence
 * takes that back after the grace.
 *
 * Real throughout except who drives the API: the edge, gateway-core, gateway-customer (verifying
 * the licence and asking the mint), the portal (its licence gate, cache and refresh), the mint,
 * the relay, and the owner's wallet bundle in a browser, which reports the licence ITSELF from the
 * dashboard (src/lib/licenceReport.ts) once the licence arrives by DM.
 *
 * Steps:
 *   1. Owner A registers a stall in the browser. The harness reads A's key from A's own key store.
 *   2. Two attested sell-and-redeem credentials are minted for A with A's key (as the owner app
 *      does), each for a device key T1, T2 the harness holds, and confirmed. T1 is the stall's free
 *      terminal, T2 is not.
 *   3. T2 sells (NIP-98 by T2, terminal warrant): 402 TERMINAL_UNLICENSED. T1 sells: 201.
 *   4. A copied licence: a licence sold to a DIFFERENT stall, reported by A, is refused 422 WRONG_KEY.
 *   5. The seller sells A a licence (sell-subscription.mjs's metadata) and DMs it to A. A's wallet,
 *      on its dashboard, verifies it and reports it (the request is watched in the browser).
 *   6. T2 sells: 201.
 *   7. The seller spends A's licence at the mint (a refund). After the portal's refresh and the
 *      grace (shortened on the gate), T2 sells: 402 again. T1 still 201.
 *
 * imani-wallet#226 (a copied licence is useless; the seller can revoke):
 *   6a. A sends A's held licence to B (a second registered stall). B's wallet sees no licence in it
 *       (WRONG_KEY), the server refuses B's report (422 LICENCE_WRONG_KEY), the mint refuses B's
 *       swap (NUT-11: no signature by A) and the proofs stay UNSPENT, and A's T2 still sells.
 *   8.  The seller sells A a second licence, A reports it, T2 sells. A non-seller's revocation is
 *       refused 403. The seller revokes the subscription (`sell-subscription.mjs`'s
 *       `revokeRequest`, NIP-98). T2 is 402, A's re-report is 422 LICENCE_REVOKED, and T1 still
 *       sells. (A still holds its spent #197 licence, so this 402 is that end's grace running out.)
 *   9.  E-1: stall C, which has never held a licence, buys one, its wallet reports it, C's T2 sells;
 *       the seller revokes it; the portal's next refresh holds licensed_until NULL, and C's T2 is
 *       402 at once, well inside the grace. W-1: C's wallet re-reports, is told 422, and its
 *       Subscription screen says the seller revoked it.
 *
 * Env: E2E_BASE, E2E_BUNDLE_DIR, E2E_LICENCE_SELLER_SK (the seller stall's key, which the gate names
 * in GATEWAY_CUSTOMER_LICENCE_SELLER_PUBKEYS), E2E_MINT_URL, E2E_LICENCE_GRACE_S,
 * E2E_PORTAL_SQL_CMD (a psql -tAc on the gate's portal database, for step 9),
 * E2E_IGNORE_HTTPS_ERRORS, E2E_CHROMIUM_ARGS. Run by imani-deploy's local gate with
 * E2E_SCRIPT=licenceGate.e2e.ts.
 */
import { chromium, type Browser, type Page } from 'playwright'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { finalizeEvent, nip98 } from 'nostr-tools'
import { registerMerchant, TEST_PASSPHRASE } from './register.mts'
import { parseVoucherToken, tokenProofs } from '../src/lib/voucherToken'
import { terminalMetadataJson } from '../src/lib/terminalCredential'
import { signOwnerAttestation } from '../src/lib/ownerAttestation'
import { enrolmentProofHeader, signEnrolmentCode } from '../src/lib/terminalEnrolProof'
import { licenceIssueParams } from '../src/lib/licenceIssue'
import { licenceIssueBody, revokeRequest } from '../scripts/sell-subscription.mjs'
import { licenceOf, verifyLicence } from '../packages/licence/src/index'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const BASE = (process.env.E2E_BASE ?? 'http://localhost').replace(/\/+$/, '')
const BUNDLE_DIR = process.env.E2E_BUNDLE_DIR
const SELLER_SK = process.env.E2E_LICENCE_SELLER_SK ?? ''
const MINT = (process.env.E2E_MINT_URL ?? '').replace(/\/+$/, '')
const GRACE_S = Number(process.env.E2E_LICENCE_GRACE_S ?? '30')
/** The portal's licence refresh on the gate (GATE_LICENCE_REFRESH_MS, default 5000). */
const REFRESH_S = Math.ceil(Number(process.env.E2E_LICENCE_REFRESH_MS ?? '5000') / 1000)
const INTERNAL_RELAY = 'ws://nostr-relay:7777'
if (process.env.E2E_IGNORE_HTTPS_ERRORS === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const failures: string[] = []
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const pub = (sk: string) => bytesToHex(schnorr.getPublicKey(hexToBytes(sk)))
const randomSk = () => bytesToHex(secp256k1.utils.randomSecretKey())

/** A request signed with NIP-98 by `sk`, optionally naming a terminal credential. */
async function as(
  sk: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const url = `${BASE}${path}`
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const auth = await nip98.getToken(url, method.toUpperCase(), (e) => finalizeEvent(e, hexToBytes(sk)), true,
    body as Record<string, unknown>)
  const res = await fetch(url, {
    method,
    headers: { Authorization: auth, ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: payload,
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => ({ status: 0, text: async () => String(e) }) as unknown as Response)
  return { status: res.status, body: await res.text().catch(() => '') }
}

/** Mint a voucher as `sk` and wait for its token. Waits out the mint's per-minute quote quota. */
async function mint(sk: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  let created = { status: 0, body: '' }
  for (let i = 0; i < 6; i++) {
    created = await as(sk, 'POST', '/api/v1/wallet/vouchers', body, { 'Idempotency-Key': crypto.randomUUID(), ...headers })
    // Retry the mint's per-minute quote quota (429 inside a 400) and a timed-out request.
    if (created.status === 201 || created.status === 200) break
    if (!/429|Timeout/i.test(created.body) && created.status !== 0) break
    await new Promise((r) => setTimeout(r, 20_000))
  }
  let voucherId = ''
  try {
    voucherId = (JSON.parse(created.body || '{}') as { voucher_id?: string }).voucher_id ?? ''
  } catch {
    voucherId = ''
  }
  if (!voucherId) return { status: created.status, error: created.body.slice(0, 300), voucherId: '', token: '', voucher: {} as Record<string, unknown> }
  for (let i = 0; i < 45; i++) {
    const got = await as(sk, 'GET', `/api/v1/wallet/vouchers/${encodeURIComponent(voucherId)}`)
    let v: Record<string, unknown> = {}
    try {
      v = JSON.parse(got.body || '{}') as Record<string, unknown>
    } catch {
      v = {}
    }
    if (v.status === 'ISSUED' && typeof v.token === 'string') return { status: 201, error: '', voucherId, token: v.token.trim(), voucher: v }
    await new Promise((r) => setTimeout(r, 2_000))
  }
  return { status: 0, error: 'no token', voucherId, token: '', voucher: {} }
}

/** An attested issue-and-redeem credential for the stall `ownerSk`, locked to `deviceSk`. */
async function sellingTill(ownerSk: string, name: string) {
  const stall = pub(ownerSk)
  const deviceSk = randomSk()
  const lock = pub(deviceSk)
  const expiresAt = Math.floor(Date.now() / 1000) + 365 * 86_400 + 600
  const attestation = signOwnerAttestation(
    { stallPubkey: stall, lockKey: lock, role: 'issue-and-redeem', expiresAt },
    { pubkey: stall, withPrivkey: (f) => f(hexToBytes(ownerSk)) },
  )
  const metadata = { ...JSON.parse(terminalMetadataJson({ stallPubkey: stall, role: 'issue-and-redeem', lockKey: lock, name })), owner_attestation: attestation }
  const minted = await mint(ownerSk, {
    face_value: 1, face_unit: 'sat', face_decimals: 0, backing_strategy: 'PROPORTIONAL', issuer_id: stall,
    memo: 'Imani terminal credential', expires_in_days: 365, merchant_metadata: metadata,
  }, {
    'X-Idempotency-Expires-At': new Date(expiresAt * 1000).toISOString().replace('.000Z', 'Z'),
    // inv-terminal-not-merchant: the device's own proof that K was created as a terminal, as the
    // device's /terminal/setup screen signs it. gateway-customer refuses a first enrolment without it.
    'X-Imani-Terminal-Enrolment': (() => {
      const at = Math.floor(Date.now() / 1000)
      return enrolmentProofHeader({ createdAt: at, sig: signEnrolmentCode(hexToBytes(deviceSk), lock, at).split(':').pop()! })
    })(),
  })
  if (minted.voucherId) {
    await as(deviceSk, 'POST', `/api/v1/wallet/terminal-credentials/${encodeURIComponent(minted.voucherId)}/confirm`, {})
  }
  return { deviceSk, stall, voucherId: minted.voucherId, secret: minted.token ? tokenProofs(minted.token)[0].secret : '', error: minted.error }
}

/** The till sells EUR 1.00 with a fresh terminal warrant. Returns the HTTP status and body. */
async function tillSells(t: { deviceSk: string; stall: string; voucherId: string; secret: string }) {
  // A 429 is the per-minute issuance quota, not a licence answer: wait it out (as mint() does).
  let r = await tillSellsOnce(t)
  for (let i = 0; i < 3 && r.status === 429; i++) {
    await new Promise((res) => setTimeout(res, 20_000))
    r = await tillSellsOnce(t)
  }
  return r
}

async function tillSellsOnce(t: { deviceSk: string; stall: string; voucherId: string; secret: string }) {
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  const digest = sha256(new TextEncoder().encode([t.stall, '100', '2', 'EUR', nonce].join('\u001f')))
  const warrant = JSON.stringify({
    form: 'terminal', sale_total: 100, face_decimals: 2, unit: 'EUR', nonce,
    signature: bytesToHex(schnorr.sign(digest, hexToBytes(t.deviceSk))), credential: t.secret,
  })
  return as(t.deviceSk, 'POST', '/api/v1/portal/vouchers',
    { face_value_minor: 100, currency: 'EUR', quantity: 1, issuance_warrant: warrant },
    { 'X-Imani-Terminal-Credential': t.voucherId })
}

/**
 * The seller sells `buyer` a licence exactly as scripts/sell-subscription.mjs does: its request body
 * (`licenceIssueBody`), so a realistic GBP 40.00 licence, `FIXED` (ADR 0007), with the seller's own
 * merchant warrant. FIXED backs it with one sat, so it is ONE P2PK proof: the buyer's receive sends
 * one NUT-11 witness, where PROPORTIONAL made a dozen and the edge refused the header as "Request
 * Header Or Cookie Too Large" (review of #197, 4a).
 */
async function sellLicence(buyer: string) {
  const subscriptionId = `sub_${bytesToHex(crypto.getRandomValues(new Uint8Array(8)))}`
  const params = licenceIssueParams({
    lockKey: buyer, subscriptionId,
    paidAmountMinor: 4000, paidCurrency: 'GBP',
  })
  const minted = await mint(SELLER_SK, licenceIssueBody({ pk: pub(SELLER_SK), sk: SELLER_SK }, {
    paidAmountMinor: params.faceValueMinor, paidCurrency: params.currency, term: 'annual',
    metadata: params.merchantMetadata,
  }))
  return { ...minted, subscriptionId }
}

/** Does the wallet's own licence check grant `presenter` anything from this token? */
function walletGrants(token: string, presenter: string): { granted: boolean; reason: string } {
  // What the wallet's licenceIn does (src/lib/licences.ts), without its @imani/* alias imports.
  let licence: ReturnType<typeof licenceOf> = null
  try {
    licence = licenceOf(parseVoucherToken(token).voucher)
  } catch {
    licence = null
  }
  if (!licence) return { granted: false, reason: 'not-a-licence' }
  // The issuer is the gate's own gateway key, read off the licence: this checks the BINDING.
  const verdict = verifyLicence(licence, {
    issuerPublicKey: licence.issuerPublicKey, now: Math.floor(Date.now() / 1000), presenter,
    sellerPublicKey: pub(SELLER_SK), verifySignature: () => true,
  })
  return verdict.granted ? { granted: true, reason: 'granted' } : { granted: false, reason: verdict.reason }
}

/** The seller's revocation, exactly as `sell-subscription.mjs --revoke` sends it. */
async function revokeAs(sk: string, subscriptionId: string, reason: string) {
  const req = revokeRequest({ pk: pub(sk), sk }, BASE, subscriptionId, reason)
  const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body }).catch(() => null)
  return { status: r?.status ?? 0, body: r ? await r.text() : 'unreachable' }
}

/** NUT-07 for a token's proofs, straight from the mint. */
function hashToCurveHex(message: string): string {
  const DOMAIN = new TextEncoder().encode('Secp256k1_HashToCurve_Cashu_')
  const msgHash = sha256(new Uint8Array([...DOMAIN, ...new TextEncoder().encode(message)]))
  for (let c = 0; c < 2 ** 16; c++) {
    const ctr = new Uint8Array(4)
    new DataView(ctr.buffer).setUint32(0, c, true)
    try {
      return secp256k1.Point.fromHex(bytesToHex(new Uint8Array([0x02, ...sha256(new Uint8Array([...msgHash, ...ctr]))]))).toHex(true)
    } catch { /* next */ }
  }
  throw new Error('no point')
}

/**
 * Spend a licence's proofs at the mint (NUT-03 swap), with a NUT-11 witness by `sk` for each locked
 * proof. The outputs are throwaway.
 */
async function spendAtMint(token: string, sk: string): Promise<{ status: number; body: string }> {
  const proofs = tokenProofs(token)
  const outputs = proofs.map((p) => {
    const Y = secp256k1.Point.fromHex(hashToCurveHex(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))))
    const r = BigInt('0x' + bytesToHex(secp256k1.utils.randomSecretKey()))
    return { amount: p.amount, id: p.id, B_: Y.add(secp256k1.Point.BASE.multiply(r)).toHex(true) }
  })
  const witness = (secret: string) =>
    JSON.stringify({ signatures: [bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(secret)), hexToBytes(sk)))] })
  const r = await fetch(`${MINT}/v1/swap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs: proofs.map((p) => ({ amount: p.amount, id: p.id, secret: p.secret, C: p.C, witness: witness(p.secret) })),
      outputs,
    }),
  }).catch(() => null)
  return { status: r?.status ?? 0, body: r ? (await r.text()).slice(0, 200) : 'unreachable' }
}

/** A POST NIP-98 signed by `sk`, sent with the owner's browser session cookie (the edge's NAP gate). */
async function asOwnerSession(owner: Page, sk: string, path: string, body: unknown): Promise<{ status: number; body: string }> {
  const url = `${BASE}${path}`
  const auth = await nip98.getToken(url, 'POST', (e) => finalizeEvent(e, hexToBytes(sk)), true, body as Record<string, unknown>)
  const res = await owner.context().request.post(url, {
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    data: JSON.stringify(body),
  })
  return { status: res.status(), body: await res.text() }
}

async function mintState(token: string): Promise<string[]> {
  const ys = tokenProofs(token).map((p) => hashToCurveHex(p.secret))
  const r = await fetch(`${MINT}/v1/checkstate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Ys: ys }),
  }).catch(() => null)
  const body = r ? ((await r.json().catch(() => ({}))) as { states?: Array<{ state: string }> }) : {}
  return (body.states ?? []).map((s) => s.state)
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
}

async function ownerPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ locale: 'en-GB', serviceWorkers: BUNDLE_DIR ? 'block' : 'allow', ignoreHTTPSErrors: true })
  if (BUNDLE_DIR) {
    const root = normalize(BUNDLE_DIR)
    const shell = join(root, 'index.html')
    await ctx.route(`${BASE}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.startsWith('/api/') || path.startsWith('/.well-known/')) return route.continue()
      const candidate = normalize(join(root, path))
      const file = candidate.startsWith(root) && extname(candidate) ? await readFile(candidate).then(() => candidate, () => shell) : shell
      return route.fulfill({ status: 200, body: await readFile(file), contentType: CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' })
    })
  }
  return ctx.newPage()
}

/** The licence token A's wallet holds, read from its own store (wallet_vouchers), or ''. */
async function heldLicenceToken(owner: Page, seller: string): Promise<string> {
  return (await owner.evaluate(`(async () => {
    const dbs = (await indexedDB.databases()).map((d) => d.name).filter((n) => n && n.startsWith('imani-wallet'))
    for (const name of dbs) {
      const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      if (!db.objectStoreNames.contains('wallet_vouchers')) continue
      const all = await new Promise((res) => { const r = db.transaction('wallet_vouchers').objectStore('wallet_vouchers').getAll(); r.onsuccess = () => res(r.result) })
      const v = all.find((x) => (x.issuer_id || '') === ${JSON.stringify(seller)} && x.token)
      if (v) return v.token
    }
    return ''
  })()`).catch(() => '')) as string
}

async function ownerKey(owner: Page): Promise<string> {
  return (await owner.evaluate(`(async () => {
    try {
      const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
      const env = JSON.parse(localStorage.getItem('imani-wallet-key') || 'null')
      const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(${JSON.stringify(TEST_PASSPHRASE)}), 'PBKDF2', false, ['deriveKey'])
      const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(env.kdf.salt), iterations: env.kdf.iterations, hash: env.kdf.hash },
        material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
      return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(env.iv) }, key, b64(env.ciphertext)))
    } catch (e) { return String(e) }
  })()`)) as string
}

async function main() {
  if (!/^[0-9a-f]{64}$/.test(SELLER_SK) || !MINT) {
    console.error('licenceGate: E2E_LICENCE_SELLER_SK and E2E_MINT_URL are required (run through the local gate)')
    process.exit(2)
  }
  const browser = await chromium.launch({ args: (process.env.E2E_CHROMIUM_ARGS ?? '').split(' ').filter(Boolean) })
  const errors: string[] = []

  console.log('\n#197: owner A registers a stall')
  const owner = await ownerPage(browser)
  owner.on('pageerror', (e) => errors.push(e.message))
  // The wallet's own licence reports, as the browser saw them. The status is taken synchronously:
  // reading the body here races the next navigation, which is what hid a 200 in early runs.
  const reports: Array<{ status: number }> = []
  owner.on('response', (r) => {
    if (new URL(r.url()).pathname === '/api/v1/portal/licence') reports.push({ status: r.status() })
  })
  const reportBodies: string[] = []
  owner.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/v1/portal/licence') reportBodies.push(r.postData() ?? '')
  })
  await registerMerchant(owner, BASE)
  const ownerSk = await ownerKey(owner)
  check("the harness opened A's key", /^[0-9a-f]{64}$/.test(ownerSk), ownerSk.slice(0, 80))
  if (!/^[0-9a-f]{64}$/.test(ownerSk)) return finish(browser, errors)
  const stall = pub(ownerSk)

  console.log('\n#197: two attested sell-and-redeem tills; the first is the free one')
  const t1 = await sellingTill(ownerSk, 'Front till')
  await new Promise((r) => setTimeout(r, 1_500))
  const t2 = await sellingTill(ownerSk, 'Second till')
  check('T1 and T2 are minted', !!t1.secret && !!t2.secret, `${t1.error} ${t2.error}`)
  if (!t1.secret || !t2.secret) return finish(browser, errors)
  const t1Sale = await tillSells(t1)
  check('T1 (the free terminal) sells: 201', t1Sale.status === 201, `${t1Sale.status} ${t1Sale.body.slice(0, 200)}`)
  const before = await tillSells(t2)
  check('T2 (a paid terminal) without a licence: 402 TERMINAL_UNLICENSED',
    before.status === 402 && /TERMINAL_UNLICENSED/.test(before.body), `${before.status} ${before.body.slice(0, 200)}`)

  console.log("\n#197: a licence sold to ANOTHER stall, reported by A, licenses nothing")
  const other = await sellLicence(pub(randomSk()))
  check('the seller mints a licence for another stall', !!other.token, other.error)
  if (other.token) {
    // Through A's own browser session, as the wallet sends it: the edge admits /api/v1/portal/ only
    // with a NAP session, and the request is still NIP-98 signed by A.
    const copied = await asOwnerSession(owner, ownerSk, '/api/v1/portal/licence', { secrets: tokenProofs(other.token).map((p) => p.secret) })
    check('the copied licence is refused 422 LICENCE_WRONG_KEY', copied.status === 422 && /LICENCE_WRONG_KEY/.test(copied.body),
      `${copied.status} ${copied.body.slice(0, 200)}`)
    const still = await tillSells(t2)
    check('T2 is still 402 after the copied report', still.status === 402, String(still.status))
  }

  console.log("\n#197: A buys a licence; A's wallet reports it by itself")
  const sold = await sellLicence(stall)
  check('the seller mints A a licence', !!sold.token, sold.error)
  if (!sold.token) return finish(browser, errors)
  // The realistic licence (review of #197, 4a): GBP 40.00 face, FIXED, so ONE locked proof.
  const soldProofs = tokenProofs(sold.token)
  check('a GBP 40.00 FIXED licence is ONE P2PK proof (backing_strategy FIXED, face 4000 GBP)',
    soldProofs.length === 1 && soldProofs[0].secret.startsWith('["P2PK_VOUCHER"') &&
      sold.voucher.backing_strategy === 'FIXED' && sold.voucher.face_value === 4000 && sold.voucher.face_unit === 'GBP',
    `proofs=${soldProofs.length} amount=${soldProofs.map((p) => p.amount).join('+')} backing=${String(sold.voucher.backing_strategy)} ` +
      `face=${String(sold.voucher.face_value)} ${String(sold.voucher.face_unit)}`)
  if (process.env.E2E_ARTIFACTS) {
    // The artefact a customer receives, for src/lib/__tests__/fixtures/live-licence.token.
    await mkdir(process.env.E2E_ARTIFACTS, { recursive: true }).catch(() => {})
    await writeFile(join(process.env.E2E_ARTIFACTS, 'live-licence.token'), `${sold.token}\n`).catch(() => {})
    await writeFile(join(process.env.E2E_ARTIFACTS, 'live-licence.customer'), `${stall}\n`).catch(() => {})
  }
  const dm = await as(SELLER_SK, 'POST', '/api/v1/dm/tokens/send', {
    recipient_pubkey: stall, token: sold.token, memo: sold.voucher.memo, voucher_id: sold.voucherId,
    face_value: sold.voucher.face_value, face_unit: sold.voucher.face_unit, face_decimals: sold.voucher.face_decimals,
    token_amount: sold.voucher.token_amount, backing_strategy: sold.voucher.backing_strategy,
    issuer_id: pub(SELLER_SK), sender_pubkey: pub(SELLER_SK),
    expires_at: Math.floor(Date.parse(String(sold.voucher.expires_at)) / 1000) || undefined,
    relay_urls: [INTERNAL_RELAY],
  })
  check('the licence is delivered to A by DM', dm.status >= 200 && dm.status < 300, `${dm.status} ${dm.body.slice(0, 200)}`)
  // The dashboard is where the owner lands after login; its licence check reports a verified licence.
  // The wallet redeems the DM: it swaps the licence at the mint and keeps fresh proofs (same signed
  // voucher, new secrets). So what it reports, and what must later be spent, are ITS proofs.
  let held = ''
  for (let i = 0; i < 24 && !held; i++) {
    await owner.goto(`${BASE}/merchant/dashboard`, { waitUntil: 'load' }).catch(() => {})
    await owner.waitForTimeout(5_000)
    held = await heldLicenceToken(owner, pub(SELLER_SK))
  }
  check("A's wallet holds the licence (stored after the DM; the receive's witness header fits)", held !== '')
  let reported = false
  for (let i = 0; i < 12 && !reported; i++) {
    reported = reports.some((r) => r.status === 200)
    if (!reported) {
      await owner.goto(`${BASE}/merchant/dashboard`, { waitUntil: 'load' }).catch(() => {})
      await owner.waitForTimeout(5_000)
    }
  }
  check("A's wallet reported the licence by itself (POST /api/v1/portal/licence 200)", reported,
    JSON.stringify(reports.slice(-2)))
  const sent = reportBodies.find((b) => b.includes('P2PK_VOUCHER') || b.includes('VOUCHER')) ?? ''
  const heldProofs = held ? tokenProofs(held) : []
  check('the report carried exactly the held proof SECRETS, and no C and no token',
    heldProofs.length > 0 &&
      JSON.stringify((JSON.parse(sent || '{}') as { secrets?: string[] }).secrets) === JSON.stringify(heldProofs.map((p) => p.secret)) &&
      heldProofs.every((p) => !sent.includes(p.C)) && !sent.includes('cashuB'),
    sent.slice(0, 160))
  const after = await tillSells(t2)
  check('T2 (a paid, attested terminal) of the licensed stall sells: 201', after.status === 201, `${after.status} ${after.body.slice(0, 200)}`)

  console.log("\n#226: A sends A's licence to B; B gets nothing, and A keeps working")
  if (held) {
    const b = await ownerPage(browser)
    b.on('pageerror', (e) => errors.push(`B: ${e.message}`))
    await registerMerchant(b, BASE)
    const bSk = await ownerKey(b)
    check("the harness opened B's key", /^[0-9a-f]{64}$/.test(bSk), bSk.slice(0, 80))
    if (/^[0-9a-f]{64}$/.test(bSk)) {
      const mine = walletGrants(held, stall)
      const theirs = walletGrants(held, pub(bSk))
      check("A's wallet check grants A the licence (control)", mine.granted, mine.reason)
      check("B's wallet check sees NO licence in A's copy (wrong-key)", !theirs.granted && theirs.reason === 'wrong-key', theirs.reason)
      const bReport = await asOwnerSession(b, bSk, '/api/v1/portal/licence', { secrets: tokenProofs(held).map((p) => p.secret) })
      check("the server refuses B's report of A's licence: 422 LICENCE_WRONG_KEY",
        bReport.status === 422 && /LICENCE_WRONG_KEY/.test(bReport.body), `${bReport.status} ${bReport.body.slice(0, 200)}`)
      const bSwap = await spendAtMint(held, bSk)
      const afterSwap = await mintState(held)
      check("the mint refuses B's swap of A's licence, and it stays UNSPENT",
        bSwap.status !== 200 && afterSwap.length > 0 && afterSwap.every((s) => s === 'UNSPENT'),
        `swap=${bSwap.status} ${bSwap.body} states=${afterSwap.join(',')}`)
      const aStill = await tillSells(t2)
      check("A's T2 still sells after B's attempts: 201", aStill.status === 201, `${aStill.status} ${aStill.body.slice(0, 200)}`)
    }
    await b.context().close().catch(() => {})
  }

  console.log('\n#197: the licence is refunded (spent at the mint); after the grace T2 is 402 again')
  // The licence leaves A's stall: spent at the mint. gateway-customer mints a licence P2PK-locked
  // to its buyer (lock_key), so only A's key can spend it (a seller's refund needs #226's refund
  // key). A's held proofs are spent here, which is what a refund or a theft looks like to the mint.
  if (!held) return finish(browser, errors)
  const refund = await spendAtMint(held, ownerSk)
  const states = await mintState(held)
  check('the licence is spent at the mint (NUT-07 SPENT)', states.length > 0 && states.every((s) => s === 'SPENT'),
    `swap=${refund.status} ${refund.body} states=${states.join(',')}`)
  // Wait out the grace and two refresh periods BEFORE asking, rather than polling: every 201 mints a
  // coupon, and the mint's per-identity quote quota (429) is low enough to trip in a poll loop.
  await new Promise((r) => setTimeout(r, (GRACE_S + 20) * 1000))
  let dropped = false
  let last = { status: 0, body: '' }
  for (let i = 0; i < 6 && !dropped; i++) {
    last = await tillSells(t2)
    dropped = last.status === 402
    if (!dropped) await new Promise((r) => setTimeout(r, 15_000))
  }
  check(`after the refresh and the ${GRACE_S} s grace, T2 is 402 TERMINAL_UNLICENSED`, dropped && /TERMINAL_UNLICENSED/.test(last.body),
    `${last.status} ${last.body.slice(0, 200)}`)
  const t1After = await tillSells(t1)
  check('T1, the free terminal, still sells', t1After.status === 201, `${t1After.status} ${t1After.body.slice(0, 160)}`)

  console.log('\n#226: the seller revokes a licence (a refund); A\'s paid till drops within one refresh, no grace')
  const second = await sellLicence(stall)
  check('the seller mints A a second licence (a new subscription)', !!second.token, second.error)
  if (!second.token) return finish(browser, errors)
  const secrets2 = tokenProofs(second.token).map((p) => p.secret)
  const report2 = await asOwnerSession(owner, ownerSk, '/api/v1/portal/licence', { secrets: secrets2 })
  check('A reports the second licence: 200', report2.status === 200, `${report2.status} ${report2.body.slice(0, 200)}`)
  const licensedAgain = await tillSells(t2)
  check('T2 sells again on the second licence: 201', licensedAgain.status === 201, `${licensedAgain.status} ${licensedAgain.body.slice(0, 200)}`)
  const notSeller = await revokeAs(ownerSk, second.subscriptionId, 'the buyer tries')
  check('a revocation signed by anyone but the seller is 403 NOT_A_LICENCE_SELLER',
    notSeller.status === 403 && /NOT_A_LICENCE_SELLER/.test(notSeller.body), `${notSeller.status} ${notSeller.body.slice(0, 200)}`)
  const revoked = await revokeAs(SELLER_SK, second.subscriptionId, 'refund (gate)')
  check('the seller revokes the subscription by NIP-98: 200, one reported licence',
    revoked.status === 200 && /"reported_licences":1/.test(revoked.body) && /"already_revoked":false/.test(revoked.body),
    `${revoked.status} ${revoked.body.slice(0, 200)}`)
  const revokedAt = Date.now()
  // One refresh period plus slack, and well inside the grace: a revocation has none.
  await new Promise((r) => setTimeout(r, (REFRESH_S + 3) * 1000))
  let cut = { status: 0, body: '' }
  for (let i = 0; i < 4; i++) {
    cut = await tillSells(t2)
    if (cut.status === 402) break
    await new Promise((r) => setTimeout(r, REFRESH_S * 1000))
  }
  const elapsedS = Math.round((Date.now() - revokedAt) / 1000)
  // Review of #226, E-1: A still holds its #197 licence (spent), so its licensed_until is that
  // licence's end, not null, and this 402 is that end's grace running out. It shows the revoked
  // licence stops counting; "no grace" itself is proved on stall C below, which has no other licence.
  check(`after the seller's revocation A's T2 is 402 TERMINAL_UNLICENSED (${elapsedS} s; A falls back to its older, spent licence)`,
    cut.status === 402 && /TERMINAL_UNLICENSED/.test(cut.body), `${cut.status} ${cut.body.slice(0, 200)} after ${elapsedS} s`)
  const reReport = await asOwnerSession(owner, ownerSk, '/api/v1/portal/licence', { secrets: secrets2 })
  check("A's re-report of the revoked licence is 422 LICENCE_REVOKED",
    reReport.status === 422 && /LICENCE_REVOKED/.test(reReport.body), `${reReport.status} ${reReport.body.slice(0, 200)}`)
  const t1Last = await tillSells(t1)
  check('T1, the free terminal, still sells after the revocation', t1Last.status === 201, `${t1Last.status} ${t1Last.body.slice(0, 160)}`)

  await revokedWithNoHistory(browser, errors)

  return finish(browser, errors)
}

/**
 * The portal's cached answer for `stall` (stall_licence_state), as `licensed_until|refreshed_at`, read
 * through the gate's psql (E2E_PORTAL_SQL_CMD), or '' when the stall has no row. `stall` is 64 hex.
 */
function portalLicenceState(stall: string): string {
  const cmd = process.env.E2E_PORTAL_SQL_CMD ?? ''
  if (!cmd || !/^[0-9a-f]{64}$/.test(stall)) return 'unavailable'
  const sql = `select coalesce(licensed_until::text, 'NULL') || '|' || coalesce(extract(epoch from refreshed_at)::bigint::text, '') ` +
    `from stall_licence_state where stall_pubkey = '${stall}'`
  try {
    return execFileSync('sh', ['-c', `${cmd} "$1"`, 'sh', sql], { encoding: 'utf8', timeout: 30_000 }).trim()
  } catch (e) {
    return `error: ${String(e).slice(0, 120)}`
  }
}

/**
 * Review of #226, E-1. The revocation above runs on A, whose OTHER licence (spent in the #197 step)
 * still gives the stall an end in the past: the portal's `licensed_until` is that end, not null, and
 * T2 is 402 because that end's grace has run out, which a grace on revocation would pass too. So
 * "no grace" is proved here on stall C, which has never held a licence: one licence, reported by C's
 * own wallet, revoked, and then the portal holds `licensed_until` NULL from a refresh AFTER the
 * revocation, and C's T2 is 402 straight away: well inside the grace, which null never gets.
 *
 * Then W-1 in C's browser: C's wallet re-reports, is told 422 LICENCE_REVOKED, and its Subscription
 * screen says the seller revoked it rather than "Active".
 */
async function revokedWithNoHistory(browser: Browser, errors: string[]) {
  console.log('\n#226 E-1: stall C, which never held a licence, is revoked: licensed_until NULL and T2 402 at once')
  const c = await ownerPage(browser)
  c.on('pageerror', (e) => errors.push(`C: ${e.message}`))
  const cReports: Array<{ status: number }> = []
  c.on('response', (r) => {
    if (new URL(r.url()).pathname === '/api/v1/portal/licence') cReports.push({ status: r.status() })
  })
  await registerMerchant(c, BASE)
  const cSk = await ownerKey(c)
  check("the harness opened C's key", /^[0-9a-f]{64}$/.test(cSk), cSk.slice(0, 80))
  if (!/^[0-9a-f]{64}$/.test(cSk)) return
  const cStall = pub(cSk)

  const c1 = await sellingTill(cSk, 'C front till')
  await new Promise((r) => setTimeout(r, 1_500))
  const c2 = await sellingTill(cSk, 'C second till')
  check("C's T1 and T2 are minted", !!c1.secret && !!c2.secret, `${c1.error} ${c2.error}`)
  if (!c1.secret || !c2.secret) return
  const unlicensed = await tillSells(c2)
  const before = portalLicenceState(cStall)
  check("C has no licence history: T2 is 402 and the portal holds no licence end for C",
    unlicensed.status === 402 && (before === '' || before.startsWith('NULL|')),
    `${unlicensed.status} state=${before}`)

  const sold = await sellLicence(cStall)
  check('the seller mints C its first licence', !!sold.token, sold.error)
  if (!sold.token) return
  const dm = await as(SELLER_SK, 'POST', '/api/v1/dm/tokens/send', {
    recipient_pubkey: cStall, token: sold.token, memo: sold.voucher.memo, voucher_id: sold.voucherId,
    face_value: sold.voucher.face_value, face_unit: sold.voucher.face_unit, face_decimals: sold.voucher.face_decimals,
    token_amount: sold.voucher.token_amount, backing_strategy: sold.voucher.backing_strategy,
    issuer_id: pub(SELLER_SK), sender_pubkey: pub(SELLER_SK),
    expires_at: Math.floor(Date.parse(String(sold.voucher.expires_at)) / 1000) || undefined,
    relay_urls: [INTERNAL_RELAY],
  })
  check('the licence is delivered to C by DM', dm.status >= 200 && dm.status < 300, `${dm.status} ${dm.body.slice(0, 200)}`)
  let reported = false
  for (let i = 0; i < 24 && !reported; i++) {
    await c.goto(`${BASE}/merchant/dashboard`, { waitUntil: 'load' }).catch(() => {})
    await c.waitForTimeout(5_000)
    reported = cReports.some((r) => r.status === 200)
  }
  check("C's wallet holds the licence and reported it by itself (200)", reported, JSON.stringify(cReports.slice(-3)))
  const licensed = await tillSells(c2)
  check("C's T2 sells on its licence: 201", licensed.status === 201, `${licensed.status} ${licensed.body.slice(0, 200)}`)
  const during = portalLicenceState(cStall)
  check('the portal holds a licence end for C while licensed (control)', /^\d{4}-/.test(during), during)

  const revoked = await revokeAs(SELLER_SK, sold.subscriptionId, 'refund (gate, E-1)')
  check("the seller revokes C's subscription: 200, one reported licence",
    revoked.status === 200 && /"reported_licences":1/.test(revoked.body), `${revoked.status} ${revoked.body.slice(0, 200)}`)
  const revokedAtS = Math.floor(Date.now() / 1000)
  // The first refresh after the revocation, and no longer: null has no grace to wait out.
  let state = ''
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, REFRESH_S * 1000))
    state = portalLicenceState(cStall)
    const refreshed = Number(state.split('|')[1] ?? '0')
    if (refreshed > revokedAtS) break
  }
  const [until, refreshedAt] = state.split('|')
  check("after C's revocation the portal's refresh answers licensed_until NULL (not a past end)",
    until === 'NULL' && Number(refreshedAt) > revokedAtS, `state=${state} revoked_at=${revokedAtS}`)
  const cut = await tillSellsOnce(c2)
  const elapsedS = Math.floor(Date.now() / 1000) - revokedAtS
  check(`C's T2 is 402 TERMINAL_UNLICENSED at its first Sell after that refresh (${elapsedS} s, grace ${GRACE_S} s)`,
    cut.status === 402 && /TERMINAL_UNLICENSED/.test(cut.body) && elapsedS < GRACE_S,
    `${cut.status} ${cut.body.slice(0, 200)} after ${elapsedS} s`)
  const free = await tillSells(c1)
  check("C's T1, the free terminal, still sells", free.status === 201, `${free.status} ${free.body.slice(0, 160)}`)

  console.log("\n#226 W-1: C's wallet learns of the revocation and stops granting")
  // The wallet re-reports a licence at most every 6 h (REPORT_INTERVAL_SECONDS); forgetting that
  // note stands in for the interval passing, and nothing else about the wallet is touched.
  await c.evaluate((k) => localStorage.removeItem(k), `imani.licence.reported.${cStall}`).catch(() => {})
  const seen = cReports.length
  let told = false
  for (let i = 0; i < 6 && !told; i++) {
    await c.goto(`${BASE}/merchant/dashboard`, { waitUntil: 'load' }).catch(() => {})
    await c.waitForTimeout(4_000)
    told = cReports.slice(seen).some((r) => r.status === 422)
  }
  check("C's wallet re-reports and is told 422 (LICENCE_REVOKED)", told, JSON.stringify(cReports.slice(seen)))
  await c.goto(`${BASE}/settings/subscription`, { waitUntil: 'load' }).catch(() => {})
  // The app opens the wallet first ("Opening wallet…"), then the screen checks: wait for a verdict.
  await c.getByText(/^(Not active|Active|Working, unconfirmed)$/).first().waitFor({ timeout: 30_000 }).catch(() => {})
  const screenText = await c.locator('body').innerText({ timeout: 20_000 }).catch(() => '')
  check("C's Subscription screen says it was revoked by the seller, not Active",
    /revoked by the seller/i.test(screenText) && /Not active/.test(screenText), screenText.replace(/\s+/g, ' ').slice(0, 300))
  await c.context().close().catch(() => {})
}

async function finish(browser: Browser, errors: string[]) {
  check('no uncaught errors in the owner wallet', errors.length === 0, errors.join('; ').slice(0, 300))
  await browser.close()
  console.log(failures.length === 0 ? '\nAll checks passed.\n' : `\n${failures.length} FAILED: ${failures.join(', ')}\n`)
  process.exit(failures.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E harness error:', e)
  process.exit(1)
})
