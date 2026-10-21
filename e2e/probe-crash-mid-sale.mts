/**
 * A sale whose gateway is killed mid-swap must still reach the customer
 * (imani-gateway-customer#168).
 *
 * Two phases, because the gateway is killed and restarted between them by the
 * shell that runs this:
 *
 *   npx tsx e2e/probe-crash-mid-sale.mts sell  > sale.json   # create + poll; the shell kills the gateway
 *   npx tsx e2e/probe-crash-mid-sale.mts check sale.json      # after recovery: did the customer get it?
 *
 * `sell` issues a quote-backed coupon to a fresh customer key the way Sell
 * does: create with `recipient_pubkey`, register the recipient (best effort, a
 * gateway before #168 answers 404), then poll. The shell watches the gateway
 * log for `swap_with_custom_secret_success` and SIGKILLs it. The poll then
 * fails and `sell` stops, as the Sell screen gives up.
 *
 * `check` never polls the voucher (the screen gave up). It reads the relay
 * for gift wraps to the customer, unwraps them with the customer's key and
 * counts those carrying this voucher. One is the pass; zero is the bug; two
 * different tokens would be a double issue.
 */
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'
import { finalizeEvent, nip17 } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'

const WALLET = process.env.WALLET_URL ?? 'http://localhost:28082'
/** NIP-98 events are bound to the origin the stack's browser signs for (SEC-02). */
const SIGNED_BASE = process.env.NIP98_BASE ?? 'http://localhost:5177'
const RELAY = process.env.RELAY_URL ?? 'ws://localhost:27778'

function auth(sk: Uint8Array, path: string, method: string, body?: string): string {
  const tags = [['u', `${SIGNED_BASE}${path}`], ['method', method]]
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, sk)
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

async function call(sk: Uint8Array, path: string, method: string, payload?: unknown) {
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  const headers: Record<string, string> = { Authorization: auth(sk, path, method, body) }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return fetch(`${WALLET}${path}`, { method, headers, body })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function sell(): Promise<void> {
  const stallSk = secp256k1.utils.randomSecretKey()
  const stall = bytesToHex(schnorr.getPublicKey(stallSk))
  const customerSk = secp256k1.utils.randomSecretKey()
  const customer = bytesToHex(schnorr.getPublicKey(customerSk))

  const created = await call(stallSk, '/api/v1/wallet/vouchers', 'POST', {
    face_value: 700,
    face_unit: 'EUR',
    face_decimals: 2,
    backing_strategy: 'PROPORTIONAL',
    issuer_id: stall,
    memo: 'crash mid-sale probe #168',
    expires_in_days: 30,
    recipient_pubkey: customer,
  })
  const text = await created.text()
  if (!created.ok) throw new Error(`create ${created.status}: ${text.slice(0, 200)}`)
  const voucherId = (JSON.parse(text) as { voucher_id: string }).voucher_id

  const registered = await call(stallSk, `/api/v1/wallet/vouchers/${voucherId}/recipient`, 'PUT', {
    recipient_pubkey: customer,
  })
  console.error(`sale voucher=${voucherId.slice(0, 8)} recipient_registration=HTTP ${registered.status}`)
  // Written before polling, so the shell has it even if the poll dies with the gateway.
  console.log(JSON.stringify({ voucherId, stall, customer, customerSk: bytesToHex(customerSk) }))

  for (let i = 0; i < 30; i++) {
    try {
      const r = await call(stallSk, `/api/v1/wallet/vouchers/${voucherId}`, 'GET')
      if (r.ok) {
        const v = (await r.json()) as { status?: string; token?: string }
        console.error(`poll ${i} HTTP 200 status=${v.status} token=${v.token ? 'present' : 'absent'}`)
        if (v.token && v.status === 'ISSUED') {
          console.error('poll got the token before the kill: the live path delivered, rerun')
          return
        }
      } else {
        console.error(`poll ${i} HTTP ${r.status}`)
      }
    } catch (e) {
      console.error(`poll ${i} ${(e as Error).message}`)
    }
    await sleep(2000)
  }
  console.error('the Sell screen gives up after 60 s')
}

async function check(file: string): Promise<void> {
  const sale = JSON.parse(readFileSync(file, 'utf8')) as { voucherId: string; customer: string; customerSk: string }
  const sk = hexToBytes(sale.customerSk)
  const tokens: string[] = []
  let wraps = 0
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(RELAY)
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'c', { kinds: [1059], '#p': [sale.customer] }])))
    ws.on('message', (data) => {
      const m = JSON.parse(String(data))
      if (m[0] === 'EVENT') {
        wraps++
        try {
          const rumor = nip17.unwrapEvent(m[2], sk)
          const payload = JSON.parse(rumor.content) as { voucher_id?: string; token?: string }
          if (payload.voucher_id === sale.voucherId && payload.token) tokens.push(payload.token)
        } catch {
          // Not for this probe.
        }
      }
      if (m[0] === 'EOSE') {
        ws.close()
        resolve()
      }
    })
    setTimeout(() => resolve(), 15000)
  })
  const distinct = new Set(tokens.map((t) => bytesToHex(sha256(new TextEncoder().encode(t))).slice(0, 32)))
  console.log(JSON.stringify({
    voucher: sale.voucherId.slice(0, 8),
    customer: sale.customer.slice(0, 8),
    gift_wraps_to_customer: wraps,
    dms_carrying_this_voucher: tokens.length,
    distinct_token_fingerprints: [...distinct],
  }))
  const pass = tokens.length >= 1 && distinct.size === 1
  console.log(pass ? 'PASS the customer received the voucher, one token' : 'FAIL the customer did not receive the voucher')
  process.exit(pass ? 0 : 1)
}

const [phase, file] = process.argv.slice(2)
if (phase === 'sell') await sell()
else if (phase === 'check') await check(file)
else {
  console.error('usage: probe-crash-mid-sale.mts sell | check <sale.json>')
  process.exit(2)
}
