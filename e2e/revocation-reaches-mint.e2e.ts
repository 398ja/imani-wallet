/**
 * Does the owner's revoke button actually revoke?
 *
 * The acceptance path for the finding in .scratch/api-coverage/ASSESSMENT.md.
 * There is a jsdom suite for this already (`ownerRevocationGap.test.ts`), but
 * it decides the question by calling `loginTerminal` with `unspent: true` — a
 * value the test supplies. That is exactly the substitution these probes exist
 * to avoid: it assumes the answer it is trying to establish.
 *
 * This asks the LIVE MINT instead, about a credential a REAL gateway minted,
 * after clicking Revoke in a REAL browser:
 *
 *   1. mint a terminal credential through the gateway
 *   2. seed it on the owner's roster and open the terminals screen
 *   3. click through the real two-step Revoke confirmation
 *   4. ask the mint (NUT-07 checkstate) whether the proof is still UNSPENT
 *
 * If step 4 says UNSPENT, the credential is still good and the owner's
 * revocation reached nothing that can refuse a login.
 *
 * NUT-07 is a READ. It does not spend the credential, which is why this can
 * run repeatedly and why it is the right question to ask — proven separately
 * by `probe-spend.mts`.
 *
 *   MINT_URL=http://localhost:27777 npx tsx e2e/revocation-reaches-mint.e2e.ts
 */
import { chromium } from 'playwright'
import { registerMerchant } from './register.mts'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

import { tokenProofs, proofSecrets, parseVoucherToken } from '../src/lib/voucherToken'

const APP = process.env.APP_URL ?? 'http://localhost:5177'
const MINT = process.env.MINT_URL ?? 'http://localhost:27777'

