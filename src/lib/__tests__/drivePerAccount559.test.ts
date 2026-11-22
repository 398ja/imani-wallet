/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPublicKey, nip19 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * #559: Drive kept one fixed file and PATCHed it on every backup, so backing up
 * a second account overwrote the first account's key. A fake Drive here holds
 * files, appProperties and revisions, and understands the queries drive.ts
 * sends, so the tests see what Drive would end up holding.
 */

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true },
  registerPlugin: () => ({
    authorize: async () => ({ accessToken: 't', grantedScopes: ['https://www.googleapis.com/auth/drive.appdata'] }),
    clearToken: async () => undefined,
  }),
}))

import { listBackups, putAndVerifyBackup, putBackup } from '../drive'
import { parseBackup } from '../backup'

const A = getPublicKey(hexToBytes('1'.repeat(64)))
const B = getPublicKey(hexToBytes('2'.repeat(64)))

function backup(pubkey: string, key: string, nip05?: string): string {
  return JSON.stringify({
    format: 'imani-wallet-backup',
    version: 1,
    createdAt: '2026-11-07T00:00:00Z',
    npub: nip19.npubEncode(pubkey),
    pubkey,
    key: { ciphertext: key, kdf: 'k', iv: 'i' },
    profile: nip05 ? { pubkey, nip05, updatedAt: 1 } : null,
  })
}

interface FakeFile {
  id: string
  name: string
  modifiedTime: string
  appProperties?: Record<string, string>
  content: string
  revisions: { id: string; modifiedTime: string; content: string }[]
}

let files: FakeFile[]
let clock: number
let writes: { method: string; url: string }[]

function tick(): string {
  clock += 60_000
  return new Date(clock).toISOString()
}

/** A minimal Drive v3: list with the q forms drive.ts uses, media, multipart upload, revisions. */
async function fakeDrive(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input)
  const method = init?.method ?? 'GET'
  const path = url.pathname

  if (path.startsWith('/upload/drive/v3/files')) {
    writes.push({ method, url: input })
    const body = String(init?.body)
    const parts = body.split(/--imani-[^\r]*\r\n/).filter(Boolean)
    const meta = JSON.parse(parts[0].split('\r\n\r\n')[1].trim()) as Partial<FakeFile>
    const content = parts[1].split('\r\n\r\n')[1].replace(/\r\n--imani-.*--$/s, '').replace(/\r\n$/, '')
    const now = tick()
    if (method === 'POST') {
      files.push({
        id: `f${files.length + 1}`,
        name: meta.name!,
        appProperties: meta.appProperties,
        modifiedTime: now,
        content,
        revisions: [{ id: 'r1', modifiedTime: now, content }],
      })
    } else {
      const id = path.split('/').pop()!
      const file = files.find((f) => f.id === id)!
      Object.assign(file, { name: meta.name, appProperties: meta.appProperties, content, modifiedTime: now })
      file.revisions.push({ id: `r${file.revisions.length + 1}`, modifiedTime: now, content })
    }
    return new Response('{}')
  }

  const revision = path.match(/^\/drive\/v3\/files\/([^/]+)\/revisions(?:\/([^/]+))?$/)
  if (revision) {
    const file = files.find((f) => f.id === revision[1])!
    if (revision[2]) return new Response(file.revisions.find((r) => r.id === revision[2])!.content)
    return new Response(JSON.stringify({ revisions: file.revisions.map(({ id, modifiedTime }) => ({ id, modifiedTime })) }))
  }

  const media = path.match(/^\/drive\/v3\/files\/([^/]+)$/)
  if (media) return new Response(files.find((f) => f.id === media[1])!.content)

  const q = url.searchParams.get('q') ?? ''
  const byName = q.match(/name = '([^']+)'/)?.[1]
  const byProp = q.match(/value='([^']+)'/)?.[1]
  const contains = q.match(/name contains '([^']+)'/)?.[1]
  const matched = files
    .filter((f) =>
      contains
        ? f.name.includes(contains)
        : f.name === byName || (byProp !== undefined && f.appProperties?.pubkey === byProp),
    )
    .sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime))
  const limit = Number(url.searchParams.get('pageSize') ?? 100)
  return new Response(JSON.stringify({ files: matched.slice(0, limit) }))
}

