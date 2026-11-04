/**
 * @vitest-environment jsdom
 */
/**
 * #511: backup files on Android. The picker must not filter by MIME type in the
 * app, saved files are labelled by extension, and in the app saving goes
 * through the cache directory and the share sheet, never a blob: URL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const native = vi.hoisted(() => ({ value: false }))
const fs = vi.hoisted(() => ({
  writeFile: vi.fn(async () => ({ uri: 'file:///cache/imani-backup.json' })),
  deleteFile: vi.fn(async () => {}),
}))
const share = vi.hoisted(() => ({ share: vi.fn(async () => ({})) }))

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.value } }))
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: fs,
  Directory: { Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
}))
vi.mock('@capacitor/share', () => ({ Share: share }))

import { downloadText, mimeTypeFor } from '../download'
import { backupFileAccept } from '../backupFileAccept'

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  URL.createObjectURL ??= () => ''
  URL.revokeObjectURL ??= () => {}
  native.value = false
})

describe('backup file picker accept (#511)', () => {
  it('accepts any file in the app, where Capacitor maps */* to no MIME filter', () => {
    native.value = true
    expect(backupFileAccept()).toBe('*/*')
  })
  it('keeps the JSON filter on the web', () => {
    expect(backupFileAccept()).toBe('application/json,.json')
  })
})

describe('mimeTypeFor', () => {
  it('labels .json as application/json and anything else as text/plain', () => {
    expect(mimeTypeFor('imani-backup-song.json')).toBe('application/json')
    expect(mimeTypeFor('X.JSON')).toBe('application/json')
    expect(mimeTypeFor('backup-key.txt')).toBe('text/plain')
  })
})

describe('downloadText on the web', () => {
  it('uses a blob labelled by extension', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await downloadText('a.json', '{}')
    expect((create.mock.calls[0][0] as Blob).type).toBe('application/json')
    expect(share.share).not.toHaveBeenCalled()
  })
})

describe('downloadText in the app', () => {
  beforeEach(() => {
    native.value = true
  })

  it('writes to the cache, shares the file, deletes it, and never makes a blob URL', async () => {
    const create = vi.spyOn(URL, 'createObjectURL')
    await downloadText('imani-backup.json', 'secret')
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'imani-backup.json', data: 'secret', directory: 'CACHE' }),
    )
    expect(share.share).toHaveBeenCalledWith(
      expect.objectContaining({ files: ['file:///cache/imani-backup.json'] }),
    )
    expect(fs.deleteFile).toHaveBeenCalledWith({ path: 'imani-backup.json', directory: 'CACHE' })
    expect(create).not.toHaveBeenCalled()
  })

  it('treats a dismissed share sheet as fine, and still deletes the file', async () => {
    share.share.mockRejectedValueOnce(new Error('Share canceled'))
    await expect(downloadText('k.txt', 'nsec1')).resolves.toBeUndefined()
    expect(fs.deleteFile).toHaveBeenCalled()
  })

  it('rejects visibly when sharing fails, and still deletes the file', async () => {
    share.share.mockRejectedValueOnce(new Error('No activity found'))
    await expect(downloadText('k.txt', 'nsec1')).rejects.toThrow(/save options/)
    expect(fs.deleteFile).toHaveBeenCalled()
  })
})
