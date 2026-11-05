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
 * nothing at all (#511). There the text is written to a private `share/`
 * folder in the app's cache and handed to the system share sheet (Files,
 * Drive, email...).
 *
 * The file is NOT deleted the moment the share sheet returns. On Android the
 * sheet returns when the person picks a target, and the target (a Drive upload,
 * a Gmail draft) reads the file after that, sometimes much later. Deleting it
 * then hands them an empty or missing attachment, and a backup that silently
 * never saved. So the folder is swept instead: before the next save, at app
 * start (`sweepSharedFiles`), and best effort a few minutes later. The folder is
 * app-private; only the target the person chose gets a read grant.
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

/** The app-cache folder shared files live in, so a sweep can never touch anything else. */
const SHARE_DIR = 'share'
/** How long a shared file stays for its target app to read it, if the app keeps running. */
export const SHARE_LINGER_MS = 10 * 60 * 1000

async function filesystem() {
  return import('@capacitor/filesystem')
}

/**
 * Remove every file a previous save left for its share target. Called before a
 * new save and at app start. Never throws: a leftover file is cleaned up next time.
 */
export async function sweepSharedFiles(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  try {
    const { Filesystem, Directory } = await filesystem()
    await Filesystem.rmdir({ path: SHARE_DIR, directory: Directory.Cache, recursive: true })
  } catch {
    // Nothing to sweep (no folder yet), or the platform refused: next time.
  }
}

async function shareFile(filename: string, text: string): Promise<void> {
  const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([filesystem(), import('@capacitor/share')])
  await sweepSharedFiles()
  const path = `${SHARE_DIR}/${filename}`
  const { uri } = await Filesystem.writeFile({
    path,
    data: text,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
    recursive: true,
  })
  const removeLater = () =>
    setTimeout(() => void Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => {}), SHARE_LINGER_MS)
  try {
    await Share.share({ title: filename, files: [uri], dialogTitle: 'Save your backup' })
  } catch (e) {
    // Nobody will read it: delete now.
    await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => {})
    if (!isCancel(e)) throw new Error('Could not open the save options. Please try again.')
    return
  }
  // Shared: the target may still be reading it. Swept later, never right away.
  removeLater()
}

function isCancel(e: unknown): boolean {
  return /cancel/i.test(e instanceof Error ? e.message : String(e))
}
