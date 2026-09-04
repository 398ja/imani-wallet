#!/usr/bin/env node
/**
 * Open a stall for the probe merchant, so gateway-core's ACL will call him one.
 *
 * `MerchantAclService.hasLiveStall` decides merchant status from a kind-30078
 * addressable event tagged `d=imani:merchant` whose content says
 * `{"active":true}`. Publishing one is what MAKES someone a merchant — there is
 * no operator step — so a stack where nobody published one has no merchants at
 * all, and every NIP-98 caller correctly resolves to `coupon:pay/receive`.
 *
 * That is exactly what the cashback probe hit: authentication succeeded, the
 * permission lookup worked, and the answer was an honest "this is a customer".
 */
import { readFileSync } from 'fs'
import { finalizeEvent } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils'
import WebSocket from 'ws'

const RELAY = process.env.RELAY_URL ?? 'ws://localhost:27777'
const seeds = JSON.parse(readFileSync(process.env.SEED_KEYS ?? '.seed-keys.json', 'utf8'))
const sk = hexToBytes(process.env.PROBE_MERCHANT_SK ?? seeds['imani-terminals'].sk)

const event = finalizeEvent({
  kind: 30078,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['d', 'imani:merchant']],
  content: JSON.stringify({ active: true, name: 'imani-terminals' }),
}, sk)

const ws = new WebSocket(RELAY)
ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])))
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  if (msg[0] === 'OK') {
    console.log(msg[2] ? `published ${event.id.slice(0, 12)}… pubkey=${event.pubkey.slice(0, 12)}…`
                       : `REFUSED: ${msg[3]}`)
    ws.close()
    process.exit(msg[2] ? 0 : 1)
  }
})
ws.on('error', (e) => { console.error('relay error', e.message); process.exit(1) })
setTimeout(() => { console.error('timed out waiting for OK'); process.exit(1) }, 10_000)
