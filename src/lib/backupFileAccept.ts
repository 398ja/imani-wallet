import { Capacitor } from '@capacitor/core'

/**
 * What the backup-file picker accepts (#511).
 *
 * In the Android app Capacitor's BridgeWebChromeClient.showFilePicker turns
 * several accept values into EXTRA_MIME_TYPES (".json" is mapped through
 * MimeTypeMap to application/json), and the system picker then greys out every
 * file not labelled application/json, which is nearly all of them (Chrome
 * downloads, WhatsApp, email). A single "*\/*" goes straight to
 * Intent.setType("*\/*") with no EXTRA_MIME_TYPES, so every file is pickable.
 * parseBackup rejects a file that is not a backup, so that is safe. The web
 * keeps the filter, where browsers match by extension too.
 */
export function backupFileAccept(): string {
  return Capacitor.isNativePlatform() ? '*/*' : 'application/json,.json'
}
