import { beforeEach, describe, expect, it, vi } from 'vitest'

const saveProfile = vi.fn()
vi.mock('../profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../profile')>()),
  saveProfile,
}))

const { parseBackup, applyBackup, BackupError } = await import('../backup')

const KEYSTORE_KEY = 'imani-wallet-key'
const PUBKEY = '4728fd8ad6a2f5c8930f4065347907e22186fba6c73bd04e145dfd780b98e451'

const envelope = (tag = 'new') => ({
  version: 1,
  kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 310000, salt: 'c2FsdA==' },
  iv: 'aXY=',
  ciphertext: tag,
})

const file = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: 'imani-wallet-backup',
    version: 1,
    createdAt: '2026-08-13T00:00:00.000Z',
    key: envelope(),
    profile: { pubkey: PUBKEY, npub: 'npub1x', updatedAt: 1 },
    ...over,
  })

// jsdom is not configured in this project, so provide the slice we use.
const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  vi.clearAllMocks()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
})

describe('parseBackup', () => {
  it('rejects anything that is not a backup file', () => {
    expect(() => parseBackup('not json')).toThrow(BackupError)
    expect(() => parseBackup(JSON.stringify({ format: 'something-else' }))).toThrow(BackupError)
  })

  it('rejects a backup from a newer wallet', () => {
    expect(() => parseBackup(file({ version: 99 }))).toThrow(/newer version/)
  })

  it('rejects a file whose envelope is incomplete', () => {
    expect(() => parseBackup(file({ key: { kdf: {}, iv: 'x' } }))).toThrow(/missing its key/)
  })

  it('writes nothing — choosing a file must not touch the stored key', () => {
    // The whole reason parse and apply are separate: /restore is reached from
    // the login screen, so this browser usually already holds a key.
    store.set(KEYSTORE_KEY, JSON.stringify(envelope('existing')))
    parseBackup(file())
    expect(JSON.parse(store.get(KEYSTORE_KEY)!).ciphertext).toBe('existing')
    expect(saveProfile).not.toHaveBeenCalled()
  })

  it('drops a profile with no pubkey rather than writing profile:undefined', () => {
    expect(parseBackup(file({ profile: { npub: 'npub1x' } })).profile).toBeNull()
  })

  it('strips a javascript: website from a supplied profile', () => {
    const parsed = parseBackup(
      file({ profile: { pubkey: PUBKEY, npub: 'npub1x', updatedAt: 1, website: 'javascript:alert(1)' } }),
    )
    expect(parsed.profile?.website).toBeUndefined()
  })

  it('keeps an https website', () => {
    const parsed = parseBackup(
      file({ profile: { pubkey: PUBKEY, npub: 'npub1x', updatedAt: 1, website: 'https://ok.example/' } }),
    )
    expect(parsed.profile?.website).toBe('https://ok.example/')
  })
})

describe('applyBackup', () => {
  it('installs the key when the passphrase opens it', async () => {
    const parsed = parseBackup(file())
    const { privkeyHex } = await applyBackup(parsed, async () => 'deadbeef')

    expect(privkeyHex).toBe('deadbeef')
    expect(JSON.parse(store.get(KEYSTORE_KEY)!).ciphertext).toBe('new')
    expect(saveProfile).toHaveBeenCalled()
  })

  it('rolls back to the previous key when the passphrase fails', async () => {
    // The data-loss case. Without the rollback, picking the wrong file — or
    // misremembering its passphrase — destroyed the only encrypted copy of the
    // key already in this browser, which the app itself says is unrecoverable.
    store.set(KEYSTORE_KEY, JSON.stringify(envelope('existing')))
    const parsed = parseBackup(file())

    await expect(
      applyBackup(parsed, () => Promise.reject(new Error('Invalid passphrase'))),
    ).rejects.toThrow('Invalid passphrase')

    expect(JSON.parse(store.get(KEYSTORE_KEY)!).ciphertext).toBe('existing')
    expect(saveProfile).not.toHaveBeenCalled()
  })

  it('leaves no key behind when there was none to begin with', async () => {
    const parsed = parseBackup(file())

    await expect(applyBackup(parsed, () => Promise.reject(new Error('nope')))).rejects.toThrow()

    expect(store.has(KEYSTORE_KEY)).toBe(false)
  })
})

/**
 * The identity a restore screen shows before it asks for anything.
 *
 * Load-bearing: someone who has just lost a phone is handed a file out of
 * Drive and has to be told whose account it holds. Naming the wrong one is
 * worse than refusing, so the npub is derived and checked rather than believed.
 */
describe('the account named in a backup', () => {
  // The real bech32 encoding of PUBKEY. It has to be, or the disagreement test
  // below passes through the unreadable-npub branch instead of the one it names.
  const NPUB = 'npub1gu50mzkk5t6u3yc0gpjng7g8ugscd7axcuaaqns5th7hszucu3gs2q2gk6'

  it('round-trips the npub for a file this build wrote', async () => {
    const { createBackup } = await import('../backup')
    store.set(KEYSTORE_KEY, JSON.stringify(envelope()))

    const written = JSON.parse(createBackup(PUBKEY)) as { npub: string; pubkey: string }

    expect(written.pubkey).toBe(PUBKEY)
    expect(parseBackup(createBackup(PUBKEY)).npub).toBe(written.npub)
  })

  it('reports no account for a file written before the field existed', () => {
    // Older backups are still good backups. Restore falls back to saying
    // nothing rather than guessing, and must not reject the file.
    expect(parseBackup(file()).npub).toBeNull()
  })

  it('rejects a file whose npub and pubkey disagree', () => {
    // NPUB is readable and decodes cleanly; only the pubkey beside it is wrong.
    expect(parseBackup(file({ npub: NPUB })).npub).toBe(NPUB)
    expect(() => parseBackup(file({ npub: NPUB, pubkey: 'f'.repeat(64) }))).toThrow(
      /npub and public key disagree/,
    )
  })

  it('rejects an unreadable npub rather than showing it', () => {
    expect(() => parseBackup(file({ npub: 'npub1notreallybech32' }))).toThrow(
      /cannot be read/,
    )
  })
})