beforeEach(() => {
  files = []
  writes = []
  clock = Date.parse('2026-11-08T00:00:00Z')
  vi.stubGlobal('fetch', vi.fn(fakeDrive))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Drive keeps one backup per account (#559)', () => {
  it('backing up A then B keeps both, and each restores its own key', async () => {
    await putBackup(backup(A, 'key-A', 'duran@imani.africa'))
    await putBackup(backup(B, 'key-B', 'cruchot@imani.africa'))

    expect(files.map((f) => f.name).sort()).toEqual(
      [`imani-wallet-account-${A}.json`, `imani-wallet-account-${B}.json`].sort(),
    )
    expect(files.find((f) => f.appProperties?.pubkey === A)?.appProperties).toEqual({
      pubkey: A,
      npub: nip19.npubEncode(A),
      nip05: 'duran@imani.africa',
    })

    const list = await listBackups()
    expect(list.map((b) => b.nip05)).toEqual(['cruchot@imani.africa', 'duran@imani.africa'])
    expect(list.every((b) => b.modifiedTime && !b.legacy)).toBe(true)
    const keyOf = (pubkey: string) => {
      const found = list.find((b) => b.pubkey === pubkey)!
      return (parseBackup(found.text).key as { ciphertext: string }).ciphertext
    }
    expect(keyOf(A)).toBe('key-A')
    expect(keyOf(B)).toBe('key-B')
  })

  it("B's backup never PATCHes A's file or the legacy file", async () => {
    files.push({
      id: 'legacy',
      name: 'imani-wallet-account.json',
      modifiedTime: tick(),
      content: backup(A, 'old-A'),
      revisions: [],
    })
    await putBackup(backup(A, 'key-A'))
    const aId = files.find((f) => f.appProperties?.pubkey === A)!.id
    writes = []

    await putBackup(backup(B, 'key-B'))
    await putBackup(backup(B, 'key-B2'))

    expect(writes[0].method).toBe('POST')
    for (const w of writes) {
      expect(w.url).not.toContain(`/files/${aId}?`)
      expect(w.url).not.toContain('/files/legacy?')
    }
    expect(files.find((f) => f.id === aId)!.content).toContain('key-A')
    expect(files.find((f) => f.id === 'legacy')!.content).toContain('old-A')
    // B's second backup updates B's own file in place.
    expect(writes[1].method).toBe('PATCH')
    expect(files.filter((f) => f.appProperties?.pubkey === B)).toHaveLength(1)
  })

  it('a backup of the same account updates its newest copy (duplicate race)', async () => {
    const name = `imani-wallet-account-${A}.json`
    files.push(
      { id: 'old', name, modifiedTime: tick(), appProperties: { pubkey: A }, content: backup(A, 'x'), revisions: [] },
      { id: 'new', name, modifiedTime: tick(), appProperties: { pubkey: A }, content: backup(A, 'y'), revisions: [] },
    )
    await putBackup(backup(A, 'z'))
    expect(writes).toEqual([expect.objectContaining({ method: 'PATCH', url: expect.stringContaining('/files/new?') })])
    const list = await listBackups()
    expect(list).toHaveLength(1)
    expect(list[0].text).toContain('"z"')
  })

  it('lists the legacy file and its older revisions, each named by its content', async () => {
    files.push({
      id: 'legacy',
      name: 'imani-wallet-account.json',
      modifiedTime: '2026-11-07T16:00:00.000Z',
      content: backup(B, 'key-B'),
      revisions: [
        { id: 'r1', modifiedTime: '2026-11-06T09:00:00.000Z', content: backup(A, 'key-A') },
        { id: 'r2', modifiedTime: '2026-11-07T16:00:00.000Z', content: backup(B, 'key-B') },
      ],
    })
    await putBackup(backup(A, 'key-A-new', 'duran@imani.africa'))

    const list = await listBackups()
    expect(list.map((b) => [b.id, b.legacy, b.pubkey])).toEqual([
      [files[1].id, false, A],
      ['legacy', true, B],
      ['legacy@r1', true, A],
    ])
    expect(list[1].npub).toBe(nip19.npubEncode(B))
    expect(list[2].revisionId).toBe('r1')
    expect(list[2].modifiedTime).toBe('2026-11-06T09:00:00.000Z')
    expect(list[2].text).toContain('key-A')
  })

  it('refuses a backup that names no account rather than guess a file', async () => {
    await expect(putBackup('{}')).rejects.toThrow(/does not name/)
    expect(writes).toEqual([])
  })
})

describe('#348: a Drive backup counts only once it is read back', () => {
  it('writes, reads the file back, and resolves when it holds this key', async () => {
    await putAndVerifyBackup(backup(A, 'key-A'))
    expect(files).toHaveLength(1)
    expect(files[0].content).toContain('key-A')
  })

  it('rejects when Drive answers with another envelope', async () => {
    const realFetch = fakeDrive
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const res = await realFetch(input, init)
        if (/\/drive\/v3\/files\/[^/?]+\?alt=media/.test(input)) return new Response(backup(A, 'something-else'))
        return res
      }),
    )
    await expect(putAndVerifyBackup(backup(A, 'key-A'))).rejects.toThrow(/does not match/)
  })
})
