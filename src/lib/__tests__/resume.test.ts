import { beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetResume, recover, remember } from '../resume'

/**
 * Bug as reported: "after a refresh, I always have to enter the password ...
 * I should not have to enter the password on every screen refresh."
 *
 * The NAP session cookie survives a reload; the in-memory secret key does not,
 * and the wallet needs the key to decrypt gift wraps. So the app asked for the
 * passphrase again even though the user was still authenticated.
 *
 * These tests cover the cache that closes that gap, and in particular the
 * properties that keep it from being "just put the key in sessionStorage":
 * the key is never readable in storage, and it dies with the tab.
 */

const PRIVKEY = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const PUBKEY = 'f'.repeat(64)

/** sessionStorage stand-in; the test env is node. */
function fakeSessionStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

/**
 * An IndexedDB stand-in that preserves the one property under test: a stored
 * CryptoKey comes back as the same live key object, never as bytes.
 */
function fakeIndexedDB(vault: Map<string, unknown>) {
  return {
    open: () => {
      const req: Record<string, unknown> = {}
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => {},
          transaction: () => ({
            objectStore: () => ({
              get: (k: string) => {
                const r: Record<string, unknown> = {}
                queueMicrotask(() => {
                  r.result = vault.get(k)
                  ;(r.onsuccess as (() => void) | undefined)?.()
                })
                return r
              },
              put: (v: unknown, k: string) => {
                const r: Record<string, unknown> = {}
                queueMicrotask(() => {
                  vault.set(k, v)
                  ;(r.onsuccess as (() => void) | undefined)?.()
                })
                return r
              },
              delete: (k: string) => {
                const r: Record<string, unknown> = {}
                queueMicrotask(() => {
                  vault.delete(k)
                  ;(r.onsuccess as (() => void) | undefined)?.()
                })
                return r
              },
            }),
          }),
        }
        ;(req.onsuccess as (() => void) | undefined)?.()
      })
      return req
    },
  }
}

let vault: Map<string, unknown>
let session: ReturnType<typeof fakeSessionStorage>

beforeEach(() => {
  vault = new Map()
  session = fakeSessionStorage()
  vi.stubGlobal('sessionStorage', session)
  vi.stubGlobal('indexedDB', fakeIndexedDB(vault))
  // Node 20 has webcrypto on globalThis.crypto; subtle is what this uses.
  vi.stubGlobal('crypto', globalThis.crypto)
})

describe('the reload cache', () => {
  it('gives the key back after a reload', async () => {
    await remember(PUBKEY, PRIVKEY)

    const back = await recover()
    expect(back).toEqual({ pubkey: PUBKEY, privkeyHex: PRIVKEY })
  })

  /**
   * The property that makes this defensible at all. RFC §1181 forbids plaintext
   * key material at rest, and the whole design exists to honour that while still
   * surviving a refresh.
   */
  it('never writes the key where anything can read it', async () => {
    await remember(PUBKEY, PRIVKEY)

    const written = [...session.map.values()].join('')
    expect(written).not.toContain(PRIVKEY)
    // Nor any recognisable fragment of it.
    expect(written).not.toContain(PRIVKEY.slice(0, 16))
  })

  it('stores the wrapping key as a non-extractable CryptoKey', async () => {
    await remember(PUBKEY, PRIVKEY)

    const key = [...vault.values()][0] as CryptoKey
    expect(key).toBeInstanceOf(CryptoKey)
    // Not exportable: script may USE it and can never read it out, so an XSS
    // cannot exfiltrate the wrapping key itself.
    expect(key.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
  })

  it('has nothing to recover in a fresh tab', async () => {
    await remember(PUBKEY, PRIVKEY)
    // A new tab: same IndexedDB (origin-scoped), empty sessionStorage.
    vi.stubGlobal('sessionStorage', fakeSessionStorage())

    expect(await recover()).toBeNull()
  })

  it('forgets on request, and cannot be recovered afterwards', async () => {
    await remember(PUBKEY, PRIVKEY)
    forgetResume()
    // The delete is fire-and-forget; let it land.
    await new Promise((r) => setTimeout(r, 0))

    expect(await recover()).toBeNull()
    expect(vault.size).toBe(0)
  })

  it('discards a record whose wrapping key is gone rather than failing forever', async () => {
    await remember(PUBKEY, PRIVKEY)
    vault.clear() // key evicted, ciphertext still in sessionStorage

    expect(await recover()).toBeNull()
    // And the unusable blob is cleared, so this does not repeat every reload.
    expect(session.map.size).toBe(0)
  })

  it('discards a tampered record', async () => {
    await remember(PUBKEY, PRIVKEY)
    const [k, v] = [...session.map.entries()][0]!
    const parsed = JSON.parse(v)
    parsed.ciphertext = Buffer.from('not the ciphertext').toString('base64')
    session.map.set(k, JSON.stringify(parsed))

    // AES-GCM is authenticated, so this fails to decrypt rather than returning
    // garbage that would then be used as somebody key.
    expect(await recover()).toBeNull()
  })

  it('never throws when storage is unavailable', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        const req: Record<string, unknown> = {}
        queueMicrotask(() => {
          req.error = new Error('storage denied')
          ;(req.onerror as (() => void) | undefined)?.()
        })
        return req
      },
    })

    // Degrades to the passphrase screen, which is always a correct fallback.
    await expect(remember(PUBKEY, PRIVKEY)).resolves.toBeUndefined()
    await expect(recover()).resolves.toBeNull()
  })

  /**
   * Caught in a real browser, not here: the first version of App.tsx called
   * `forgetResume()` in the catch of its resume effect, so a single 5xx from the
   * gateway destroyed the only copy of the key this tab had. The reload after a
   * gateway blip then asked for the passphrase, and so did every reload after
   * it, for the life of the tab.
   *
   * The cache itself has to make that recoverable: a read that fails for a
   * reason unrelated to the record must leave the record alone. This pins the
   * half of that contract which lives here — `recover()` only clears what it
   * has PROVEN unusable.
   */
  it('keeps a good record when the caller simply reads it twice', async () => {
    await remember(PUBKEY, PRIVKEY)

    expect(await recover()).not.toBeNull()
    // A second read — the shape of a retry after a transient failure elsewhere.
    expect(await recover()).toEqual({ pubkey: PUBKEY, privkeyHex: PRIVKEY })
  })
})
