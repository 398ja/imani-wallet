/**
 * #366 end to end on the local stack: an employer's integration sends Cashlinks with
 * `@imani/cashlink-sender`, holding its own key, and wallet-api answers the read-only questions.
 *
 *   CASHLINK_COUPONS=/path/coupons.txt npx tsx --tsconfig tsconfig.services.json e2e/cashlink-sender-local.e2e.mts
 *
 * Needs: the local stack with the Cashlink refund relay on (deploy/compose.override.yml,
 * GATEWAY_CUSTOMER_CASHLINK_REFUND_RELAY_ENABLED), wallet-api on :8788 with WALLET_API_MINT_URL (and
 * WALLET_API_MINT_TRANSPORT_URL=http://localhost:27777) and the employer listed in
 * WALLET_API_BUSINESS_SENDERS, and coupons (one per line) delivered to the employer key named by
 * CASHLINK_EMPLOYER_HEX (seed-merchant.mjs PRINT_TOKENS=1 prints them).
 *
 * Checked against the real gateway and mint, nothing faked:
 *   A  limits and plan from wallet-api: business limit for the employer, a batch planned, the
 *      coupons judged armable (real minted coupons carry DLEQ).
 *   B  send: the coupon reaches its link, is burnt, LOCKED to the link with refund = [R] and
 *      locktime = x, and the take-back is deposited at the relay (armed). State holds no secret.
 *   C  claim: the recipient (a fresh key) opens the link with the app's own claim path and gets an
 *      unlocked coupon; the sender's reconcile marks it claimed.
 *   D  take back before x: the sender takes a second link back; keep() receives the coupon,
 *      re-formed and UNLOCKED, worth the same face value; a recipient opening it then finds nothing.
 *   E  restore: a lost state file is rebuilt from the sender key alone, adopting an open link.
 *   F  limits: an individual (not listed) gets 10, and the SDK refuses past the limit before
 *      anything moves.
 */
import { readFileSync } from 'node:fs'
import { hexToBytes } from '@noble/hashes/utils'
import { getPublicKey, generateSecretKey } from 'nostr-tools/pure'

const results: Array<[string, boolean]> = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push([name, ok])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  (${detail})` : ''}`)
}

// A tiny localStorage for the recipient's claim (the app keeps claim factors there).
const store = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
}

const GATEWAY = process.env.CASHLINK_GATEWAY_URL ?? 'http://localhost:28082'
const MINT_NAMED = process.env.CASHLINK_MINT_URL ?? 'http://127.0.0.1.mint:7777'
const MINT_REACH = process.env.CASHLINK_MINT_TRANSPORT_URL ?? 'http://localhost:27777'
// The origin the gateway binds NIP-98 to (GATEWAY_SECURITY_NIP98_PUBLIC_BASE_URL); locally the wallet dev server.
const GATEWAY_ORIGIN = process.env.CASHLINK_GATEWAY_PUBLIC_ORIGIN ?? 'http://localhost:5173'
const WALLET_API = process.env.CASHLINK_WALLET_API_URL ?? 'http://localhost:8788'
const WALLET_ORIGIN = process.env.CASHLINK_WALLET_ORIGIN ?? 'http://localhost:5173'
const employerHex = process.env.CASHLINK_EMPLOYER_HEX ?? ''
const coupons = readFileSync(process.env.CASHLINK_COUPONS ?? '', 'utf8').trim().split('\n').filter(Boolean)
if (!/^[0-9a-f]{64}$/.test(employerHex) || coupons.length < 3) throw new Error('CASHLINK_EMPLOYER_HEX and at least 3 CASHLINK_COUPONS are required')
const employerKey = hexToBytes(employerHex)

const { createCashlinkSender, emptyState, CashlinkSenderError, nip98 } = await import('../sdk/cashlink-sender/src/index')
const { readLinkLock } = await import('../src/lib/cashlinkLock')
const { tokenProofs, parseVoucherToken } = await import('../src/lib/voucherToken')
const { secretFromText } = await import('../src/lib/giftLink')
const { claimLockedGift, lockedOnLink } = await import('../src/lib/cashlinkFlow')
const { nodeGateway, nodeMint, queryWraps } = await import('../sdk/cashlink-sender/src/ports')
const { nip17 } = await import('nostr-tools')

