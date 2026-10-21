import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'

import { parseVoucherToken, tokenProofs } from '../../src/lib/voucherToken.js'
import { effectiveNow } from './testSeams.js'

/**
 * `POST /v1/links/status`: where a caller's Cashlinks stand (#295 phase 0).
 *
 * The caller sends the link RECORDS it already keeps (the proofs' `Y` points, or the coupons
 * themselves) and the expiry `x` it chose. The service asks the mint (NUT-07 `checkstate`) and
 * answers per link: `claimed`, `outstanding`, or `expired_unreturned`. Read-only: nothing is
 * stored, signed or spent, and nothing is returned that was not sent.
 *
 * ## It never takes a key
 *
 * ADR 0001 and 0002: this service holds no key and cannot spend. A Cashlink's secret IS a key (it
 * spends the gift), so a request that carries anything shaped like one is refused before any work,
 * and the refusal names the field without echoing the value:
 *
 * - a field named like a key (`k`, `key`, `secret`, `nsec`, `privkey`, `link_secret`, …);
 * - an `nsec1…` string, a bare 64-hex string (a raw private key looks exactly like that), a
 *   43-character base64url string (a Cashlink secret), or a link URL with `k=` in it.
 *
 * `Y`s are 33-byte compressed points (66 hex, `02`/`03`), so they never collide with the 64-hex
 * rule. That is why the endpoint asks for `Y`s rather than secrets: `Y = hash_to_curve(secret)`
 * tells the mint which proof, and nothing more.
 *
 * ## Which mint
 *
 * Only the one this service is configured with (`WALLET_API_MINT_URL`), never a mint named by the
 * caller or by a token: a caller-chosen URL would make this service fetch anything for anyone.
 * A token at another mint is refused by field.
 *
 * ## Customer and stall Cashlinks
 *
 * `kind` labels the answer. A customer's link that expires unclaimed comes back to the sender (today
 * the next time their wallet runs), so it reads `expired_unreturned` with `comesBack: true`. A
 * stall's Cashlink (Sell, or a till) is not returned by design: once expired it reads `expired`
 * with `comesBack: false`. The mint cannot tell a claim from the sender taking a link back, so
 * both read `claimed` (the coupon is no longer on the link).
 */

type Parsed<T> = { ok: true; value: T } | { ok: false; error: { field: string; detail: string } }
const fail = (field: string, detail: string): Parsed<never> => ({ ok: false, error: { field, detail } })

export const MAX_LINKS = 50
export const MAX_YS_PER_LINK = 100
export const MAX_YS_TOTAL = 1000

export type LinkKind = 'customer' | 'merchant'
export type LinkStatus = 'claimed' | 'outstanding' | 'expired_unreturned' | 'expired' | 'pending' | 'unknown'

export interface LinkRecord {
  /** The caller's own label for the link, echoed back. Never a secret (refused if it looks like one). */
  id: string
  kind: LinkKind
  /** The link's expiry, unix seconds. */
  x: number
  /** One per proof, hex compressed points. */
  ys: string[]
}

export interface LinksStatusInput {
  links: LinkRecord[]
  now: number
}

export interface LinkAnswer {
  id: string
  kind: LinkKind
  status: LinkStatus
  /** Whether an unclaimed link's coupon goes back to whoever sent it. */
  comesBack: boolean
  x: number
  proofs: number
}

// ─── Refusing anything that looks like a key ────────────────────────────────

