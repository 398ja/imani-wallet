#!/usr/bin/env node
/**
 * Provision the customers a run needs.
 *
 *   node loadtest/pool.mjs --size 50           # create or top up
 *   node loadtest/pool.mjs --size 50 --verify  # and check each one works
 *
 * Setting up a run should not itself be a project, so this is one command.
 * Running it again tops the pool up rather than rebuilding it: identities are
 * derived from a stable name, so a second run at the same size is a no-op and
 * a run at a larger size adds only what is missing.
 *
 * Why that matters beyond convenience: rebuilding would orphan the coupons a
 * previous run issued, under keys nothing references any more. The pool is
 * meant to accumulate value across runs, since issuance is what funds sending,
 * splitting and draining.
 *
 * The keys live beside the wallet's own seed keys, in a file git ignores. They
 * are throwaway identities on a test deployment and worth nothing, but they
 * are still keys, so they do not go in the repository.
 */

import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const POOL_FILE = join(ROOT, '.loadtest-pool.json')

function arg(flag, fallback) {
  const i = process.argv.indexOf(`--${flag}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const SIZE = Number(arg('size', '50'))
const VERIFY = process.argv.includes('--verify')
const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:28082'

/**
 * One customer, by position in the pool.
 *
 * Named by index rather than randomly, so the same index is the same customer
 * on every run. That is what makes topping up possible, and it also means a
 * run can pair customer N with customer M reproducibly.
 */
function customerName(index) {
  return `loadtest-customer-${String(index).padStart(4, '0')}`
}

function loadPool() {
  if (!existsSync(POOL_FILE)) return {}
  return JSON.parse(readFileSync(POOL_FILE, 'utf8'))
}

function savePool(pool) {
  mkdirSync(dirname(POOL_FILE), { recursive: true })
  writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2) + '\n')
}

async function verify(customer) {
  // An unauthenticated call: this checks the customer is addressable and the
  // gateway is up, not that they hold anything. Coupons are client-held, so
  // there is no server-side balance to ask for.
  try {
    const res = await fetch(
      `${GATEWAY}/api/v1/resolve?q=${encodeURIComponent(customer.npub)}`,
      { signal: AbortSignal.timeout(10_000) },
    )
    return res.status > 0 && res.status < 500
  } catch {
    return false
  }
}

async function main() {
  const pool = loadPool()
  const before = Object.keys(pool).length

  let added = 0
  for (let i = 0; i < SIZE; i++) {
    const name = customerName(i)
    if (pool[name]) continue
    const sk = generateSecretKey()
    const pk = getPublicKey(sk)
    pool[name] = {
      index: i,
      privHex: bytesToHex(sk),
      pubHex: pk,
      npub: nip19.npubEncode(pk),
      createdAt: new Date().toISOString(),
    }
    added++
  }

  savePool(pool)
  const after = Object.keys(pool).length

  console.log(`pool ${POOL_FILE}`)
  console.log(`  before   ${before}`)
  console.log(`  added    ${added}`)
  console.log(`  total    ${after}`)
  if (added === 0 && before >= SIZE) {
    console.log(`  (already had ${SIZE}, so nothing to do)`)
  }

  if (VERIFY) {
    console.log(`\nverifying ${SIZE} customers against ${GATEWAY}…`)
    const customers = Object.values(pool)
      .filter((c) => c.index < SIZE)
      .sort((a, b) => a.index - b.index)

    let ok = 0
    for (const customer of customers) {
      if (await verify(customer)) ok++
    }
    console.log(`  ${ok}/${customers.length} usable`)
    if (ok < customers.length) {
      console.error(`\n${customers.length - ok} customers are not usable. Is the gateway up?`)
      process.exit(1)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
