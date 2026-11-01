/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { nip19, verifyEvent } from 'nostr-tools'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// @ts-expect-error a plain .mjs script with no type declarations
import * as operator from '../../../scripts/operator.mjs'

/**
 * scripts/operator.mjs: gateway-core's admin endpoints from the command line (rev-540p2 6a).
 *
 * What matters here is the signing and the URL binding, because those are what gateway-core
 * checks: the NIP-98 `u` tag must be the PUBLIC origin + path + query, byte for byte, while the
 * request itself goes to core on the host (/internal is not routed at the edge). And the nsec:
 * read from the env or one env-file line, never from argv, never printed.
 */
const SK = 'ab'.repeat(32)
const PK = bytesToHex(schnorr.getPublicKey(hexToBytes(SK)))
const NSEC = nip19.nsecEncode(hexToBytes(SK))
const PUBLIC = 'https://wallet.staging.398ja.xyz'
const CORE = 'http://127.0.0.1:8081'

function decodeAuth(header: string) {
  expect(header.startsWith('Nostr ')).toBe(true)
  return JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8'))
}

function tag(event: { tags: string[][] }, name: string) {
  return event.tags.find((t) => t[0] === name)?.[1]
}

const operatorKey = () => operator.operatorFromEnv({ IMANI_OPERATOR_NSEC: NSEC })

describe('the operator key', () => {
  it('reads IMANI_OPERATOR_NSEC from the environment', () => {
    const op = operatorKey()
    expect(op.pk).toBe(PK)
  })

  it('reads only that line from an env file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'openv-')), '.env.staging')
    writeFileSync(file, `# operator\nGATEWAY_CORE_OPERATOR_PUBKEYS=${PK}\nIMANI_OPERATOR_NSEC="${NSEC}"\nOTHER=x\n`)
    expect(operator.operatorFromEnv({}, file).pk).toBe(PK)
  })

  it('the environment wins over the file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'openv-')), '.env')
    const other = nip19.nsecEncode(hexToBytes('cd'.repeat(32)))
    writeFileSync(file, `IMANI_OPERATOR_NSEC=${other}\n`)
    expect(operator.operatorFromEnv({ IMANI_OPERATOR_NSEC: NSEC }, file).pk).toBe(PK)
  })

  it('is required: no key, no run', () => {
    expect(() => operator.operatorFromEnv({})).toThrow(/IMANI_OPERATOR_NSEC/)
  })

  it('refuses a malformed value without echoing it', () => {
    let message = ''
    try {
      operator.operatorFromEnv({ IMANI_OPERATOR_NSEC: 'nsec1secretishbutbroken' })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toMatch(/IMANI_OPERATOR_NSEC/)
    expect(message).not.toContain('secretish')
  })

  it('refuses an nsec on the command line, whatever the flag', () => {
    for (const argv of [
      ['lookup', '--voucher-id', 'v', '--nsec', NSEC],
      ['lookup', '--voucher-id', NSEC],
      ['refund-redemption', 's1', `--note=${NSEC}`],
      ['lookup', '--voucher-id', 'v', '--key', SK],
    ]) {
      let message = ''
      try {
        operator.parseArgs(argv)
      } catch (e) {
        message = (e as Error).message
      }
      expect(message, argv.join(' ')).toMatch(/never on the command line/)
      expect(message).not.toContain(NSEC)
      expect(message).not.toContain(SK)
    }
  })

  it('the key object never serialises its secret', () => {
    const op = operatorKey()
    expect(JSON.stringify(op)).not.toContain(SK)
    expect(String(op)).not.toContain(SK)
    expect(JSON.stringify(op)).toContain(PK.slice(0, 12))
  })
})

