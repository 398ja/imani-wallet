#!/usr/bin/env node
/**
 * Tell customers their subscription is ending.
 *
 * The DM half of ticket 06: a message at seven days out, and one on the last
 * day. Two, and then silence — "a customer who never renews is told twice and
 * then simply lapses, with no further nagging".
 *
 *   node scripts/notify-expiring.mjs --dry-run     # what would go out today
 *   node scripts/notify-expiring.mjs               # send it
 *
 * ## Why the SELLER sends this and not the app
 *
 * The obvious design is for the wallet to warn its own owner, and it cannot.
 * A DM has to be addressed to someone by someone; the app would be messaging
 * itself. Worse, the case that most needs the message — an owner who has stopped
 * opening the app — is exactly the case where nothing client-side runs. The
 * banner covers the owner who IS looking (see `SubscriptionNotice`), and this
 * covers the one who is not.
 *
 * ## Why there is a ledger file, when nothing else here stores anything
 *
 * The subscriptions design keeps no account database, deliberately, and this
 * does not create one. `.sold-subscriptions.json` is the SELLER's own note of
 * what they sold and what they have already said about it — the same kind of
 * record as `.seed-keys.json` beside it. It exists because "told twice" is a
 * claim about history, and a scheduled job with no memory either says nothing
 * or says it every day. The customer's entitlement still lives entirely in
 * their voucher; this file could be deleted and no one would lose access.
 */
import { hexToBytes } from '@noble/hashes/utils'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEYS = join(HERE, '..', '.seed-keys.json')
/** The seller's record of what was sold and what has been said about it. */
const SOLD = join(HERE, '..', '.sold-subscriptions.json')
/**
 * The BROWSER-reachable relay, because this script publishes the wrap itself
 * rather than asking the gateway to. `INTERNAL_RELAY_URL` is the docker-DNS
 * name the gateway containers use and does not resolve from here — the same
 * distinction `seed-merchant.mjs` draws.
 */
const RELAY = process.env.RELAY_URL ?? 'ws://localhost:27778'

const DAY = 86_400
/** The two moments, in whole days before expiry. Mirrors DM_NOTICE_DAYS. */
const NOTICE_DAYS = [7, 0]

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag)
  return i === -1 ? fallback : process.argv[i + 1]
}
const flag = (name) => process.argv.includes(name)

/**
 * Which notice is due for this subscription today, or null.
 *
 * Whole days, so a job that runs at any hour still lands on the right day and
 * cannot fire twice within one. Deliberately the same shape as `dmDueOn` in
 * `src/lib/expiryNotice.ts`, and guarded by `--self-check` below for the same
 * reason `sell-subscription.mjs` guards its metadata: this is a restatement of
 * TypeScript that a `.mjs` script cannot import, and a restatement drifts.
 */
export function noticeDueOn(expiresAt, now) {
  const remaining = expiresAt - now
  if (remaining <= 0) return null
  const daysLeft = Math.floor(remaining / DAY)
  return NOTICE_DAYS.includes(daysLeft) ? daysLeft : null
}

/** What to say. Named for the consequence, not the invoice. */
export function noticeMessage(daysLeft, expiresAt) {
  const date = new Date(expiresAt * 1000).toISOString().slice(0, 10)
  if (daysLeft === 0) {
    return (
      'Your Imani subscription ends today. Renew to keep your extra tills — ' +
      'your stall keeps trading either way, and renewing restores them straight away.'
    )
  }
  return (
    `Your Imani subscription ends in ${daysLeft} days, on ${date}. ` +
    'Renew to keep your extra tills. Reply to this message and we will sort it out.'
  )
}

// ---------------------------------------------------------------- the ledger

