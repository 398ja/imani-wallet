import { Notice } from './ui'

/**
 * #559: until v0.58.0, Google Drive kept ONE wallet backup per Google account, and every Drive backup
 * replaced it, whichever Imani account wrote it. A user lost an account's key that way. Each account
 * now has its own Drive file (`driveFilename` in backup.ts), so a backup replaces only this
 * account's own earlier copy. Every screen that writes to Drive says so, and warns that an app on
 * an older version may still overwrite the shared file.
 *
 * `who` is this account's handle when known, so the sentence says whose backup it is.
 */
export function DriveOverwriteWarning({ who }: { who?: string | null }) {
  const account = who ? `${who}'s` : "this account's"
  return (
    <Notice tone="warning">
      Saving to Google Drive replaces {account} earlier Drive backup. Other Imani accounts in the same
      Google account keep their own backups. An app older than this version still writes one shared
      backup that replaces any other, so update every device before backing up there.
    </Notice>
  )
}
