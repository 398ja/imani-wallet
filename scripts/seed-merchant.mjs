#!/usr/bin/env node
/**
 * Seed a merchant and issue real coupons from them.
 *
 * Why the portal tier and not the customer gateway: voucher issuance on
 * customer-wallet is refused by design —
 *
 *   "Voucher creation is not supported on JdbcWalletPort — the customer-wallet
 *    is self-custodial (Constitution Principle II). Voucher state is
 *    client-held; the backend MUST NOT persist vouchers, proofs, or balances.
 *    If a caller is hitting this guard, its request is routing to the wrong
 *    tier."
 *
 * Issuing is a merchant action, so it goes to gateway-portal's
 * PortalVoucherController. The issuer pubkey is never a request field — it comes
 * from whoever the portal authenticated, which is the point: the merchant's
 * identity is their key.
 *
 * Auth: the portal accepts either NIP-98 or a pubkey forwarded by the trusted
 * edge proxy (X-Auth-Pubkey + X-Edge-Auth). We don't run edge-proxy locally —
 * Vite talks to host ports directly — so this script plays the edge proxy's
 * role, with the shared secret set in deploy/compose.override.yml. The NIP-98
 * path is built below too and is what a real merchant client would use.
 *
 * Usage:
 *   node scripts/seed-merchant.mjs                      # default merchant + 3 coupons
 *   node scripts/seed-merchant.mjs --name "Rosa" --quantity 5 --face 750
 */
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEYS = join(HERE, '..', '.seed-keys.json')
const PORTAL = process.env.PORTAL_URL ?? 'http://localhost:28084'
/** Must match GATEWAY_PORTAL_EDGE_SHARED_SECRET in deploy/compose.override.yml. */
const EDGE_SECRET = process.env.EDGE_SECRET ?? 'dev-edge-secret-local-only'
const WALLET = process.env.WALLET_URL ?? 'http://localhost:28082'
/** Browser-reachable relay (host port). */
const RELAY = process.env.RELAY_URL ?? 'ws://localhost:27778'
/** The same relay as the gateway addresses it, on the docker network. */
const INTERNAL_RELAY = process.env.INTERNAL_RELAY_URL ?? 'ws://nostr-relay:7777'

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag)
  return i === -1 ? fallback : process.argv[i + 1]
}

/**
 * Stable merchant identities across runs.
 *
 * Regenerating keys every run would orphan previously issued coupons under a
 * pubkey nothing references any more, and the merchant list would fill with
 * duplicates of the same person.
 */
function loadOrCreateMerchant(name) {
  const store = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, 'utf8')) : {}
  if (!store[name]) {
    const sk = generateSecretKey()
    store[name] = { sk: bytesToHex(sk), pk: getPublicKey(sk) }
    mkdirSync(dirname(KEYS), { recursive: true })
    writeFileSync(KEYS, JSON.stringify(store, null, 2))
    console.log(`  new identity for ${name}`)
  }
  return { name, sk: hexToBytes(store[name].sk), pk: store[name].pk }
}

/**
 * A NAP session cookie for the merchant, when the target is edge-guarded.
 *
 * Staging puts nap_auth.lua in front of `/api/v1/portal`, which answers 401
 * "No session cookie" long before the portal ever sees the NIP-98 proof this
 * script signs. The dev stack has no edge at all, so the cookie is optional:
 * `napLogin` is only called when a base URL is not localhost.
 *
 * This is the same init/complete exchange the wallet performs at login, and the
 * session it returns is what carries `coupon:issue` — the permission the portal
 * actually checks. Header-injected permissions are NOT a substitute: the edge
 * strips client-supplied X-Auth-* on the way in, by design.
 */
async function napLogin(base, sk) {
  const pk = getPublicKey(sk)
  const init = await fetch(`${base}/api/v1/auth/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ npub: nip19.npubEncode(pk) }),
  })
  const challenge = await init.json()
  if (!challenge.challenge_id) throw new Error(`auth/init failed: ${JSON.stringify(challenge)}`)

  // Signed by hash, so the body must be serialised once and sent byte for byte.
  const raw = new TextEncoder().encode(JSON.stringify({ challenge_id: challenge.challenge_id }))
  const proof = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['u', challenge.auth_url],
        ['method', challenge.auth_method],
        ['payload', bytesToHex(sha256(raw))],
        ['challenge', challenge.challenge],
        ['challenge_id', challenge.challenge_id],
      ],
      content: '',
    },
    sk,
  )
  const complete = await fetch(`${base}/api/v1/auth/complete`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Nostr ${Buffer.from(JSON.stringify(proof)).toString('base64')}`,
    },
    body: raw,
  })
  const session = await complete.json()
  if (!complete.ok) throw new Error(`auth/complete failed ${complete.status}: ${JSON.stringify(session)}`)
  const cookie = (complete.headers.get('set-cookie') ?? '').split(';')[0]
  if (!cookie) throw new Error('auth/complete returned no session cookie')
  console.log(`  session roles=${(session.roles ?? []).join(',')} permissions=${(session.permissions ?? []).join(',')}`)
  return cookie
}