const KEY_FIELD = /^(k|key|keys|secret|secrets|sk|seckey|secret_?key|private_?key|privkey|priv|nsec|link_?secret|linksecret|seed|mnemonic|passphrase)$/i
const NSEC = /^nsec1/i
const HEX64 = /^(0x)?[0-9a-f]{64}$/i
const LINK_SECRET = /^[A-Za-z0-9_-]{43}$/
const LINK_URL_KEY = /[#?&]k=/

/**
 * The first place in `value` that looks like a key, as a field path, or null. Walks every object
 * and array, so a key cannot hide in a nested or unknown field.
 */
export function keyLikeField(value: unknown, path = 'body', depth = 0): string | null {
  if (depth > 8) return path
  if (typeof value === 'string') {
    const s = value.trim()
    if (NSEC.test(s) || HEX64.test(s) || LINK_SECRET.test(s) || LINK_URL_KEY.test(s)) return path
    return null
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = keyLikeField(value[i], `${path}[${i}]`, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (value && typeof value === 'object') {
    for (const [name, inner] of Object.entries(value)) {
      const at = path === 'body' ? name : `${path}.${name}`
      if (KEY_FIELD.test(name)) return at
      const hit = keyLikeField(inner, at, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

export const KEY_REFUSAL =
  'this looks like a key or a Cashlink secret. This service never takes one: send the proofs\u2019 Y points (or the coupons) and the expiry instead'

// ─── Reading the request ─────────────────────────────────────────────────────

const Y_HEX = /^0[23][0-9a-f]{64}$/i
const ID = /^[A-Za-z0-9:._-]{1,64}$/
const LINK_FIELDS = new Set(['id', 'kind', 'x', 'ys', 'tokens'])

/** `Y = hash_to_curve(secret)`, NUT-00, the same construction the mint and the wallet use. */
export function hashToCurveHex(secret: string): string {
  const DOMAIN = utf8ToBytes('Secp256k1_HashToCurve_Cashu_')
  const msg = sha256(new Uint8Array([...DOMAIN, ...utf8ToBytes(secret)]))
  const counter = new Uint8Array(4)
  for (let i = 0; i < 2 ** 16; i++) {
    new DataView(counter.buffer).setUint32(0, i, true)
    const candidate = '02' + bytesToHex(sha256(new Uint8Array([...msg, ...counter])))
    try {
      secp256k1.Point.fromHex(candidate)
      return candidate
    } catch {
      // Not on the curve: next counter, exactly as NUT-00 says.
    }
  }
  throw new Error('no point found')
}

function isPoint(hex: string): boolean {
  try {
    secp256k1.Point.fromHex(hex)
    return true
  } catch {
    return false
  }
}

function sameMint(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase()
}

export function parseLinksStatusRequest(body: unknown, mintUrl: string, serverNow: number): Parsed<LinksStatusInput> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail('body', 'expected a JSON object')
  // Before anything else, and over the WHOLE body: a key in any field is refused, not ignored.
  const keyAt = keyLikeField(body)
  if (keyAt) return fail(keyAt, KEY_REFUSAL)

  const b = body as Record<string, unknown>
  for (const name of Object.keys(b)) {
    if (name !== 'links' && name !== 'now') return fail(name, 'unknown field; expected only links')
  }
  if (!Array.isArray(b.links)) return fail('links', 'expected an array of link records')
  if (b.links.length === 0) return fail('links', 'expected at least one link')
  if (b.links.length > MAX_LINKS) return fail('links', `at most ${MAX_LINKS} links per request`)

  const links: LinkRecord[] = []
  let total = 0
  for (let n = 0; n < b.links.length; n++) {
    const at = (f: string) => `links[${n}].${f}`
    const raw = b.links[n]
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail(`links[${n}]`, 'expected an object')
    const r = raw as Record<string, unknown>
    for (const name of Object.keys(r)) {
      if (!LINK_FIELDS.has(name)) return fail(at(name), 'unknown field; expected id, kind, x, ys or tokens')
    }
    const id = r.id === undefined ? String(n) : r.id
    if (typeof id !== 'string' || !ID.test(id)) return fail(at('id'), 'expected 1 to 64 letters, digits or : . _ -')
    const kind = r.kind === undefined ? 'customer' : r.kind
    if (kind !== 'customer' && kind !== 'merchant') return fail(at('kind'), 'expected customer or merchant')
    if (typeof r.x !== 'number' || !Number.isSafeInteger(r.x) || r.x <= 0) return fail(at('x'), 'expected the expiry in unix seconds')
    if (r.x > 1e11) return fail(at('x'), 'expected unix SECONDS, not milliseconds')

    const ys: string[] = []
    if (r.ys !== undefined) {
      if (!Array.isArray(r.ys)) return fail(at('ys'), 'expected an array of hex points')
      for (let i = 0; i < r.ys.length; i++) {
        const y = r.ys[i]
        if (typeof y !== 'string' || !Y_HEX.test(y) || !isPoint(y)) return fail(`${at('ys')}[${i}]`, 'expected a 33-byte compressed point in hex')
        ys.push(y.toLowerCase())
      }
    }
    if (r.tokens !== undefined) {
      if (!Array.isArray(r.tokens)) return fail(at('tokens'), 'expected an array of coupons')
      for (let i = 0; i < r.tokens.length; i++) {
        const t = r.tokens[i]
        const field = `${at('tokens')}[${i}]`
        if (typeof t !== 'string' || !t.startsWith('cashuB')) return fail(field, 'expected a coupon (cashuB…)')
        let mint: string
        let secrets: string[]
        try {
          mint = parseVoucherToken(t).mintUrl
          secrets = tokenProofs(t).map((p) => p.secret)
        } catch {
          return fail(field, 'could not read this coupon')
        }
        if (!sameMint(mint, mintUrl)) return fail(field, 'this coupon is not from the mint this service checks')
        for (const s of secrets) ys.push(hashToCurveHex(s))
      }
    }
    if (ys.length === 0) return fail(at('ys'), 'expected the proofs\u2019 Y points, or the coupons')
    if (ys.length > MAX_YS_PER_LINK) return fail(at('ys'), `at most ${MAX_YS_PER_LINK} proofs per link`)
    total += ys.length
    if (total > MAX_YS_TOTAL) return fail('links', `at most ${MAX_YS_TOTAL} proofs per request`)
    links.push({ id, kind, x: r.x, ys })
  }
  return { ok: true, value: { links, now: effectiveNow(b.now, serverNow) } }
}

// ─── Asking the mint ─────────────────────────────────────────────────────────

/** The mint this service checks, or null when unset. No default: a guess would be a wrong answer. */
export function linksMintUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.WALLET_API_MINT_URL?.trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? raw.replace(/\/+$/, '') : null
  } catch {
    return null
  }
}

const MINT_TIMEOUT_MS = Number(process.env.WALLET_API_MINT_TIMEOUT_MS ?? 10_000)

type ProofState = 'UNSPENT' | 'PENDING' | 'SPENT' | 'UNKNOWN'

/** NUT-07 for every `Y`, in one request. Throws when the mint does not answer properly. */
export async function checkStates(mintUrl: string, ys: string[], fetchImpl: typeof fetch): Promise<Map<string, ProofState>> {
  const unique = [...new Set(ys)]
  const response = await fetchImpl(`${mintUrl}/v1/checkstate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Ys: unique }),
    signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`mint answered ${response.status}`)
  const json = (await response.json()) as { states?: Array<{ Y?: unknown; state?: unknown }> }
  const out = new Map<string, ProofState>()
  for (const s of json.states ?? []) {
    if (typeof s.Y !== 'string') continue
    const state = s.state === 'SPENT' || s.state === 'UNSPENT' || s.state === 'PENDING' ? s.state : 'UNKNOWN'
    out.set(s.Y.toLowerCase(), state)
  }
  return out
}

/** One link's answer from its proofs' states. All spent is claimed; any unknown is unknown. */
export function linkStatus(link: LinkRecord, states: Map<string, ProofState>, now: number): LinkAnswer {
  const each = link.ys.map((y) => states.get(y) ?? 'UNKNOWN')
  let status: LinkStatus
  if (each.every((s) => s === 'SPENT')) status = 'claimed'
  else if (each.includes('UNKNOWN')) status = 'unknown'
  else if (each.includes('PENDING')) status = 'pending'
  else if (now < link.x) status = 'outstanding'
  else status = link.kind === 'customer' ? 'expired_unreturned' : 'expired'
  return { id: link.id, kind: link.kind, status, comesBack: link.kind === 'customer', x: link.x, proofs: link.ys.length }
}

export async function linksStatus(input: LinksStatusInput, mintUrl: string, fetchImpl: typeof fetch): Promise<{ links: LinkAnswer[] }> {
  const states = await checkStates(
    mintUrl,
    input.links.flatMap((l) => l.ys),
    fetchImpl,
  )
  return { links: input.links.map((l) => linkStatus(l, states, input.now)) }
}
