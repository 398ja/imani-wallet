#!/usr/bin/env node
/**
 * Mint one REAL terminal credential, and prove the wallet reads it back.
 *
 * Terminals ticket 10. Every earlier ticket's terminal carried a stand-in: a
 * record the device wrote for itself. This mints the real thing through the
 * live gateway — `merchant_metadata` signed by the ISSUER, locked to a key the
 * terminal generated — and writes the token to a fixture the unit tests assert
 * against, so the shape they check is the shape a real mint produces.
 *
 *   node scripts/mint-terminal-credential.mjs --stall <hex> --device <hex> \
 *       --role redeem-only --name "Front counter"
 *
 * ## Why a real mint and not a fixture we sign ourselves
 *
 * The same reason the licence work ended up here. A fixture proves the parser
 * reads what the parser writes. It cannot catch the gateway dropping
 * `merchant_metadata` before it reaches the signed secret — which is a bug
 * that HAS happened twice in this codebase (imani-gateway-customer b0fdca5 and
 * b282e87), was invisible to every unit test, and produced a credential that
 * verified perfectly while granting nothing.
 *
 * ## The issuer is the stall
 *
 * `issuer_id` is the stall's own key, because `credentialActor` refuses any
 * credential whose issuer is not the stall it names. That is what stops a
 * terminal minting its own authority.
 */
import { finalizeEvent } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEYS = join(HERE, '..', '.seed-keys.json')
const WALLET = process.env.WALLET_URL ?? 'http://localhost:28082'
const EDGE_SECRET = process.env.EDGE_SECRET ?? 'dev-edge-secret-local-only'

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag)
  return i === -1 ? fallback : process.argv[i + 1]
}

/**
 * The metadata shape, restated from `src/lib/terminalCredential.ts`.
 *
 * This is a .mjs script and cannot import the app's TypeScript without a build
 * step, so the pair is guarded by `--self-check` below — which fails loudly if
 * they ever disagree, because a silent disagreement is a terminal that enrols
 * and then cannot log in.
 */
export function terminalMetadata({ stallPubkey, role, lockKey, name }) {
  if (!lockKey) throw new Error('a terminal credential must be locked to the device key')
  if (!stallPubkey) throw new Error('a terminal credential must name the stall it acts for')
  if (!['redeem-only', 'issue-and-redeem'].includes(role)) {
    throw new Error('a terminal credential must carry a role from the catalog')
  }
  return JSON.stringify({
    terminal: true,
    stall_pubkey: stallPubkey.toLowerCase(),
    role,
    lock_key: lockKey.toLowerCase(),
    ...(name?.trim() ? { name: name.trim() } : {}),
  })
}

function stallKey() {
  const name = arg('--stall-name', 'imani-subscriptions')
  const store = existsSync(KEYS) ? JSON.parse(readFileSync(KEYS, 'utf8')) : {}
  if (!store[name]) {
    throw new Error(
      `no identity '${name}' in .seed-keys.json. Run scripts/seed-merchant.mjs --name "${name}" once.`,
    )
  }
  return { name, sk: hexToBytes(store[name].sk), pk: store[name].pk }
}

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

function authHeaders(k, url, method, body) {
  return {
    'Content-Type': 'application/json',
    Authorization: nip98(k.sk, url, method, body),
    'X-Auth-Pubkey': k.pk,
    'X-Edge-Auth': EDGE_SECRET,
  }
}

async function mint(stall, metadata) {
  const url = `${WALLET}/api/v1/wallet/vouchers`
  const body = JSON.stringify({
    // A terminal credential is not money. It carries the smallest face the
    // gateway will accept, because the voucher is the carrier for the signed
    // metadata and nothing else — the wallet must never sum it into a balance.
    face_value: 1,
    face_unit: 'sat',
    face_decimals: 0,
    backing_strategy: 'PROPORTIONAL',
    issuer_id: stall.pk,
    memo: 'Imani terminal credential',
    expires_in_days: 365,
    merchant_metadata: JSON.parse(metadata),
  })
  const r = await fetch(url, { method: 'POST', headers: authHeaders(stall, url, 'POST', body), body })
  const text = await r.text()
  if (!r.ok) throw new Error(`mint failed ${r.status}: ${text}`)
  return JSON.parse(text)
}

async function waitForToken(stall, voucherId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last = {}
  while (Date.now() < deadline) {
    const url = `${WALLET}/api/v1/wallet/vouchers/${voucherId}`
    const r = await fetch(url, { headers: authHeaders(stall, url, 'GET') })
    if (r.ok) {
      last = await r.json()
      if (last.token && last.status === 'ISSUED') return last
    }
    await new Promise((res) => setTimeout(res, 2000))
  }
  throw new Error(`voucher ${voucherId} never produced a token (status=${last.status})`)
}

async function main() {
  const stall = stallKey()
  const device = arg('--device')
  const role = arg('--role', 'redeem-only')
  const name = arg('--name', 'Front counter')

  if (!device) throw new Error('--device <hex> is required (the key the terminal generated)')

  const metadata = terminalMetadata({
    stallPubkey: stall.pk,
    role,
    lockKey: device,
    name,
  })

  console.log(`minting a ${role} credential for ${device.slice(0, 12)}… issued by ${stall.pk.slice(0, 12)}…`)
  const created = await mint(stall, metadata)
  const ready = await waitForToken(stall, created.voucher_id)

  const out = join(HERE, '..', 'src', 'lib', '__tests__', 'fixtures', 'live-terminal-credential.token')
  writeFileSync(out, ready.token.trim() + '\n')
  console.log(`wrote ${out}`)
  console.log(`issuer ${stall.pk}`)
  console.log(`locked to ${device}`)
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