let failures = 0
function check(what: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** NUT-00 hash_to_curve, to compute a proof's `Y` for checkstate. */
function hashToCurve(message: Uint8Array): InstanceType<typeof secp256k1.Point> {
  const DOMAIN = new TextEncoder().encode('Secp256k1_HashToCurve_Cashu_')
  const msgHash = sha256(new Uint8Array([...DOMAIN, ...message]))
  for (let counter = 0; counter < 2 ** 16; counter++) {
    const c = new Uint8Array(4)
    new DataView(c.buffer).setUint32(0, counter, true)
    const hash = sha256(new Uint8Array([...msgHash, ...c]))
    try {
      return secp256k1.Point.fromHex(bytesToHex(new Uint8Array([0x02, ...hash])))
    } catch { /* not on curve; next counter */ }
  }
  throw new Error('no valid point')
}

/** What the mint says about this credential right now. */
async function mintStates(token: string): Promise<string[]> {
  const Ys = proofSecrets(token).map((s) =>
    hashToCurve(new TextEncoder().encode(s)).toHex(true),
  )
  const r = await fetch(`${MINT}/v1/checkstate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Ys }),
  })
  const body = (await r.json()) as { states?: Array<{ state?: string }> }
  return (body.states ?? []).map((s) => s.state ?? 'UNKNOWN')
}

console.log('Minting a real terminal credential through the gateway')
const device = (() => {
  // A real x-only pubkey. Random bytes are only ~50% on-curve, and an
  // off-curve key makes the gateway issue UNLOCKED, which would quietly
  // change what this probe is testing.
  for (;;) {
    const k = bytesToHex(secp256k1.utils.randomSecretKey())
    try { secp256k1.Point.fromHex('02' + k); return k } catch { /* retry */ }
  }
})()

execFileSync('node', [
  'scripts/mint-terminal-credential.mjs', '--stall-name', 'imani-terminals',
  '--device', device, '--name', 'Front counter', '--out', 'revocation-probe.token',
], { stdio: 'pipe' })

const TOKEN = readFileSync('src/lib/__tests__/fixtures/revocation-probe.token', 'utf8').trim()
console.log(
  `  credential for ${device.slice(0, 12)}… issued by ` +
    `${parseVoucherToken(TOKEN).voucher.issuerId.slice(0, 12)}…`,
)

const before = await mintStates(TOKEN)
check('the fresh credential is UNSPENT at the mint', before.every((s) => s === 'UNSPENT'), before.join(','))
check('it is one proof', tokenProofs(TOKEN).length === 1)

const browser = await chromium.launch()
const page = await browser.newPage()
const pageErrors: string[] = []
page.on('pageerror', (e) => pageErrors.push(e.message))

/**
 * Register a real stall first.
 *
 * The roster is keyed on the stall's own pubkey, and the terminals screen only
 * renders for a logged-in owner. Seeding storage without registering produced
 * an empty screen and a 30s timeout on a button that was never going to exist —
 * the app was working correctly and the probe was wrong.
 */
console.log('\nA real merchant registers against the live gateway')
const handle = await registerMerchant(page, APP)
/**
 * The stall pubkey, read from the KEY of a namespaced entry.
 *
 * Not from a key containing "pub": no such entry exists. The app namespaces by
 * pubkey in the key itself — `imani-wallet:merchant:<64 hex>` — and a first
 * attempt looking for "pub" silently returned '' and produced an empty
 * terminals screen, which read as a broken app rather than a broken probe.
 */
const STALL = await page.evaluate(() => {
  for (const k of Object.keys(localStorage)) {
    const m = k.match(/^imani-wallet:merchant:([0-9a-f]{64})$/)
    if (m) return m[1]
  }
  return ''
})
check('registered, with a stall pubkey to key the roster on', /^[0-9a-f]{64}$/.test(STALL), STALL)
console.log(`  registered @${handle}, stall ${STALL.slice(0, 12)}…`)

console.log('\nRevoking it in the real UI')
const seeded = await page.evaluate(
  ([stall, dev]) => {
    const key = `imani-wallet:terminals:${stall}`
    localStorage.setItem(
      key,
      JSON.stringify([
        { terminalPubkey: dev, name: 'Front counter', role: 'redeem-only', enrolledAt: 900_000 },
      ]),
    )
    return localStorage.getItem(key)
  },
  [STALL, device] as const,
)
check('the roster row was seeded under the stall key', (seeded ?? '').includes(device))
/**
 * Retried because a bare `goto` here failed one run in two with
 * `net::ERR_NETWORK_CHANGED` — the dev server and the host network, not the
 * app. A probe that reports a transient navigation error as a finding is worse
 * than no probe, since this one's whole job is to say something true about
 * revocation.
 */
for (let attempt = 1; ; attempt++) {
  try {
    await page.goto(`${APP}/settings/terminals`, { waitUntil: 'domcontentloaded' })
    break
  } catch (e) {
    if (attempt === 3) throw e
    console.log(`  (navigation retry ${attempt}: ${(e as Error).message.split('\n')[0]})`)
    await page.waitForTimeout(500)
  }
}
await page.waitForTimeout(1500)

const revoke = page.getByRole('button', { name: 'Revoke' })
check('the owner is offered Revoke', (await revoke.count()) === 1)
if ((await revoke.count()) === 0) {
  // Bail rather than time out for 30s on a button that will never appear.
  console.log('  (the terminals screen rendered no roster — probe setup, not a finding)')
  await browser.close()
  process.exit(1)
}
await revoke.first().click()
await page.getByRole('button', { name: /Revoke Front counter/ }).click()
await page.waitForTimeout(400)

const row = await page.evaluate(
  (stall) =>
    JSON.parse(localStorage.getItem(`imani-wallet:terminals:${stall}`)!)[0] as {
      revokedAt?: number
    },
  STALL,
)
check('the roster now marks it revoked', row.revokedAt !== undefined)
check('no uncaught errors', pageErrors.length === 0, pageErrors.join('; '))

console.log('\nAsking the mint whether that changed anything')
const after = await mintStates(TOKEN)
console.log(`  mint says: ${after.join(',')}`)

/**
 * The finding, stated as the assertion it is.
 *
 * This currently PASSES, which is the bad news: the credential the owner just
 * revoked is still spendable. When owner-side revocation reaches the mint,
 * this check flips and the message below becomes the failure to fix.
 */
const stillSpendable = after.every((s) => s === 'UNSPENT')
check(
  'GAP: the credential is STILL UNSPENT after the owner revoked it',
  stillSpendable,
  stillSpendable
    ? 'the owner\u2019s revoke reached nothing the mint can see'
    : 'revocation now reaches the mint \u2014 update this probe and the assessment',
)

await browser.close()
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
