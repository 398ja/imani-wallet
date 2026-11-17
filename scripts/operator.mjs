#!/usr/bin/env node
/**
 * gateway-core's operator endpoints, from the command line (imani-gateway-core, rev-540p2 6a).
 *
 *   node scripts/operator.mjs lookup --voucher-id <id> | --payment-request-id <id> [--limit N] [--cursor C]
 *   node scripts/operator.mjs refund-redemption <sendId> --note "<why>"
 *   node scripts/operator.mjs manual-attention list [--limit N]
 *   node scripts/operator.mjs stuck-sends list [--limit N] [--cursor C]
 *   node scripts/operator.mjs stuck-sends show <sendId>
 *   node scripts/operator.mjs stuck-sends resume <sendId> --note "<why>"
 *   node scripts/operator.mjs merchant suspend <pubkey-hex>
 *   node scripts/operator.mjs merchant unsuspend <pubkey-hex> [--role merchant|customer]
 *
 * ## Who may run it
 *
 * The key whose x-only pubkey is on gateway-core's GATEWAY_CORE_OPERATOR_PUBKEYS. Anyone else gets
 * 403. The nsec is read from IMANI_OPERATOR_NSEC, or from that ONE line of `--env-file <path>`
 * (the deploy env file). Never from the command line (it would sit in shell history and `ps`), and
 * never printed: the script refuses an argument that looks like a key.
 *
 * ## Where it runs: on the host
 *
 * The admin endpoints live under /internal, which the edge never routes to gateway-core (the API
 * hosts answer 403, the wallet hosts fall through to the app). So the request goes straight to
 * gateway-core's service port on the host, GATEWAY_CORE_URL (default http://127.0.0.1:8081), or
 * through an SSH tunnel to it. Plain http is refused for anything but loopback.
 *
 * gateway-core binds a NIP-98 signature to its PUBLIC origin, not to the address the request
 * arrived on (SEC-02), so the signed `u` tag is IMANI_PUBLIC_BASE_URL + path + query: the same value
 * as the deploy env's GATEWAY_SECURITY_NIP98_PUBLIC_BASE_URL (read from --env-file when not set).
 *
 *   ssh -N -L 127.0.0.1:8081:<gateway-core's address on the host>:8081 <host>   # see the runbook
 *   IMANI_OPERATOR_NSEC=... IMANI_PUBLIC_BASE_URL=https://wallet.staging.398ja.xyz \
 *     node scripts/operator.mjs lookup --voucher-id <coupon id>
 *
 * Every call is audited by gateway-core with the operator's key prefix, the action, the target and
 * the outcome.
 */
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const NSEC_VAR = 'IMANI_OPERATOR_NSEC'
const PUBLIC_VAR = 'IMANI_PUBLIC_BASE_URL'
const PUBLIC_DEPLOY_VAR = 'GATEWAY_SECURITY_NIP98_PUBLIC_BASE_URL'
const CORE_VAR = 'GATEWAY_CORE_URL'
const DEFAULT_CORE = 'http://127.0.0.1:8081'
const PUBKEY = /^[0-9a-f]{64}$/
const ROLES = ['merchant', 'customer']

const USAGE = `gateway-core operator commands (rev-540p2 6a). Runbook: imani-deploy docs/runbooks/operator-access.md

  operator.mjs lookup --voucher-id <id> | --payment-request-id <id> [--limit N] [--cursor C]
  operator.mjs refund-redemption <sendId> --note "<why>"
  operator.mjs manual-attention list [--limit N]
  operator.mjs stuck-sends list [--limit N] [--cursor C]   bundle parts that cannot be delivered (gateway-core#220)
  operator.mjs stuck-sends show <sendId>
  operator.mjs stuck-sends resume <sendId> --note "<why>"   re-queue delivery, never a refund
  operator.mjs merchant suspend <pubkey-hex>
  operator.mjs merchant unsuspend <pubkey-hex> [--role merchant|customer]
  any command: [--env-file <deploy env file>]

  ${NSEC_VAR}       the operator's nsec, from the environment or that one line of --env-file.
                            Never on the command line.
  ${PUBLIC_VAR}     the public origin signatures are bound to (else the env file's
                            ${PUBLIC_DEPLOY_VAR})
  ${CORE_VAR}          where gateway-core answers, loopback or https (default ${DEFAULT_CORE});
                            /internal is not routed at the edge, so run on the host or via an SSH tunnel`

// ---------------------------------------------------------------- the key

