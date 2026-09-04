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
 * exactly one key in it — `campaign_id` — so a licence minted through it arrives
 * carrying no subscription id, no grant and no lock key, and grants nothing.
 * This calls the wallet tier's `POST /api/v1/wallet/vouchers`, which takes
 * `CreateVoucherRequest` and passes `merchant_metadata` through to the signed
 * secret. Selling is out-of-band precisely so it can use the tier that fits
 * rather than wait for a portal field.
 *
 * IF THIS 4xxs on `merchant_metadata`: see the note at the bottom of the
 * subscriptions spec. The gateway's `VoucherAdapter` must pass
 * `pending.merchantMetadata()` into `VoucherSecret.builder()` for the field to
 * reach the SIGNED bytes; it carries the value through its response either way,
 * so a token that verifies but is not recognised as a licence is that gap and
 * not this script.
 */
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEYS = join(HERE, '..', '.seed-keys.json')
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

/** The seller's own identity, reused across runs so renewals come from one key. */
function sellerKey() {
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

// ---------------------------------------------------------------- minting

/**
 * Mint the licence voucher.
 *
 * The face value IS the price paid, which looks wrong and is the spec's
 * decision: "it makes the credential its own receipt". The wallet keeps it out
 * of every balance by recognising it as a licence, not by it being worth zero.
 */
async function mintLicence(seller, { paidAmountMinor, paidCurrency, term, metadata }) {
  const url = `${WALLET}/api/v1/wallet/vouchers`
  const body = JSON.stringify({
    face_value: paidAmountMinor,
    face_unit: paidCurrency,
    face_decimals: paidCurrency === 'sat' ? 0 : 2,
    backing_strategy: 'PROPORTIONAL',
    issuer_id: seller.pk,
    memo: `Imani subscription (${term})`,
    expires_in_days: TERM_DAYS[term],
    merchant_metadata: JSON.parse(metadata),
  })

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
  await main()
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
  console.log(`\nkeep this for renewal:  --subscription-id ${subscriptionId}`)
}