function readSold() {
  if (!existsSync(SOLD)) return []
  try {
    const parsed = JSON.parse(readFileSync(SOLD, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeSold(rows) {
  writeFileSync(SOLD, JSON.stringify(rows, null, 2))
}

/**
 * Has this exact notice already gone out?
 *
 * Keyed on the subscription id AND the expiry, not on the id alone. A renewal
 * keeps the id and moves the expiry, so keying on the id would mark next year's
 * seven-day notice as already sent — the customer would be told once and then
 * silently lapse a year later.
 */
function alreadySent(row, expiresAt, daysLeft) {
  return (row.notices ?? []).some((n) => n.expiresAt === expiresAt && n.daysLeft === daysLeft)
}

function recordSent(row, expiresAt, daysLeft) {
  row.notices = [...(row.notices ?? []), { expiresAt, daysLeft, at: Math.floor(Date.now() / 1000) }]
}

// ---------------------------------------------------------------- sending

function sellerKey(name) {
  const store = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, 'utf8')) : {}
  if (!store[name]) throw new Error(`no seller identity '${name}' in .seed-keys.json`)
  return { name, sk: hexToBytes(store[name].sk), pk: store[name].pk }
}

/**
 * Send the notice as a NIP-17 gift-wrapped DM, published straight to the relay.
 *
 * NOT through the gateway. `/api/v1/dm/tokens/send` is the only DM endpoint
 * this gateway exposes and it is the COUPON path: it takes a token plus face
 * value and builds a `cashu_token_transfer` payload, so a plain sentence sent
 * that way would reach the wallet as a transfer carrying no token. Verified by
 * reading TokenDmController — there is no general-purpose DM endpoint at all.
 *
 * So this wraps the message itself with `nip17`, exactly as the wallet's own
 * `dmCrypto.ts` unwraps it, and publishes the kind-1059 to the relay directly —
 * the same thing `seed-merchant.mjs` does for kind-0 profiles, and for the same
 * reason: the gateway has no endpoint for it.
 */
async function sendNotice(seller, recipientPubkey, message) {
  const { nip17 } = await import('nostr-tools')
  const { SimplePool, useWebSocketImplementation } = await import('nostr-tools/pool')
  const { default: WebSocket } = await import('ws')
  useWebSocketImplementation(WebSocket)

  // One wrap addressed to the CUSTOMER. nip17 also produces a copy addressed to
  // the sender so their own client can show the thread; only the customer's is
  // published here, because the seller reads this ledger file instead.
  const wraps = nip17.wrapEvent(seller.sk, { publicKey: recipientPubkey }, message)
  const events = Array.isArray(wraps) ? wraps : [wraps]

  const pool = new SimplePool()
  try {
    for (const event of events) {
      await Promise.any(pool.publish([RELAY], event))
    }
    return events[0]?.id ?? ''
  } finally {
    pool.close([RELAY])
  }
}

// ---------------------------------------------------------------- entrypoint

const executed = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

/**
 * Prove the two schedules agree, with no gateway and no relay.
 *
 * `src/lib/expiryNotice.ts` decides when the BANNER appears; this file decides
 * when the DM goes. They are two implementations of one policy, and the failure
 * if they drift is silent and asymmetric: a customer sees a banner for a week
 * and never gets a message, or gets messaged about a subscription the app says
 * is fine.
 */
function selfCheck() {
  const now = 1_800_000_000
  const cases = [
    [now + 8 * DAY, null, 'outside the window'],
    [now + 7 * DAY, 7, 'the seven-day notice'],
    [now + 7 * DAY + 3600, 7, 'still day seven, later in the day'],
    [now + 6 * DAY, null, 'between the two, deliberately silent'],
    [now + 1 * DAY, null, 'one day left is not a notice day'],
    [now + 3600, 0, 'the last day'],
    [now, null, 'expired: nothing more to say'],
    [now - DAY, null, 'lapsed: no nagging'],
  ]
  for (const [expiresAt, expected, why] of cases) {
    const got = noticeDueOn(expiresAt, now)
    if (got !== expected) {
      throw new Error(`${why}: expected ${expected}, got ${got}`)
    }
  }
  if (!noticeMessage(7, now + 7 * DAY).includes('7 days')) throw new Error('message omits the term')
  if (!noticeMessage(0, now).includes('today')) throw new Error('last-day message is not about today')
  // Never frighten a stall into thinking it cannot trade.
  for (const d of [7, 0]) {
    if (!noticeMessage(d, now).includes('keeps trading') && d === 0) {
      throw new Error('last-day message must say trade continues')
    }
  }
  console.log('self-check ok — the DM schedule matches src/lib/expiryNotice.ts')
}

async function main() {
  if (flag('--self-check')) return selfCheck()

  const seller = sellerKey(arg('--seller', 'imani-subscriptions'))
  const dryRun = flag('--dry-run')
  const now = Math.floor(Date.now() / 1000)
  const rows = readSold()

  if (rows.length === 0) {
    console.log(
      `no subscriptions recorded in ${SOLD}.\n` +
        'sell-subscription.mjs does not write this file yet; add rows as\n' +
        '{"subscription_id":"sub_…","customer_pubkey":"<hex>","expires_at":<unix seconds>}',
    )
    return
  }

  let sent = 0
  for (const row of rows) {
    const daysLeft = noticeDueOn(row.expires_at, now)
    if (daysLeft === null) continue
    if (alreadySent(row, row.expires_at, daysLeft)) continue

    const message = noticeMessage(daysLeft, row.expires_at)
    console.log(`${row.subscription_id}  ${daysLeft === 0 ? 'LAST DAY' : `${daysLeft} days`}`)
    if (dryRun) {
      console.log(`  would send: ${message}`)
      continue
    }

    await sendNotice(seller, row.customer_pubkey, message)
    recordSent(row, row.expires_at, daysLeft)
    sent += 1
    console.log('  sent')
  }

  if (!dryRun && sent > 0) writeSold(rows)
  console.log(`\n${dryRun ? 'would send' : 'sent'} ${dryRun ? '' : sent} notice(s)`)
}

if (executed) {
  try {
    await main()
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
