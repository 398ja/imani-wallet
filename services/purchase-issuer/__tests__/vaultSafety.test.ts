/**
 * @vitest-environment node
 *
 * Review of #302. Self-service enrolment makes the credential file a shared, concurrently written
 * thing, and #290 makes the running service follow it. Both must fail SAFE: no enrolled stall may
 * be lost to a race or to a bad file.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { FileCredentialStore } from '../adapters'
import { CredentialVault } from '../vault'

const KEY = 'a'.repeat(64)
const stall = (n: number) => n.toString(16).padStart(64, '0')
const record = (n: number) => ({ stallPubkey: stall(n), credentialId: `cred-${n}`, lockKeyHex: '22'.repeat(32) })

async function file(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'pi-safety-')), 'credentials.json')
}

describe('the vault, under concurrent enrolment and a bad file', () => {
  // Eight stalls turn on card sales at the same moment. Every one was confirmed at the gateway and
  // told "on", so every one must be on disk. Red before: ENOENT on the shared `.tmp`, and lost records.
  it('keeps every record when stalls enrol concurrently', async () => {
    const path = await file()
    const vault = new CredentialVault(KEY, new FileCredentialStore(path))
    await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((n) => vault.put(record(n))))
    const all = await new CredentialVault(KEY, new FileCredentialStore(path)).all()
    expect(all.map((c) => c.credentialId).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `cred-${n}`).sort())
  })

  // A file that turns unreadable under a running service (hand edit, a non-atomic copy) must not
  // take every stall off sale. Red before: the reload read it as [] and every stall vanished.
  it('keeps serving what it holds when the file turns corrupt, and picks up the fixed file', async () => {
    const path = await file()
    const vault = new CredentialVault(KEY, new FileCredentialStore(path))
    await vault.put(record(1))
    const good = await readFile(path, 'utf8')
    expect(await vault.get(stall(1))).not.toBeNull()

    await writeFile(path, '[{"stallPubkey": "trunc')
    expect((await vault.get(stall(1)))?.credentialId).toBe('cred-1')
    expect((await vault.get(stall(1)))?.credentialId).toBe('cred-1')

    await writeFile(path, '[]')
    expect(await vault.get(stall(1))).toBeNull()
    await writeFile(path, good)
    expect((await vault.get(stall(1)))?.credentialId).toBe('cred-1')
  })

  // And an enrolment while the file is corrupt is refused rather than writing [its record] over
  // everybody else's. Red before: the file became one record, stall 1 was gone for good.
  it('refuses to write over a corrupt file', async () => {
    const path = await file()
    const vault = new CredentialVault(KEY, new FileCredentialStore(path))
    await vault.put(record(1))
    const corrupt = '[{"stallPubkey": "trunc'
    await writeFile(path, corrupt)
    await expect(vault.put(record(2))).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(corrupt)
  })

  // A file that is valid JSON but not a list is just as unreadable.
  it('treats a non-array file as unreadable, not as empty', async () => {
    const path = await file()
    await writeFile(path, '{"oops": true}')
    await expect(new FileCredentialStore(path).read()).rejects.toThrow()
  })

  // A missing file is still the ordinary fresh deployment: no stalls, no error.
  it('reads a missing file as no stalls', async () => {
    expect(await new FileCredentialStore(await file()).read()).toEqual([])
  })
})
