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
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha256'
import { secp256k1 } from '@noble/curves/secp256k1.js'
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

  /**
   * A device key must be a real x-only PUBLIC key, not 32 random bytes.
   *
   * Only about half of all 32-byte values are valid secp256k1 x-coordinates, so
   * `--device $(openssl rand -hex 32)` produced a credential the gateway could
   * not lock roughly half the time. It fell back to issuing UNLOCKED — which is
   * the correct, documented behaviour (a bad lock must not fail the sale) and
   * is logged as `lock_key_not_on_curve`.
   *
   * The effect was a fixture whose kind flickered between P2PK_VOUCHER and
   * VOUCHER run to run, which looked exactly like an intermittent gateway bug
   * and was entirely this script's doing. Refuse the key here instead, where
   * the cause is obvious.
   */
  //
  // `--allow-unlocked` is the ONE legitimate reason to pass a key that is not on
  // the curve: the witness probe needs an UNLOCKED control, and the only way to
  // get one from the real gateway is to trip its documented fallback. It must be
  // asked for explicitly, because silently issuing an unlocked credential is the
  // exact failure this check exists to make visible.
  const allowUnlocked = process.argv.includes('--allow-unlocked')
  try {
    if (!secp256k1.Point.fromHex('02' + device.toLowerCase())) throw new Error('bad')
  } catch {
    if (allowUnlocked) {
      console.log('WARNING --allow-unlocked: this key is off-curve, so the gateway')
      console.log('        will fall back to issuing an UNLOCKED voucher.')
    } else {
      throw new Error(
        `--device ${device.slice(0, 16)}… is not on the curve, so it is nobody's public key.\n` +
          'Pass a real x-only pubkey. To generate one:\n' +
          "  node -e \"import('nostr-tools').then(n=>console.log(n.getPublicKey(n.generateSecretKey())))\"\n" +
          'Or pass --allow-unlocked if you deliberately want the UNLOCKED fallback.',
      )
    }
  }

  const metadata = terminalMetadata({
    stallPubkey: stall.pk,
    role,
    lockKey: device,
    name,
  })

  console.log(`minting a ${role} credential for ${device.slice(0, 12)}… issued by ${stall.pk.slice(0, 12)}…`)
  const created = await mint(stall, metadata)
  const ready = await waitForToken(stall, created.voucher_id)

  const out = join(HERE, '..', 'src', 'lib', '__tests__', 'fixtures', arg('--out', 'live-terminal-credential.token'))
  writeFileSync(out, ready.token.trim() + '\n')
  console.log(`wrote ${out}`)

  /**
   * The keys this run chose, written BESIDE the token.
   *
   * The tests must know which device the credential was locked to, and the
   * first version of this pinned that hex in the test file. Re-minting the
   * fixture then broke three tests for no reason other than the key having
   * changed — the credential was perfectly good.
   *
   * This is deliberately NOT read back out of the token. Deriving the expected
   * device from the bytes under test would make the assertion circular and it
   * would pass even if the gateway dropped the lock entirely. It records what
   * this script SENT, so the test still compares two independent things.
   */
  const sidecar = out.replace(/\.token$/, '.json')
  writeFileSync(sidecar, JSON.stringify({ stall: stall.pk, device, role, name }, null, 2) + '\n')
  console.log(`wrote ${sidecar}`)
  console.log(`issuer ${stall.pk}`)
  console.log(`locked to ${device}`)
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
