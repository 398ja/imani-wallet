#!/usr/bin/env node
/**
 * Make the pool's stalls trade, so a run can measure acquiring.
 *
 *   node loadtest/stalls.mjs --count 10            # enrol, or top up to 10
 *   node loadtest/stalls.mjs --count 10 --verify   # and check each can issue
 *
 * ## Why this exists
 *
 * A pool identity is a CUSTOMER. Its NAP session carries
 * `coupon:pay,coupon:receive`, and the portal answers `403 Insufficient
 * permissions` to any attempt to issue. So the acquiring half of the customer
 * behaviour in `market-day.js` never ran, and every run said so in its summary.
 *
 * A stall is not a different kind of account. It is a key that has PUBLISHED A
 * STALL RECORD: a kind-30078 addressable event tagged `d=imani:merchant`, which
 * is the same self-published record a stall owner's phone writes when they set
 * up their business. gateway-core derives the session's role from it
 * (`compose.override.yml`: "derives the role from the caller's kind-30078
 * `d=imani:merchant` stall record"), and the session then carries
 * `coupon:issue,coupon:pay,coupon:redeem,coupon:receive`.
 *
 * So enrolling a stall for a load run is not a special back door. It is the
 * ordinary thing a stall owner does, performed by script.
 *
 * ## What was tried first, and why it was wrong
 *
 * A terminal credential (ADR 0005), minted by
 * `scripts/mint-terminal-credential.mjs`. That is the mechanism for giving a
 * SECOND DEVICE authority to act for a stall that already exists, and it was
 * the wrong tool for making a stall exist at all: it is more machinery, it
 * needs a mint quote that staging currently answers with
 * `mint_error_code=90008`, and terminal enrolment is not yet wired to any
 * screen (`.scratch/terminals/OUTSTANDING.md`).
 *
 * The owner's own phone never mints a terminal credential to sell. Neither
 * does this.
 *
 * ## The ACL is not immediate
 *
 * Publishing is not enough on its own: the record has to reach the gateway and
 * the ACL has to resolve it. MEASURED against staging on 2026-09-23: a session
 * opened ~5s after publishing still carried customer permissions, while one
 * opened ~90s later carried `coupon:issue` and issuance answered 201. So this
 * polls the permissions rather than sleeping a guessed interval, and reports
 * how long each stall took.
 */

import { finalizeEvent } from 'nostr-tools/pure'
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes, hexToBytes } from '@noble/hashes/utils.js'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

useWebSocketImplementation(WebSocket)

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const POOL_FILE = join(ROOT, '.loadtest-pool.json')