/** Set by the entrypoint when the target is remote; empty on the dev stack. */
let sessionCookie = ''

/** NIP-98 (kind 27235) Authorization header over an exact URL + method + body. */
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

async function issue(merchant, { quantity, faceValueMinor, currency, memo }) {
  const url = `${PORTAL}/api/v1/portal/vouchers`
  const body = JSON.stringify({
    face_value_minor: faceValueMinor,
    currency,
    quantity,
    expiry_days: 90,
    memo,
  })

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Both paths are sent. Whichever the deployed portal build honours wins;
      // they agree on the pubkey, so there is no ambiguity about the issuer.
      Authorization: nip98(merchant.sk, url, 'POST', body),
      'X-Auth-Pubkey': merchant.pk,
      'X-Edge-Auth': EDGE_SECRET,
      // Issuance is now guarded by `coupon:issue` on the portal side, resolved
      // from the caller's NAP session and forwarded by the edge. This script IS
      // the edge here, and a seeded identity issues by definition, so it
      // asserts the permission the same way the proxy would. Without it every
      // seed run 403s on a request that used to be accepted.
      'X-Auth-Permissions': 'coupon:issue',
      ...(sessionCookie ? { cookie: sessionCookie } : {}),
    },
    body,
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`issue failed ${response.status}: ${text}`)
  }
  return JSON.parse(text)
}


/**
 * A voucher is not deliverable the moment it is created.
 *
 * Issuance returns PENDING with a bolt11 top-up invoice (the merchant starts with
 * 0 sats, so PROPORTIONAL backing takes the insufficient_balance_fallback path).
 * phoenixd-mock auto-settles it ~2s later, and only then does the voucher carry
 * a real Cashu token. Sending before that would DM an empty token.
 *
 * Note `expires_at` is NOT a readiness signal — while PENDING it holds the
 * 60-second mint-quote deadline, and it stays null for ~5-10s after the voucher
 * already reports ISSUED. Poll on `token` presence instead.
 *
 * But do not deliver the instant the token appears either. `deliver` passes
 * `expires_at` straight into the DM, the gateway forwards only what it is given,
 * and that lag means the field is still null at that moment — so EVERY seeded
 * coupon reached the wallet expiry-less, and the wallet's expiry rendering could
 * never be exercised against real data. After ISSUED we spend a bounded extra
 * wait on the real expiry: present, and far enough out to distinguish it from
 * the mint-quote deadline the PENDING record was carrying. It is a best-effort
 * wait — a gateway issuing genuinely no-expiry vouchers must still seed.
 */
/**
 * The voucher read-back is edge-guarded on staging.
 *
 * `NapProxyAuthFilter` on customer-wallet wants `X-Auth-Pubkey` +
 * `X-Edge-Auth` (`GATEWAY_CUSTOMER_EDGE_SHARED_SECRET`, the same value the
 * portal uses). Without them the poll 401s on every attempt and the run dies
 * with `status=undefined`, which reads as "the voucher never settled" when in
 * fact it was never readable. The dev stack ignores the extra headers.
 */
function walletAuth(url) {
  return {
    'X-Auth-Pubkey': merchant.pk,
    'X-Edge-Auth': EDGE_SECRET,
    // On staging the edge does not inject NIP-98 for us and
    // CustomerSecurityConfiguration protects /api/v1/wallet with it, so a
    // header-only read gets 401 and the poll reports "never settled".
    ...(url ? { Authorization: nip98(merchant.sk, url, 'GET') } : {}),
    ...(sessionCookie ? { cookie: sessionCookie } : {}),
  }
}

async function waitForToken(voucherId, timeoutMs = 60_000, expiryGraceMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last = {}
  while (Date.now() < deadline) {
    const url = `${WALLET}/api/v1/wallet/vouchers/${voucherId}`
    const r = await fetch(url, { headers: walletAuth(url) })
    if (r.ok) {
      last = await r.json()
      if (last.token && last.status === 'ISSUED') {
        return waitForExpiry(voucherId, last, Date.now() + expiryGraceMs)
      }
    }
    await new Promise((res) => setTimeout(res, 2000))
  }
  throw new Error(
    `voucher ${voucherId} never produced a token ` +
      `(status=${last.status} payment_state=${last.payment_state})`,
  )
}