/** One `NAME=value` line of an env file, unquoted. Nothing else in the file is read into memory. */
function envFileValue(path, name) {
  if (!path) return ''
  const line = readFileSync(path, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${name}=`))
  return (line?.slice(name.length + 1) ?? '').trim().replace(/^["']|["']$/g, '')
}

/**
 * The operator's key, from IMANI_OPERATOR_NSEC or that one line of the env file. A bad value is
 * refused WITHOUT echoing it. The returned object keeps the secret off every serialisation, so a
 * stray `console.log(op)` or JSON dump prints the pubkey prefix and nothing else.
 */
export function operatorFromEnv(env = process.env, envFile = '') {
  const value = (env[NSEC_VAR] ?? '').trim() || envFileValue(envFile, NSEC_VAR)
  if (!value) {
    throw new Error(`${NSEC_VAR} is not set: export it, or pass --env-file <deploy env file> (never on the command line)`)
  }
  let sk
  try {
    const decoded = nip19.decode(value)
    if (decoded.type !== 'nsec') throw new Error('not an nsec')
    sk = decoded.data
  } catch {
    throw new Error(`${NSEC_VAR} is set but is not a valid nsec (value not shown)`)
  }
  const pk = getPublicKey(sk)
  const op = { pk }
  Object.defineProperty(op, 'sk', { value: sk, enumerable: false })
  Object.defineProperty(op, 'toString', { value: () => `operator ${pk.slice(0, 12)}`, enumerable: false })
  Object.defineProperty(op, 'toJSON', { value: () => ({ pk: pk.slice(0, 12) }), enumerable: false })
  return op
}

// ---------------------------------------------------------------- the command line

/**
 * True for an nsec anywhere in an argument. A bare 64-hex value is NOT treated as a key on its own:
 * that is also exactly what a merchant pubkey looks like. Any key-named flag (--nsec, --key, ...) is
 * refused whatever its value, in parseArgs.
 */
function looksLikeKey(value) {
  return /nsec1[02-9ac-hj-np-z]{20,}/i.test(value)
}

/**
 * The command, as data. Throws on anything it would not send, and on anything that looks like a
 * key, whatever flag carried it.
 */
export function parseArgs(argv) {
  const args = [...argv]
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i])
    const keyFlag = /^--(nsec|key|secret|sk|private-key)(=|$)/i.test(a)
    if (looksLikeKey(a) || keyFlag) {
      throw new Error(`a key was given on the argument list: keys are read from ${NSEC_VAR} or --env-file, never on the command line`)
    }
  }
  const flags = {}
  const positional = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        const next = args[i + 1]
        if (next === undefined || next.startsWith('--')) throw new Error(`${a} needs a value`)
        flags[a.slice(2)] = next
        i++
      }
    } else {
      positional.push(a)
    }
  }
  const [command, ...rest] = positional
  const limit = flags.limit === undefined ? undefined : Number.parseInt(flags.limit, 10)
  if (flags.limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit must be a positive integer')
  const note = flags.note
  const requireNote = () => {
    if (!note || !note.trim()) throw new Error('--note "<why>" is required: it goes into the audit trail with your key')
  }
  const one = (name, value) => {
    if (!value) throw new Error(`${name} is required`)
    return value
  }

  switch (command) {
    case 'lookup': {
      const voucherId = flags['voucher-id']
      const paymentRequestId = flags['payment-request-id']
      if (!voucherId === !paymentRequestId) throw new Error('lookup needs exactly one of --voucher-id and --payment-request-id')
      return { command, voucherId, paymentRequestId, limit, cursor: flags.cursor, envFile: flags['env-file'] }
    }
    case 'refund-redemption':
      requireNote()
      return { command, sendId: one('<sendId>', rest[0]), note, envFile: flags['env-file'] }
    case 'manual-attention': {
      const action = rest[0]
      if (action === 'list') return { command, action, limit, envFile: flags['env-file'] }
      // retry-payout and open-refund went with the atomic purchase (gateway-core#156): the list is read-only.
      throw new Error('manual-attention list (read-only: the atomic purchase is removed)')
    }
    case 'stuck-sends': {
      // gateway-core#220: a forward-only bundle part whose delivery stopped. The only action pushes
      // it forward to the recipient: there is no reclaim or refund of a part past the decision.
      const action = rest[0]
      if (action === 'list') return { command, action, limit, cursor: flags.cursor, envFile: flags['env-file'] }
      if (action === 'show') return { command, action, sendId: one('<sendId>', rest[1]), envFile: flags['env-file'] }
      if (action === 'resume') {
        requireNote()
        if (note.trim().length > 500) throw new Error('--note is at most 500 characters')
        return { command, action, sendId: one('<sendId>', rest[1]), note, envFile: flags['env-file'] }
      }
      throw new Error('stuck-sends list | show <sendId> | resume <sendId> --note "<why>"')
    }
    case 'merchant': {
      const action = rest[0]
      if (action !== 'suspend' && action !== 'unsuspend') throw new Error('merchant suspend|unsuspend <pubkey-hex>')
      const pubkey = (rest[1] ?? '').toLowerCase()
      if (!PUBKEY.test(pubkey)) throw new Error('the merchant is a 64-hex x-only pubkey (not an npub)')
      const role = flags.role ?? 'merchant'
      if (action === 'unsuspend' && !ROLES.includes(role)) throw new Error(`--role ${ROLES.join('|')}`)
      return { command, action, pubkey, role: action === 'unsuspend' ? role : undefined, envFile: flags['env-file'] }
    }
    default:
      throw new Error(`unknown command '${command ?? ''}': lookup | refund-redemption | manual-attention | stuck-sends | merchant`)
  }
}

// ---------------------------------------------------------------- the request

/** A bare http(s) origin with no path, query or fragment; a trailing slash is dropped. */
function origin(value, what) {
  const raw = (value ?? '').trim().replace(/\/+$/, '')
  if (!raw) throw new Error(`${what} is required`)
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${what} is not a URL: ${raw}`)
  }
  if (!/^https?:$/.test(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${what} must be a bare origin like https://wallet.staging.398ja.xyz, got ${raw}`)
  }
  return `${url.protocol}//${url.host}`
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Method, path and body for a parsed command. Every path segment is encoded. */
function route(cmd) {
  const seg = encodeURIComponent
  const query = (pairs) => {
    const q = pairs.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${seg(String(v))}`).join('&')
    return q ? `?${q}` : ''
  }
  switch (cmd.command) {
    case 'lookup':
      return { method: 'GET', path: '/internal/v1/atomic-sends/lookup' + query([
        ['voucher_id', cmd.voucherId], ['payment_request_id', cmd.paymentRequestId],
        ['limit', cmd.limit], ['cursor', cmd.cursor]]) }
    case 'refund-redemption':
      return { method: 'POST', path: `/internal/v1/atomic-sends/${seg(cmd.sendId)}/refund-redemption`,
        body: JSON.stringify({ note: cmd.note }) }
    case 'manual-attention':
      return { method: 'GET', path: '/internal/v1/atomic-purchases/manual-attention' + query([['limit', cmd.limit]]) }
    case 'stuck-sends':
      if (cmd.action === 'list') {
        return { method: 'GET', path: '/internal/v1/atomic-sends/manual-attention'
          + query([['limit', cmd.limit], ['cursor', cmd.cursor]]) }
      }
      if (cmd.action === 'show') return { method: 'GET', path: `/internal/v1/atomic-sends/${seg(cmd.sendId)}/delivery` }
      return { method: 'POST', path: `/internal/v1/atomic-sends/${seg(cmd.sendId)}/resume-delivery`,
        body: JSON.stringify({ note: cmd.note }) }
    case 'merchant':
      return { method: 'POST', path: `/internal/v1/merchants/${seg(cmd.pubkey)}/${cmd.action}`
        + query([['role', cmd.role]]), body: '' }
    default:
      throw new Error(`unknown command ${cmd.command}`)
  }
}

/** NIP-98 (kind 27235) over the exact signed URL, method and, for a write, body. */
function nip98(sk, url, method, body) {
  const tags = [['u', url], ['method', method]]
  if (body !== undefined) tags.push(['payload', bytesToHex(sha256(new TextEncoder().encode(body)))])
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, sk)
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
}

/**
 * The HTTP request for a command: sent to `coreUrl`, signed for `publicBase`. Only the NIP-98
 * header authenticates it; no edge identity header is ever sent.
 */
export function buildRequest(op, cmd, { publicBase, coreUrl }) {
  const signedOrigin = origin(publicBase, `the public base URL (${PUBLIC_VAR})`)
  const target = origin(coreUrl || DEFAULT_CORE, `the gateway-core URL (${CORE_VAR})`)
  const host = new URL(target).hostname
  if (target.startsWith('http://') && !LOOPBACK.has(host)) {
    throw new Error(`refusing plain http to ${host}: use loopback (run on the host, or an SSH tunnel) or https`)
  }
  const { method, path, body } = route(cmd)
  const headers = { Authorization: nip98(op.sk, signedOrigin + path, method, body) }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return { method, url: target + path, headers, body }
}

// ---------------------------------------------------------------- running it

export async function run(argv, { env = process.env, fetchImpl = fetch, print = console.log } = {}) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    print(USAGE)
    return argv.length === 0 ? 2 : 0
  }
  let cmd
  let op
  try {
    cmd = parseArgs(argv)
    op = operatorFromEnv(env, cmd.envFile)
  } catch (e) {
    print(e instanceof Error ? e.message : String(e))
    return 2
  }
  const publicBase = env[PUBLIC_VAR] || envFileValue(cmd.envFile, PUBLIC_DEPLOY_VAR)
  let req
  try {
    req = buildRequest(op, cmd, { publicBase, coreUrl: env[CORE_VAR] })
  } catch (e) {
    print(e instanceof Error ? e.message : String(e))
    return 2
  }
  print(`operator ${op.pk.slice(0, 12)} -> ${req.method} ${req.url}`)
  let response
  try {
    response = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body })
  } catch (e) {
    print(`gateway-core unreachable at ${req.url}: ${e instanceof Error ? e.message : e}`)
    return 3
  }
  const text = await response.text()
  let shown = text
  try {
    shown = JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    // not JSON: print it as it came
  }
  print(`${response.status}`)
  if (shown) print(shown)
  if (response.status === 401 || response.status === 403) {
    print(`refused: is ${op.pk} on gateway-core's GATEWAY_CORE_OPERATOR_PUBKEYS, and is ${PUBLIC_VAR} the`
      + ` deploy's ${PUBLIC_DEPLOY_VAR}?`)
  }
  return response.ok ? 0 : 1
}

const executed = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (executed) {
  process.exitCode = await run(process.argv.slice(2))
}