describe('the command line', () => {
  it('parses each command into one request', () => {
    expect(operator.parseArgs(['lookup', '--voucher-id', 'v1'])).toMatchObject({ command: 'lookup', voucherId: 'v1' })
    expect(operator.parseArgs(['lookup', '--payment-request-id', 'pr1', '--limit', '10', '--cursor', 'c'])).toMatchObject({
      paymentRequestId: 'pr1', limit: 10, cursor: 'c',
    })
    expect(operator.parseArgs(['refund-redemption', 's1', '--note', 'counter refund'])).toMatchObject({
      command: 'refund-redemption', sendId: 's1', note: 'counter refund',
    })
    expect(operator.parseArgs(['manual-attention', 'list'])).toMatchObject({ command: 'manual-attention', action: 'list' })
    expect(operator.parseArgs(['merchant', 'unsuspend', PK, '--role', 'customer'])).toMatchObject({
      command: 'merchant', action: 'unsuspend', pubkey: PK, role: 'customer',
    })
  })

  it('refuses what it cannot send', () => {
    expect(() => operator.parseArgs(['lookup'])).toThrow(/exactly one of/)
    expect(() => operator.parseArgs(['lookup', '--voucher-id', 'a', '--payment-request-id', 'b'])).toThrow(/exactly one of/)
    expect(() => operator.parseArgs(['refund-redemption', 's1'])).toThrow(/--note/)
    expect(() => operator.parseArgs(['merchant', 'suspend', 'npub1xyz'])).toThrow(/64-hex/)
    // The manual-attention writes went with the atomic purchase (gateway-core#156).
    expect(() => operator.parseArgs(['manual-attention', 'open-refund', 'p1', '--disposition', 'RECLAIMED', '--note', 'n']))
      .toThrow(/read-only/)
    expect(() => operator.parseArgs(['manual-attention', 'retry-payout', 'p1', '--note', 'n'])).toThrow(/read-only/)
    expect(() => operator.parseArgs(['frobnicate'])).toThrow(/unknown command/)
  })
})

describe('the request', () => {
  const op = operatorKey()
  const opts = { publicBase: PUBLIC, coreUrl: CORE }

  it('signs the PUBLIC url and sends to core on the host', () => {
    const req = operator.buildRequest(op, operator.parseArgs(['lookup', '--voucher-id', 'coupon one', '--limit', '5']), opts)
    expect(req.url).toBe(`${CORE}/internal/v1/atomic-sends/lookup?voucher_id=coupon%20one&limit=5`)
    const ev = decodeAuth(req.headers.Authorization)
    expect(ev.kind).toBe(27235)
    expect(ev.pubkey).toBe(PK)
    expect(tag(ev, 'u')).toBe(`${PUBLIC}/internal/v1/atomic-sends/lookup?voucher_id=coupon%20one&limit=5`)
    expect(tag(ev, 'method')).toBe('GET')
    expect(tag(ev, 'payload')).toBeUndefined()
    expect(verifyEvent(ev)).toBe(true)
  })

  it('binds a write to its exact body with the payload hash', () => {
    const req = operator.buildRequest(op, operator.parseArgs(['refund-redemption', 'send-1', '--note', 'refunded at the till']), opts)
    expect(req.method).toBe('POST')
    expect(req.url).toBe(`${CORE}/internal/v1/atomic-sends/send-1/refund-redemption`)
    expect(req.body).toBe('{"note":"refunded at the till"}')
    const ev = decodeAuth(req.headers.Authorization)
    expect(tag(ev, 'u')).toBe(`${PUBLIC}/internal/v1/atomic-sends/send-1/refund-redemption`)
    expect(tag(ev, 'method')).toBe('POST')
    expect(tag(ev, 'payload')).toBe(bytesToHex(sha256(new TextEncoder().encode(req.body))))
    expect(verifyEvent(ev)).toBe(true)
  })

  it('a write with no body still signs the empty body', () => {
    const req = operator.buildRequest(op, operator.parseArgs(['merchant', 'suspend', PK]), opts)
    expect(req.url).toBe(`${CORE}/internal/v1/merchants/${PK}/suspend`)
    expect(req.body).toBe('')
    expect(tag(decodeAuth(req.headers.Authorization), 'payload')).toBe(bytesToHex(sha256(new Uint8Array())))
  })

  it('path segments are encoded so an id cannot change the route', () => {
    const req = operator.buildRequest(op, operator.parseArgs(['refund-redemption', '../merchants/x', '--note', 'n']), opts)
    expect(req.url).toBe(`${CORE}/internal/v1/atomic-sends/..%2Fmerchants%2Fx/refund-redemption`)
    expect(tag(decodeAuth(req.headers.Authorization), 'u')).toBe(
      `${PUBLIC}/internal/v1/atomic-sends/..%2Fmerchants%2Fx/refund-redemption`)
  })

  it('every route the script knows', () => {
    const routes = [
      [['manual-attention', 'list', '--limit', '20'], 'GET', '/internal/v1/atomic-purchases/manual-attention?limit=20'],
      [['merchant', 'unsuspend', PK, '--role', 'merchant'], 'POST', `/internal/v1/merchants/${PK}/unsuspend?role=merchant`],
      [['lookup', '--payment-request-id', 'pr-9'], 'GET', '/internal/v1/atomic-sends/lookup?payment_request_id=pr-9'],
    ] as const
    for (const [argv, method, path] of routes) {
      const req = operator.buildRequest(op, operator.parseArgs([...argv]), opts)
      expect(req.method, argv.join(' ')).toBe(method)
      expect(req.url).toBe(CORE + path)
      expect(tag(decodeAuth(req.headers.Authorization), 'u')).toBe(PUBLIC + path)
    }
  })

  it('never sends the edge identity headers', () => {
    const req = operator.buildRequest(op, operator.parseArgs(['lookup', '--voucher-id', 'v']), opts)
    expect(Object.keys(req.headers).map((h) => h.toLowerCase())).not.toContain('x-auth-pubkey')
    expect(Object.keys(req.headers).map((h) => h.toLowerCase())).not.toContain('x-edge-auth')
  })

  it('the public base must be a bare origin, and is required', () => {
    const args = operator.parseArgs(['lookup', '--voucher-id', 'v'])
    expect(() => operator.buildRequest(op, args, { publicBase: '', coreUrl: CORE })).toThrow(/public/i)
    expect(() => operator.buildRequest(op, args, { publicBase: `${PUBLIC}/api`, coreUrl: CORE })).toThrow(/bare origin/)
    const trailing = operator.buildRequest(op, args, { publicBase: `${PUBLIC}/`, coreUrl: `${CORE}/` })
    expect(tag(decodeAuth(trailing.headers.Authorization), 'u')).toBe(`${PUBLIC}/internal/v1/atomic-sends/lookup?voucher_id=v`)
    expect(trailing.url).toBe(`${CORE}/internal/v1/atomic-sends/lookup?voucher_id=v`)
  })

  it('refuses to send the operator key over plain http off the host', () => {
    const args = operator.parseArgs(['lookup', '--voucher-id', 'v'])
    expect(() => operator.buildRequest(op, args, { publicBase: PUBLIC, coreUrl: 'http://10.0.0.5:8081' }))
      .toThrow(/loopback|https/)
    expect(() => operator.buildRequest(op, args, { publicBase: PUBLIC, coreUrl: 'https://wallet.staging.398ja.xyz' }))
      .not.toThrow()
  })
})