/** Re-read until `expires_at` settles on the issued value, or the grace runs out. */
async function waitForExpiry(voucherId, issued, deadline) {
  let last = issued
  while (Date.now() < deadline) {
    const seconds = toEpochSeconds(last.expires_at)
    // An hour out clears the 60-second mint-quote deadline by a wide margin
    // without assuming the issuer's expiry_days.
    if (seconds && seconds * 1000 > Date.now() + 3_600_000) return last
    await new Promise((res) => setTimeout(res, 2000))
    const url = `${WALLET}/api/v1/wallet/vouchers/${voucherId}`
    const r = await fetch(url, { headers: walletAuth(url) })
    if (r.ok) last = await r.json()
  }
  return last
}

/**
 * Deliver a coupon as a NIP-17 gift-wrapped DM.
 *
 * The gateway does the wrapping, not this script. TokenDmTransferAdapter builds
 * the kind-1059 gift wrap in exactly the shape the receive pipeline parses, so
 * hand-rolling it here would only risk drifting from that format.
 *
 * The DM is signed by the gateway's own identity rather than the merchant's — but
 * merchant attribution rides on `issuer_id` inside the payload (which is also what
 * the wallet groups by), not on who signed the envelope.
 */
/**
 * Epoch seconds, whatever the gateway returned.
 *
 * The voucher record's expires_at has been seen as both an ISO-8601 string and
 * a number, and the number itself could be seconds or milliseconds. Sending
 * milliseconds where seconds are expected dates a coupon to the year 58000;
 * sending an ISO string fails Jackson's Long binding outright. Same 1e11
 * magnitude test the wallet uses.
 */
function toEpochSeconds(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.floor(value > 1e11 ? value / 1000 : value) : null
  }
  const ms = Date.parse(String(value))
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

async function deliver(voucher, merchant, customerPubkey) {
  // The DM leg is skippable when the point is to hand the token over by other
  // means — pasting it into a wallet's Receive box, say, when gateway-customer's
  // nostr query is dropping wraps and the DM never arrives.
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
      issuer_id: merchant.pk,
      sender_pubkey: merchant.pk,
      // SendTokenDmRequest declares `@JsonProperty("expires_at") Long` — epoch
      // SECONDS as a number. The gateway only forwards what the sender supplies
      // (TokenDmController:132 is a straight `request.expiresAt()` passthrough),
      // so omitting it here is why every received coupon had a blank expiry.
      expires_at: toEpochSeconds(voucher.expires_at),
      relay_urls: [INTERNAL_RELAY],
  })

  // Unlike voucher creation, this endpoint enforces NIP-98.
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: nip98(merchant.sk, url, 'POST', body),
      ...(sessionCookie ? { cookie: sessionCookie } : {}),
    },
    body,
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`deliver failed ${r.status}: ${text}`)
  return JSON.parse(text)
}

/**
 * Publish the shop's kind-0 profile to the relay.
 *
 * Without this the wallet has no name, avatar or `about` for the issuer, and
 * `lib/branding.ts` falls back to `EMPTY_BRANDING` — every voucher then renders
 * under a truncated pubkey and the default "Gift Card" title. Seeded vouchers
 * looked broken for exactly this reason. It is published straight to the relay,
 * not through the gateway, because that is where the wallet writes profiles and
 * where `fetchNewestKind0` falls back to when the nostrdb cache is cold.
 */
async function publishProfile(shop, about, picture) {
  const { SimplePool, useWebSocketImplementation } = await import('nostr-tools/pool')
  const { default: WebSocket } = await import('ws')
  useWebSocketImplementation(WebSocket)

  const pool = new SimplePool()
  try {
    const event = finalizeEvent(
      {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        // `picture` is omitted rather than sent empty: the wallet treats the key
        // being absent as "fall back to initials", and an empty string as a URL
        // to load, which is a broken image where a monogram belongs.
        content: JSON.stringify({
          name: shop.name,
          display_name: shop.name,
          about,
          ...(picture ? { picture } : {}),
        }),
      },
      shop.sk,
    )
    await Promise.any(pool.publish([RELAY], event))
    return event.id
  } finally {
    pool.close([RELAY])
  }
}

