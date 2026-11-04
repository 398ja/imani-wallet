import { Capacitor } from '@capacitor/core'

/**
 * Save text to a file.
 *
 * Used by the three places a user takes something out of the wallet: the backup
 * key at registration, the nsec export in Security, and the backup file. All of
 * them hand over key material, so none of them may go through a server.
 *
 * On the web this is a `blob:` download. In the Android app it is not: the
 * Capacitor WebView has no DownloadListener, so an `<a download>` click does
 * nothing at all (#511). There the text is written to the app's private cache
 * directory, handed to the system share sheet (Files, Drive, email...), and the
 * cache copy is deleted afterwards whatever happens, because it is key material.
 *
 * Rejects when the file could not be handed over, so callers can say so. A
 * share sheet the user dismissed resolves quietly: that was their choice.
 */
export async function downloadText(filename: string, text: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await shareFile(filename, text)
    return
  }
  const url = URL.createObjectURL(new Blob([text], { type: mimeTypeFor(filename) }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  // The object URL pins the blob in memory until revoked, and these blobs hold
  // key material. Revoking immediately is safe — the download has already been
  // handed to the browser by the synchronous click().
  URL.revokeObjectURL(url)
}

/**
 * `application/json` for `.json`, so a saved backup is labelled as what it is.
 * Our backups used to be saved as `text/plain`, which is part of why Android's
 * picker greyed them out (#511).
 */
export function mimeTypeFor(filename: string): string {
  return filename.toLowerCase().endsWith('.json') ? 'application/json' : 'text/plain'
}

async function shareFile(filename: string, text: string): Promise<void> {
  const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ])
  const path = filename
  const { uri } = await Filesystem.writeFile({
    path,
    data: text,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
  })
  try {
    await Share.share({ title: filename, files: [uri], dialogTitle: 'Save your backup' })
  } catch (e) {
    if (!isCancel(e)) throw new Error('Could not open the save options. Please try again.')
  } finally {
    await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => {})
  }
}

function isCancel(e: unknown): boolean {
  return /cancel/i.test(e instanceof Error ? e.message : String(e))
}
