/**
 * Save text to a file.
 *
 * Used by the three places a user takes something out of the wallet: the backup
 * key at registration, the nsec export in Security, and the backup file. All of
 * them hand over key material, so none of them may go through a server.
 */
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  // The object URL pins the blob in memory until revoked, and these blobs hold
  // key material. Revoking immediately is safe — the download has already been
  // handed to the browser by the synchronous click().
  URL.revokeObjectURL(url)
}
