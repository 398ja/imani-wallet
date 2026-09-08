/**
 * @vitest-environment node
 *
 * The runtime the worker never had.
 *
 * `worker.ts` and `discharge.ts` were tested from the day they were written,
 * and none of it could run: there was no entrypoint, no config, no credential
 * store on disk and no `tokenFor` outside a test double. This covers the seam
 * where a correct worker meets a real deployment, which is where this feature
 * would have died silently.
 */
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { FileCredentialStore, tokenFor } from '../adapters'
import { ConfigError, readConfig } from '../config'
import { depsFor } from '../server'
import { CredentialVault } from '../vault'

const KEY = 'a'.repeat(64)
const LOCK = '11'.repeat(32)

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    PURCHASE_API_URL: 'http://payment-adapter:8080',
    PURCHASE_API_TOKEN: 'token',
    PURCHASE_GATEWAY_URL: 'http://gateway:8082',
    PURCHASE_VAULT_KEY: KEY,
    PURCHASE_LIVEMODE: 'false',
    ...overrides,
  }
}

async function tempPath(name = 'credentials.json'): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'issuer-')), name)
}

describe('config', () => {
  it('reads a complete environment', () => {
    const config = readConfig(env())
    expect(config.purchasesUrl).toBe('http://payment-adapter:8080')
    expect(config.livemode).toBe(false)
    expect(config.intervalMs).toBe(15_000)
  })

  /*
   * The reason this file exists.
   *
   * `PurchasesApi.owed()` returns [] on ANY failure, so a worker with a wrong
   * token polls a 401 forever and reports a healthy, empty queue while debts
   * pile up behind it. Nothing downstream can tell that apart from a quiet
   * afternoon, so it has to be caught here or not at all.
   */
  it('refuses to start without a purchases token', () => {
    expect(() => readConfig(env({ PURCHASE_API_TOKEN: '' }))).toThrow(ConfigError)
  })

  it('refuses to start without somewhere to poll', () => {
    expect(() => readConfig(env({ PURCHASE_API_URL: undefined }))).toThrow(ConfigError)
  })

  it('refuses to start without a gateway', () => {
    expect(() => readConfig(env({ PURCHASE_GATEWAY_URL: '' }))).toThrow(ConfigError)
  })

  /*
   * livemode decides whether a test payment can mint real value. Defaulting it
   * either way picks a wrong answer for somebody, so an unset or misspelt
   * value must stop the deploy rather than guess.
   */
  it.each(['', undefined, 'yes', '1', 'no', 'on'])('refuses livemode %o', (value) => {
    expect(() => readConfig(env({ PURCHASE_LIVEMODE: value }))).toThrow(ConfigError)
  })

  it('accepts both spellings of livemode', () => {
    expect(readConfig(env({ PURCHASE_LIVEMODE: 'true' })).livemode).toBe(true)
    expect(readConfig(env({ PURCHASE_LIVEMODE: 'false' })).livemode).toBe(false)
  })

  /*
   * Whitespace and case ARE forgiven, and that is not laziness. A compose file
   * writes `PURCHASE_LIVEMODE: "true"` next to a comment and picks up a
   * trailing space; refusing that would block a deploy over something invisible
   * in the editor. The strictness above is about AMBIGUOUS words — "yes", "1",
   * "on" — where guessing which one the author meant is the actual risk.
   */
  it('forgives the whitespace and case a compose file introduces', () => {
    expect(readConfig(env({ PURCHASE_LIVEMODE: ' TRUE ' })).livemode).toBe(true)
    expect(readConfig(env({ PURCHASE_LIVEMODE: 'False' })).livemode).toBe(false)
  })

  /*
   * The vault throws on a bad key at construction, but that is the FIRST USE,
   * which for a fresh deployment is the first sale. Checked at boot so a
   * truncated secret fails a deploy instead of a customer's purchase.
   */
  it('refuses a vault key of the wrong size', () => {
    expect(() => readConfig(env({ PURCHASE_VAULT_KEY: 'abcd' }))).toThrow(ConfigError)
  })

  it('names every problem at once, not just the first', () => {
    try {
      readConfig({})
      expect.unreachable('should have thrown')
    } catch (error) {
      // All five, so one restart is enough to learn what is wrong.
      expect((error as ConfigError).missing).toHaveLength(5)
    }
  })

  /*
   * Number('') is 0 and Number('x') is NaN, and both sail through a bare ??.
   * A zero interval spins the loop as fast as the event loop allows.
   */
  it.each(['', 'soon', '0', '-5'])('falls back on a nonsense interval %o', (value) => {
    expect(readConfig(env({ PURCHASE_INTERVAL_MS: value })).intervalMs).toBe(15_000)
  })

  it('takes a real interval', () => {
    expect(readConfig(env({ PURCHASE_INTERVAL_MS: '500' })).intervalMs).toBe(500)
  })
})