describe('running it', () => {
  it('prints the answer and never the key', async () => {
    const out: string[] = []
    const fetchImpl = vi.fn(async () => new Response('{"sends":[],"next_cursor":null}', { status: 200 }))
    const code = await operator.run(['lookup', '--voucher-id', 'v'], {
      env: { IMANI_OPERATOR_NSEC: NSEC, IMANI_PUBLIC_BASE_URL: PUBLIC, GATEWAY_CORE_URL: CORE },
      fetchImpl, print: (s: string) => out.push(s),
    })
    expect(code).toBe(0)
    expect(fetchImpl).toHaveBeenCalledOnce()
    const all = out.join('\n')
    expect(all).toContain('"sends"')
    expect(all).toContain(PK.slice(0, 12))
    expect(all).not.toContain(NSEC)
    expect(all).not.toContain(SK)
  })

  it('a refusal is a non-zero exit with the status, and still no key', async () => {
    const out: string[] = []
    const fetchImpl = vi.fn(async () => new Response('{"error_code":"NOT_AN_OPERATOR"}', { status: 403 }))
    const code = await operator.run(['merchant', 'suspend', PK], {
      env: { IMANI_OPERATOR_NSEC: NSEC, IMANI_PUBLIC_BASE_URL: PUBLIC, GATEWAY_CORE_URL: CORE },
      fetchImpl, print: (s: string) => out.push(s),
    })
    expect(code).not.toBe(0)
    expect(out.join('\n')).toMatch(/403/)
    expect(out.join('\n')).toMatch(/GATEWAY_CORE_OPERATOR_PUBKEYS/)
    expect(out.join('\n')).not.toContain(NSEC)
  })

  it('--help or no command prints the usage and needs no key', async () => {
    for (const argv of [['--help'], ['-h'], []]) {
      const out: string[] = []
      const fetchImpl = vi.fn()
      const code = await operator.run(argv, { env: {}, fetchImpl, print: (s: string) => out.push(s) })
      expect(code).toBe(argv.length ? 0 : 2)
      expect(fetchImpl).not.toHaveBeenCalled()
      const all = out.join('\n')
      for (const c of ['lookup', 'refund-redemption', 'manual-attention', 'merchant suspend', 'IMANI_OPERATOR_NSEC',
        'IMANI_PUBLIC_BASE_URL', 'GATEWAY_CORE_URL', 'operator-access.md']) expect(all).toContain(c)
    }
  })
})
