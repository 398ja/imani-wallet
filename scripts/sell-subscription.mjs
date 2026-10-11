#!/usr/bin/env node
/**
 * Sell one subscription, by hand.
 *
 * Ticket 05 of the subscriptions spec. There is no purchase flow and this is not
 * one: "building one before knowing what customers ask is guessing". This is the
 * pilot mechanism, it does not scale past a few dozen customers, and that is the
 * point at which the in-app flow will have evidence behind it.
 *
 *   node scripts/sell-subscription.mjs --customer-pubkey <hex> --paid 4000
 *   node scripts/sell-subscription.mjs --customer-pubkey <hex> --paid 0 --pilot
 *   node scripts/sell-subscription.mjs --customer-pubkey <hex> --paid 4200 \
 *       --subscription-id sub_9f2c11          # a RENEWAL, or a re-issue
 *   node scripts/sell-subscription.mjs --revoke sub_9f2c11 --reason "refund"   # a REFUND
 *
 * The deployed seller (staging): its nsec is IMANI_SUBSCRIPTIONS_SELLER_NSEC in the deploy env file,
 * and only that line is read:
 *
 *   WALLET_URL=https://wallet.staging.398ja.xyz node scripts/sell-subscription.mjs \
 *       --env-file ../imani-deploy/.env.staging --customer-pubkey <hex> --paid 4000
 *
 * ## What makes this a licence rather than a coupon
 *
 * One field: `merchant_metadata`, carrying a subscription id, a grant, and the
 * customer's key. It is the only difference, and everything downstream keys off
 * it — `licences.ts` decides money-or-licence from it, `verifyLicence` reads the
 * lock and the grant from it. The shape is defined ONCE, in
 * `src/lib/licenceIssue.ts`, and imported here rather than restated, because a
 * second copy of these key names is a licence the wallet silently stops
 * recognising. That module is tested; this script is the delivery around it.
 *
 * ## Why not the portal endpoint the Sell flow uses
 *
 * `POST /api/v1/portal/vouchers` builds `merchant_metadata` itself and puts
 * exactly one key in it — `campaign_id`. Its request record has no metadata
 * field at all and is annotated `@JsonIgnoreProperties(ignoreUnknown = true)`,
 * so sending licence fields there does not fail: it returns 201 and DROPS them.
 * Verified by deserialising this exact body with the real DTO. That silence is
 * the danger — the seller sees a successful sale and the customer receives an
 * ordinary coupon.
 *
 * This calls the wallet tier's `POST /api/v1/wallet/vouchers`, which takes
 * `CreateVoucherRequest` and passes `merchant_metadata` through to the signed
 * secret. The body below was checked against that DTO and its bean validation:
 * every field binds, zero violations. Selling is out-of-band precisely so it
 * can use the tier that fits rather than wait for a portal field.
 *
 * IF THIS 4xxs on `merchant_metadata`: the gateway's `VoucherAdapter` must pass
 * `pending.merchantMetadata()` into `VoucherSecret.builder()` for the field to
 * reach the SIGNED bytes (imani-gateway-customer b0fdca5). It carries the value
 * through its response either way, so a token that verifies but is not
 * recognised as a licence means that fix is not in the deployed build.
 *
 * ## Refunds: `--revoke` (imani-wallet#226)
 *
 * A licence is P2PK-locked to the buyer, so neither the seller nor anyone who copies it can spend
 * it, and the seller holds nothing that would end it. A refund therefore revokes the SUBSCRIPTION
 * at gateway-customer: `--revoke <subscription id>` signs `POST /api/v1/wallet/licences/revoke`
 * with NIP-98 as the seller (only a key in `GATEWAY_CUSTOMER_LICENCE_SELLER_PUBKEYS` may), and every
 * licence of that subscription stops counting at once. The buyer's paid terminals are refused on
 * the portal's next refresh (15 minutes), with no grace. It is permanent: a customer who comes
 * back buys under a NEW subscription id (omit `--subscription-id`).
 */
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEYS = join(HERE, '..', '.seed-keys.json')
/** The seller's record of what was sold, read by notify-expiring.mjs. */
const SOLD = join(HERE, '..', '.sold-subscriptions.json')
const WALLET = process.env.WALLET_URL ?? 'http://localhost:28082'
const EDGE_SECRET = process.env.EDGE_SECRET ?? 'dev-edge-secret-local-only'
const INTERNAL_RELAY = process.env.INTERNAL_RELAY_URL ?? 'ws://nostr-relay:7777'

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag)
  return i === -1 ? fallback : process.argv[i + 1]
}
const flag = (name) => process.argv.includes(name)

