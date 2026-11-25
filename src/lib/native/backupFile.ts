import { registerPlugin } from '@capacitor/core'

/**
 * The app's local Android plugin (android/app/src/main/java/.../BackupFilePlugin.java): save a
 * backup through the system "save as" screen and open the same document again later through a
 * persisted grant, with no picker and no storage permission.
 *
 * Rejections carry `code`: `cancelled` (save screen closed), `gone` (deleted or moved), `denied`
 * (grant revoked), `too-large`, `invalid`, `failed`.
 */
export interface BackupFilePlugin {
  create(options: { fileName: string; text: string }): Promise<{ uri: string }>
  read(options: { uri: string }): Promise<{ text: string }>
}

export const BackupFile = registerPlugin<BackupFilePlugin>('BackupFile')