function arg(flag, fallback) {
  const i = process.argv.indexOf(`--${flag}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const COUNT = Number(arg('count', '10'))
const VERIFY = process.argv.includes('--verify')
const GATEWAY = (process.env.GATEWAY_URL ?? 'http://localhost:28082').replace(/\/$/, '')
const PORTAL = (process.env.PORTAL_URL ?? GATEWAY).replace(/\/$/, '')
const CURRENCY = process.env.CURRENCY ?? 'EUR'

/** The stall's `merchant` issuance warrant for one sale, as src/lib/warrantSigner.ts signs it. */
function merchantWarrant(stall, saleTotalMinor, unit) {
  const faceDecimals = new Intl.NumberFormat('en', { style: 'currency', currency: unit }).resolvedOptions().maximumFractionDigits
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  const preimage = [stall.pubHex, String(saleTotalMinor), String(faceDecimals), unit, nonce].join('\u001f')
  const sig = bytesToHex(schnorr.sign(sha256(utf8ToBytes(preimage)), hexToBytes(stall.privHex)))
  return JSON.stringify({ form: 'merchant', sale_total: saleTotalMinor, face_decimals: faceDecimals, unit, nonce, sig })
}
const VALIDITY_DAYS = Number(process.env.VOUCHER_VALIDITY_DAYS ?? '90')

/** How long to wait for the ACL to notice a new stall record. */
const ACL_TIMEOUT_MS = Number(process.env.ACL_TIMEOUT_MS ?? '180000')
const ACL_POLL_MS = 10_000

/**
 * The relay to publish to.
 *
 * Read from the deployment's own `/api/v1/config` rather than guessed, because
 * a stall record published to the wrong relay is invisible to the ACL and the
 * failure looks identical to the ACL not working.
 */
async function relayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL
  const res = await fetch(`${GATEWAY}/api/v1/config`)
  if (!res.ok) {
    throw new Error(
      `could not read ${GATEWAY}/api/v1/config to find the relay (${res.status}).\n` +
        '  Set RELAY_URL explicitly if this deployment does not serve config.',
    )
  }
  const config = await res.json()
  if (!config.relay_url) throw new Error('the deployment config named no relay_url')
  return config.relay_url
}

/**
 * Open a NAP session and report what it may do.
 *
 * This is the wallet's own login, performed without a browser: `/auth/init`
 * returns a challenge, a kind-27235 event signs it, `/auth/complete` returns
 * the session cookie. The README used to say a script could never obtain one,
 * which was wrong, and this is the counter-example.
 */
async function napSession(identity) {
  const init = await fetch(`${GATEWAY}/api/v1/auth/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ npub: identity.npub }),
  })
  if (!init.ok) return { error: `auth/init ${init.status}` }
  const challenge = await init.json()

  const body = JSON.stringify({ challenge_id: challenge.challenge_id })
  const event = {
    pubkey: identity.pubHex,
    created_at: Math.floor(Date.now() / 1000),
    kind: 27235,
    tags: [
      ['u', challenge.auth_url],
      ['method', challenge.auth_method],
      ['payload', bytesToHex(sha256(utf8ToBytes(body)))],
      ['challenge', challenge.challenge],
      ['challenge_id', challenge.challenge_id],
    ],
    content: '',
  }
  const id = bytesToHex(
    sha256(
      utf8ToBytes(
        JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]),
      ),
    ),
  )
  event.id = id
  event.sig = bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(identity.privHex)))

  // `auth_url` names the account host, which on staging is a name that does
  // NOT resolve from outside (account.staging.398ja.xyz is NXDOMAIN). Every
  // tier answers on the wallet host by path, so the path is what matters and
  // the host is replaced. Verified: completing at the wallet host returns 200.
  const url = challenge.auth_url.replace(/^https?:\/\/[^/]+/, GATEWAY)
  const complete = await fetch(url, {
    method: challenge.auth_method,
    headers: {
      'content-type': 'application/json',
      authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`,
    },
    body,
  })
  if (!complete.ok) return { error: `auth/complete ${complete.status}` }

  const cookie = (complete.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ')
  const validate = await fetch(`${GATEWAY}/api/v1/auth/validate`, { headers: { cookie } })
  return {
    cookie,
    permissions: (validate.headers.get('x-auth-permissions') ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  }
}

/** The stall record a phone would publish, and the same one this publishes. */
function stallEvent(identity, index) {
  const content = JSON.stringify({
    active: true,
    categories: ['loadtest'],
    issuanceCurrency: CURRENCY,
    voucherValidityDays: VALIDITY_DAYS,
    businessType: 'market stall',
    storeDescription: `Load test stall ${String(index).padStart(4, '0')}`,
  })
  return finalizeEvent(
    {
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', 'imani:merchant']],
      content,
    },
    hexToBytes(identity.privHex),
  )
}

async function canIssue(identity) {
  const session = await napSession(identity)
  if (session.error) return { trading: false, why: session.error }
  return {
    trading: session.permissions.includes('coupon:issue'),
    permissions: session.permissions,
    cookie: session.cookie,
  }
}

async function main() {
  if (!existsSync(POOL_FILE)) {
    throw new Error(`no ${POOL_FILE}; run \`node loadtest/pool.mjs --size 140\` first`)
  }
  const pool = JSON.parse(readFileSync(POOL_FILE, 'utf8'))
  const identities = Object.values(pool).sort((a, b) => a.index - b.index)

  if (identities.length < COUNT) {
    throw new Error(
      `the pool holds ${identities.length} identities and ${COUNT} stalls were asked for.\n` +
        `  Run: node loadtest/pool.mjs --size ${COUNT + 130}`,
    )
  }

  // The FIRST COUNT identities, matching how market-day.js splits the pool:
  // stalls from the top, customers below them. A different split here would
  // enrol keys the run never uses as stalls.
  const stalls = identities.slice(0, COUNT)

  console.log(`gateway  ${GATEWAY}`)
  console.log(`stalls   ${COUNT} (pool indices 0-${COUNT - 1})`)

  const already = []
  const toEnrol = []
  for (const stall of stalls) {
    const state = await canIssue(stall)
    if (state.trading) already.push(stall)
    else toEnrol.push(stall)
  }

  console.log(`trading  ${already.length} already, ${toEnrol.length} to enrol`)

  if (toEnrol.length === 0) {
    console.log('\nnothing to do; every stall can already issue')
    if (VERIFY) await verify(stalls)
    return
  }

  const url = await relayUrl()
  console.log(`relay    ${url}`)

  const relay = await Relay.connect(url)
  for (const stall of toEnrol) {
    const event = stallEvent(stall, stall.index)
    await relay.publish(event)
    console.log(`  published stall record for #${String(stall.index).padStart(4, '0')}`)
  }
  relay.close()

  // Poll rather than sleep. The delay is real but not fixed, and a guessed
  // interval either wastes a minute or reports a failure that was only
  // earliness. MEASURED on staging: ~5s was too early, ~90s was enough.
  console.log(`\nwaiting for the ACL to resolve them (up to ${ACL_TIMEOUT_MS / 1000}s)`)
  const started = Date.now()
  const pending = new Set(toEnrol.map((s) => s.index))

  // The last thing each pending stall reported, so a timeout can say WHY.
  // Without this the failure is only "still cannot issue", which reads like a
  // slow ACL no matter what actually happened. The distinction that matters:
  // an empty permission list means the session is fine and the merchant record
  // has not resolved yet, whereas customer permissions without `coupon:issue`
  // means it resolved and decided against issuing, and a `why` means the login
  // never completed and the ACL is not involved at all. Those have different
  // causes and only the first is worth waiting longer for.
  const lastSeen = new Map()

  while (pending.size > 0 && Date.now() - started < ACL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, ACL_POLL_MS))
    for (const stall of toEnrol) {
      if (!pending.has(stall.index)) continue
      const state = await canIssue(stall)
      lastSeen.set(stall.index, state)
      if (state.trading) {
        pending.delete(stall.index)
        const seconds = ((Date.now() - started) / 1000).toFixed(0)
        console.log(`  #${String(stall.index).padStart(4, '0')} is trading after ${seconds}s`)
      }
    }
  }

  if (pending.size > 0) {
    const detail = [...pending]
      .map((index) => {
        const state = lastSeen.get(index) ?? {}
        if (state.why) return `  #${String(index).padStart(4, '0')} login failed: ${state.why}`
        const granted = state.permissions?.length ? state.permissions.join(',') : '(none)'
        return `  #${String(index).padStart(4, '0')} session ok, permissions: ${granted}`
      })
      .join('\n')
    console.error(
      `\n${pending.size} stall(s) still cannot issue after ${ACL_TIMEOUT_MS / 1000}s: ` +
        `${[...pending].join(', ')}\n${detail}\n` +
        '  The record is published either way, so this may simply be slower than the\n' +
        '  timeout. Re-run to check rather than publishing again.',
    )
    process.exitCode = 1
    return
  }

  console.log(`\nall ${toEnrol.length} enrolled`)
  if (VERIFY) await verify(stalls)
}