// ---------------------------------------------------------------- the licence

/**
 * The licence metadata, in the shape `src/lib/licences.ts` reads back.
 *
 * Kept deliberately identical to `licenceMetadataJson` in
 * `src/lib/licenceIssue.ts` — that module is the definition and is tested by
 * round trip. This is a `.mjs` script and cannot import the app's TypeScript
 * without a build step, so the shape is restated here and the pair is guarded
 * by `--self-check` below, which fails loudly if they ever disagree.
 */
export function licenceMetadata({ lockKey, subscriptionId, features, pilot, paidAmountMinor, paidCurrency }) {
  if (!lockKey) throw new Error('a licence must be locked to the customer key')
  if (!subscriptionId) throw new Error('a licence must carry a subscription id')
  if (!features?.length) throw new Error('a licence must confer at least one feature')

  return JSON.stringify({
    subscription_id: subscriptionId,
    features,
    lock_key: lockKey,
    ...(pilot ? { pilot: true } : {}),
    paid_amount_minor: paidAmountMinor,
    paid_currency: paidCurrency,
  })
}

/** Random, so it says nothing about the customer it belongs to. */
function newSubscriptionId() {
  return `sub_${bytesToHex(crypto.getRandomValues(new Uint8Array(8)))}`
}

const TERM_DAYS = { annual: 365, monthly: 30 }

// ---------------------------------------------------------------- auth

/** The deployed seller's secret: the deploy env file holds it, nothing else does. */
export const SELLER_NSEC_VAR = 'IMANI_SUBSCRIPTIONS_SELLER_NSEC'

/**
 * The `imani-subscriptions` seller from the environment, or `null` when it is not set.
 *
 * The deployed seller's nsec lives ONLY in the deploy env file (`imani-deploy/.env.staging`), next
 * to the public `GATEWAY_CUSTOMER_LICENCE_SELLER_PUBKEYS`. No compose service references it, so
 * this script is its only reader. Pass it as an env var, or point `--env-file` at the env file and
 * only that one line is read. A bad value is refused WITHOUT echoing it.
 */