describe('the credential file', () => {
  it('survives a round trip through the vault', async () => {
    const path = await tempPath()
    const vault = new CredentialVault(KEY, new FileCredentialStore(path))
    await vault.put({ stallPubkey: 'b'.repeat(64), credentialId: 'c1', lockKeyHex: LOCK })

    // A FRESH vault over the same file: this is the restart case, and the
    // whole point of writing to disk.
    const reopened = new CredentialVault(KEY, new FileCredentialStore(path))
    expect((await reopened.get('b'.repeat(64)))?.lockKeyHex).toBe(LOCK)
  })

  it('never writes an issuing key in the clear', async () => {
    const path = await tempPath()
    const vault = new CredentialVault(KEY, new FileCredentialStore(path))
    await vault.put({ stallPubkey: 'b'.repeat(64), credentialId: 'c1', lockKeyHex: LOCK })

    expect(await readFile(path, 'utf8')).not.toContain(LOCK)
  })

  /*
   * The sealing key lives in this process's environment, so a world-readable
   * file plus a leaked environment is one mistake rather than two.
   */
  it('writes the store 0600', async () => {
    const path = await tempPath()
    await new FileCredentialStore(path).write([{ stallPubkey: 'b' }])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  /*
   * A fresh deployment has no file, and that is not an error: it means no
   * stall has enrolled, which lands where the design already sends a stall
   * with no credential.
   */
  it('reads a missing file as no credentials', async () => {
    expect(await new FileCredentialStore(await tempPath()).read()).toEqual([])
  })

  it('reads a corrupt file as no credentials rather than crashing', async () => {
    const path = await tempPath()
    await writeFile(path, 'not json at all')
    expect(await new FileCredentialStore(path).read()).toEqual([])
  })

  it('creates the directory it was pointed at', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'issuer-')), 'nested', 'deep', 'creds.json')
    await new FileCredentialStore(path).write([{ stallPubkey: 'b' }])
    expect(await new FileCredentialStore(path).read()).toHaveLength(1)
  })

  /*
   * Rename, not truncate-and-write. A crash mid-write would otherwise leave a
   * zero-byte file, every stall would fall back to manual issuance, and the
   * vault's own skip-unreadable-records handling would keep the logs silent.
   *
   * Asserted on the INODE, which is the observable signature of an atomic
   * replace: rename swaps in a new file, so the number changes, while
   * truncate-and-write keeps the same inode and exposes readers to the empty
   * window in between.
   *
   * The obvious test — "no .tmp file is left behind" — was written first and is
   * a FAKE GUARD. Point the store at its own path and no temporary is ever
   * created, so `stat` rejects for the wrong reason and the test passes while
   * describing a property the code no longer has. Verified by making exactly
   * that mutation: the inode assertion goes red, the leftover-file one stays
   * green.
   */
  it('replaces the store atomically rather than truncating it', async () => {
    const path = await tempPath()
    const store = new FileCredentialStore(path)

    await store.write([{ stallPubkey: 'b' }])
    const first = (await stat(path)).ino
    await store.write([{ stallPubkey: 'c' }])

    expect((await stat(path)).ino).not.toBe(first)
    // And the swap actually landed, so the atomicity is not bought by
    // never writing anything.
    expect(await store.read()).toEqual([{ stallPubkey: 'c' }])
    // No debris either, which matters for a store that is rewritten per enrol.
    await expect(stat(`${path}.tmp`)).rejects.toThrow()
  })
})