/**
 * Prove a stall can actually issue, rather than trusting the permission string.
 *
 * A permission is what the session CLAIMS; a 201 is the portal agreeing. These
 * came apart once already on this stack, where a registry image granted a flat
 * role and the portal refused every merchant anyway.
 */
async function verify(stalls) {
  console.log('\nverifying each stall can issue')
  let ok = 0
  for (const stall of stalls) {
    const session = await canIssue(stall)
    if (!session.trading) {
      console.error(`  #${String(stall.index).padStart(4, '0')} cannot issue: ${session.why ?? session.permissions}`)
      continue
    }
    const res = await fetch(`${PORTAL}/api/v1/portal/vouchers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookie },
      body: JSON.stringify({
        face_value_minor: 500,
        currency: CURRENCY,
        quantity: 1,
        expiry_days: VALIDITY_DAYS,
        memo: 'stall enrolment check',
        // The portal refuses a sale with no warrant (since 2026-11-05).
        issuance_warrant: merchantWarrant(stall, 500, CURRENCY),
      }),
    })
    const issued = res.status === 201 || res.status === 200
    console.log(`  #${String(stall.index).padStart(4, '0')} ${issued ? 'issued' : `FAILED ${res.status}`}`)
    if (issued) ok++
  }
  console.log(`\n${ok}/${stalls.length} stalls can issue`)
  if (ok !== stalls.length) process.exitCode = 1
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