export function sellerFromEnv(env = process.env, envFile = '') {
  let value = (env[SELLER_NSEC_VAR] ?? '').trim()
  if (!value && envFile) {
    const line = readFileSync(envFile, 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${SELLER_NSEC_VAR}=`))
    value = (line?.slice(SELLER_NSEC_VAR.length + 1) ?? '').trim().replace(/^["']|["']$/g, '')
  }
  if (!value) return null
  let sk
  try {
    const decoded = nip19.decode(value)
    if (decoded.type !== 'nsec') throw new Error('not an nsec')
    sk = decoded.data
  } catch {
    throw new Error(`${SELLER_NSEC_VAR} is set but is not a valid nsec (value not shown)`)
  }
  return { name: 'imani-subscriptions', sk, pk: getPublicKey(sk) }
}

/**
 * The seller's own identity, reused across runs so renewals come from one key.
 *
 * The env (`IMANI_SUBSCRIPTIONS_SELLER_NSEC`, or `--env-file <path>`) wins: that is the deployed
 * seller. `.seed-keys.json` is the local dev stack's fallback only.
 */
function sellerKey() {
  const fromEnv = sellerFromEnv(process.env, arg('--env-file', ''))
  if (fromEnv) return fromEnv
  const name = arg('--seller', 'imani-subscriptions')
  const store = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, 'utf8')) : {}
  if (!store[name]) {
    throw new Error(
      `no seller identity '${name}' in .seed-keys.json. ` +
        `Run scripts/seed-merchant.mjs --name "${name}" once to create one, ` +
        `so every subscription is signed by the same issuer.`,
    )
  }
  return { name, sk: hexToBytes(store[name].sk), pk: store[name].pk }
}

/** NIP-98 (kind 27235) over an exact URL + method + body. */
function nip98(sk, url, method, body) {
  const tags = [
    ['u', url],
    ['method', method],
  ]
  if (body) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  const event = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' },
    sk,
  )
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

function authHeaders(seller, url, method, body) {
  return {
    'Content-Type': 'application/json',
    Authorization: nip98(seller.sk, url, method, body),
    'X-Auth-Pubkey': seller.pk,
    'X-Edge-Auth': EDGE_SECRET,
  }
}

// ---------------------------------------------------------------- revoking (#226)

/** The shape gateway-customer accepts, which `newSubscriptionId` always produces. */
const SUBSCRIPTION_ID = /^[A-Za-z0-9_.:-]{1,128}$/

/**
 * The revocation request: NIP-98 ONLY. No `X-Auth-Pubkey` / `X-Edge-Auth`: the server refuses an
 * edge session for a revocation (a leaked edge secret must not revoke anyone's licence), and the
 * signature is what proves this is the seller.
 */
export function revokeRequest(seller, walletUrl, subscriptionId, reason) {
  if (typeof subscriptionId !== 'string' || !SUBSCRIPTION_ID.test(subscriptionId)) {
    throw new Error('--revoke needs the subscription id as sold (sub_…)')
  }
  const url = `${walletUrl.replace(/\/+$/, '')}/api/v1/wallet/licences/revoke`
  const trimmed = (reason ?? '').trim()
  const body = JSON.stringify(trimmed ? { subscription_id: subscriptionId, reason: trimmed } : { subscription_id: subscriptionId })
  return {
    url,
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      Authorization: nip98(typeof seller.sk === 'string' ? hexToBytes(seller.sk) : seller.sk, url, 'POST', body),
    },
  }
}

/**
 * Refuses to sell under a subscription id this ledger records as revoked (review of #226).
 *
 * A revocation is permanent at gateway-customer: every licence of that id, sold by this seller, is
 * refused `422 LICENCE_REVOKED` when reported, including one minted AFTER the revocation. So a
 * "renewal" under a revoked id would charge the customer for a licence that grants nothing. A
 * customer who comes back gets a NEW subscription id (omit `--subscription-id`).
 *
 * The ledger is local, so this only catches what this machine revoked; gateway-customer is still
 * the authority.
 */
export function assertNotRevoked(rows, subscriptionId) {
  const row = (Array.isArray(rows) ? rows : []).find((r) => r && r.subscription_id === subscriptionId)
  if (row && row.revoked_at) {
    throw new Error(
      `subscription ${subscriptionId} was revoked at ${row.revoked_at}: a licence under it would grant ` +
        'nothing (422 LICENCE_REVOKED). Sell under a NEW subscription id: omit --subscription-id.',
    )
  }
}

/** The ledger rows, or [] when it is missing or unreadable. */
function readLedger() {
  try {
    if (existsSync(SOLD)) {
      const parsed = JSON.parse(readFileSync(SOLD, 'utf8'))
      if (Array.isArray(parsed)) return parsed
    }
  } catch {
    // unreadable: treated as empty, as recordSale does
  }
  return []
}

/** The ledger with this subscription marked revoked (added if it was never recorded). */
export function markRevoked(rows, subscriptionId, revokedAt, reason) {
  const out = rows.map((r) => ({ ...r }))
  let row = out.find((r) => r.subscription_id === subscriptionId)
  if (!row) {
    row = { subscription_id: subscriptionId, notices: [] }
    out.push(row)
  }
  row.revoked_at = revokedAt
  if (reason && reason.trim()) row.revoked_reason = reason.trim()
  return out
}

async function revoke(seller, subscriptionId, reason) {
  const req = revokeRequest(seller, WALLET, subscriptionId, reason)
  const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body })
  const text = await r.text()
  if (!r.ok) throw new Error(`revoke failed ${r.status}: ${text}`)
  const answer = JSON.parse(text)
  let rows = []
  try {
    if (existsSync(SOLD)) {
      const parsed = JSON.parse(readFileSync(SOLD, 'utf8'))
      if (Array.isArray(parsed)) rows = parsed
    }
  } catch {
    rows = []
  }
  try {
    writeFileSync(SOLD, JSON.stringify(markRevoked(rows, subscriptionId, answer.revoked_at, reason), null, 2))
  } catch {
    console.warn('WARNING: revoked at the server, but .sold-subscriptions.json could not be updated.')
  }
  return answer
}

// ---------------------------------------------------------------- minting

/**
 * Mint the licence voucher.
 *
 * The face value IS the price paid, which looks wrong and is the spec's
 * decision: "it makes the credential its own receipt". The wallet keeps it out
 * of every balance by recognising it as a licence, not by it being worth zero.
 */
/**
 * The issuance request for one licence. Exported so a test pins it.
 *
 * **`FIXED`**, as ADR 0007 decides: non-splittable, backed by the platform's fixed 1 sat, so the
 * licence is ONE proof. `PROPORTIONAL` backed a GBP 40 licence with its whole value in sats: a
 * dozen P2PK-locked proofs, whose NUT-11 witness header (one entry of the full secret per proof)
 * the edge refused as "Request Header Or Cookie Too Large" on the buyer's receive, and sats a
 * buyer could melt (review of imani-wallet#197, 4a).
 *
 * The seller's own `merchant` warrant over the sale goes inside: since #159 every wallet refuses a
 * coupon with no usable authorisation from its stall, a licence included.
 */
export function licenceIssueBody(seller, { paidAmountMinor, paidCurrency, term, metadata }) {
  const faceDecimals = paidCurrency === 'sat' ? 0 : 2
  return {
    face_value: paidAmountMinor,
    face_unit: paidCurrency,
    face_decimals: faceDecimals,
    backing_strategy: 'FIXED',
    issuer_id: seller.pk,
    memo: `Imani subscription (${term})`,
    expires_in_days: TERM_DAYS[term],
    merchant_metadata: JSON.parse(metadata),
    issuance_warrant: sellerWarrant(seller, paidAmountMinor, faceDecimals, paidCurrency),
  }
}

/** The seller's signed `merchant` warrant (src/lib/issuanceWarrant.ts, IssuanceWarrant.java). */
function sellerWarrant(seller, saleTotal, faceDecimals, unit) {
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  const digest = sha256(
    new TextEncoder().encode([seller.pk, String(saleTotal), String(faceDecimals), unit, nonce].join('\u001f')),
  )
  const sk = typeof seller.sk === 'string' ? hexToBytes(seller.sk) : seller.sk
  if (!sk) throw new Error('the seller key is needed to sign the sale warrant')
  return JSON.stringify({
    form: 'merchant', sale_total: saleTotal, face_decimals: faceDecimals, unit, nonce,
    sig: bytesToHex(schnorr.sign(digest, sk)),
  })
}

async function mintLicence(seller, { paidAmountMinor, paidCurrency, term, metadata }) {
  const url = `${WALLET}/api/v1/wallet/vouchers`
  const body = JSON.stringify(licenceIssueBody(seller, { paidAmountMinor, paidCurrency, term, metadata }))

  const response = await fetch(url, { method: 'POST', headers: authHeaders(seller, url, 'POST', body), body })
  const text = await response.text()
  if (!response.ok) throw new Error(`mint failed ${response.status}: ${text}`)
  return JSON.parse(text)
}

/**
 * Wait until the voucher actually carries a token.
 *
 * Issuance returns PENDING behind a top-up invoice and only carries a real
 * Cashu token once that settles; delivering earlier DMs an empty token. Poll on
 * `token`, never on `expires_at` — that field stays null for seconds after the
 * voucher already reports ISSUED, so it is not a readiness signal.
 */
async function waitForToken(seller, voucherId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last = {}
  while (Date.now() < deadline) {
    const url = `${WALLET}/api/v1/wallet/vouchers/${voucherId}`
    const r = await fetch(url, { headers: authHeaders(seller, url, 'GET') })
    if (r.ok) {
      last = await r.json()
      if (last.token && last.status === 'ISSUED') return last
    }
    await new Promise((res) => setTimeout(res, 2000))
  }
  throw new Error(`voucher ${voucherId} never produced a token (status=${last.status})`)
}

/** Epoch SECONDS, whatever the gateway returned. */
function toEpochSeconds(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.floor(value > 1e11 ? value / 1000 : value) : null
  }
  const ms = Date.parse(String(value))
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

/**
 * Deliver by the same gift-wrapped DM as everything else.
 *
 * "A licence arrives in my wallet, so there is nothing to activate and no code
 * to type." The gateway does the wrapping, so the receive pipeline parses the
 * exact shape it already knows.
 */
async function deliver(seller, voucher, customerPubkey) {
  if (process.env.PRINT_TOKENS) {
    console.log(`\nTOKEN ${voucher.voucher_id}\n${voucher.token}\n`)
    return { skipped: true }
  }
  const url = `${WALLET}/api/v1/dm/tokens/send`
  const body = JSON.stringify({
    recipient_pubkey: customerPubkey,
    token: voucher.token,
    memo: voucher.memo,
    voucher_id: voucher.voucher_id,
    face_value: voucher.face_value,
    face_unit: voucher.face_unit,
    face_decimals: voucher.face_decimals,
    token_amount: voucher.token_amount,
    backing_strategy: voucher.backing_strategy,
    issuer_id: seller.pk,
    sender_pubkey: seller.pk,
    expires_at: toEpochSeconds(voucher.expires_at),
    relay_urls: [INTERNAL_RELAY],
  })

  const r = await fetch(url, { method: 'POST', headers: authHeaders(seller, url, 'POST', body), body })
  const text = await r.text()
  if (!r.ok) {
    throw new Error(
      `deliver failed ${r.status}: ${text}. The licence IS minted under voucher ` +
        `${voucher.voucher_id} — re-deliver it rather than minting a second one, ` +
        `or the customer ends up with two licences for one subscription.`,
    )
  }
  return JSON.parse(text)
}

/**
 * Record the sale, so the expiry notices have something to run from.
 *
 * `notify-expiring.mjs` cannot warn anyone about a subscription nobody wrote
 * down, and asking a seller to hand-maintain a JSON file is asking for the one
 * customer who is missed to be the one who lapses silently. Written here
 * because this is the moment the facts exist and are certainly correct.
 *
 * NOT an account database. It is the seller's own note of what they sold —
 * the same kind of record as `.seed-keys.json` beside it — and the customer's
 * entitlement still lives entirely in their voucher. Delete this file and
 * nobody loses access; only the reminders stop.
 *
 * Keyed by subscription id, so a RENEWAL updates the existing row rather than
 * adding a second. The expiry moving is what re-arms the notices for the new
 * term (see `alreadySent`, which keys on the expiry as well as the id).
 */
function recordSale({ subscriptionId, customerPubkey, expiresAt, term, paidAmountMinor, paidCurrency, pilot }) {
  let rows = []
  try {
    if (existsSync(SOLD)) {
      const parsed = JSON.parse(readFileSync(SOLD, 'utf8'))
      if (Array.isArray(parsed)) rows = parsed
    }
  } catch {
    // An unreadable ledger must not fail a sale that already completed. The
    // customer HAS their licence; the worst case is a missed reminder.
    rows = []
  }

  const existing = rows.find((r) => r.subscription_id === subscriptionId)
  const row = existing ?? { subscription_id: subscriptionId, notices: [] }
  row.customer_pubkey = customerPubkey
  row.expires_at = expiresAt
  row.term = term
  row.paid_amount_minor = paidAmountMinor
  row.paid_currency = paidCurrency
  row.pilot = pilot
  if (!existing) rows.push(row)

  try {
    writeFileSync(SOLD, JSON.stringify(rows, null, 2))
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- entrypoint

/**
 * Everything below runs only when this file is EXECUTED, not when it is
 * imported.
 *
 * `licenceMetadata` above is exported so `src/lib/__tests__/licenceIssue.test.ts`
 * can assert it agrees, byte for byte, with the TypeScript definition it
 * restates. Without this guard that import would try to sell a subscription.
 */
const executed =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (executed) {
  // Operator errors — no seller identity, a gateway that refuses, a delivery
  // that fails — are reported as a sentence, not a stack trace. Every one of
  // them is something the person running this can act on, and a stack frame
  // from inside node's ESM loader tells them nothing about which.
  //
  // The message matters most on the delivery failure, where it names the
  // voucher that WAS minted: re-delivering it is right and minting a second is
  // not, because the customer would then hold two licences for one subscription.
  try {
    await main()
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

/**
 * Prove the metadata this script writes is the metadata the wallet reads.
 *
 * `--self-check` needs no gateway, no mint and no relay, so it runs anywhere.
 * It exists because this file restates a shape defined in TypeScript it cannot
 * import: without it, a rename on the app side would be discovered by a
 * customer whose paid subscription had quietly become a coupon.
 */
function selfCheck() {
  const meta = JSON.parse(
    licenceMetadata({
      lockKey: 'b'.repeat(64),
      subscriptionId: 'sub_test',
      features: ['terminals'],
      paidAmountMinor: 4000,
      paidCurrency: 'GBP',
    }),
  )
  // Exactly the keys `LicenceMetadata` in src/lib/licences.ts declares, plus the
  // paid_* pair `paidFor` reads.
  const expected = ['subscription_id', 'features', 'lock_key', 'paid_amount_minor', 'paid_currency']
  const missing = expected.filter((k) => !(k in meta))
  if (missing.length) throw new Error(`licence metadata is missing ${missing.join(', ')}`)

  for (const bad of [
    { subscriptionId: 'x', features: ['terminals'] },
    { lockKey: 'b', features: ['terminals'] },
    { lockKey: 'b', subscriptionId: 'x', features: [] },
  ]) {
    let threw = false
    try {
      licenceMetadata({ ...bad, paidAmountMinor: 0, paidCurrency: 'GBP' })
    } catch {
      threw = true
    }
    if (!threw) throw new Error(`minted a licence that could never grant: ${JSON.stringify(bad)}`)
  }
  console.log('self-check ok — metadata matches what src/lib/licences.ts reads')
}

async function main() {
  if (flag('--self-check')) {
    selfCheck()
    return
  }

  const revoking = arg('--revoke', '')
  if (revoking) {
    const seller = sellerKey()
    console.log(`seller        ${seller.name} (${seller.pk.slice(0, 12)}…)`)
    console.log(`revoking      ${revoking}`)
    const answer = await revoke(seller, revoking, arg('--reason', ''))
    console.log(
      `${answer.already_revoked ? 'already revoked' : 'revoked'} at ${answer.revoked_at}; ` +
        `${answer.reported_licences} reported licence(s) stop counting. The buyer's paid terminals ` +
        'are refused on the next licence refresh.',
    )
    return
  }

  const customerPubkey = arg('--customer-pubkey', '')
  if (!customerPubkey || !/^[0-9a-f]{64}$/i.test(customerPubkey)) {
    console.error(
      'usage: sell-subscription.mjs --customer-pubkey <64-hex> --paid <minor units> ' +
        '[--currency GBP] [--term annual|monthly] [--pilot] [--subscription-id sub_…]\n\n' +
        'The pubkey is the key the licence is LOCKED to. Get it from the customer; ' +
        'a licence locked to the wrong key grants nothing and cannot be re-pointed.',
    )
    process.exitCode = 1
    return
  }

  const term = arg('--term', 'annual')
  if (!TERM_DAYS[term]) {
    console.error(`unknown term '${term}' — annual or monthly`)
    process.exitCode = 1
    return
  }

  const paidAmountMinor = Number(arg('--paid', '0'))
  const paidCurrency = arg('--currency', 'GBP')
  const pilot = flag('--pilot')
  // Supplied = this is a RENEWAL or a re-issue to a replacement key. Omitted = a
  // new customer. Getting this wrong is silent: a renewal with a fresh id mints
  // a working licence and quietly turns one relationship into two.
  const renewing = arg('--subscription-id', '')
  const subscriptionId = renewing || newSubscriptionId()
  if (renewing) {
    try {
      assertNotRevoked(readLedger(), renewing)
    } catch (e) {
      console.error(e.message)
      process.exitCode = 1
      return
    }
  }

  const seller = sellerKey()
  const metadata = licenceMetadata({
    lockKey: customerPubkey,
    subscriptionId,
    features: arg('--features', 'terminals').split(','),
    pilot,
    paidAmountMinor,
    paidCurrency,
  })

  console.log(`seller        ${seller.name} (${seller.pk.slice(0, 12)}…)`)
  console.log(`customer      ${nip19.npubEncode(customerPubkey)}`)
  console.log(
    `subscription  ${subscriptionId}${renewing ? '  (RENEWAL — same relationship)' : '  (new)'}`,
  )
  console.log(`term          ${term} (${TERM_DAYS[term]} days)`)
  console.log(`paid          ${paidAmountMinor} ${paidCurrency}${pilot ? '   [PILOT]' : ''}`)

  const created = await mintLicence(seller, { paidAmountMinor, paidCurrency, term, metadata })
  console.log(`\nminted ${created.voucher_id}, waiting for settlement…`)

  const ready = await waitForToken(seller, created.voucher_id)
  const result = await deliver(seller, ready, customerPubkey)

  const expiry = toEpochSeconds(ready.expires_at)
  console.log(
    `delivered ${String(result.event_id ?? result.eventId ?? '(printed)').slice(0, 12)}…  ` +
      `expires ${expiry ? new Date(expiry * 1000).toISOString().slice(0, 10) : 'NEVER — a licence with no expiry grants NOTHING'}`,
  )
  const recorded = recordSale({
    subscriptionId,
    customerPubkey,
    expiresAt: expiry,
    term,
    paidAmountMinor,
    paidCurrency,
    pilot,
  })
  if (!recorded) {
    console.warn(
      '\nWARNING: the sale could not be written to .sold-subscriptions.json, so ' +
        'no expiry reminder will go out for it. The licence IS delivered.',
    )
  }

  console.log(`\nkeep this for renewal:  --subscription-id ${subscriptionId}`)
}