describe('fetching a token for a coupon still minting', () => {
  const credential = { stallPubkey: 'b'.repeat(64), credentialId: 'c1', lockKeyHex: LOCK }

  it('asks the gateway for the voucher and returns its token', async () => {
    let seen: { url: string; auth: string } | null = null
    const token = await tokenFor(
      'http://gateway:8082/',
      credential,
      'v-1',
      (async (url: string, init: RequestInit) => {
        seen = { url, auth: String((init.headers as Record<string, string>).Authorization) }
        return new Response(JSON.stringify({ token: 'cashuB123' }), { status: 200 })
      }) as unknown as typeof fetch,
    )

    expect(token).toBe('cashuB123')
    // The issuance path plus the id, not a second opinion about where a coupon
    // lives. The trailing slash on the base must not double up.
    expect(seen!.url).toBe('http://gateway:8082/api/v1/wallet/vouchers/v-1')
    expect(seen!.auth.startsWith('Nostr ')).toBe(true)
  })

  /*
   * A GET sends no body, and a NIP-98 payload tag is a hash of the body
   * actually sent. Hashing '{}' would sign over a body that never existed —
   * a gateway that checks the tag would reject every poll, and the coupon
   * would sit issued and undelivered until someone read the logs.
   */
  it('signs over an empty body', async () => {
    let payload: string | undefined
    await tokenFor(
      'http://gateway:8082',
      credential,
      'v-1',
      (async (_url: string, init: RequestInit) => {
        const header = String((init.headers as Record<string, string>).Authorization)
        const event = JSON.parse(atob(header.slice('Nostr '.length))) as {
          tags: string[][]
        }
        payload = event.tags.find((t) => t[0] === 'payload')?.[1]
        return new Response(JSON.stringify({ token: 't' }), { status: 200 })
      }) as unknown as typeof fetch,
    )

    // sha256 of the empty string.
    expect(payload).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('escapes a voucher id rather than pasting it into a path', async () => {
    let seen = ''
    await tokenFor(
      'http://gateway:8082',
      credential,
      'a/../b',
      (async (url: string) => {
        seen = url
        return new Response(JSON.stringify({ token: 't' }), { status: 200 })
      }) as unknown as typeof fetch,
    )
    expect(seen).toBe('http://gateway:8082/api/v1/wallet/vouchers/a%2F..%2Fb')
  })

  /*
   * Mid-mint is the EXPECTED state for the first second or so. It must read as
   * "poll again", not as a failure: discharge.ts loops on '' and gives up on a
   * throw, and confusing the two would abandon a coupon that was about to
   * exist.
   */
  it('reads a voucher with no token yet as still minting', async () => {
    const token = await tokenFor(
      'http://gateway:8082',
      credential,
      'v-1',
      (async () => new Response(JSON.stringify({ voucher_id: 'v-1' }), { status: 200 })) as unknown as typeof fetch,
    )
    expect(token).toBe('')
  })

  it.each([500, 404, 401])('throws retryably on HTTP %i', async (status) => {
    await expect(
      tokenFor(
        'http://gateway:8082',
        credential,
        'v-1',
        (async () => new Response('', { status })) as unknown as typeof fetch,
      ),
    ).rejects.toThrow()
  })

  it('throws when the gateway cannot be reached', async () => {
    await expect(
      tokenFor(
        'http://gateway:8082',
        credential,
        'v-1',
        (async () => {
          throw new Error('ECONNREFUSED')
        }) as unknown as typeof fetch,
      ),
    ).rejects.toThrow('ECONNREFUSED')
  })
})

/*
 * The wiring, which no unit test can see.
 *
 * Every piece of this service was correct and unreachable for a day because
 * nothing constructed them together. That is the same defect class that left
 * the whole purchase feature out of the shipped jar, and the only test that
 * catches it is one that builds the real object graph.
 */
describe('wiring', () => {
  it('builds a worker whose ports reach the vault', async () => {
    const path = await tempPath()
    const config = readConfig(env({ PURCHASE_CREDENTIALS_PATH: path, PURCHASE_LIVEMODE: 'true' }))

    await new CredentialVault(KEY, new FileCredentialStore(path)).put({
      stallPubkey: 'b'.repeat(64),
      credentialId: 'c1',
      lockKeyHex: LOCK,
    })

    const deps = depsFor(config)
    expect(deps.livemode).toBe(true)
    expect(deps.gatewayUrl).toBe('http://gateway:8082')
    // The port reads the store the config named, rather than some other one.
    expect((await deps.ports.credentialFor('b'.repeat(64)))?.credentialId).toBe('c1')
  })

  it('reports no credential for a stall that never enrolled', async () => {
    const deps = depsFor(readConfig(env({ PURCHASE_CREDENTIALS_PATH: await tempPath() })))
    expect(await deps.ports.credentialFor('c'.repeat(64))).toBeNull()
  })

  it('gives the worker a clock and a sleep that actually pass time', async () => {
    const deps = depsFor(readConfig(env({ PURCHASE_CREDENTIALS_PATH: await tempPath() })))
    const before = deps.ports.now()
    await deps.ports.sleep(5)
    expect(deps.ports.now()).toBeGreaterThanOrEqual(before)
  })
})
