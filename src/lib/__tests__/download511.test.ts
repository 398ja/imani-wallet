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
  writeFile: vi.fn(async () => ({ uri: 'file:///cache/share/imani-backup.json' })),
  deleteFile: vi.fn(async () => {}),
  rmdir: vi.fn(async () => {}),
}))
const share = vi.hoisted(() => ({ share: vi.fn(async () => ({})) }))

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.value } }))
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: fs,
  Directory: { Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
}))
vi.mock('@capacitor/share', () => ({ Share: share }))

import { downloadText, mimeTypeFor, SHARE_LINGER_MS, sweepSharedFiles } from '../download'
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

  it('writes to the share folder, shares the file, and never makes a blob URL', async () => {
    const create = vi.spyOn(URL, 'createObjectURL')
    await downloadText('imani-backup.json', 'secret')
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'share/imani-backup.json', data: 'secret', directory: 'CACHE' }),
    )
    expect(share.share).toHaveBeenCalledWith(
      expect.objectContaining({ files: ['file:///cache/share/imani-backup.json'] }),
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('keeps a shared file for its target to read, and removes it later', async () => {
    // Android resolves the share when a target is PICKED; Drive or Gmail read the file after that.
    vi.useFakeTimers()
    try {
      await downloadText('imani-backup.json', 'secret')
      expect(fs.deleteFile).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(SHARE_LINGER_MS)
      expect(fs.deleteFile).toHaveBeenCalledWith({ path: 'share/imani-backup.json', directory: 'CACHE' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('sweeps what an earlier save left before writing a new one', async () => {
    await downloadText('imani-backup.json', 'secret')
    expect(fs.rmdir).toHaveBeenCalledWith({ path: 'share', directory: 'CACHE', recursive: true })
    expect(fs.rmdir.mock.invocationCallOrder[0]).toBeLessThan(fs.writeFile.mock.invocationCallOrder[0])
  })

  it('sweeps at start without throwing, and does nothing on the web', async () => {
    fs.rmdir.mockRejectedValueOnce(new Error('does not exist'))
    await expect(sweepSharedFiles()).resolves.toBeUndefined()
    native.value = false
    fs.rmdir.mockClear()
    await sweepSharedFiles()
    expect(fs.rmdir).not.toHaveBeenCalled()
  })

  it('treats a dismissed share sheet as fine, and deletes the file at once', async () => {
    share.share.mockRejectedValueOnce(new Error('Share canceled'))
    await expect(downloadText('k.txt', 'nsec1')).resolves.toBeUndefined()
    expect(fs.deleteFile).toHaveBeenCalledWith({ path: 'share/k.txt', directory: 'CACHE' })
  })

  it('rejects visibly when sharing fails, and deletes the file at once', async () => {
    share.share.mockRejectedValueOnce(new Error('No activity found'))
    await expect(downloadText('k.txt', 'nsec1')).rejects.toThrow(/save options/)
    expect(fs.deleteFile).toHaveBeenCalledWith({ path: 'share/k.txt', directory: 'CACHE' })
  })
})