const kept: Array<{ token: string; why: string; i: number }> = []
const sender = createCashlinkSender({
  secretKey: employerKey,
  gatewayUrl: GATEWAY,
  publicOrigin: GATEWAY_ORIGIN,
  mintUrl: MINT_NAMED,
  mintTransportUrl: MINT_REACH,
  walletOrigin: WALLET_ORIGIN,
  walletApiUrl: WALLET_API,
  keep: async (c) => void kept.push({ token: c.token, why: c.why, i: c.i }),
})

async function walletApi(method: 'GET' | 'POST', path: string, body?: unknown) {
  const raw = body === undefined ? undefined : JSON.stringify(body)
  const r = await fetch(`${WALLET_API}${path}`, {
    method,
    headers: { ...(raw ? { 'content-type': 'application/json' } : {}), authorization: nip98(employerKey, `${WALLET_API}${path}`, method, raw) },
    ...(raw ? { body: raw } : {}),
  })
  return { status: r.status, body: (await r.json()) as Record<string, unknown> }
}

const nowS = Math.floor(Date.now() / 1000)
const x = nowS + 3 * 86_400

// ─── A ──────────────────────────────────────────────────────────────────────
const limits = await walletApi('GET', '/v1/links/limits')
check('A1 wallet-api gives the employer the business limit', limits.status === 200 && (limits.body.limits as { accountType: string }).accountType === 'business', JSON.stringify(limits.body))
const plan = await walletApi('POST', '/v1/links/plan', { coupons: coupons.slice(0, 2), x })
const verdicts = (plan.body.coupons as Array<{ armable: boolean; blockers: string[] }>) ?? []
check('A2 the plan allows the batch and judges real coupons armable', plan.status === 200 && (plan.body.allowance as { ok: boolean }).ok && verdicts.every((v) => v.armable), JSON.stringify(plan.body).slice(0, 300))

// ─── B ──────────────────────────────────────────────────────────────────────
const state = emptyState(sender.pubkey)
const sent1 = await sender.send(state, coupons[0], x, 'employee-001')
const lockedProofs = tokenProofs(sent1.link.token)
const lock = readLinkLock(lockedProofs[0].secret)
check('B1 the gift is armed: locked to its link and comes back on its own', sent1.returnsOnItsOwn && sent1.link.status === 'armed', JSON.stringify({ status: sent1.link.status, why: sent1.link.why }))
check('B2 the lock is the Cashlink shape: refund key, locktime = x', !!lock && lock.locktime === x && lock.refundPub !== lock.linkPub)
check('B3 the face value on the link is the coupon’s', parseVoucherToken(sent1.link.token).voucher.faceValue === parseVoucherToken(coupons[0]).voucher.faceValue)
const k = new URL(sent1.url).hash.match(/k=([^&]+)/)?.[1] ?? ''
check('B4 the link is the wallet’s format, and state holds no secret', sent1.url.startsWith(`${WALLET_ORIGIN}/g#v=1&k=`) && !JSON.stringify(state).includes(k))

// ─── C: the recipient claims with the app's own claim path ───────────────────
const recipient = generateSecretKey()
const linkSecret = secretFromText(k)!
const gw = nodeGateway({ gatewayUrl: GATEWAY, publicOrigin: GATEWAY_ORIGIN, mintUrl: MINT_NAMED }, { secret: recipient })
const recipientKept: string[] = []
const recipientPorts = {
  mint: nodeMint(fetch, 20_000, () => MINT_REACH),
  gateway: gw,
  deliver: async () => true,
  keep: async (c: { token: string }) => void recipientKept.push(c.token),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  now: () => Date.now(),
}
const wraps = await queryWraps({ gatewayUrl: GATEWAY, publicOrigin: GATEWAY_ORIGIN, mintUrl: MINT_NAMED }, linkSecret, getPublicKey(linkSecret))
const onLink = wraps
  .map((w) => {
    try {
      const r = nip17.unwrapEvent(w as never, linkSecret) as { content: string; created_at: number }
      return { token: (JSON.parse(r.content) as { token: string }).token, sentAt: r.created_at }
    } catch {
      return null
    }
  })
  .filter((t): t is { token: string; sentAt: number } => !!t)
