/**
 * @vitest-environment node
 *
 * imani-wallet#290: the credential vault was read once and cached for the life of the process, so
 * a stall enrolled by another process (the operator script `s3-seal.mts`, `attachDelegation.ts`)
 * was invisible until a restart, and its paid card purchases sat OWED.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { FileCredentialStore } from '../adapters'
import { CredentialVault } from '../vault'

const KEY = 'a'.repeat(64)
const STALL = 'b'.repeat(64)

async function file(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'pi-reload-')), 'credentials.json')
}

describe('#290: the vault follows its file', () => {
  // A record written to the shared file by ANOTHER process after this one first read it is
  // returned by the next read, with no restart.
  it('picks up a record another process sealed', async () => {
    const shared = await file()
    const running = new CredentialVault(KEY, new FileCredentialStore(shared))
    expect(await running.get(STALL)).toBeNull()

    const elsewhere = await file()
    await new CredentialVault(KEY, new FileCredentialStore(elsewhere)).put({
      stallPubkey: STALL,
      credentialId: 'cred-script',
      lockKeyHex: '22'.repeat(32),
    })
    // The script's write lands in the file the running service reads.
    await writeFile(shared, await readFile(elsewhere, 'utf8'))

    expect((await running.get(STALL))?.credentialId).toBe('cred-script')
    expect((await running.all()).map((c) => c.credentialId)).toEqual(['cred-script'])
  })

  // A record removed from the file by another process stops being used too.
  it('drops a record another process removed', async () => {
    const shared = await file()
    const running = new CredentialVault(KEY, new FileCredentialStore(shared))
    await running.put({ stallPubkey: STALL, credentialId: 'c1', lockKeyHex: '22'.repeat(32) })
    expect(await running.get(STALL)).not.toBeNull()
    await writeFile(shared, '[]')
    expect(await running.get(STALL)).toBeNull()
  })

  // Somebody else's write is announced once, so the service can confirm it at once (#296).
  it('announces an external reload, not its own writes', async () => {
    const shared = await file()
    const running = new CredentialVault(KEY, new FileCredentialStore(shared))
    let reloads = 0
    running.onReload(() => (reloads += 1))
    await running.get(STALL)
    await running.put({ stallPubkey: STALL, credentialId: 'c1', lockKeyHex: '22'.repeat(32) })
    await running.get(STALL)
    expect(reloads).toBe(0)
    await writeFile(shared, '[]')
    await running.get(STALL)
    await running.get(STALL)
    expect(reloads).toBe(1)
  })
})