/**
 * Count kind-1059 gift wraps addressed to the customer, straight off the relay.
 *
 * The `ws` polyfill is load-bearing, not incidental. Node 20 has no global
 * WebSocket, and without it SimplePool fails with "WebSocket is not defined"
 * inside a promise that `publish()` reports as *fulfilled* — so every query
 * silently returns 0 and delivery looks broken when it is not. Do not drop it
 * until this runs on Node 22+.
 */
async function countGiftWraps(customerPubkey) {
  const { SimplePool, useWebSocketImplementation } = await import('nostr-tools/pool')
  const { default: WebSocket } = await import('ws')
  useWebSocketImplementation(WebSocket)

  const pool = new SimplePool()
  try {
    const events = await pool.querySync([RELAY], { kinds: [1059], '#p': [customerPubkey] })
    return events.length
  } finally {
    pool.close([RELAY])
  }
}

// ---------------------------------------------------------------- entrypoint

const name = arg('--name', 'Rosa Green Farm')
const quantity = Number(arg('--quantity', '3'))
const faceValueMinor = Number(arg('--face', '500'))
const currency = arg('--currency', 'EUR')
const memo = arg('--memo', `${name} — voucher`)
const about = arg('--about', '')
// A hosted URL, not a file — kind-0 carries a link. Upload the image first
// (Blossom is at :28089) and pass what the server hands back.
const picture = arg('--picture', '')

const merchant = loadOrCreateMerchant(name)
// `--issuer-pubkey` attributes the coupons to a merchant that already exists in
// the app. The portal reads the issuer from X-Auth-Pubkey and the DM payload
// carries `issuer_id`, so neither needs that merchant's secret key — this
// script still signs as itself, which is all the NIP-98 check asks for.
const issuerPubkey = arg('--issuer-pubkey', '')
if (issuerPubkey) merchant.pk = issuerPubkey
// `--customer-pubkey` delivers to an account that already exists — one
// registered in the wallet itself — instead of minting a throwaway identity
// here. That is the only way to seed the app you are actually looking at, and
// it keeps a real nsec out of the terminal, which is the reason it exists.
const customerPubkey = arg('--customer-pubkey', '')
const customer = customerPubkey
  ? { pk: customerPubkey, sk: null }
  : loadOrCreateMerchant(arg('--customer', 'demo-customer'))

console.log(`merchant    ${issuerPubkey ? `existing issuer (signed by ${name})` : name}`)
console.log(`  pubkey  ${merchant.pk}`)
console.log(`customer  ${nip19.npubEncode(customer.pk)}`)
console.log(`  pubkey  ${customer.pk}`)
if (customer.sk) {
  console.log(`  nsec    ${nip19.nsecEncode(customer.sk)}   <- import into your NIP-07 extension`)
}
if (!PORTAL.includes('localhost')) {
  console.log(`\nlogging in at ${PORTAL}`)
  sessionCookie = await napLogin(PORTAL, merchant.sk)
}

console.log(`\nissuing ${quantity} x ${faceValueMinor / 100} ${currency}\n`)

const before = await countGiftWraps(customer.pk)

// Before issuing, not after: the wallet renders a voucher the moment the DM
// lands, and a profile that arrives later leaves the first render showing a
// truncated pubkey.
// A merchant that already exists in the app published their own kind-0; ours
// would be signed by the wrong key and would not replace it.
if (issuerPubkey) {
  console.log('profile   published by the issuer already')
} else {
  console.log(`profile   kind-0 ${(await publishProfile(merchant, about, picture)).slice(0, 12)}…`)
}

const { items } = await issue(merchant, {
  quantity,
  faceValueMinor,
  currency,
  memo,
})
console.log(`issued ${items.length}, waiting for Lightning settlement…`)

let delivered = 0
for (const item of items) {
  const voucher = await waitForToken(item.voucher_id)
  const result = await deliver(voucher, merchant, customer.pk)
  delivered += 1
  // Expiry is printed because it has bitten twice: the gateway populates it
  // asynchronously (null for ~5-10s after ISSUED), and a null here is the
  // difference between a coupon that shows an expiry date and one that does not.
  const expiry = toEpochSeconds(voucher.expires_at)
  console.log(
    `  ${voucher.voucher_id.slice(0, 8)} -> DM ${String(result.event_id ?? result.eventId ?? '').slice(0, 12)}…` +
      `  expires ${expiry ? new Date(expiry * 1000).toISOString().slice(0, 10) : 'NEVER (raw: ' + JSON.stringify(voucher.expires_at) + ')'}`,
  )
}

const after = await countGiftWraps(customer.pk)
console.log(`\ndelivered ${delivered}`)
console.log(`kind-1059 gift wraps on relay for customer: ${before} -> ${after}`)