const claim = await claimLockedGift({ ports: recipientPorts as never, pubkey: getPublicKey(recipient), linkSecret, k, lockedTokens: lockedOnLink(onLink, getPublicKey(linkSecret)) })
const claimedToken = recipientKept[0] ?? ''
check('C1 the recipient claims the gift into an unlocked coupon', claim.kind === 'ok' && claimedToken !== '' && tokenProofs(claimedToken).every((p) => !readLinkLock(p.secret)), JSON.stringify(claim))
const r1 = await sender.reconcile(state)
check('C2 the sender’s reconcile marks it claimed and keeps nothing', state.links[0].status === 'claimed' && r1.claimed === 1 && kept.length === 0, JSON.stringify({ r1, status: state.links[0].status }))

// ─── D: take back before x ───────────────────────────────────────────────────
const sent2 = await sender.send(state, coupons[1], x, 'employee-002')
check('D1 a second gift is armed', sent2.link.status === 'armed', sent2.link.why ?? '')
const backStatus = await sender.takeBack(state, sent2.link.i)
const back = kept.find((c) => c.i === sent2.link.i)
check('D2 take back returns the coupon to keep(), re-formed and unlocked', backStatus === 'returned' && !!back && tokenProofs(back.token).every((p) => !readLinkLock(p.secret)), JSON.stringify({ backStatus, kept: kept.length }))
check('D3 with the same face value as the gift', !!back && parseVoucherToken(back.token).voucher.faceValue === parseVoucherToken(coupons[1]).voucher.faceValue)
const k2 = new URL(sent2.url).hash.match(/k=([^&]+)/)?.[1] ?? ''
const ls2 = secretFromText(k2)!
const wraps2 = await queryWraps({ gatewayUrl: GATEWAY, publicOrigin: GATEWAY_ORIGIN, mintUrl: MINT_NAMED }, ls2, getPublicKey(ls2))
const states2 = await nodeMint(fetch, 20_000, () => MINT_REACH).states(MINT_NAMED, tokenProofs(sent2.link.token).map((p) => p.secret))
check('D4 the link’s gift is spent, so whoever opens the link finds nothing to add', wraps2.length > 0 && states2.every((s) => s === 'SPENT'), JSON.stringify(states2))

// ─── E: restore from the key alone ───────────────────────────────────────────
const sent3 = await sender.send(state, coupons[2], x, 'employee-003')
const fresh = emptyState(sender.pubkey)
const restored = await sender.restore(fresh)
const found3 = fresh.links.find((l) => l.i === sent3.link.i)
check('E1 restore finds the open link from the key alone, with its exact expiry', !!found3 && found3.x === x && ['not_armed', 'armed'].includes(found3.status), JSON.stringify({ restored, found3 }))
check('E2 and does not adopt the claimed or taken-back links as open', !fresh.links.some((l) => l.i === sent1.link.i || l.i === sent2.link.i))
await sender.takeBack(state, sent3.link.i)

// ─── F: an individual's limit ────────────────────────────────────────────────
const person = generateSecretKey()
const individual = createCashlinkSender({ secretKey: person, gatewayUrl: GATEWAY, publicOrigin: GATEWAY_ORIGIN, mintUrl: MINT_NAMED, mintTransportUrl: MINT_REACH, walletOrigin: WALLET_ORIGIN, walletApiUrl: WALLET_API, keep: async () => {} })
const lim = await individual.limits()
check('F1 an unlisted sender gets the individual limit (10)', lim.accountType === 'individual' && lim.maxOutstanding === 10)
const full = emptyState(individual.pubkey)
for (let i = 0; i < 10; i++) full.links.push({ i, x, status: 'armed', token: coupons[0], sentAt: nowS })
full.highWater = 9
let refused = ''
try {
  await individual.send(full, coupons[3] ?? coupons[0], x)
} catch (e) {
  refused = e instanceof CashlinkSenderError ? e.code : String(e)
}
check('F2 the 11th link is refused before anything moves', refused === 'too_many_outstanding' && full.links.length === 10, refused)

const failed = results.filter(([, ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
