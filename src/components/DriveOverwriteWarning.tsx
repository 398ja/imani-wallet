import { Notice } from './ui'

/**
 * #559: Google Drive keeps ONE wallet backup per Google account (`DRIVE_FILENAME` in backup.ts), and
 * every Drive backup replaces it, whichever Imani account wrote it. A user who backed up a second
 * account to the same Google account lost the first one's key that way: restore brought back the
 * other account. Until each account gets its own Drive file, every screen that writes to Drive says
 * so, next to the button, in words that name what is lost.
 *
 * `who` is this account's handle when known, so the sentence says whose backup goes in.
 */
export function DriveOverwriteWarning({ who }: { who?: string | null }) {
  const account = who ? `${who}'s` : "this account's"
  return (
    <Notice tone="warning">
      Google Drive holds one wallet backup per Google account. Saving here replaces any backup already
      there, including another Imani account&apos;s, with {account}. If you use more than one Imani
      account, back up the others with Download file instead, or use a different Google account for
      each.
    </Notice>
  )
}
